# Building this from scratch

The other docs in this folder explain *why* each decision was made, in
the order it was actually discovered. This one is different on
purpose: it's the plain recipe you'd follow **today**, starting from
nothing but a clean checkout of upstream `gcam-core`, to end up with
the exact same `gcam-production-v8` snapshot this project runs --
Reference plus SSP1-5, all the fixes already applied, no detours. If
you just want to confirm the committed files match what's deployed,
skip to "Checking your work" at the end.

## 1. Compile `gcam.exe`

```
git clone --depth 1 https://github.com/JGCRI/gcam-core.git
cd gcam-core
git submodule update --init --depth 1 \
  cvs/objects/climate/source/hector \
  output/modelinterface/modelinterface
```

Don't use `--recursive` -- one submodule (`util/testing-framework`)
points at an internal PNNL server you can't reach, and it isn't needed
to build the executable.

Install `build-essential libboost-dev libeigen3-dev libtbb-dev
default-jdk`, set `JARS_LIB` to this checkout's own `exe/` directory
(undocumented upstream, but required), then:

```
cd cvs/objects/build/linux && make gcam -j4
```

~9 minutes on 4 cores. You now have a working `gcam.exe` (294MB) --
it won't run yet, there's no input data.

Full command list: `sandboxes/gcam/Dockerfile`'s `builder` stage.

## 2. Generate the input database

