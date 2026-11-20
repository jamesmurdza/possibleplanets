# Known gaps and deliberate non-fixes

Things left unsolved or unintegrated on purpose, so nobody re-discovers
the same dead end or re-does already-settled work.

## Integrated, six scenarios exposed

GCAM is now registered in `apps/web/lib/models.ts` and has a real
`sandboxes/gcam/run.py` entrypoint (reads `SCENARIO_PARAMS`, shells out
to `gcam.exe`, parses its Hector-output CSV, reports progress).
`"Reference"` plus `"SSP1"`-`"SSP5"` are all exposed and live-validated
end-to-end -- see `ssp-scenarios.md` for how the SSP configs were
built (NOT by reusing `configuration_ssp.xml`/`batch_SSP_*.xml`'s
BatchMode mechanism directly -- that was tried and found to OOM via
double-parsing, independent of `max-parallelism`) and the full
validation (all 5 ran the complete 21-period horizon, exit 0, 0
`oom_kills`, genuinely divergent results).

No curated ParameterSpec sliders (like every other model's `parameters`
array) are exposed -- but a general `config_overrides` escape hatch now
is: any existing value in `configuration_ref.xml` can be overridden per
request (any section, not just a "safe" allowlisted subset). See
`config-overrides.md` for the full mechanism, and `oom-fix.md` for why
it needed a dedicated snapshot (v5) just like the other two gcam fixes
did.

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

## Only `configuration_ref.xml`, `configuration_ssp1-5.xml` were actually run-tested

The full 21-period validated runs used `configuration_ref.xml` and the
5 new `configuration_sspN.xml` files (see `ssp-scenarios.md`) --
all 6 individually confirmed end-to-end. Upstream's own
`configuration_policy.xml`, `configuration_usa.xml`, and the
`batch_SSP_*.xml`/`configuration_ssp.xml` BatchMode mechanism itself
ship as-is but are **not** run-tested or exposed. They're presumed to
work in the same general sense (same underlying XML database, same
`gcam.exe` binary) but this hasn't been directly verified, and the SSP
work above found a real, non-obvious bug (a land-allocation
inconsistency) in the naive version of exactly this kind of "just
reuse the shipped config" assumption -- so "presumed to work" should
not be read as "verified."

## Production-snapshot run: 8GB was marginal -- intermittent OOM at the final periods (fixed, see `oom-fix.md`)

Previously an open/unexplained issue (runs intermittently dying at
"Period 20: 2095" with a bare `exit_code=1`) -- now diagnosed and
fixed. Short version: `gcam.exe`'s solver keeps a full per-thread
scratch copy of its state, and `configuration_ref.xml`'s
`max-parallelism=-1` (all 4 cores) was multiplying memory ~4x, hitting
the plain 8GB sandbox's ceiling right at the final periods. Fixed by
setting `max-parallelism` to `1`. A separate, previously-committed-but-
never-deployed `run.py` fix (raw CSV text instead of a buggy
`csv.DictReader` parse) is now deployed alongside it; both land in
`gcam-production-v4`. See `oom-fix.md` for the full live-measured
diagnosis, the before/after numbers, the deploy process (no `gcamdata`
re-run needed for either fix), and the speed/memory tradeoff.

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
