# Trial log

The messy real history: every attempt, what blocked it, what fixed it,
and the resource/time cost of each. This is the source-of-truth detail
behind `setup-guide.md`'s clean version. Condensed from
`docs/sandbox-resource-experiments.md`'s GCAM section, which has the full
blow-by-blow if something here is too terse.

## Blockers/restrictions discovered (account-level, not GCAM-specific)

- Plain CPU sandboxes hard-cap at **4 vCPU / 8GB memory** on this
  account. Confirmed by direct testing: `memory` requests of 9 through
  32GB and `cpu: 16` were all rejected outright by the API
  (`DaytonaValidationError`). This account only has `container` and
  `windows` sandbox classes available -- no higher-tier `linux-vm` class.
- Swap is disabled at the cgroup level (`/sys/fs/cgroup/memory.swap.max =
  0`) -- not a usable workaround.
- The only lever that unlocks more memory: attaching a GPU
  (`resources.gpu: 1`) removes the 8GB ceiling entirely (tested up to
  96GB accepted), with no corresponding CPU ceiling increase. GPU
  sandboxes must be ephemeral (`autoDeleteInterval: 0` mandatory).
- Daytona's own internal container registry
  (`cr.app.daytona.io/sbox/...`) backing snapshots is not externally
  pullable (confirmed via both `Image.base(ref)` and direct `skopeo
  inspect`, both 401 Unauthorized) -- ruled out "clone an existing
  snapshot's image layer directly" as an approach.
- Snapshots carry a fixed resource profile baked in at creation time --
  cannot override `resources` when creating a sandbox from a named
  snapshot.

## What didn't work

| Attempt | Result | Cost/time spent |
|---|---|---|
| `git clone --recursive` (all GCAM submodules) | Hangs forever -- `util/testing-framework` submodule points at an internal PNNL server (`stash.pnnl.gov`) unreachable externally. Not actually needed to build `gcam.exe` (Makefile never touches it). | Discovered fast, no real cost -- fixed by only initializing the 2 submodules actually needed (`hector`, `modelinterface`). |
| Default 3GB sandbox disk for the C++ build | Fills to 79%, fails at the final `ar ru libgcam.a` step with "No space left on device" -- one step from success. | ~9 min wasted per attempt until fixed with `disk: 4`. |
| Plain `driver()` (gcamdata, non-drake variant) | OOM-killed (exit 137) partway through `Population_hist`, reproduced twice. Keeps all 2087 chunks' output resident in memory simultaneously -- memory exceeds 8GB on its own by that point in the pipeline, independent of input data size. | Each attempt: ~tens of minutes before the OOM hit, on an 8GB plain CPU sandbox. |
| `driver_drake()` without `jobs=1`/`autoclean` | Not separately isolated, but drake's default parallelism was understood early to make memory worse (multiple chunks' output held at once) -- never run this way on purpose. | N/A -- avoided based on reasoning, not an isolated failed trial. |
| `driver_drake(jobs=1, memory_strategy="autoclean")` on plain 8GB CPU sandbox | Real improvement over plain `driver()` -- got to 127 of 221 XML files (vs. 0 before) -- but still OOM-killed, this time on `module_emissions_L112.ceds_ghg_en_R_S_T_Y`. A genuine, intentional cross-join (gas species x 53 CEDS years x 32 GCAM regions), not a bug -- deliberately left unpatched. | ~tens of minutes per attempt, 8GB/4CPU plain sandbox, $0 incremental beyond normal sandbox billing. |
| Adding a swapfile inside the sandbox | Blocked -- `/sys/fs/cgroup/memory.swap.max = 0`, disabled at the platform level. | Discovered fast, no real cost. |
| Compiling `gcam.exe` locally (for the Docker Hub backup image) | `cc1plus` OOM-killed compiling one specific file (`calc_base_price.o`) identically at `-j4` and `-j1` -- this machine's own 3GB cgroup limit, a genuine per-file memory requirement exceeding 3GB (not a parallelism issue). | Abandoned; reused the already-compiled, already-validated binary instead. |
| `daytona.objectStorageApi.getPushAccess()` as general storage | Returns Daytona's own internal S3 creds for their build-context bucket, not usable as general object storage. | Dead end, no cost -- used git + local Docker build context instead. |
| `git sparse-checkout add` for deep nested paths (`cvs/objects/build/linux`) | Didn't reliably materialize the directory (49 .cpp files, mostly empty, vs. the needed 306). | Fixed with `git sparse-checkout set` using the full combined path list instead. |

