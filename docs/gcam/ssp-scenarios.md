# SSP1-5 scenario support

## What this adds

Five new scenarios -- `SSP1` through `SSP5` -- alongside the existing
`Reference`. Each maps to its own config file
(`sandboxes/gcam/runtime/exe/configuration_sspN.xml`), selected the
same way `Reference` already is: `run.py`'s `SUPPORTED_SCENARIOS` dict
maps a `scenario` request param straight to a config filename, no new
plumbing needed anywhere else (dashboard scenario dropdown, caching,
`config_overrides` -- all generalize automatically, see below).

## Why not just use GCAM's own BatchMode/batch_SSP_*.xml files

Upstream `gcam-core` already ships `configuration_ssp.xml` plus
`batch_SSP_REF.xml`/`batch_SSP_SPA{1,23,4,5}.xml` -- GCAM's own
mechanism for running multiple SSP combinations in one process via
`BatchMode`. This was the first thing tried, and it failed, for two
separate reasons found by live-testing against the real snapshot:

1. **Every real `batch_SSP_SPA*.xml` file bundles a `<runner-set>`**
   of 5 forcing-policy targets (`_6p0`, `_4p5`, `_3p7`, `_2p6`,
   `_1p9`) plus the base no-policy case -- so "run SSP1" via one of
   those files actually means 6 full scenario runs back to back in one
   process. `batch_SSP_REF.xml` (no runner-set) avoids that, but:
2. **`BatchMode` double-parses the shared component list.** Even
   using `config_overrides: {"BatchMode": 1, "BatchFileName":
   "batch_SSP_REF.xml"}` against `configuration_ref.xml` directly
   (reusing the already-validated, already-patched file instead of
   touching `configuration_ssp.xml` at all), every shared input file
   got parsed twice -- once from `configuration_ref.xml`'s own inline
   `<ScenarioComponents>`, once again from the batch file's own `base`
   `FileSet` -- before `gcam.exe`'s solver even started. That OOM'd
   this sandbox's 8GB ceiling **at both `max-parallelism=2` and
   `max-parallelism=1`** -- confirming the problem is the double load
   itself, not solver-thread duplication (which is what
   `max-parallelism` actually controls). A trimmed batch file (one
   `ComponentSet`/`FileSet` combo, no runner-set) and the two missing
   `input/extra/*.xml` files (see below) didn't fix it -- still
   OOM'd, now also printing repeated `"Could not delete node ... as it
   does not exist"` warnings consistent with GCAM's own XML-merge
   logic doing redundant work on the overlapping file lists.

So BatchMode itself, reused against this already-patched config file,
is not viable on this sandbox tier. The fix: skip it entirely.

## The actual approach: flat, pre-merged, BatchMode=0 configs

Each `configuration_sspN.xml` is a complete, standalone copy of
`configuration_ref.xml`'s structure (same `Files`, `Strings`, `Bools`,
`Ints`, `Doubles` -- same `write-output="0"` and `max-parallelism="-1"`
fixes) with only `<ScenarioComponents>` different: the SSP base file
list plus that SSP's own overlay, both lifted from upstream's
`batch_SSP_REF.xml`, concatenated once by a script instead of merged
by GCAM's `BatchRunner` at run time. `BatchMode` stays `0`, same as
`Reference` -- there's no runtime batch merging at all, so there's
nothing to double-parse.

They don't reference each other, or `configuration_ref.xml`, in any
way -- GCAM's `Configuration` format has no include/inheritance
mechanism (the only cross-file reference it has at all is
`BatchFileName`, deliberately unused here). `run.py` doesn't change in
how it treats them either -- `main()` does a plain dict lookup
(`scenario` -> filename) and passes that path straight to `gcam.exe`
as a subprocess argument; it never parses config file contents.
`apply_config_overrides` is equally agnostic -- it patches whichever
file it's given, so every existing `config_overrides` key
(`max-parallelism`, `stop-period`, etc.) works identically against any
of the six scenarios, no per-scenario override logic needed.

