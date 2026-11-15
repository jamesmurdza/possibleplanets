# Climate Models API Platform — Spec & Plan

This document specs a platform that exposes the climate/economic models cataloged on
this site (DICE, FAIR, HECTOR, MAGICC, OSCAR) as a uniform API, plus a minimal
dashboard on top. It reflects findings from manually testing the models in a sandbox
(see guides in `guides/`), where install friction and environment mismatches were the
main barrier to accessibility — not the models themselves.

Status: **in progress.** HECTOR and FAIR sandbox images are built and tested
against real Daytona sandboxes; a minimal gateway and dashboard are implemented
over those two models. OSCAR, DICE, and MAGICC are not yet built. See the repo
layout below and the Build plan section for what's next.

## Repo layout (monorepo)

```
sandboxes/        model sandbox images (Dockerfile + run.py), shared build
                   artifacts used by apps/gateway -- one subdir per model
apps/
  gateway/         the API gateway (FastAPI) -- see Architecture below
  dashboard/       the minimal frontend -- see Minimal dashboard below
guides/            the site's existing per-model how-to guides
```

## Background

Each model currently has its own install story and its own input/output shape:

| Model  | Family | Runtime                     | Notes from testing                                   |
| ------ | ------ | ---------------------------- | ----------------------------------------------------- |
| DICE   | IAM    | Julia / Docker                | Guide already points to a `possibleplanets` fork      |
| FAIR   | RCM    | Python                        | Many small config/fill() calls; granular input surface|
| HECTOR | RCM    | Python + compiled C++ ext     | Needs `libboost-all-dev` to build outside Colab; undocumented in the current guide |
| MAGICC | RCM    | Python + Wine (closed-source) | Heaviest/most fragile install (Wine, i386 arch)       |
| OSCAR  | RCM    | Python + Poetry                | Guide has a likely typo: `poetry run install` should be `poetry install` |

Scenario taxonomies also differ across models (SSPs for FAIR/HECTOR, RCPs in MAGICC's
example) and aren't a 1:1 mapping. Output baselines differ too (e.g. MAGICC's example
explicitly rebases temperature to the 1850–1900 mean; HECTOR's raw output does not).
The platform spec below treats these as real differences to surface, not paper over.

## Goals (minimal version)

- One API to submit a model run and fetch its result, regardless of which of the 5
  models is underneath.
- Each run is fully isolated per tenant — no shared state, no shared filesystem,
  no shared process across requests.
- A minimal dashboard: pick a model, pick a scenario, run it, see one chart, get the
  raw output.
- No cross-model normalization, no scenario-taxonomy translation, no comparison view
  in this version — see Future Ideas.

## Architecture

### Execution unit: one sandbox per run

- Each model has a pinned, versioned image (e.g. `hector-v2024.1`) with all install-time
  friction baked in once (Boost + build toolchain for HECTOR, Wine + i386 arch for
  MAGICC, Julia + package precompilation for DICE, Poetry env for OSCAR).
- Daytona sandboxes start from these images in well under a second once the image is
  built — every run gets a fresh sandbox, used once, then destroyed.
- Rationale: this is what eliminates the cross-tenant risks identified during design
  (in-process global/static state in compiled extensions, shared Wine profile
  directories, shared Jupyter kernel state) — isolation is "one sandbox per run,"
  not "warm instance, hope it's stateless."

### Request flow

1. **Queued** — request lands in a per-model job queue. The queue's job is to
   rate-limit concurrent sandbox creation.
2. **Sandbox start** — worker starts a sandbox from the model's pinned image.
3. **Seed** — run-specific params/scenario are injected into the sandbox (not baked
   into the image).
4. **Execute** — run the model's script under a per-model timeout (short for
   HECTOR/FAIR/OSCAR, longer for MAGICC/DICE).
5. **Collect** — worker pulls the result out before teardown.
6. **Destroy** — sandbox is always destroyed after use, success or failure. Never
   reused across requests or tenants.