## What worked

| Step | Fix | Resource cost | Time |
|---|---|---|---|
| `JARS_LIB` undocumented Makefile env var | Set to the repo's own `exe/` dir (already has GCAM's bundled jars). | -- | -- |
| C++ build disk sizing | `disk: 4` (not an arbitrary larger value -- confirmed sufficient with ~500MB to spare). | cpu:4, disk:4 | ~9 min cold build |
| R 4.2.2 too old | Installed R 4.4.3 via [`rig`](https://github.com/r-lib/rig)'s GitHub release tarball (CRAN's documented apt-repo key URL 404s). | -- | few min |
| `renv::restore()` missing system libs | Installed `libharfbuzz-dev`, `libfribidi-dev`, `curl` (binary). | -- | ~400s, 118 packages |
| Missing `java` for gcamdata's XML-conversion step | `apt-get install default-jdk-headless`. | -- | -- |
| `Employment` chunk real upstream bug | `left_join_error_no_match()` -> tolerant `left_join()` + `filter(!is.na(iso))`, matching the pattern already used later in the same file. | -- | -- |
| `Population_hist` real upstream bug | Two chained `repeat_add_columns()` calls squaring row count into the hundreds of millions -> replaced with `tidyr::complete(iso, year)`. | -- | -- |
| **The 8GB memory wall itself** | GPU-attached sandbox purely for the higher memory ceiling (no GPU compute used). | `cpu:4, memory:24, gpu:1 (L40S)` | **~75 min**, peak memory ~13.5GB |
| `gcam.exe`'s BaseX JVM segfault | Disabled that one output stream: `configuration_ref.xml`'s `xmldb-location` `write-output` `"1"` -> `"0"`. Restart file + CSV outputs unaffected. | -- | -- |
| Missing `input/solution`/`policy`/`climate` dirs at runtime | Added to the sparse-checkout / COPY list. | -- | -- |
| **Full validated run** | `./gcam.exe -C configuration_ref.xml` -- all 21 periods (1975-2100), "All model periods solved correctly.", exit 0. | cpu:4 (same GPU sandbox, memory incidental here) | **~31 min** |
| Persisting the result | `sandbox.createSnapshot()` -> `gcam-production-v1`, built from `sandboxes/gcam/Dockerfile` with plain `cpu:4, memory:8, disk:12`, **no GPU**. | cpu:4, memory:8, disk:12 | -- |
| Production-tier verification | Fresh sandbox from `gcam-production-v1` (no GPU), confirmed `/sys/fs/cgroup/memory.max = 8589934592` (8GB, not 24GB), matched the GPU run's iteration counts through period 6 before cleanup. **Not independently confirmed to full completion on this specific sandbox** -- see `known-gaps.md`. | cpu:4, memory:8, disk:12 | ~4 min observed |
| Public backup | `possibleplanets/gcam:v1`/`:latest` pushed to Docker Hub, built locally with the already-validated binary (no recompile, due to the local 3GB limit above). | -- | -- |

## Resource/time cost summary, and what to expect on a repeat

| Phase | Resources | Time | Approx. $ cost (Daytona) |
|---|---|---|---|
| Compile `gcam.exe` | cpu:4, disk:4 | ~9 min | ~$0.03 (cpu only, negligible disk) |
| `gcamdata` full pipeline (one-time) | cpu:4, memory:24, gpu:1 L40S | ~75 min | ~$3.0 (GPU attach dominates: ~1.25hr x $1.99/hr + cpu/mem) |
| Full `gcam.exe` scenario run | cpu:4, memory:8-24 (8 is enough) | ~30-31 min | ~$0.22 at plain cpu:4/mem:8/disk:12 |

If the `gcamdata` step needed to be run again from scratch (upstream
data change, cache lost), expect the same ~75 minutes and ~$3 -- nothing
found during this investigation would make a repeat run meaningfully
faster or cheaper; the GPU attach is specifically there to buy memory
headroom, not speed, and the pipeline's own runtime is dominated by
`drake`'s sequential, autoclean-forced chunk processing (a deliberate
trade of speed for staying under any memory ceiling at all).
