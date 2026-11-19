# Known gaps and deliberate non-fixes

Things left unsolved or unintegrated on purpose, so nobody re-discovers
the same dead end or re-does already-settled work.

## Integrated, but only one scenario exposed

GCAM is now registered in `apps/web/lib/models.ts` and has a real
`sandboxes/gcam/run.py` entrypoint (reads `SCENARIO_PARAMS`, shells out
to `gcam.exe`, parses its Hector-output CSV, reports progress). But only
`"Reference"` is exposed as a scenario -- not the fuller SSP taxonomy
other models here expose. That's because only `configuration_ref.xml`
was ever run-tested end-to-end (see "Only configuration_ref.xml was
actually run-tested" below); using `configuration_ssp.xml` to add real
SSP scenario selection would need its own validation pass first
(confirming its additional referenced input files exist in
`runtime/input/`, and either shipping BaseX's jars or patching its
`write-output` flag the same way `configuration_ref.xml` was patched).

Once that validation is done, adding more scenarios is cheap -- it's
just mapping a scenario name to one of the already-shipped
`batch_SSP_*.xml` files (see `sandboxes/gcam/runtime/exe/`), not a
repeat of the expensive `gcamdata` generation step (per
`architecture.md`'s scenario-independence finding).

No tunable parameters are exposed either, for the same reason
`architecture.md` flags: GCAM has no equivalent of hector's config-dict
overrides reachable without either regenerating `gcamdata`'s database
per request (reopens the memory problem) or editing
`configuration_ref.xml`'s own values, which hasn't been tested against
anything but what's already shipped.

## `ceds_ghg_en_R_S_T_Y` OOM -- intentionally unpatched

The last OOM point hit even with `driver_drake(jobs=1, autoclean)` on a
plain 8GB sandbox. Unlike the two bugs that were fixed
(`Employment`, `Population_hist`), this chunk's expansion (gas species x
53 CEDS years x 32 GCAM regions) is a **real, intentional** cross-join
needed to build a complete emissions-factor grid -- not an accidental
self-multiplication. Deliberately left as-is rather than patched, because
changing real emissions-calculation logic without domain certainty about
what downstream GCAM math depends on its exact row structure risks
silently corrupting model output in a way that wouldn't show up as an
error. Resolved instead by giving the sandbox more memory via the GPU
trick, not by changing this chunk's logic.

## GCAM's own XML output database -- disabled, not fixed

`gcam.exe` natively writes a BaseX-backed XML output database
(`xmldb-location` in `configuration_*.xml`). This project doesn't ship
the jars it needs, causing a JVM segfault
(`SEVERE ERROR: Failed to find Java class XMLDBDriver`). Worked around by
setting that output stream's `write-output` attribute to `"0"` --
restart file and CSV outputs still write fine without it, which is all
this project currently needs. If BaseX output is ever actually required,
this needs real investigation (finding/bundling the right jars), not
just re-flipping the flag back on.

## Only `configuration_ref.xml` was actually run-tested

The full 21-period validated run used `configuration_ref.xml`
specifically. The other `configuration_*.xml`/`batch_*.xml` files ship as-is
from upstream gcam-core but were **not individually run-tested** the same
way. They're presumed to work (same underlying XML database, same
`gcam.exe` binary, per `architecture.md`'s scenario-independence finding)
but this hasn't been directly verified for each one.

## Production-snapshot run: 8GB is marginal -- intermittent OOM at the final periods

Directly observed (2026-11-19, `gcam-production-v2`, plain `cpu:4,
memory:8`, sampling `/sys/fs/cgroup/memory.*` every few minutes during a
full run):

- `gcam.exe`'s own anon memory grows steadily across periods: 5.4GB at
  47% (period ~10), 7.7GB at 80% (period ~17), with the cgroup's
  `memory.peak` landing exactly on the 8GiB ceiling (`8589942784` =
  limit + 8KB) at the final periods.
- One run completed (`exit 0`, "All model periods solved correctly.",
  ~24 min) -- surviving only because the kernel reclaimed ~1.5GB of file
  cache at the peak (`oom_kill 0`, `memory.events.max` reclaim hits
  ~10k). This and the earlier 09:44 UTC production run are the only two
  completions ever observed.
- Two production runs died instead at "Period 20: 2095" (the final
  period's start line, nothing after it -- no solve line, no success
  marker) with `gcam.exe` exiting non-zero and `run.py` reporting
  failure. Identical iteration counts through period 19 across all runs
  (deterministic model), so the difference is environmental: when the
  kernel can't free enough page cache at the final peak, it SIGKILLs
  `gcam.exe` mid-solve, which also loses gcam's unflushed stdout tail.

The previously-open questions ("ran to completion inferred, not
observed", "memory.current/memory.peak never checked during the
gcam.exe phase") are now answered: it completes **sometimes**, memory is
the constraint, and 8GB is the wrong tier for a reliable run. Daytona
rejects per-request resource overrides for snapshot-based sandboxes
("Cannot specify Sandbox resources when using a snapshot", confirmed
2026-11-19), so the memory ceiling itself cannot be raised from the
gateway's `create()` call -- it is snapshot-creation-time only, and
Daytona's org-wide cap on this account is 8GB regardless (confirmed
2026-11-19), so a bigger memory class isn't actually available at all
right now.

**Fix applied instead: `configuration_ref.xml`'s `max-parallelism` -1 ->
1.** GCAM 9's solver keeps a full per-thread scratch copy of its solver
state (`Value::sCentralValue` is `tbb::enumerable_thread_specific`), so
`-1` (all 4 cores) was multiplying memory by ~4x for parallel-solve
scratch space on top of the base model state. Verified live
(2026-11-19, same `gcam-production-v2` snapshot, same memory sampling
method as above): with `max-parallelism=1`, anon peaked at ~7.3GB
(never hit the ceiling) vs. the `-1` baseline's 7.7GB-at-80%-then-ceiling
trajectory, `oom_kill` stayed at 0 for the full run, and it completed
(`exit 0`, "All model periods solved correctly.", byte-identical
13,766,812-byte result to a known-good run). The real cost: serial
solving is slower -- this run took ~50min wall-clock vs. the earlier
~20-24min parallel-solve completions -- but that's still well inside
`exec_timeout_seconds` (5000s / ~83min). If gcam's run times become a
UX problem, revisit with an intermediate parallelism value (e.g. 2) as
a middle ground between speed and memory headroom -- not tested here.

`run.py` also folds the cgroup evidence (`memory.peak` / `memory.max` /
`oom_kill` count) into its failure report on any `gcam.exe` non-zero
exit, so an OOM kill -- should one still happen -- is labeled as one in
the dashboard instead of presenting as a bare "exit_code=N" with an
output tail that otherwise looks fine. This only takes effect on a
`gcam-production-v3`+ snapshot rebuild (both this and the
`max-parallelism` fix live in files baked into the snapshot image, not
reachable by the gateway at runtime).

## Local compilation is blocked on this agent's own machine

Not a Daytona or GCAM problem -- this agent's own working environment has
a 3GB memory cgroup limit, under which one specific translation unit
(`calc_base_price.o`) reliably OOMs `cc1plus` under `-O3`, at both `-j4`
and `-j1` (confirmed a genuine per-file memory requirement, not a
parallelism issue). This only matters if someone needs to rebuild the
Docker Hub backup image locally without Daytona -- the fix used
(reusing the already-compiled binary rather than recompiling) is a
one-time workaround, not a permanent fix; a true local rebuild still
needs a machine with more than 3GB available to the build process.
