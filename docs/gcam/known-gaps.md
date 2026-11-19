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

## Production-snapshot run: 8GB was marginal -- intermittent OOM at the final periods (fixed, see `oom-fix.md`)

Previously an open/unexplained issue (runs intermittently dying at
"Period 20: 2095" with a bare `exit_code=1`) -- now diagnosed and
fixed. Short version: `gcam.exe`'s solver keeps a full per-thread
scratch copy of its state, and `configuration_ref.xml`'s
`max-parallelism=-1` (all 4 cores) was multiplying memory ~4x, hitting
the plain 8GB sandbox's ceiling right at the final periods. Fixed by
setting `max-parallelism` to `1`; deployed as `gcam-production-v3`.
See `oom-fix.md` for the full live-measured diagnosis, the before/after
numbers, the deploy process (no `gcamdata` re-run needed), and the
speed/memory tradeoff.

`run.py` also now folds cgroup evidence (`memory.peak` / `memory.max` /
`oom_kill` count) into its failure report on any `gcam.exe` non-zero
exit, so a future OOM kill -- should one still happen -- is labeled as
one in the dashboard instead of presenting as a bare "exit_code=N"
with an output tail that otherwise looks fine.

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
