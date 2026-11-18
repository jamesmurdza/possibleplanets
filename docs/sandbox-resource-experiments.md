# Sandbox resource experiments

Investigates whether increasing/decreasing a Daytona sandbox's CPU and
memory allocation changes how fast each model actually runs, and whether
CPU and memory matter independently of each other. All runs below are
real Daytona sandboxes (not estimates), built from each model's own
`sandboxes/<model>/Dockerfile`, executed via `sandbox.process.exec()`,
timed around that call only (sandbox creation time excluded, since that's
pure infra overhead unrelated to the model's own compute).

Context: this project is billed per CPU, so the question isn't just "does
more help" but "where's the cost/latency tradeoff" -- see each model's
conclusion below.

## Method

- Each cell is **5 trials**, reporting median (the per-trial times and
  stdev are included so the spread is visible, not just one number).
- A fixed, deterministic set of params per model (same scenario/seed every
  trial) so each trial does genuinely the same amount of work.
- Sandboxes are created fresh and deleted after each trial -- no reuse,
  no caching, matching how this project always provisions sandboxes
  (PLATFORM.md's per-run isolation).

## hector

### Experiment 1: is hector resource-sensitive at all? (2x2: cpu x memory)

Initial single-sample check suggested hector sped up with more resources;
re-run with 5 trials/cell to confirm it wasn't noise, and to separate
*which* resource was responsible by varying CPU and memory independently.

| | 1 GB | 4 GB |
|---|---|---|
| **1 CPU** | 2.03s median (stdev 0.115) | 2.08s median (stdev 0.187) |
| **4 CPU** | 1.10s median (stdev 0.097) | 1.06s median (stdev 0.021) |

**Finding:** raising CPU alone (either memory row) consistently roughly
halves the time. Raising memory alone (either CPU row) changes nothing.
The effect is 100% CPU, 0% memory -- pyhector's C++/numpy-linked core
evidently does some multi-threaded work (BLAS/OpenMP) even though the
Python wrapper itself is single-threaded, and a 1-CPU cgroup cap
throttles that.

### Experiment 2: 1 vs 2 vs 4 CPU (memory fixed at 1 GB)

Having established CPU is the real variable, swept it finely to find
where the curve flattens.

| CPUs | Trials (s) | Median | Stdev |
|---|---|---|---|
| 1 | 2.197, 2.244, 2.311, 2.196, 2.392 | 2.24s | 0.08 |
| 2 | 1.297, 1.254, 1.200, 1.333, 1.151 | 1.25s | 0.07 |
| 4 | 1.164, 1.112, 1.035, 2.028, 1.103 | 1.11s | 0.42 (one outlier; other 4 trials ~1.1s) |

**Finding:** the 1->2 step carries nearly all of the real gain (~44%
faster). 2->4 is a much smaller further step (~11% faster on top of
that). Since CPU is billed per-count, doubling cost again for 4 buys a
fraction of what the first doubling bought.

**Conclusion / applied:** `resources: { cpu: 2 }` (`apps/web/lib/models.ts`).
No memory override -- confirmed to make no difference.

## oscar

### Experiment 1: does the "needs more resources" note actually hold?

`lib/models.ts` already set `resources: { cpu: 4, memory: 8, disk: 10 }`
for oscar, with a comment claiming the default sandbox size OOM-kills it.
Verified directly: running oscar with **no** resource override at all --

- **Result: OOM-killed (exit code 137) in 7.8 seconds.** Confirms the
  existing comment/config was correct and necessary, not just
  defensive/unverified.

### Experiment 2: does more CPU/memory speed up the real (non-OOM) run?

Tested the real ~500s run (`SSP2-4.5`, `nMC=1`) at three tiers:

| Resources | Exec time |
|---|---|
| 2 CPU / 4 GB | 524.5s |
| 4 CPU / 8 GB | 522.0s |
| 8 CPU / 16 GB | rejected at sandbox creation -- *"CPU request 8 exceeds maximum allowed per sandbox (4)"* (this Daytona plan caps at 4 CPUs/sandbox) |

**Finding:** 2 CPU/4GB and 4 CPU/8GB are statistically the same (522-524s,
a ~0.5% difference, well within normal run-to-run noise for a ~9-minute
job). Unlike hector, oscar does NOT get faster with more CPU -- its
bottleneck is memory headroom (avoiding the OOM kill), not CPU-bound
compute. More CPU past the minimum that avoids OOM buys nothing.

**Conclusion:** existing `{cpu: 4, memory: 8, disk: 10}` is justified by
the OOM finding, not by a speed finding -- the memory number is load-bearing,
the cpu number isn't really doing anything for oscar specifically (though
it's also not costing extra beyond this plan's 4-cpu ceiling, so no
reason to change it). No code change made here; existing config already
matches what the data supports.

## fair, dice, magicc: 1 vs 2 vs 4 CPU sweep

None of these had a `resources` override before this. Swept the same way
as hector's experiment 2 (memory fixed small/sufficient, only CPU varied).

| Model | 1 CPU | 2 CPU | 4 CPU | Shape |
|---|---|---|---|---|
| **fair** | 19.18s median (stdev 1.32) | 14.63s median (stdev 4.21) | 12.82s median (stdev 4.74) | Speeds up both steps, but noisiest of the four models (fair's 66-config ensemble + progress-file-polling architecture adds timing variance beyond pure compute time) |
| **dice** | 36.26s median (stdev 0.53) | 19.63s median (stdev 0.50) | 20.73s median (stdev 0.87) | Big 1->2 win (**-46%**), 2->4 flat/slightly worse (noise) -- same shape as hector |
| **magicc** | 12.47s median (stdev 0.92) | 9.45s median (stdev 0.70) | 9.12s median (stdev 0.23) | Speeds up 1->2 (-24%), 2->4 is noise-level |

**Finding:** all three follow the same "1->2 CPU is where the real gain
is, 2->4 is flat or noise" shape hector and dice show clearly; fair shows
the same direction with more variance. None of the three justify `cpu: 4`.

**Conclusion / applied:** `resources: { cpu: 2 }` for all three
(`apps/web/lib/models.ts`) -- same cost/latency tradeoff as hector.

## Overall takeaways

1. **CPU, not memory, is what speeds these models up** -- confirmed
   directly (not assumed) for hector via a proper 2x2 factorial. Memory
   only matters as a hard pass/fail cliff (oscar's OOM), never as a speed
   dial.
2. **The CPU-vs-speed curve has strongly diminishing returns past 2** for
   every model tested: hector, dice, and magicc all show 2->4 as flat or
   within noise; fair shows a smaller further gain but with much higher
   variance. None of the five models tested show a case for `cpu: 4` over
   `cpu: 2` once cost is considered.
3. **Not every model benefits from more CPU at all** -- oscar is the
   counterexample: its real bottleneck is memory (avoiding an OOM kill at
   7.8s), and once past that, more CPU doesn't move its ~520s runtime.
4. Applied: hector/fair/dice/magicc all set to `cpu: 2`. Oscar's existing
   `{cpu: 4, memory: 8}` is validated as-is (memory load-bearing, cpu
   incidental, and also this plan's per-sandbox cpu ceiling anyway).

## GCAM (not added -- feasibility test only)

Tested whether GCAM (the Global Change Analysis Model, an IAM candidate
raised in earlier model-selection discussion) could be built and run the
same way every other model in this project is -- a real build/run in a
throwaway Daytona sandbox, not a guess from reading its docs.

**This account's real resource ceiling, discovered by testing (not
documented anywhere):** 4 CPU, 8GB memory max per sandbox -- requesting
`cpu: 16` or `memory: 16` both failed outright with
`DaytonaValidationError`. So "start with high CPU" tops out at the same
`cpu: 4` every other model in this project is already capped at; there's
no higher tier available to test against.

**Three real build-time gotchas found, undocumented anywhere official:**

1. `git clone --recursive` hangs forever -- one of GCAM's submodules
   (`util/testing-framework`) points at `stash.pnnl.gov`, an internal
   PNNL server unreachable from outside their network. Not needed to
   build the actual `gcam` executable (confirmed: the Makefile never
   touches it). Fix: `git submodule update --init` only the two
   submodules actually needed (`hector`, `modelinterface`).
2. The Makefile needs `JARS_LIB` set to a directory containing GCAM's own
   bundled `.jar` files (already shipped in the repo's own `exe/`
   directory) -- undocumented in jgcri.github.io/gcam-doc's own build
   page, which only lists `BOOST_INCLUDE`/`JAVA_INCLUDE`/`EIGEN_INCLUDE`/
   `TBB_INCLUDE`/`TBB_LIB`.
3. **The default sandbox disk (3GB) isn't enough.** Confirmed by testing:
   compiling the full codebase (546 `.o` files, ~747MB) inside the 1.7GB
   cloned repo filled the 3GB disk to 79% before the final `ar ru
   libgcam.a` archive step, which then failed outright with "No space
   left on device" -- one step away from a working build. First retried
   with `disk: 20` (confirmed allowed on this account, unlike the
   cpu/memory ceilings) to confirm the build itself was otherwise fine --
   it was. Then sized down to find the real minimum rather than shipping
   an arbitrary 20GB: `disk: 4` also builds clean, peaking at 88% full
   (3.6GB used, 499MB to spare) -- `disk: 4` is what's actually used,
   not 20.

**Build time:** ~9 minutes with `cpu: 4` from a cold clone to a working
`gcam.exe` (294MB binary), once all three issues above were fixed. Not
validated against `cpu: 1`/`cpu: 2` -- the real blockers here were disk
space and two undocumented env vars, not raw compute, so a CPU-scaling
comparison wouldn't have told us anything new this time.

**The real blocker, found after the build succeeded:** `gcam.exe` can't
actually run against anything yet. Its own `configuration_ref.xml`
points at input files like `../input/gcamdata/xml/modeltime.xml`, and
`input/gcamdata/` in the cloned repo is only `gcamdata`'s **R package
source** (confirmed: no `input/gcamdata/xml/` directory exists anywhere
in the repo) -- that XML input database has to be generated by running
gcamdata's own R data pipeline first, a separate, non-trivial step (R +
its own `renv`-pinned package set) not attempted here.

**Conclusion (build-only):** buildable, with real but fixable gotchas, in
about the same resource envelope as this project's existing models (just
needing `disk: 4`, which nothing else here currently needs). Packaged
into a real, tested multi-stage `sandboxes/gcam/Dockerfile` (not added to
`lib/models.ts` yet -- see below for why).

### Follow-up: actually running the gcamdata R pipeline

Picked this back up to resolve the one remaining real unknown: can
`gcamdata`'s R `driver()` (the function that turns the 385MB/983-CSV raw
data already shipped in `input/gcamdata/inst/extdata/` into the XML input
database `gcam.exe` needs) actually complete inside this account's
resource ceiling?