**Cost of this design**: no shared inheritance means no automatic
sync. A future fix to `configuration_ref.xml` (another tuning change,
like the `max-parallelism` revert in v6) won't propagate to the SSP
files automatically -- each one is a frozen copy and has to be
re-patched by hand if it ever needs the same fix.

## A real bug found by live-testing, not assumed away

The first build used `configuration_ref.xml`'s own `ScenarioComponents`
list as the shared base for all 5 SSP files (reasoning: it's the
already-validated, already-patched list, so reusing it felt safer than
re-deriving a new one). Live-tested that build directly -- and SSP3
and SSP4 (the two SSPs whose overlay includes `pasture_ssp34.xml`)
failed immediately:

```
ERROR:The sum of land areas in region Africa_Eastern exceeds the land
allocation by 396.382 (6.81087%) in period 0
gcam.exe exited with code 255
```

Not a parsing problem, not memory (`oom_kills: 0`, anon well under the
8GB ceiling) -- a genuine land-accounting inconsistency. Diffing
`configuration_ref.xml`'s `ScenarioComponents` against
`batch_SSP_REF.xml`'s own `base` `FileSet` (the literal file list
upstream's own `BatchRunner` loads for **every** SSP run, not just the
ones that happened to break) found the root cause: upstream's SSP base
deliberately **omits** `protected_land2`/`protected_land3`
(`protected_land_input_2/3.xml`) -- those are Reference-only, never
part of the SSP base at all -- and **adds**
`bio_neg_emiss_budget` (`negative_emissions_budget.xml`), which
`configuration_ref.xml`'s own list doesn't have.
`socioeconomics`/`socioeconomics_income_elas` are also absent from the
batch base (every SSP overlay re-adds them itself).

Using `configuration_ref.xml`'s own base silently included
`protected_land2/3` for every SSP. That's compatible with SSP1/2/5's
land overlays (none of which touch pasture allocation) but conflicts
with SSP3/4's `pasture_ssp34.xml` reallocation -- the protected-land
fraction and the reallocated pasture land don't agree, and GCAM's own
consistency check catches it immediately at period 0.

**Fix**: rebuilt all 5 files using `batch_SSP_REF.xml`'s own `base`
`FileSet` verbatim as the `ScenarioComponents` base, instead of
`configuration_ref.xml`'s list -- matching exactly what upstream's own
`BatchRunner` would load for every SSP. Re-tested: all 5 passed a
short smoke test (`stop-period: 2`), then all 5 ran the full 21-period
horizon to completion (see Results below).

## A second real gap: `input/extra/`

SSP1's overlay references `../input/extra/renewable_shareweights_ssp1_32.xml`
-- a file that didn't exist anywhere in the image. Traced it: it's a
real, small (157KB) file checked into upstream `gcam-core`'s own git
repo (not generated by the `gcamdata` R pipeline), confirmed by adding
`input/extra` to a sparse checkout of upstream and finding it present.
The Dockerfile's `COPY runtime/input/...` list simply never included
that directory -- `configuration_ref.xml`'s own `Reference` scenario
never needed it, so the gap went unnoticed until an SSP1 test actually
exercised that file path.

Checked every other file path referenced across all 5 SSP overlays
(59 unique paths total) against a live sandbox before building
anything further: all 59 already existed except this one directory's
two files (`renewable_shareweights_ssp1_32.xml`,
`supply_demand_curves.xml`, ~160KB combined) -- added both to
`sandboxes/gcam/runtime/input/extra/` and a new `COPY` line in the
Dockerfile.

## `scenarioName` cosmetic fix

Each new file's `<Strings>` section also has `scenarioName` updated to
match (`"SSP1"` instead of the inherited `"Reference"`) -- this feeds
`append-scenario-name="1"` outputs (`xmlDebugFileName`,
`costCurvesOutputFileName`), which would otherwise be mislabeled.
`run.py`'s own output path (`hector-output`, `append-scenario-name="0"`)
is unaffected either way.

## Verified live, full end-to-end, not just smoke-tested

