# Provenance: from upstream gcam-core source to the deployed image

This is the audit trail. Every other doc in this folder explains *why*
a particular decision was made; this one exists to answer a narrower
question precisely: **starting from a clean checkout of
`https://github.com/JGCRI/gcam-core`, what exact sequence of steps
produces what's running in `gcam-production-v8` today, and which of
those steps are reproducible from this repo's committed files alone
versus requiring a one-time external artifact or a live-sandbox patch
that was never captured as a Dockerfile `RUN` step?**

Read this top to bottom for the full chain. Each stage names the exact
file(s) involved and whether it's **(A) committed and deterministic**
(running it again today reproduces the same bytes), **(B) committed
recipe, external artifact** (the steps are committed, but the actual
output is a gitignored multi-GB file that must exist locally before
the next stage can run), or **(C) live-sandbox patch, not a Dockerfile
step** (what actually happened to get from one snapshot version to the
next was a direct patch to a running sandbox, not a `docker build` --
flagged explicitly because this is the main way the deployed artifact
can silently drift from what the committed files alone would produce).

## Stage 0 -- known non-determinism in the starting point

Both Dockerfiles that touch upstream source
(`sandboxes/gcam/Dockerfile`'s `builder` stage,
`sandboxes/gcam/gcamdata.Dockerfile`) do:

```
git clone --depth 1 https://github.com/JGCRI/gcam-core.git
```

