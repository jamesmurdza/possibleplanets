# Known gaps and deliberate non-fixes

Things left unsolved or unintegrated on purpose, so nobody re-discovers
the same dead end or re-does already-settled work.

## Not integrated into the app yet

GCAM is not in `apps/web/lib/models.ts` or `run.py`. The hard
infrastructure problem (generating its input data within this account's
sandbox limits) is solved and the result is packaged and reusable (see
`artifacts.md`), but the actual app-level integration -- reading
`SCENARIO_PARAMS`, mapping to one of the five `batch_SSP_*.xml` scenario
files, parsing `gcam.exe`'s output into whatever shape the app expects --
has not been done.

Open question this raises, not yet resolved: will the eventual
integration only expose **scenario selection** (free, no data refresh
ever needed -- see `architecture.md`), or actual tunable parameters that
would require new source data per request? If it's the latter, the
`gcamdata` memory problem reopens on a per-request basis, which the
current "bake it once" architecture does not solve. This needs to be
decided before integration starts, since it changes the shape of the
work substantially.

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

## Production-snapshot run: only partially directly observed

When the `gcam-production-v1` snapshot was verified (plain `cpu:4,
memory:8`, no GPU), the verification sandbox was only directly observed
progressing through Period 6 (2025) -- matching the already-fully-completed
GPU-sandbox run's iteration counts exactly -- before the sandbox was
deleted during cleanup (it also only had a 20-minute TTL). The claim that
it "ran to completion" is inferred from that match, not from directly
observing this specific sandbox's own exit code. A clean, fully-observed
run on the plain 8GB tier (with `memory.current`/`memory.peak` actually
checked during the `gcam.exe` phase specifically, which has never been
done on either sandbox so far) would close this gap -- see
`setup-guide.md` step 3/`artifacts.md` for how to do that if it matters
for a future decision.

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