Given this needed to be production-ready, not just "parses and runs a
few periods": every SSP got a full real validation, same rigor as the
original Reference OOM fix (`oom-fix.md`).

1. **Path check** -- all 59 unique file paths referenced across the
   5 overlays checked for existence against a live sandbox before
   building anything, to catch missing-file gaps before burning a full
   run on them.
2. **Smoke test** (`stop-period: 2`, ~2-3 min each) -- caught the land-
   allocation bug above on the first attempt; passed cleanly on all 5
   after the base-list fix.
3. **Full 21-period run, in parallel, one isolated sandbox per SSP**
   (five concurrent sandboxes -- running them all in one sandbox was
   tried first and caused false OOMs from 5 concurrent `gcam.exe`
   processes competing for one 8GB cgroup, a test artifact, not a
   real production concern since every real run gets its own
   sandbox). All 5 completed with **exit 0, 0 `oom_kills`**, at the
   app's real default (`max-parallelism=2`). SSP4 ran the closest to
   the ceiling (`memory.peak` landed within 8KB of the 8GiB limit at
   one point) but never crossed it.
4. **Divergence sanity check** -- confirmed the overlays are actually
   changing model behavior, not just being silently ignored, by
   comparing each scenario's own year-2100 global mean surface
   temperature (`gmst`) from its real `hector-output` CSV:

   | Scenario | 2100 gmst (degC) |
   |---|---|
   | SSP1 | 2.715 |
   | SSP4 | 3.077 |
   | SSP2 | 3.081 |
   | SSP3 | 3.091 |
   | SSP5 | 3.491 |

   SSP1 (lowest-challenge pathway) lowest, SSP5 (fossil-fueled
   development) highest -- the physically expected ordering, and a
   much stronger confirmation than "exit code 0" alone that these are
   genuinely different model runs.
5. Re-verified the final file set (`run.py`, the 5 new config files,
   the 2 new `input/extra/` files) against a **fresh** sandbox created
   straight from the deployed `gcam-production-v7` snapshot (not just
   the build sandbox), then ran one more full real request through
   that snapshot (`{"scenario": "SSP2"}` plus the app's own
   `max-parallelism=2` default, exactly what a real dashboard request
   sends) before switching the `scenarios` list on in `models.ts`.

## Deploying this needed one more snapshot

Same lightweight process as v3-v6 (no `gcamdata`/`gcam.exe` rebuild):
overlay the new `run.py`, the 5 `configuration_sspN.xml` files, and
`input/extra/`'s 2 files onto a sandbox from `gcam-production-v6`,
verify, `createSnapshot("gcam-production-v7")`.

One more small fix landed right after: `run.py`'s own comments (module
docstring and the `SUPPORTED_SCENARIOS` comment) still said the SSP
base list came from `configuration_ref.xml`'s own `ScenarioComponents`
-- true of the *first* build, not the land-allocation-bug-fixed one
that actually got live-tested and shipped in v7. Corrected the prose to
say upstream's `batch_SSP_REF.xml` base `FileSet`, matching what v7
actually runs. No functional change (`SUPPORTED_SCENARIOS` itself,
every `configuration_sspN.xml`, and `gcam.exe` are all byte-identical
to v7, md5-verified) -- shipped as `gcam-production-v8` anyway, so the
deployed `run.py`'s own comments don't contradict this document.
Re-verified with one more live smoke test before switching
`daytona_snapshot` over.

`apps/web/lib/models.ts`'s `daytona_snapshot` for gcam updated to v8,
and `scenarios` extended to `["Reference", "SSP1", "SSP2", "SSP3",
"SSP4", "SSP5"]` -- that list is what drives the scenario dropdown in
`NewRunPanel.tsx` for every model, so no dashboard code changes were
needed. `gcam-production-v2` through `v7` are all left in place,
unused, as rollback options.

## Still not exposed

`configuration_policy.xml` (a specific forcing-policy variant) and
`configuration_usa.xml` (the GCAM-USA regional variant) remain
unvalidated and unexposed -- same reasoning as before: using them
without the same live-testing rigor risks a run that looks successful
but silently returns garbage.
