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
"""
import json
import os

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

    Out_hist = OSCAR(Ini=None, Par=Par, For=For_hist_t)

    For_scen_sel = For_scen.sel(scen=scenario, drop=True).sel(year=slice(None, 2100))
    Ini = Out_hist.isel(year=-1, drop=True)
    Out_scen = OSCAR(Ini=Ini, Par=Par, For=For_scen_sel, nt=4)

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
