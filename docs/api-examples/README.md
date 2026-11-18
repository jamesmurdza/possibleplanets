# Real API example outputs

Full, untruncated native results backing the request/response excerpts
shown on each model's "How to run" REST example (`apps/web/lib/runGuides.ts`'s
`restApiStep()`). Those excerpts truncate long arrays for readability;
these files are the real, complete output each truncation was taken from,
kept here for provenance -- so the numbers in the UI can always be traced
back to an actual run, not just trusted on faith.

## How each one was generated

Same method for all five: install that model's actual dependency (pip or
Julia, no Docker needed, same packages `sandboxes/<model>/Dockerfile`
installs), then run that model's real `sandboxes/<model>/run.py` (or
`run.jl`) script directly with a real `SCENARIO_PARAMS` env var -- the
exact same entry point the gateway's sandbox invokes in production (see
`apps/gateway/jobs.py`/`apps/web/lib/runs.ts`). Nothing here is a mock or
a hand-written fixture.

| File | Command | Params |
|---|---|---|
| `fair.json` | `pip install fair==2.2.5` then `python3 sandboxes/fair/run.py` | `{"scenarios": ["ssp245"]}` |
| `hector.json` | `apt install libboost-all-dev` + `pip install pyhector==3.2.0.0` then `python3 sandboxes/hector/run.py` | `{"scenario": "ssp245"}` |
| `oscar.json` | `git clone` the OSCAR repo + pip install its pinned deps, then `python3 sandboxes/oscar/run.py` (full real run, ~6 minutes even at nMC=1) | `{"scenario": "SSP2-4.5", "nMC": 1}` |
| `dice.json` | Julia + `Pkg.add` DICE.jl (pinned commit) + Ipopt 1.0.2, then `julia sandboxes/dice/run.jl` (real IPOPT solve, ~8-17s depending on cold/warm compile cache) | `{"scenario": "optimal"}` |
| `twolayer.json` | `pip install openscm-twolayermodel==0.2.3` + the 2-line pandas>=2.0 compat patch `sandboxes/twolayer/Dockerfile` also applies, then `python3 sandboxes/twolayer/run.py` | `{"scenario": "ssp245"}` |

All five ran in a throwaway venv/Julia depot outside Docker (no Docker
daemon available in the authoring environment -- same situation
`sandboxes/fair/run.py`'s own module docstring already notes), not inside
the actual sandbox image. The installed package versions match each
Dockerfile exactly, so the computation itself is the same; only the
surrounding OS environment differs (bare Debian 12 host vs. each
Dockerfile's `FROM` image).

## magicc is NOT here

Wine (which `pymagicc` needs to run the real `MAGICC6.exe` binary it
wraps) could not be installed in the environment these files were
generated in -- confirmed by two separate attempts, both failing with "No
space left on device" partway through unpacking Wine's own dependency
tree (which pulls in X11/audio/video libraries well beyond what a
5GB-disk sandbox has room for, even with `--no-install-recommends`). The
REST example for magicc on its model page is explicitly labeled
illustrative in both the rendered guide text and `runGuides.ts`'s code
comment -- its response *shape* is still real (read directly from
`sandboxes/magicc/run.py`'s source), just not independently re-executed
the way the other five are.

## gcam is also NOT here

Same situation as magicc, for a different reason: GCAM isn't a pip/Julia
package at all -- `sandboxes/gcam/run.py` shells out to a compiled
`gcam.exe` binary that needs its full 5.2GB generated input database
present on disk (see `docs/gcam/artifacts.md`), which doesn't exist
outside the `possibleplanets/gcam` image/the `gcam-production-v1`
Daytona snapshot. A real, complete 21-period run of that exact
`gcam.exe`+database combination *has* been independently verified
end-to-end (see `docs/sandbox-resource-experiments.md`'s GCAM section) --
but that was a plain successful exit and log output, not this specific
`run.py` wrapper's JSON output captured and saved here. The REST example
on GCAM's model page is labeled illustrative for that reason: its
response *shape* is real (Hector's own standard long-format output,
which is what `gcam-hector-outputstream.csv` actually is -- GCAM runs
Hector internally for its climate component), just not independently
re-executed through this wrapper and saved to a file here the way the
other five are.

## Headline numbers (year 2100, for the params above)

- **fair**: mean temperature anomaly across 66 climate configs = 3.61°C
- **hector**: `temperature.global_tas` = 2.7214°C
- **oscar**: `mean_D_Tg` = 2.521°C (`std_D_Tg` = 0 -- only one Monte Carlo
  sample at `nMC=1`, nothing to vary)
- **twolayer**: `T_atmos` = 2.8367°C
- **dice**: DICE.jl steps every 5 years from 2015, so 2100 lands exactly
  on a step -- `T_atmos` = 3.4814°C there, continuing to rise to a peak
  of 4.1519°C at year 2240 before slowly declining under the optimal
  policy path.
