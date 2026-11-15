"""
Run script for the OSCAR sandbox image.

Adapted from run_scripts/basic_example_1.py (in the OSCAR repo this image
clones) into a parametrized script, following the same pattern as
sandboxes/hector/run.py and sandboxes/fair/run.py: params read at run time
(env var or /input/params.json), native result returned untouched.

Confirmed by manual testing: OSCAR's native scenario names are AR6-style
marker SSPs (e.g. "SSP2-4.5"), NOT the "ssp245"-style names HECTOR/FAIR use --
these are not the same taxonomy and this script does not translate between
them (see PLATFORM.md's decision not to force a cross-model scenario mapping).

nMC (Monte Carlo sample size) defaults to 1, the smallest possible, because
even at nMC=1 the full run takes ~6 minutes (confirmed by testing: ~210s for
the historical run, ~145s for the scenario run to 2100). Increasing nMC
increases run time further.

PROGRESS: confirmed by reading core_fct/cls_main.py (the OSCAR class this
image clones) that its main simulation loop does
`print(time_axis + ' = ' + str(int(time[t])), end=' ')` once per simulated
year, for time_axis='year' (the actual default used by this script's calls).
That's a real signal -- not a synthetic estimate -- so _ProgressStdout below
intercepts those specific writes (passing everything else through to real
stdout unchanged) and reports progress as real-years-completed / real-total-
years, where the total is computed from the actual forcing data lengths
before running, not guessed.
"""
import json
import os
import sys

DEFAULT_PARAMS = {"scenario": "SSP2-4.5", "nMC": 1}

SUPPORTED_SCENARIOS = [
    "SSP1-1.9",
    "SSP1-2.6",
    "SSP2-4.5",
    "SSP3-7.0",
    "SSP3-7.0-LowNTCF",
    "SSP4-3.4",
    "SSP4-6.0",
    "SSP5-3.4-OS",
    "SSP5-8.5",
]


PROGRESS_FILE = "/tmp/progress.json"


def _write_progress(percent):
    """
    Same mechanism as sandboxes/fair/run.py -- a direct file write, read back
    by the gateway via the sandbox filesystem API. Daytona's session log APIs
    were confirmed (by testing, for FAIR) to buffer all stdout until the
    command finishes, so they can't be used to observe progress mid-run.
    """
    try:
        with open(PROGRESS_FILE, "w") as f:
            json.dump({"percent": percent}, f)
            f.flush()
            os.fsync(f.fileno())
    except Exception:
        pass


class _ProgressStdout:
    """
    Tees stdout: every write still reaches the real stdout untouched (so
    nothing about the process's normal output changes), but writes that
    match OSCAR's own `"year = <N>"` prefix (see module docstring) also
    advance a real step counter against a real, precomputed total.
    """

    def __init__(self, real_stdout, total_steps):
        self._real = real_stdout
        self._total_steps = total_steps
        self._count = 0

    def write(self, s):
        self._real.write(s)
        if s.startswith("year = "):
            self._count += 1
            if self._total_steps:
                _write_progress(int(100 * min(self._count, self._total_steps) / self._total_steps))

    def flush(self):
        self._real.flush()


def load_params():
    raw = os.environ.get("SCENARIO_PARAMS")
    if raw:
        return json.loads(raw)
    input_path = "/input/params.json"
    if os.path.exists(input_path):
        with open(input_path) as f:
            return json.load(f)
    return DEFAULT_PARAMS


def main():
    params = load_params()
    scenario = params.get("scenario", DEFAULT_PARAMS["scenario"])
    nMC = int(params.get("nMC", DEFAULT_PARAMS["nMC"]))

    if scenario not in SUPPORTED_SCENARIOS:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "error": f"unsupported scenario '{scenario}'. supported: {SUPPORTED_SCENARIOS}",
                }
            )
        )
        raise SystemExit(1)

    # OSCAR's own code loads data files with bare relative paths (e.g.
    # 'input_data/parameters/...'), relative to CWD -- see Dockerfile comment.
    # This script lives at /app/run.py (the gateway's fixed convention) while
    # the actual OSCAR checkout + its data files are at /app/oscar, so both
    # the CWD and sys.path need to point there before any core_fct import.
    oscar_dir = "/app/oscar"
    if os.path.isdir(oscar_dir):
        os.chdir(oscar_dir)
        sys.path.insert(0, oscar_dir)

    from core_fct.mod_process import OSCAR
    from core_fct.fct_loadP import load_all_param
    from core_fct.fct_genMC import generate_config
    from run_scripts.get_SSP_drivers import For_hist, For_scen
    import xarray as xr

    Par0 = load_all_param(mod_region="RCP_5reg")
    Par = generate_config(Par0, nMC=nMC)

    Par = xr.merge(
        [Par, For_hist.drop([VAR for VAR in For_hist if "year" in For_hist[VAR].dims])]
    )
    For_hist_t = For_hist.drop(
        [VAR for VAR in For_hist if "year" not in For_hist[VAR].dims]
    )
    For_scen_sel = For_scen.sel(scen=scenario, drop=True).sel(year=slice(None, 2100))

    # Real total step count, computed from the actual forcing data (not a
    # guessed/typical duration): OSCAR's main loop (core_fct/cls_main.py)
    # prints one "year = ..." line per step from t=1 to len(time)-1, for each
    # of the two OSCAR() calls below.
    total_steps = (len(For_hist_t["year"]) - 1) + (len(For_scen_sel["year"]) - 1)
    _write_progress(0)
    sys.stdout = _ProgressStdout(sys.stdout, total_steps)

    Out_hist = OSCAR(Ini=None, Par=Par, For=For_hist_t)

    Ini = Out_hist.isel(year=-1, drop=True)
    Out_scen = OSCAR(Ini=Ini, Par=Par, For=For_scen_sel, nt=4)

    sys.stdout = sys.stdout._real
    _write_progress(100)

    years = [int(y) for y in Out_scen.year.values]
    mean_temp = Out_scen.D_Tg.mean("config").values.tolist()
    std_temp = Out_scen.D_Tg.std("config").values.tolist()

    result = {
        "status": "succeeded",
        "model": "oscar",
        "scenario": scenario,
        "nMC": nMC,
        "result": {
            "year": years,
            "mean_D_Tg": mean_temp,
            "std_D_Tg": std_temp,
        },
    }

    # See sandboxes/hector/run.py for why this is wrapped: /output is expected
    # to be a mounted volume in the sandbox and isn't writable when running
    # this script directly on a host outside the container.
    try:
        os.makedirs("/output", exist_ok=True)
        with open("/output/result.json", "w") as f:
            json.dump(result, f)
    except PermissionError:
        pass

    print(json.dumps(result))


if __name__ == "__main__":
    main()