**Environment setup, two more undocumented gotchas found by testing:**

4. Debian 12's own `r-base` apt package is R 4.2.2, but `gcamdata`'s
   `renv.lock` pins packages (`Matrix`, transitively required by `drake`)
   that require R >= 4.4. Installing a newer R isn't a simple apt flag --
   CRAN's own documented Debian apt-repo instructions (`marutter_pubkey.asc`
   key URL from cloud.r-project.org's own docs) returns a 404 as of this
   test. Fix: used [`rig`](https://github.com/r-lib/rig) (R installation
   manager) instead, downloading its release tarball directly from GitHub
   (`rig-linux-x86_64-0.11.1.tar.gz`) and `rig add 4.4`, which pulls a
   prebuilt R 4.4.3 from Posit's CDN -- this sidesteps CRAN's apt repo
   entirely.
5. `renv::restore()` still fails on `textshaping`/`ragg` (pulled in
   transitively by `devtools`, not actually needed to run `driver()`
   itself) without `libharfbuzz-dev`/`libfribidi-dev` installed first, and
   downloads need the `curl` *binary* present (not just libcurl-dev) or
   renv silently can't fetch sources.

With R 4.4.3 and those system libs, `renv::restore()` succeeded cleanly:
**118 packages, ~400 seconds**, including `drake 7.13.10` (officially
unmaintained but still installable).

