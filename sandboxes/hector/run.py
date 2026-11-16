"""
Run script for the HECTOR sandbox image.

Per the platform spec (PLATFORM.md), run-specific input is injected at run time,
not baked into the image. This script reads scenario/params as JSON, either from
the SCENARIO_PARAMS env var or from a file at /input/params.json (whichever the
sandbox orchestration ends up using), runs pyhector, and writes the native result
as JSON to stdout and to /output/result.json.

No cross-model output normalization here (per PLATFORM.md's minimal-version
decision) -- this is pyhector's native result, untouched.

Optional tunable parameters (climate_sensitivity/ocean_diffusivity/
aerosol_scaling) are passed straight through to pyhector's own `config`
override dict -- confirmed by direct testing that passing pyhector's own
documented default values this way (temperature.S=3.0, diff=2.38, alpha=1.0)
reproduces bit-identical output to calling pyhector.run() with no config
override at all, so this is a real, verified override path, not a guess.
When a key is omitted here, no default is substituted -- it's simply not
passed to pyhector's config at all (letting pyhector's own build-in default
apply), not stood in for by this script's own copy of that default. See
apps/web/lib/models.ts's module docstring for why that distinction matters
for caching.
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

    # Build the config override from only whatever keys were actually
    # supplied -- never synthesize a value for an omitted key (see the
    # module docstring on why "omitted" and "explicit default" are kept
    # distinct here).
    config = {}
    if "climate_sensitivity" in params:
        config.setdefault("temperature", {})["S"] = float(params["climate_sensitivity"])
    if "ocean_diffusivity" in params:
        config.setdefault("temperature", {})["diff"] = float(params["ocean_diffusivity"])
    if "aerosol_scaling" in params:
        config.setdefault("temperature", {})["alpha"] = float(params["aerosol_scaling"])

    output_df = pyhector.run(scenario, config=config or None)

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
