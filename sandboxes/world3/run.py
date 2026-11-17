"""
Run script for the WORLD3 sandbox image (pyworld3's World3 -- the "Limits
to Growth" system-dynamics model).

Same params-at-run-time pattern as sandboxes/hector/run.py: scenario/params
read from SCENARIO_PARAMS env var or /input/params.json, output written
untouched (no cross-model normalization, per PLATFORM.md) to stdout and
/output/result.json.

Only one scenario is exposed: "standard_run" -- the "Business as usual"
run pyworld3's own README/hello_world3() example demonstrates. Checked
pyworld3's upstream docs directly before assuming otherwise: unlike the
original 1972 "Limits to Growth" book's named scenarios 1-10 (each a
different combination of resource/pollution/policy constants), pyworld3
ships no pre-built scenario presets of its own -- only documented knobs are
the constructor's year_min/year_max/pyear and init_world3_constants()'s
~80 individual constants. Exposing a second "scenario" here would mean
this project inventing its own constant combinations and calling them
by the book's names, which isn't backed by anything pyworld3 itself
documents -- so this stays at the one real, confirmed scenario for now.

World3 isn't a climate model -- it has no temperature/forcing output at
all. Its five headline variables (confirmed via pyworld3's own
hello_world3() example) are population, nonrenewable resource fraction
remaining, food/industrial output per capita, and a pollution index. All
five are returned here, untouched, rather than this project picking one
and relabeling it to fit the other models' temperature-shaped output.

Confirmed by direct testing (bare Debian 12 host): a full fast-mode run
(year_min=1900, year_max=2100) completes in well under half a second,
including import time -- no real intermediate progress signal exists to
report (same situation as hector/magicc/dice).
"""
import json
import os
import sys

from pyworld3 import World3

DEFAULT_PARAMS = {"scenario": "standard_run"}

SUPPORTED_SCENARIOS = {"standard_run"}


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

    world3 = World3()
    world3.init_world3_constants()
    world3.init_world3_variables()
    world3.set_world3_table_functions()
    world3.set_world3_delay_functions()
    world3.run_world3(fast=True)

    years = world3.time.tolist()

    result = {
        "status": "succeeded",
        "model": "world3",
        "scenario": scenario_name,
        "result": {
            "years": years,
            # Same five series pyworld3's own hello_world3() example plots:
            # nonrenewable resource fraction remaining, industrial output
            # per capita, food per capita, population, pollution index.
            "nrfr": world3.nrfr.tolist(),
            "iopc": world3.iopc.tolist(),
            "fpc": world3.fpc.tolist(),
            "pop": world3.pop.tolist(),
            "ppolx": world3.ppolx.tolist(),
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
