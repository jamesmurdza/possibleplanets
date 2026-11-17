"""
Run script for the TWOLAYER sandbox image (openscm-twolayermodel's
TwoLayerModel).

Same params-at-run-time pattern as sandboxes/hector/run.py: scenario/params
are read from the SCENARIO_PARAMS env var or /input/params.json, not baked
into the image. Output is TwoLayerModel's native result, untouched (no
cross-model normalization, per PLATFORM.md's minimal-version decision).

Unlike hector/fair/oscar, this model has no emissions-scenario handling of
its own -- it's driven directly by an Effective Radiative Forcing (ERF)
time series (confirmed via run_scenarios()'s driver_var default). The
bundled rcmip-erf.csv (see Dockerfile's comment) supplies that ERF input
for the same 8 SSPs sandboxes/fair/run.py exposes, since fair/hector/oscar
already give users SSP-named options and there's no reason to introduce a
9th scenario-naming scheme for a model that doesn't define its own.

Confirmed by direct testing (bare Debian 12 host, same situation as
sandboxes/fair -- no Docker daemon available in the authoring environment):
loading the bundled CSV via `ScmRun(path, lowercase_cols=True)`, filtering
to one scenario, and calling `TwoLayerModel().run_scenarios(...)` really
produces a real temperature response (e.g. ssp585's Surface Temperature
rises to ~9.1 degC by 2500, ssp126 levels off around ~1.6 degC) -- not a
stub. Took well under a second per scenario, including import time.
"""
import json
import os
import sys

from scmdata import ScmRun
from openscm_twolayermodel import TwoLayerModel

DEFAULT_PARAMS = {"scenario": "ssp245"}

# Same 8 SSPs sandboxes/fair/run.py exposes -- confirmed present in the
# bundled rcmip-erf.csv via `ScmRun(path).meta["scenario"]`.
SUPPORTED_SCENARIOS = {
    "ssp119",
    "ssp126",
    "ssp245",
    "ssp370",
    "ssp434",
    "ssp460",
    "ssp534-over",
    "ssp585",
}

DATA_PATH = os.path.join(os.path.dirname(__file__), "rcmip-erf.csv")


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
    scenario_name = params.get("scenario", DEFAULT_PARAMS["scenario"])
    if scenario_name not in SUPPORTED_SCENARIOS:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "error": f"unsupported scenario '{scenario_name}'. "
                    f"supported: {sorted(SUPPORTED_SCENARIOS)}",
                }
            )
        )
        sys.exit(1)

    driver = ScmRun(DATA_PATH, lowercase_cols=True).filter(scenario=scenario_name)

    # The only parameter openscm-twolayermodel exposes that's both simple to
    # pass through and confirmed (by direct testing) to actually change the
    # result: `lambda0`, the climate feedback parameter (W/m^2 per degC of
    # warming) -- lower values mean less heat radiated away per degree of
    # warming, i.e. higher effective climate sensitivity. Passed in the same
    # units pint expects (W/m^2/delta_degC); the model's own documented
    # default is 3.74/3 ~= 1.2467.
    run_kwargs = {}
    if "climate_feedback_parameter" in params:
        from openscm_units import unit_registry as ur

        run_kwargs["lambda0"] = float(params["climate_feedback_parameter"]) * ur(
            "W/m^2/delta_degC"
        )

    runner = TwoLayerModel(**run_kwargs)
    output = runner.run_scenarios(driver, progress=False)

    # "Surface Temperature|Upper" is TwoLayerModel's own name for the
    # upper-layer (surface) temperature anomaly relative to the start of the
    # ERF driver series (confirmed via output.meta["variable"].unique()) --
    # analogous to hector's temperature.global_tas.
    temp = output.filter(variable="Surface Temperature|Upper").timeseries()
    years = [d.year for d in temp.columns]
    values = temp.iloc[0].tolist()

    result = {
        "status": "succeeded",
        "model": "twolayer",
        "scenario": scenario_name,
        "result": {
            "years": years,
            "T_atmos": values,
        },
    }

    try:
        os.makedirs("/output", exist_ok=True)
        with open("/output/result.json", "w") as f:
            json.dump(result, f)
    except PermissionError:
        pass

    print(json.dumps(result))


if __name__ == "__main__":
    main()
