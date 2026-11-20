# Arbitrary config overrides

A request can override ANY existing `<Value name="...">...</Value>` in
`configuration_ref.xml` -- any section (`Files`, `ScenarioComponents`,
`Strings`, `Bools`, `Ints`, `Doubles`) -- without needing a new Daytona
snapshot for each individual value someone wants to try. This is what
replaced the previous "every new knob needs a snapshot rebuild" cycle
(see `oom-fix.md` -- that's exactly the cycle `max-parallelism` and the
CSV-parsing fix each went through, v2 -> v3 -> v4).

## How it works

- A request's `params` can include `config_overrides`: a flat
  `{name: value}` object, e.g. `{"max-parallelism": 2, "stop-period": 5}`.
- `sandboxes/gcam/run.py`'s `apply_config_overrides` reads the baked
  `configuration_ref.xml`, and for each override, regex-replaces that
  `<Value ... name="X">OLD</Value>` tag's inner text with the new value
  -- its other attributes (`write-output=`, `append-scenario-name=`)
  and its section are left alone, so `gcam.exe`'s own
  `Configuration::getInt`/`getBool`/`getString`/`getDouble` still parses
  it with whatever type that section always implied.
- The patched XML is written to a per-run path
  (`/tmp/configuration_run.xml`), NOT overwriting the canonical file --
  `gcam.exe -C /tmp/configuration_run.xml` is invoked instead. A run
  with no overrides never touches this at all and still uses the
  canonical file directly.
- A name with more than one matching tag (a few real
  `ScenarioComponents` names repeat, e.g. `nonco2_energy` appears twice
  for the MAC-adjusted variant) gets the override applied to **every**
  match -- there's no way to disambiguate which one was meant from the
  name alone.

## Deliberately unrestricted, not an allowlist

Earlier design notes (see this project's own conversation history)
considered restricting overrides to a "safe" subset (scalar
`Ints`/`Bools`/`Doubles`/`Strings` only, excluding `Files`/
`ScenarioComponents`) with a curated allowlist. That's **not** what got
built. Per explicit direction: this is deliberately permissive across
every section, because this project's own dashboard already shows a
run's full error/log output on failure -- a bad override (wrong type, a
nonexistent file path for a `ScenarioComponents` entry, etc.) is just as
visible and diagnosable there as any other `gcam.exe` failure, so there
was no reason to pre-validate correctness here on top of that.

The one thing that IS enforced: the override's name has to match an
EXISTING `<Value name="X">` somewhere in the file. A typo fails loudly,
before `gcam.exe` ever launches:

```json
{"status": "failed", "error": "config_overrides: no matching <Value> found for: totally-not-a-real-key"}
```

Without this check, a typo'd key would silently do nothing -- `gcam.exe`
would just run with its unmodified default, indistinguishable from the
override "working" except by comparing output. Confirmed this failure
mode by testing both ways directly against the real snapshot.

## Verified live, not just unit-tested

`apply_config_overrides`'s regex logic was unit-tested locally first
(multi-match keys, attribute preservation, unknown-key detection, every
section type) -- but the real test was against a live sandbox on the
actual `gcam-production-v4` snapshot (2026-11-19), to confirm an
override doesn't just change the file text but genuinely changes
`gcam.exe`'s own behavior:

- `config_overrides: {"stop-period": 2, "max-parallelism": 2}` ->
  `/tmp/configuration_run.xml` had both values patched correctly, and
  `gcam.exe` itself printed `"Starting a model run. Running period 2"`
  (its own log line reflecting the override, not something `run.py`
  could have faked) and exited 0 after only 3 periods (0, 1, 2) instead
  of the full 21 -- also a handy way to get a fast (~2-3 min) smoke-test
  run instead of waiting the usual ~20-50 minutes.
- `config_overrides: {"totally-not-a-real-key": 1}` failed immediately
  with the clear error above, confirmed via direct `run.py` invocation
  (not routed through the full app) for a tight feedback loop.

## Deploying this needed exactly one more snapshot

