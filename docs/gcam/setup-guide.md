# Setup guide

The clean, prescriptive path for a person setting GCAM up for the first
time, or regenerating its data from scratch. Read `prerequisites.md`
first. If you just want to *use* the already-working result, skip this
entirely and read `artifacts.md` instead -- none of this needs to happen
again for that.

Total realistic time for a newcomer doing every step below: **roughly
1.5-2 hours** of actual waiting (dominated by the `gcamdata` pipeline's
~75 minutes), plus whatever time it takes to read/understand each step
the first time through. None of it requires active attention the whole
time -- it's mostly "kick off a long-running command, check back."

## Step 1: compile and sanity-check `gcam.exe` (no data yet)

This confirms your toolchain works before worrying about data generation.

- Build `sandboxes/gcam/Dockerfile`'s `builder` stage in a plain CPU
  sandbox (`cpu: 4, disk: 4` minimum -- the default 3GB disk is NOT
  enough, confirmed by testing: it fills to ~88% and fails on the final
  archive step).
- Expect ~9 minutes to a working 294MB `gcam.exe` binary.
- It won't run yet (no input database) -- that's expected, not a bug.

## Step 2: generate the input database (`gcamdata`)

This is the expensive, one-time step. **Needs a GPU-attached sandbox**,
purely to unlock a memory ceiling above 8GB (see `prerequisites.md` for
why).

1. Build `sandboxes/gcam/gcamdata.Dockerfile` into a sandbox with:
   ```js
   resources: { cpu: 4, memory: 24, gpu: 1, gpuType: GpuType.L40S }
   autoDeleteInterval: 0   // mandatory for GPU sandboxes
   ```
2. Inside it, run:
   ```r
   devtools::load_all()
   driver_drake(jobs=1, memory_strategy="autoclean",
                garbage_collection=TRUE, caching="worker")
   ```
   `jobs=1` + `autoclean` is load-bearing -- default drake parallelism
   keeps multiple chunks' output resident in memory at once, which is
   strictly worse for this memory-bound pipeline.
3. Wait. **~75 minutes** end to end. Peak memory observed: ~13.5GB (well
   under the 24GB allotted).
4. `tar -czf` the resulting `input/gcamdata/xml/` directory (5.2GB ->
   ~430MB compressed) and download it.
5. **Delete the GPU sandbox immediately** once the data is downloaded --
   it bills at a much higher rate than this project's normal CPU
   sandboxes and has no further use.

If this step gets OOM-killed partway through, see `trial-log.md` --
there's a real on-disk resume mechanism (`driver_drake()`'s `.drake/`
cache) rather than needing to restart from zero.

## Step 3: validate `gcam.exe` against the fresh database

While the GPU sandbox from step 2 is still up (it already has the
toolchain), also compile `gcam.exe` there and actually run it:

```
./gcam.exe -C configuration_ref.xml
```

Expect to hit (and need to fix, or confirm already-fixed) the same two
gotchas found during this project's own first run:
- A JVM segfault writing GCAM's own BaseX-backed XML output database
  (missing jars this project doesn't ship) -- worked around by setting
  `configuration_ref.xml`'s `xmldb-location` `write-output` attribute to
  `"0"`. The restart file and CSV outputs still write fine without it.
- Missing `input/solution/`, `input/policy/`, `input/climate/`
  directories that the config references.

A successful run prints `"All model periods solved correctly."` /
`"Model exiting successfully."` and exits 0, having run all 21 periods
(1975-2100). Expect **~30 minutes** for this.

## Step 4: package the result

1. Commit the small supporting files into
   `sandboxes/gcam/runtime/` (`exe/` configs, `input/{solution,policy,
   climate}/`) -- these are small (~1.6MB total) and go straight into
   git.
2. Extract the downloaded XML tarball into
   `sandboxes/gcam/runtime/input/gcamdata/xml/` -- this is gitignored
   (too large for git), build-time only.
3. Build `sandboxes/gcam/Dockerfile` (the real runtime image, not
   `gcamdata.Dockerfile`) into a **plain CPU sandbox** (`cpu: 4, memory:
   8, disk: 12` -- no GPU needed here at all).
4. `sandbox.createSnapshot(name)` to persist it as a reusable Daytona
   snapshot.
5. Optionally also push a Docker Hub backup -- see `artifacts.md` for
   why and how.

## Step 5: wire into the app

Done -- `apps/web/lib/models.ts` registers `gcam`, and
`sandboxes/gcam/run.py` is the real entrypoint (reads `SCENARIO_PARAMS`,
shells out to `gcam.exe -C configuration_ref.xml`, parses its output,
reports progress). Only the `"Reference"` scenario is exposed so far --
see `known-gaps.md` for what it would take to add real SSP scenario
selection on top of this.
