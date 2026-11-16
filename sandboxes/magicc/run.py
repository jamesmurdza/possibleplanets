"""
Run script for the MAGICC sandbox image.

Adapted from guides/MAGICC.markdown's Colab walkthrough into a parametrized
script, following the same pattern as sandboxes/hector/run.py: params are
read at run time (SCENARIO_PARAMS env var or /input/params.json), not baked
into the image, and the result is MAGICC's native output, untouched (no
cross-model normalization, per PLATFORM.md's minimal-version decision).

Confirmed by direct testing (no Docker daemon available in the authoring
environment -- same situation as sandboxes/fair, but this one WAS actually
exercised, on a bare Debian 12 host with the same packages the Dockerfile
installs): `pymagicc.run(pymagicc.rcp26)` really invokes the bundled
MAGICC6.exe through Wine and returns real output -- not a stub. Took ~5-6s
wall-clock for a single scenario, including Python/pymagicc import time.

Scenario names are pymagicc's own four RCPs (RCP26/45/60/85), confirmed via
`pymagicc.rcps["scenario"].unique()` -- a different, smaller taxonomy than
the SSP names hector/fair/oscar use. No cross-model scenario mapping, same
as DICE's own named policy scenarios (see PLATFORM.md).
"""
import json
import os
import sys

import pymagicc

DEFAULT_PARAMS = {"scenario": "RCP26"}

# pymagicc exposes each RCP as a ready-made MAGICCData object (confirmed via
# `pymagicc.rcp26` etc., rather than needing to filter `pymagicc.rcps`
# ourselves).
SUPPORTED_SCENARIOS = {
    "RCP26": pymagicc.rcp26,
    "RCP45": pymagicc.rcp45,
    "RCP60": pymagicc.rcp60,
    "RCP85": pymagicc.rcp85,
}


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
    scenario = SUPPORTED_SCENARIOS.get(scenario_name)
    if scenario is None:
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

    output = pymagicc.run(scenario)

    # "Surface Temperature" / region "World" -- confirmed by testing to be
    # the global-mean temperature anomaly series (K, relative to MAGICC's
    # own pre-industrial baseline), analogous to hector's
    # temperature.global_tas and oscar's mean_D_Tg.
    temp = output.filter(variable="Surface Temperature", region="World")
    timeseries = temp.timeseries()
    years = [d.year for d in timeseries.columns]
    values = timeseries.iloc[0].tolist()

    result = {
        "status": "succeeded",
        "model": "magicc",
        "scenario": scenario_name,
        "result": {
            "years": years,
            "T_atmos": values,
        },
    }

    # /output is expected to be a mounted volume in the sandbox; fall back
    # to stdout-only if it's not writable (e.g. running this script directly
    # on a host for testing, outside the container) -- same as hector/fair.
    try:
        os.makedirs("/output", exist_ok=True)
        with open("/output/result.json", "w") as f:
            json.dump(result, f)
    except PermissionError:
        pass

    print(json.dumps(result))


if __name__ == "__main__":
    main()