**unpinned** -- no `git checkout <sha>` after the clone. This means
re-running either Dockerfile today pulls whatever upstream's `main`
branch currently is, not necessarily the same commit that originally
produced `gcam-production-v8`. This was a conscious, confirmed gap
(see `apps/web/lib/models.ts`'s `model_version` comment) -- the actual
version baked into every snapshot so far was verified directly by
running `./gcam.exe --version` against the live sandbox
(`"GCAM version 9.1 Revision: gcam-v9.1"`, confirmed 2026-11-18,
unchanged through v8), not by reading the Dockerfile. **If exact
reproducibility is ever required, pin both Dockerfiles' `git clone` to
a specific commit SHA before rebuilding** -- this hasn't been done yet.

## Stage 1 -- generate the XML input database (`gcamdata`)

**(B) committed recipe, external artifact.**

- Recipe: `sandboxes/gcam/gcamdata.Dockerfile`, built and run once
  inside a GPU-attached Daytona sandbox (GPU used only to unlock a
  memory ceiling above this account's plain 8GB cap -- no GPU compute
  involved; R's dplyr/tidyr joins are CPU-only).
- Two real upstream R bugs patched as part of that Dockerfile's own
  `RUN` steps (not external to it -- see `sandboxes/gcam/patches/README.md`
  for the full explanation of each, `sandboxes/gcam/patch_population_hist.py`
  for the exact byte-for-byte patch applied to
  `zsocio_L100.Population_hist.R`, and an inline `sed` in the
  Dockerfile itself for `zsocio_L100.Employment.R`):
  - `zsocio_L100.Employment.R`: `left_join_error_no_match()` ->
    `left_join()` + `filter(!is.na(iso))` (matches the pattern the next
    block in the same file already uses).
  - `zsocio_L100.Population_hist.R`: a `repeat_add_columns()` x2 chain
    that squared an already-correct grid into hundreds of millions of
    rows -> `tidyr::complete(iso, year)`.
- Command run inside that sandbox once the image was built:
  `devtools::load_all(); driver_drake(jobs=1,
  memory_strategy="autoclean", garbage_collection=TRUE,
  caching="worker")` -- took ~75 minutes, peaked at ~13.5GB.
- **Output** (~221 XML files, 5.2GB uncompressed): downloaded out of
  that sandbox and placed at
  `sandboxes/gcam/runtime/input/gcamdata/xml/` locally. **This
  directory is gitignored** -- too large for git, so the actual bytes
  are not in version control. Only the recipe to regenerate them is.
  Full step-by-step regeneration instructions:
  `sandboxes/gcam/runtime/README.md`'s "Regenerating `input/gcamdata/xml/`"
  section.
- Confirmed not scenario-specific (see `architecture.md`): every
  `configuration_*.xml`, including the 5 new SSP ones, reads from this
  exact same database -- this stage runs once, not per scenario.

**Audit note**: because this directory is gitignored, verifying "the
database currently baked into `gcam-production-v8` matches what this
recipe would produce today" requires actually re-running Stage 1 and
diffing -- there's no way to do it by inspecting git alone. The
Dockerfile's own unpinned clone (Stage 0) means even a careful re-run
isn't guaranteed to match without first pinning the commit.

## Stage 2 -- compile `gcam.exe`

**(A) committed and deterministic** (modulo Stage 0's unpinned clone).

- Recipe: `sandboxes/gcam/Dockerfile`'s `builder` stage.
- `git clone --depth 1` + `git submodule update --init --depth 1` for
  exactly two submodules (`cvs/objects/climate/source/hector`,
  `output/modelinterface/modelinterface`) -- NOT
  `--recursive`, because one submodule
  (`util/testing-framework`) points at an internal PNNL server
  unreachable from outside their network and isn't needed to build the
  executable itself.
- `make gcam -j4` inside `cvs/objects/build/linux`, with `JARS_LIB`
  pointed at the repo's own `exe/` directory (undocumented requirement,
  found by testing) and the usual boost/eigen/tbb/JDK env vars set.
- **Output**: `gcam.exe` (294MB) plus upstream's own default
  `exe/` directory (jars, default `configuration_*.xml`/`batch_*.xml`
  files, `log_conf.xml`) -- copied via `COPY --from=builder
  /app/gcam-core/exe /app/gcam-core/exe` into the final image stage.
  This is upstream's content, byte-for-byte, before any of this
  project's own patches are applied in Stage 3.
- `gcam.exe` itself is also gitignored locally
  (`sandboxes/gcam/runtime/README.md` keeps a copy for the Docker Hub
  backup build path, but it's not tracked in git) -- verify a rebuild
  produced an equivalent binary via `./gcam.exe --version`, not a byte
  diff (compiler/toolchain non-determinism is expected; behavior is
  what's actually verified, same way every snapshot bump already does).

## Stage 3 -- this project's own patches, layered on top

**(A) committed and deterministic** -- this is the part that's
entirely this project's own work, not upstream's, and it's the part
most likely to need auditing after the fact.

`sandboxes/gcam/Dockerfile`'s final stage does, in this exact order:

```dockerfile
COPY run.py .
COPY --from=builder /app/gcam-core/exe /app/gcam-core/exe   # Stage 2's output, untouched
COPY runtime/exe/ /app/gcam-core/exe/                       # <-- overlays/patches Stage 2's own configs
COPY runtime/input/gcamdata/xml /app/gcam-core/input/gcamdata/xml   # Stage 1's output
COPY runtime/input/solution /app/gcam-core/input/solution
COPY runtime/input/policy /app/gcam-core/input/policy
COPY runtime/input/climate /app/gcam-core/input/climate
COPY runtime/input/extra /app/gcam-core/input/extra         # added in v7, see below
```

Every file inside `sandboxes/gcam/runtime/exe/` and
`sandboxes/gcam/runtime/input/{solution,policy,climate,extra}/` **is
committed to git** (unlike Stage 1's `gcamdata/xml/`) -- this is the
one part of the whole pipeline where "clone this repo and look" is
sufficient, no external artifact needed. The table below is the
complete list of what's different from upstream, and why.

### File-by-file provenance

| File | Origin | What changed, and why |
|---|---|---|
| `runtime/exe/configuration_ref.xml` | Upstream, patched | `xmldb-location`'s `write-output` `"1"` -> `"0"` (GCAM's BaseX output needs jars this image doesn't ship -- JVM segfault otherwise; see `known-gaps.md`). `max-parallelism`: `-1` -> `1` (v3, OOM fix) -> back to `-1` (v6, once the app-level default made the image-level override redundant; see `config-overrides.md`). |
| `runtime/exe/configuration_ssp1.xml` through `configuration_ssp5.xml` | **New, authored by this project** (v7) | Not from upstream at all as standalone files -- each is `configuration_ref.xml`'s own `Files`/`Strings`/`Bools`/`Ints`/`Doubles` sections (same patches as above) plus a `ScenarioComponents` list built by concatenating upstream `batch_SSP_REF.xml`'s own `base` `FileSet` with that SSP's own overlay `FileSet`, pre-merged once instead of using `BatchMode` at run time. See `ssp-scenarios.md` for the exact bug found (an earlier version used `configuration_ref.xml`'s own component list instead of the batch file's base, which silently differs) and the live-tested fix. The source batch files these were derived from (`batch_SSP_REF.xml`, `batch_SSP_SPA{1,23,4,5}.xml`) are themselves unmodified upstream files, still present in the image for reference but not used by `run.py`. |
| `runtime/exe/configuration_ssp.xml`, `configuration_policy.xml`, `configuration_usa.xml`, `batch_SSP_*.xml`, `log_conf.xml`, `XMLDBDriver.jar`/`.properties` | Upstream, **unmodified** | Shipped as-is for completeness/reference. Not individually run-tested or exposed through `run.py` -- see `known-gaps.md`. |
| `runtime/input/solution/*`, `runtime/input/policy/*`, `runtime/input/climate/*` | Upstream, unmodified | Small supporting config dirs `configuration_ref.xml` (and now the SSP configs) reference -- solver config, policy-target files, Hector's own ini. |
| `runtime/input/extra/renewable_shareweights_ssp1_32.xml`, `supply_demand_curves.xml` | Upstream, unmodified, but **newly added to this image in v7** | Real upstream files (checked into `gcam-core`'s own repo, not generated by `gcamdata`) that SSP1's overlay references. Missing from every version through v6 because `configuration_ref.xml`'s `Reference` scenario never needed them -- confirmed missing by checking all 59 unique file paths the 5 SSP overlays reference against a live v6 sandbox before adding anything. |
| `runtime/input/gcamdata/xml/*` | Stage 1's output | Gitignored, see Stage 1 above. |
| `run.py` | **New, authored by this project** | Not an upstream file at all -- this project's fixed entrypoint convention (reads `SCENARIO_PARAMS`, shells out to `gcam.exe`, parses its Hector-output CSV, reports progress, applies `config_overrides`). See its own module docstring for the full behavior writeup. |

## Stage 4 -- the running Daytona snapshot

**This is the stage where (C) live-sandbox patches, not Dockerfile
rebuilds, start to matter.**

`gcam-production-v1`/`v2` were built by actually running
`sandboxes/gcam/Dockerfile` (via `Image.fromDockerfile`) against a
populated `runtime/` directory, the normal way. **Every version since
(`v3` through the current `v8`) was built differently**: create a
sandbox *from the previous snapshot*, upload just the specific
changed file(s) directly into the running sandbox's filesystem
(`sandbox.fs.uploadFile`), verify live, then
`sandbox.createSnapshot("gcam-production-vN")`. This is a deliberate,
repeatedly-used shortcut (see `oom-fix.md`'s "Deploying the fix"
section for the original reasoning) -- it avoids re-running Stage 1/2
(the gcamdata pipeline and C++ compile, both expensive) for a change
that only touches a handful of small files, but it also means **the
Dockerfile text alone no longer fully describes what's running** --
the true history is the chain of live patches below, each of which
IS fully captured by what's committed in `runtime/` (so re-running the
Dockerfile fresh against today's `runtime/` directory *should*
produce an equivalent result to `v8`), but the two paths (fresh build
vs. incremental live patches) have never been diffed against each
other to confirm byte-for-byte equivalence.

| Version | What changed from the previous one | Source doc |
|---|---|---|
| v1 | First working build (not production-named `gcam-production-v1` until later) | `setup-guide.md`, `trial-log.md` |
| v2 | First build actually promoted to `gcam-production-*` naming | `trial-log.md` |
| v3 | `configuration_ref.xml`: `max-parallelism` `-1` -> `1` (serialize the solver -- fixes an intermittent OOM at the final periods) | `oom-fix.md` |
| v4 | `run.py`: stopped parsing GCAM's CSV output with a buggy `csv.DictReader` (Hector's leading comment line was misread as the header) -- a fix that existed in the repo but had never actually been deployed to a snapshot until this version | `oom-fix.md` |
| v5 | `run.py`: added `apply_config_overrides` -- the general `config_overrides` mechanism (override any existing `<Value name="X">` in any section, no snapshot rebuild needed per knob) | `config-overrides.md` |
| v6 | `configuration_ref.xml`: `max-parallelism` `1` -> `-1` (back to upstream's own default -- redundant once the app-level default covered every real request; keeps the image itself general-purpose) | `config-overrides.md` |
| v7 | Added `configuration_ssp1.xml` through `configuration_ssp5.xml`, `input/extra/`'s 2 files, and the matching Dockerfile `COPY` line; `run.py`: `SUPPORTED_SCENARIOS` extended | `ssp-scenarios.md` |
| v8 | `run.py`: comment-only correction (no functional change, md5-verified against v7) | `ssp-scenarios.md` |

`gcam-production-v1` through `v7` are all left in place, unused, as
rollback options -- same policy at every version bump.

## How to audit or reproduce this from scratch

1. **Verify Stage 3's claims directly**: every file this project
   patched or added is committed and small -- `git log -p` on
   `sandboxes/gcam/runtime/exe/configuration_ref.xml`,
   `sandboxes/gcam/run.py`, and the 5 `configuration_sspN.xml` files
   gives the exact diff history. This is the fastest, most reliable
   audit path and needs no sandbox at all.
2. **Verify the live snapshot matches the committed files**: create a
   sandbox from `gcam-production-v8`, `md5sum` every file under
   `/app/gcam-core/exe/*.xml` and `/app/run.py`, and diff against the
   local `sandboxes/gcam/runtime/exe/` + `run.py` -- this is exactly
   the check done after every version bump so far (see each stage's
   source doc for the specific hashes recorded at the time).
3. **Reproduce Stage 1 (the XML database)**: follow
   `runtime/README.md`'s regeneration steps. Needs a GPU-attached
   sandbox; ~75 minutes; compare file count/sizes against the existing
   ~221 files, 5.2GB as a sanity check, not a byte-for-byte diff (R's
   own output isn't guaranteed byte-stable run to run even with
   identical input).
4. **Reproduce Stage 2 (the compile)**: follow the `builder` stage in
   `sandboxes/gcam/Dockerfile` directly, or build the whole Dockerfile
   with a populated `runtime/` directory from step 3. Verify via
   `./gcam.exe --version` and a real end-to-end run, not a binary diff
   (compiler output isn't guaranteed byte-stable either).
5. **If exact byte-for-byte reproducibility is ever required** (not
   just "behaves the same"): pin both Dockerfiles' `git clone` calls to
   the specific upstream commit first (Stage 0's gap) -- this has never
   been done, so right now "rebuild the Dockerfile" and "what's
   actually running in v8" are only known to match in *behavior*
   (confirmed live, repeatedly, via the version string and real
   21-period runs), not confirmed to match in exact source commit.
