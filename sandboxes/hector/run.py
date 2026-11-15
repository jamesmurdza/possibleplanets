"""
Run script for the HECTOR sandbox image.

Per the platform spec (PLATFORM.md), run-specific input is injected at run time,
not baked into the image. This script reads scenario/params as JSON, either from
the SCENARIO_PARAMS env var or from a file at /input/params.json (whichever the
sandbox orchestration ends up using), runs pyhector, and writes the native result
as JSON to stdout and to /output/result.json.

No cross-model output normalization here (per PLATFORM.md's minimal-version
decision) -- this is pyhector's native result, untouched.
"""
import json
import os
import sys

import pyhector

DEFAULT_PARAMS = {"scenario": "ssp126"}

# Known-good native scenario names for this model, exposed via /v1/models/hector/schema
# in the real API; listed here for reference while this is just a sandbox script.
SUPPORTED_SCENARIOS = {
    "ssp119": pyhector.ssp119 if hasattr(pyhector, "ssp119") else None,
    "ssp126": pyhector.ssp126,
    "ssp245": getattr(pyhector, "ssp245", None),
    "ssp370": getattr(pyhector, "ssp370", None),
    "ssp585": getattr(pyhector, "ssp585", None),
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
                    f"supported: {sorted(k for k, v in SUPPORTED_SCENARIOS.items() if v is not None)}",
                }
            )
        )
        sys.exit(1)

    output_df = pyhector.run(scenario)

    result = {
        "status": "succeeded",
        "model": "hector",
        "scenario": scenario_name,
        # Native pyhector output: a pandas DataFrame indexed by year, with columns
        # like temperature.global_tas, simpleNbox.CO2_concentration, forcing.RF_tot
        # (confirmed by manual testing). Returned untouched, per the minimal
        # output-shape decision in PLATFORM.md.
        "result": {
            "columns": list(output_df.columns),
            "index": list(output_df.index),
            "data": output_df.to_dict(orient="list"),
        },
    }

    # /output is expected to be a mounted volume in the sandbox; fall back to
    # stdout-only if it's not writable (e.g. when running this script directly
    # on a host for testing, outside the container).
    try:
        os.makedirs("/output", exist_ok=True)
        with open("/output/result.json", "w") as f:
            json.dump(result, f)
    except PermissionError:
        pass

    print(json.dumps(result))


if __name__ == "__main__":
    main()