### API surface

```
POST /v1/models/{model}/runs
  body: { "scenario": "<model-native scenario id>", "params": {...optional overrides} }
  -> { "run_id": "...", "status": "queued" }

GET /v1/runs/{run_id}
  -> { "run_id": "...", "status": "queued|running|succeeded|failed",
       "result": {...} | null, "error": null }

GET /v1/models
  -> list of the 5 models with basic metadata (family, expected runtime, license)

GET /v1/models/{model}/schema
  -> that model's native scenario list and accepted params (no cross-model mapping)
```

All runs are async (submit → poll or webhook) even for fast models like HECTOR, so
API consumers write one client pattern regardless of which model they call.

### Output shape (minimal version)

No forced universal schema across models. Each model's adapter returns its native
result, untouched:

```json
{
  "run_id": "...",
  "model": "hector",
  "status": "succeeded",
  "result": { ...model's native output, e.g. a table of columns it produces... }
}
```

No "canonical" normalized layer in this version — see Future Ideas for why that's
deferred rather than cut outright.

### Result caching (implemented)

Results are cached by (model, params) in Postgres (`apps/gateway/cache.py`), using
a Supabase Postgres instance accessed via its **connection pooler** -- confirmed by
testing that Supabase's *direct* connection host is IPv6-only, which this sandbox
environment (and many others) can't reach; the pooler host is IPv4-reachable.
Connection string lives in `apps/gateway/.env`'s (gitignored) `DATABASE_URL`, never
committed.

Before creating a sandbox, a run is looked up by an exact (model, params) match; a
hit skips the sandbox entirely and returns the cached native result instantly. This
matters most for the slower models (OSCAR's smallest possible run takes ~6 minutes,
confirmed by testing) but applies uniformly to all models. Caching is best-effort
and fails open: if `DATABASE_URL` is unset or the DB is unreachable, the gateway
runs exactly as it would without caching -- a DB outage never blocks a model run,
it just stops being cached. The API surfaces a `cached: true/false` field on
`GET /v1/runs/{run_id}` so consumers (including the dashboard) aren't misled about
whether a result came from a real run.

### Progress reporting (implemented for fair; hector correctly has none)

Real, not synthetic: progress is only ever reported when a model has a genuine
intermediate signal, confirmed per model by testing rather than assumed:

- **hector** -- confirmed by testing there's no real signal at all: `pyhector.run()`
  has no progress hook, writes no log file, and finishes in well under a second.
  Runs via a plain blocking `sandbox.process.exec()`; `progress` stays `null` the
  whole time, correctly, not faked.
- **fair** -- has a real signal: FAIR's own library imports `tqdm` and iterates its
  main loop with it (confirmed by reading the installed library's source).
  `sandboxes/fair/run.py` monkey-patches that `tqdm` name to also write
  `{"percent": N}` to `/tmp/progress.json` (flushed + fsynced) on every real update
  from FAIR's own bar.
- **oscar** (not yet wired in) -- also has a real signal (it prints `year = ...`
  live as it runs, confirmed by testing) and would use the same mechanism; left
  out of this round deliberately.

How the gateway reads it, and why it's shaped this way: Daytona's session log APIs
(`get_session_command_logs`, and the async-callback `get_session_command_logs_async`)
were confirmed by direct testing to buffer ALL output until the command finishes --
polled every second for 22s during a real fair run, stdout stayed empty the whole
time, then all output arrived at once at the very end. Neither can be used to
observe progress mid-run, for any model. A direct filesystem read instead
(`sandbox.fs.download_file`) does reflect live state, confirmed by testing: polling
it while a background write loop ran caught real intermediate values as they were
written.

So for models with `supports_progress: True` (`apps/gateway/models.py`), `jobs.py`
starts the run via a session with `run_async=True` instead of a blocking `exec()`,
and polls the progress file directly every ~0.5s while also checking the session
command's exit code for completion. `GET /v1/runs/{run_id}` exposes this as a
`progress` field (e.g. `{"percent": 34}`), `null` when the model has nothing real to
report. The dashboard renders a real `<progress>` bar when a percent is present and
an indeterminate one otherwise -- never an estimated/fake value.

### Per-tenant isolation checklist

- Every run = new sandbox, no reuse, no shared temp dirs, no shared Wine prefix.
- No model "instance" object persisted or reused across requests.
- Per-model timeout enforced regardless of sandbox start speed, since compute time
  (not sandbox startup) is the variable cost for MAGICC/DICE.
- Image versions pinned and rebuilt deliberately, never mutated in place, so results
  stay reproducible.

## Minimal dashboard

One screen, three controls, one chart:

1. **Model dropdown** — the 5 models, plain list.
2. **Scenario dropdown** — populated from that model's native `/schema` options. No
   translation or "nearest equivalent" mapping shown.
3. **Run button** — submits the job, shows a simple "running..." state until the
   job's `status` flips to `succeeded`/`failed`.
4. **One chart** — a single default plot of that model's primary output (e.g.
   temperature anomaly for an RCM, a cost/damage curve for DICE), plus a link to
   download the raw JSON/CSV result.