Like every gcam fix so far, this needed one snapshot rebuild to ship
the `apply_config_overrides` mechanism itself in `run.py` -- no
`gcamdata`/`gcam.exe` rebuild (same patch-a-live-sandbox-and-resnapshot
process as v3/v4). Deployed as `gcam-production-v5`
(`apps/web/lib/models.ts`'s `daytona_snapshot`). From here on, trying a
different config value is just a request parameter -- no further
snapshot changes needed for that specific case, only if the mechanism
itself ever needs to change.

## Dashboard surface

- `apps/web/lib/clientTypes.ts`/`lib/models.ts`: `ModelMeta` gained
  `supports_config_overrides` (only true for gcam). This is NOT a
  `ParameterSpec` entry -- there's no fixed list of "safe" keys to
  enumerate ahead of time the way every other parameter here is a
  curated, range-checked slider.
- `apps/web/components/NewRunPanel.tsx`: when the selected model
  supports this, the Advanced section shows a raw JSON textarea
  ("Config overrides (advanced)"). `lib/clientApi.ts`'s `buildParams`
  parses it and throws a clear client-side error on invalid JSON or a
  non-flat-object shape (caught and shown the same way any other
  submission error is) -- unlike the numeric parameter fields, which
  just silently skip an unparseable value, a config-override typo
  blocks submission instead of silently running without it.
- `apps/web/lib/runs.ts`'s `validateParams` allows a `config_overrides`
  key only for a model with `supportsConfigOverrides`, checked server-
  side too (plain object, no nested objects/arrays as values) -- same
  "not a validated subset" reasoning, just confirming the SHAPE is
  sane, not the individual key names/values.
- Caching is unaffected by construction: `getCachedRun` matches on the
  full `params` JSON, and `config_overrides` is part of `params`, so two
  requests with different overrides are automatically different cache
  entries -- no special-casing needed.

## A pre-existing gap this fix also closed

`buildWrappedCommand` (`lib/runs.ts`) used to interpolate
`JSON.stringify(params)` directly into a single-quoted shell argument
(`SCENARIO_PARAMS='...'`). A literal single quote anywhere in a param
value would have terminated that argument early and corrupted the rest
of the wrapped command -- a latent bug for every model's params, just
never hit before because no existing parameter's value was ever
free-form text. `config_overrides` makes this much more likely to
happen in practice (arbitrary string/path override values), so this was
fixed as part of this change: the params JSON is now base64-encoded
before being embedded (base64's own alphabet never contains a quote, so
wrapping THAT in single quotes is always safe regardless of what's
inside), then decoded back via shell command substitution immediately
before `runCommand` sees it as `SCENARIO_PARAMS`.

## Defaulting a value at the app layer, not the image

`config_overrides` also made it possible to change a default WITHOUT
touching the Daytona snapshot at all -- and that distinction matters in
practice, not just in theory. The first attempt at "make 2 cores the
default" baked `max-parallelism=2` straight into
`configuration_ref.xml` and shipped it as a new snapshot
(`gcam-production-v6`) -- technically correct, but the wrong layer: the
actual ask was for the APP to default to 2 cores, not for the shipped
image's own default to change. That attempt was reverted (see this
repo's commit history -- "Revert... Make 2 cores the default").

The real implementation lives entirely in `apps/web/lib/runs.ts`:

- `models.ts`'s `ModelMeta` gained `defaultConfigOverrides`, set for
  gcam to `{"max-parallelism": 2}`.
- A small helper, `withDefaultParams(model, params)`, merges
  `model.defaultConfigOverrides` UNDER whatever the caller's own
  `params.config_overrides` already sets -- an explicit key always
  wins, this only fills in a key the caller never mentioned. Applied
  at the very top of both `checkRun` and `submitRun`, before
  validation and before anything touches the cache, so "no override
  set" and "explicitly set to the same default" are genuinely the same
  effective request -- same cache key, same validation -- for every
  caller, dashboard or raw API alike.
- `configuration_ref.xml`'s own baked-in default was left untouched at
  first (still `max-parallelism=1`, same as `gcam-production-v5`) --
  it only mattered for requests that somehow bypassed this app layer
  entirely (there currently are none). Since the app-level default
  above now covers every real request, that image-level override was
  later judged redundant and reverted back to upstream's own default
  (`-1`) in the repo, shipped as `gcam-production-v6` (see "Reverting
  the image-level default" below).

Verified live (2026-11-19) against the real `gcam-production-v5`
snapshot (no new snapshot involved at all): a caller params object with
NO `max-parallelism` key at all (just an unrelated `stop-period`
override, to keep the test run fast) produced, after
`withDefaultParams`, `{"config_overrides": {"max-parallelism": 2,
"stop-period": 1}}` -- confirmed the per-run patched
`/tmp/configuration_run.xml` read `max-parallelism=2` while the
snapshot's own canonical `configuration_ref.xml` still read `1`
unchanged, and the run completed with exit 0.

Changing this default again in the future -- a different core count, a
different default value for some other config key -- is purely a
`models.ts` edit, deployed the same way as any other web app change,
with no Daytona snapshot involved.

## Reverting the image-level default

Once the app-level default existed, the earlier image-level
`max-parallelism=1` fix (see `oom-fix.md`) was no longer doing
anything for requests that go through this app -- `withDefaultParams`
always supplies `2` first. Keeping the image pinned to `1` only made
sense as a general-purpose-image concern: someone pulling
`possibleplanets/gcam` from Docker Hub and running it directly, with
no app in front of it, gets upstream's own default back (`-1`, use
all available cores) rather than this app's own sandbox-tier tuning
baked permanently into the file.

`sandboxes/gcam/runtime/exe/configuration_ref.xml` was changed back to
`max-parallelism=-1` to match, then shipped the same lightweight way
as v3/v4/v5 (no `gcamdata`/`gcam.exe` rebuild): create a sandbox from
`gcam-production-v5`, overlay just the patched `configuration_ref.xml`
(`sandbox.fs.uploadFile`), verify it live (file parses, `max-parallelism`
reads `-1`, `gcam.exe`'s md5 and `run.py`'s md5 both unchanged from
v5), then `sandbox.createSnapshot("gcam-production-v6")`. Verified
again from a brand-new sandbox created straight from
`gcam-production-v6`, same checks. `apps/web/lib/models.ts`'s
`daytona_snapshot` for gcam updated from `v5` to `v6`. The app's own
`max-parallelism=2` default is unaffected either way, since it's
applied per-request regardless of what the image ships. `v2`-`v5` are
all left in place, unused, as rollback options.