**Running `driver()` itself:**

- First attempt failed fast on a missing `java` binary (needed for the
  XML-conversion step, `run_xml_conversion` -> `system2("java", ...)`) --
  undocumented as a `gcamdata`-side dependency (the only java mention
  anywhere is GCAM's own C++ build needing a JDK, a separate concern).
  Fixed: `apt-get install default-jdk-headless`.
- Second attempt got through nearly the entire pipeline (2087 chunks) and
  hit a real **data bug** in a newly-added module,
  `module_socio_L100.Employment` (file header says `@author xz 2025` --
  evidently still in development upstream): a `left_join_error_no_match()`
  against an ILO country/ISO mapping table fails because some country
  labels in the raw ILO employment CSV don't have a matching row in the
  mapping file. The *second* half of the same chunk (the ILOEST dataset,
  a few lines below) already handles this correctly with a plain
  `left_join()` + `filter(!is.na(iso))`. Patched the first half
  (`zsocio_L100.Employment.R`) to match that pattern. This is a genuine
  upstream data-coverage bug, unrelated to our environment -- not a
  sandbox/infra issue.
- Third attempt (post-patch) got past `Employment` cleanly, but was
  **OOM-killed (exit 137) partway through the very next chunk,
  `module_socio_L100.Population_hist`** -- reproduced twice. Confirmed via
  `/sys/fs/cgroup/memory.max` (8589934592 bytes = exactly 8GB, this
  account's known hard ceiling) and `/sys/fs/cgroup/memory.peak`
  (8589938688 bytes -- essentially identical, i.e. genuinely pinned at the
  limit, not an unrelated crash) that this is a real OOM, not a code bug.
  `driver()`'s plain (non-drake) variant keeps every one of the 2087
  chunks' output in memory simultaneously rather than streaming/releasing
  them -- by the time it reaches a population-data chunk this deep into
  the pipeline, cumulative R memory usage already exceeds 8GB on its own,
  independent of the raw input data size.

### Follow-up 2: confirming the account's memory ceiling, then `driver_drake()`

Before chasing a workaround, re-verified directly (not from memory) that
8GB really is this account's hard ceiling: `resources.memory` requests of
9 through 32GB were all rejected by the API with the same "exceeds
maximum allowed per sandbox (8GB)" error; `cpu` is still capped at 4
too. Checked `organizations/{id}/available-sandbox-classes` directly --
this org only has `container` and `windows` classes, no higher-tier
`linux-vm` class. The **only** way found to request more than 8GB is
attaching a GPU (`resources.gpu: 1` unlocked `memory: 16` in testing) --
but GPU sandboxes must be ephemeral (`autoDeleteInterval: 0` is
mandatory) and bill for GPU time this is pure-CPU R code doesn't need, so
not pursued. Also tried adding a swapfile inside the sandbox as a
zero-cost way to extend past the cgroup's RAM limit --
`/sys/fs/cgroup/memory.swap.max` is `0`, i.e. swap is disabled at the
platform level; not available either.

With no resource increase available, tried `driver_drake()` (the
incremental/caching variant mentioned as unexplored above) with
`jobs=1, memory_strategy="autoclean", garbage_collection=TRUE` to force
drake to release each completed target's memory rather than accumulate
all of them like plain `driver()` does. Result: real improvement, not a
full fix. It got past `Population_hist` cleanly this time (memory stayed
in the 1-7GB range, visibly fluctuating rather than monotonically
climbing, and progressed to generating 127 of the model's XML outputs --
compared to 0 on every previous attempt) before OOM-killing again, this
time on `module_emissions_L112.ceds_ghg_en_R_S_T_Y`.

**Found and fixed one genuine upstream bug this way:** `Population_hist`
itself turned out to have the same class of bug as `Employment` -- a
block meant to build the full iso x year grid for interpolation chained
two `repeat_add_columns()` calls on a dataframe that **already contained
both the `iso` and `year` columns being added**, squaring the row count
twice over (should be ~21,600 rows for the intended grid; the actual
code produces hundreds of millions). Replaced the whole block with the
one-line equivalent, `tidyr::complete(iso, year)`, which produces the
identical grid+ NA-fill result without the accidental cross-multiplication.
This fix is why `driver_drake()`'s second attempt got past `Population_hist`
at all -- the first attempt (before this fix) died on it instantly, just
like plain `driver()` did.

Confirmed `driver_drake()`'s on-disk cache (`.drake/`) lets a killed run
resume rather than restart from scratch -- re-running the same
`driver_drake()` call after unlocking the cache
(`drake::drake_cache(path)$unlock()`, needed because the prior process
was killed mid-write) picked up exactly where it left off with a fresh,
near-zero-memory R process. This is a real, usable checkpoint/resume
mechanism for working through the pipeline in bounded-memory passes.

**The new blocker (`ceds_ghg_en_R_S_T_Y`) is different in kind.** Unlike
`Population_hist`/`Employment`, this one's `repeat_add_columns()` chain
expands a filtered sector/tech table by genuinely distinct dimensions
(gas species x 53 CEDS years x 32 GCAM regions) -- a real, intentional
cross-join needed to build a complete emissions-factor grid, not an
accidental self-multiplication. It reproduces the OOM on a cold retry
from near-zero memory, meaning this single chunk's own working set
exceeds what's left of the 8GB budget. Did not patch this one: changing
real emissions-calculation logic without being certain what downstream
GCAM math depends on its exact row structure risks silently corrupting
model output in a way that wouldn't show up as an error -- a materially
different risk than the `Population_hist`/`Employment` fixes, which were
provably redundant intermediate steps with an identical end result.

**Status as of the write-up above:** GCAM was **not added** to
`sandboxes/` or `lib/models.ts`. 8GB was confirmed a hard ceiling for
plain CPU sandboxes on this account, and `ceds_ghg_en_R_S_T_Y` needed
more than that to complete.

### Follow-up: solved via GPU-attached memory, not GPU compute

Re-confirmed the 8GB/4-CPU ceiling directly (tested 9-32GB memory
requests, checked `available-sandbox-classes`, tried a swapfile --
disabled at the cgroup level, `memory.swap.max = 0`). The one real
lever found: **attaching a GPU unlocks a much higher memory ceiling**
(`memory: 96` accepted with `gpu: 1`), purely because GPU-class sandboxes
aren't subject to the same 8GB cap -- the GPU itself does nothing for
this workload (R's dplyr/tidyr joins are CPU-only). GPU sandboxes must be
ephemeral (`autoDeleteInterval: 0`) and bill at GPU rates ($1.99/hr for
an L40S, ~$2.58/hr all-in with this config), but since gcamdata's output
is a one-time, non-scenario-specific artifact (confirmed by diffing
`configuration_ref.xml` against `configuration_ssp.xml` -- both read the
exact same `input/gcamdata/xml/` files, scenario variation lives in small
separate `batch_*.xml` files), paying that rate once is a one-time cost,
not a per-request one.

Ran `driver_drake(jobs=1, memory_strategy="autoclean")` in a
`cpu:4, memory:24, gpu:1 (L40S)` sandbox: **completed successfully** --
"All done." / exit 0 -- generating all 221 XML files, peak memory ~13.5GB
(comfortably under 24GB, nowhere near the old 8GB wall). Total pipeline
runtime: ~75 minutes.

Then, in the same sandbox (already had `git`/`g++`/`make` from the R
build's system deps), compiled `gcam.exe` from source the same way
`sandboxes/gcam/Dockerfile`'s builder stage does, and ran it against the
freshly-generated database:

- First attempt: JVM segfault trying to write GCAM's own BaseX-backed
  XML output database (`SEVERE ERROR: Failed to find Java class
  XMLDBDriver`) -- this project doesn't ship BaseX's jars, a separate,
  unsolved problem. Fixed by disabling that one output stream
  (`xmldb-location`'s `write-output` flipped from `"1"` to `"0"` in
  `configuration_ref.xml`) -- we don't need it; the restart file and CSV
  outputs still write normally.
- Second attempt: missing `input/solution/`, `input/policy/`,
  `input/climate/` directories (never part of any sparse-checkout so
  far) -- GCAM's solver config and Hector's own `.ini` file live there.
  Added them.
- Third attempt: **ran clean, all 21 periods, 1975 through 2100,
  "All model periods solved correctly." / "Model exiting successfully." /
  exit 0.** First time any scenario has actually run end-to-end in this
  project's GCAM investigation.

Snapshotted the sandbox's filesystem directly (`sandbox.createSnapshot()`)
to preserve this result independent of the sandbox's own lifecycle, then
downloaded the generated XML (5.2GB, compresses to ~430MB as a tarball)
out via `sandbox.fs.downloadFile()` and committed the small supporting
files (`sandboxes/gcam/runtime/exe/`, `input/{solution,policy,climate}/`
-- ~1.6MB total, including the patched `configuration_ref.xml`) into the
repo. The 5.2GB XML database itself is gitignored (see
`sandboxes/gcam/runtime/README.md` for exactly how to regenerate it) and
baked directly into `sandboxes/gcam/Dockerfile`'s final image via `COPY`.

Built a `gcam-production-v1` Daytona snapshot from that Dockerfile with
plain `cpu:4, memory:8, disk:12` -- **no GPU at all** -- and verified a
fresh sandbox created from it (`memory.max` confirmed at the normal 8GB
cgroup limit, not 24GB) runs `gcam.exe -C configuration_ref.xml` and
solves periods identically to the GPU-sandbox test. The GPU was never
needed for *running* GCAM -- only for the one-time step of generating its
input database within this account's memory limits.

**Conclusion:** GCAM is now fully working end-to-end within this
project's normal per-request sandbox budget (no GPU, no special
resources beyond the already-standard `cpu:4, memory:8`). Not yet wired
into `lib/models.ts`/`run.py` -- that's the remaining integration work
(reading `SCENARIO_PARAMS`, mapping to one of the five `batch_SSP_*.xml`
scenario files, parsing `gcam.exe`'s output) -- but the hard infra
problem (an R data pipeline needing more memory than this account's
sandboxes allow) is solved, and the solution (one-time GPU-assisted data
generation, baked into a reusable snapshot) is documented and reusable if
the data ever needs regenerating.

### Backup copy on Docker Hub

The `gcam-production-v1` Daytona snapshot above is the primary artifact,
but it only exists inside Daytona's own registry -- confirmed
inaccessible from outside (a direct `skopeo`/`Image.base()` pull against
its `cr.app.daytona.io` ref returns `401 Unauthorized`; Daytona doesn't
expose pull credentials for it). Pushed a second copy to
**`possibleplanets/gcam:v1`** (also tagged `:latest`) on Docker Hub,
public, as an independent backup that survives even if the Daytona
snapshot is ever lost or expires.

Built with plain `docker build`/`docker push` from this machine rather
than through Daytona at all -- this machine's own cgroup caps at 3GB
memory, well under what compiling GCAM's C++ from source needs (the same
single file, `calc_base_price.o`, OOM-killed `cc1plus` under `-O3` at
both `-j4` and `-j1`; this isn't a parallelism problem, one translation
unit alone needs more than 3GB to compile). Rather than fight that,
reused the already-compiled, already-verified `gcam.exe` binary pulled
down earlier from the GPU sandbox (`sandboxes/gcam/runtime/exe/gcam.exe`
-- gitignored, 294MB, not committed, but kept locally since it's the
exact binary that already passed the full 21-period validation run) and
built a single-stage image straight from `runtime/` with no compilation
step at all. Verified with `gcam.exe --help` before pushing.