Explicitly out of scope for this version: cross-model comparison/overlay, scenario
taxonomy translation, advanced/raw parameter editing in the UI, run history, sharing.

## Build plan (sequencing, not implementation)

1. Pick one model (HECTOR — simplest install, already tested manually) and build the
   full path end to end: image → sandbox run → API → minimal dashboard chart. This
   validates the architecture before replicating it four more times.
2. Fix the known guide/doc issues while building each model's image, so they don't
   get baked into the platform silently:
   - HECTOR: bake `libboost-all-dev` + build toolchain into the image.
   - OSCAR: fix `poetry install` in the fork/guide.
   - MAGICC: isolate the Wine setup entirely inside its image; this is the model
     most likely to need iteration.
   - DICE: decide which existing `possibleplanets` DICE repo is canonical before
     building its image, to avoid baking in the current repo sprawl.
3. Add the remaining 4 models one at a time, reusing the same sandbox lifecycle and
   API shape from step 1.
4. Ship the minimal dashboard against all 5.

## Future ideas (not in scope now)

- **Canonical output schema per model family** — a shared subset of fields (e.g.
  temperature anomaly, CO2 concentration, forcing) for the RCMs (FAIR/HECTOR/MAGICC),
  with explicit per-value baseline/unit metadata so overlaying two models' output
  doesn't silently imply they used the same reference period. DICE/IAM models would
  get their own separate canonical schema (economic outputs), not forced into the
  RCM shape.
- **Cross-model comparison view** — run the same scenario against multiple RCMs in
  parallel and overlay results on one chart, built on top of the canonical schema
  above.
- **Scenario taxonomy translation** — an explicit, visible mapping between SSP and
  RCP scenario families (e.g. "SSP2-4.5 ≈ RCP4.5") rather than assuming equivalence.
- **Advanced/raw parameter editor in the UI** — expose each model's full native
  parameter surface (e.g. FAIR's many `fill()`-able config fields) for power users.
- **Run history and shareable result links**, keyed off `run_id`.
- **Per-tenant usage metering and rate limits**, especially to prevent one tenant's
  MAGICC-heavy usage from starving others sharing queue capacity.
- **Licensing review** — MAGICC is closed-source (wrapped via `pymagicc`), and
  HECTOR (GPLv3) / OSCAR (CeCILL-2.1) carry copyleft terms; worth confirming terms
  before offering any of these as a hosted service, before scaling past a prototype.
- **Consolidate the DICE repo sprawl** in the `possibleplanets` org (currently
  `DICE-notebooks`, `DICE.jl-notebooks`, `DICE.jl`, `PyDICE`) down to one canonical
  implementation before/while building its platform image.