This is the one genuinely expensive step (~75 minutes), and the only
one that needs a GPU-attached sandbox -- not for GPU compute, just to
get a memory ceiling above 8GB (R's own joins are CPU-only).

1. Patch two real upstream bugs in `gcam-core/input/gcamdata/R/` before
   running anything:
   - `zsocio_L100.Employment.R`: change
     `left_join_error_no_match(ILO_country_iso_mapping, by = "country")`
     to `left_join(ILO_country_iso_mapping, by = "country") %>%
     filter(!is.na(iso))`.
   - `zsocio_L100.Population_hist.R`: replace the block that chains two
     `repeat_add_columns()` calls onto `L100.Pop_thous_ctry_Yh` with
     `tidyr::complete(iso, year)`.
   (Exact patch commands: `sandboxes/gcam/gcamdata.Dockerfile`. Why
   each is needed: `sandboxes/gcam/patches/README.md`.)
2. In a sandbox with `memory: 24, gpu: 1`, run:
   ```r
   devtools::load_all()
   driver_drake(jobs=1, memory_strategy="autoclean",
                garbage_collection=TRUE, caching="worker")
   ```
   `jobs=1` + `autoclean` matters -- default parallelism keeps multiple
   chunks resident in memory at once, which this pipeline can't afford.
3. Output: ~221 XML files, 5.2GB, under `input/gcamdata/xml/`. Download
   it, then delete the GPU sandbox -- it has no further use and costs
   more than a plain one.

This step is scenario-independent -- the same database serves
Reference and every SSP. It only needs to run again if upstream's raw
data changes or a new pipeline bug needs patching.

## 3. Fix two things in `configuration_ref.xml`, then build five more

Before packaging, upstream's `configuration_ref.xml` needs two values
changed:

```diff
-<Value write-output="1" append-scenario-name="0" name="xmldb-location">...</Value>
+<Value write-output="0" append-scenario-name="0" name="xmldb-location">...</Value>
```
GCAM's BaseX XML-output writer needs jars this project doesn't ship --
without this, writing it causes a JVM segfault. The restart file and
CSV output still write fine without it.

`max-parallelism` stays at upstream's own default, `-1` -- don't
change it. (A per-sandbox-tier override used to live here; it's
unnecessary now, see `config-overrides.md` if curious why.)

That's the only edit `configuration_ref.xml` itself needs. Now build
five more scenario files, one per SSP, **each a full standalone copy**
of `configuration_ref.xml`'s `Files`/`Strings`/`Bools`/`Ints`/`Doubles`
sections (same two fixes) with only `ScenarioComponents` different:

1. Start from upstream's own `batch_SSP_REF.xml` -- NOT
   `configuration_ref.xml`'s `ScenarioComponents` list. This matters:
   the two lists differ (upstream's batch base omits two
   Reference-only files, `protected_land_input_2/3.xml`, and includes
   one Reference doesn't, `negative_emissions_budget.xml`). Using
   `configuration_ref.xml`'s own list instead will build and run fine
   for SSP1/2/5, then fail SSP3/4 immediately with a land-allocation
   error, because those two use a pasture-reallocation file
   (`pasture_ssp34.xml`) that's incompatible with the protected-land
   files. Use `batch_SSP_REF.xml`'s `<FileSet name="GCAM_">` block
   (its `base` `ComponentSet`) as the shared list for all five.
2. For each SSP, append that SSP's own `<FileSet name="SSP{N}">` block
   from the same `batch_SSP_REF.xml` (under its `"SSP Harmonized"`
   `ComponentSet`) after the base list.
3. Set `<Value name="scenarioName">` to `"SSP{N}"` (cosmetic, but it
   feeds a couple of output filenames).
4. Leave `BatchMode` at `0`. Don't try to set it to `1` and point
   `BatchFileName` at `batch_SSP_REF.xml`/`batch_SSP_SPA*.xml` to get
   GCAM to do this merge itself at run time -- that's the obvious
   shortcut, and it doesn't work here: every real `batch_SSP_SPA*.xml`
   bundles 5 policy-target reruns per SSP, and even the one that
   doesn't (`batch_SSP_REF.xml` itself) still double-parses the shared
   component list under `BatchMode`, OOMing this sandbox tier even
   with the solver serialized. Building the five flat files by hand,
   once, is the actual fix.
5. Copy two small files upstream ships but this image doesn't yet --
   `input/extra/renewable_shareweights_ssp1_32.xml` and
   `supply_demand_curves.xml` (~160KB total, needed by SSP1's overlay)
   -- into `input/extra/`.

Validate each of the six configs (Reference + 5 SSPs) the same way:
a short run (`stop-period: 2`) first to catch anything obviously
broken, then a full 21-period run watching
`/sys/fs/cgroup/memory.{current,peak,events}` for `oom_kill` -- this
sandbox tier is genuinely tight (8GB), and a config that "looks right"
can still fail in ways that only show up over the full run.

## 4. Package it

```
COPY run.py .
COPY --from=builder /app/gcam-core/exe /app/gcam-core/exe
COPY runtime/exe/ /app/gcam-core/exe/           # the 6 fixed/new config files overlay the builder's defaults
COPY runtime/input/gcamdata/xml /app/gcam-core/input/gcamdata/xml
COPY runtime/input/solution /app/gcam-core/input/solution
COPY runtime/input/policy /app/gcam-core/input/policy
COPY runtime/input/climate /app/gcam-core/input/climate
COPY runtime/input/extra /app/gcam-core/input/extra
```

`run.py` needs one thing beyond the usual params-in/result-out
contract every model here follows: a `scenario` name mapped to a
config filename:

```python
SUPPORTED_SCENARIOS = {
    "Reference": "configuration_ref.xml",
    "SSP1": "configuration_ssp1.xml",
    "SSP2": "configuration_ssp2.xml",
    "SSP3": "configuration_ssp3.xml",
    "SSP4": "configuration_ssp4.xml",
    "SSP5": "configuration_ssp5.xml",
}
```

Build `sandboxes/gcam/Dockerfile` (the real runtime image, not
`gcamdata.Dockerfile`) in a plain CPU sandbox (`cpu: 4, memory: 8,
disk: 12` -- no GPU here, this stage is pure CPU). `createSnapshot()`
to persist it.

## 5. Register it in the app

`apps/web/lib/models.ts`'s gcam entry needs:
- `daytona_snapshot` pointed at the new snapshot's name.
- `scenarios: ["Reference", "SSP1", "SSP2", "SSP3", "SSP4", "SSP5"]` --
  this one array is what drives the scenario dropdown for every model,
  so nothing else in the dashboard needs to change.
- `supportsConfigOverrides: true` and `defaultConfigOverrides:
  {"max-parallelism": 2}` if you want the app (not the image) to
  default to 2 cores per run -- optional, see `config-overrides.md`
  for why this lives at the app layer instead of baked into the image.

That's the whole thing, start to finish.

## File-by-file: what's upstream vs. what this project changed

| File | Upstream, unmodified | This project's change |
|---|---|---|
| `gcam.exe` | -- | Compiled as-is, no source changes |
| `input/gcamdata/xml/*` | -- | Generated as-is (just the 2 R pipeline bug fixes above) |
| `exe/configuration_ref.xml` | | `write-output` 0, otherwise untouched |
| `exe/configuration_ssp{1-5}.xml` | | New files, built from `batch_SSP_REF.xml`'s base + per-SSP overlay (step 3) |
| `exe/configuration_ssp.xml`, `configuration_policy.xml`, `configuration_usa.xml`, `batch_*.xml`, `log_conf.xml`, `XMLDBDriver.*` | yes | Shipped for reference, not used by `run.py` |
| `input/solution/*`, `input/policy/*`, `input/climate/*` | yes | -- |
| `input/extra/*` | yes | Just newly copied in (step 3.5) -- content itself is unmodified upstream |
| `run.py` | -- | New file, this project's entrypoint |

## Checking your work

- `./gcam.exe --version` should print `GCAM version 9.1 Revision:
  gcam-v9.1` -- if it doesn't, upstream's `main` has moved since this
  was last built (the `git clone` above isn't pinned to a commit; pin
  it if you need byte-for-byte reproducibility, not just the same
  behavior).
- Each of the 6 scenarios should run all 21 periods, exit 0, 0
  `oom_kills`.
- Pick two SSPs and confirm their outputs actually differ (e.g. year-
  2100 `gmst` from the Hector CSV) -- a scenario that "runs successfully"
  but produces output identical to Reference means the config
  override silently didn't do anything, which is a real failure mode
  worth checking for, not a hypothetical one.
