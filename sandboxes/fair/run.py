"""
Run script for the FAIR sandbox image.

Adapted from the Colab walkthrough in guides/FAIR.markdown into a parametrized
script, following the same pattern as sandboxes/hector/run.py: params are read
at run time (env var or /input/params.json), not baked into the image, and the
result is FAIR's native output, untouched (no cross-model normalization yet,
per PLATFORM.md's minimal-version decision).

NOT YET BUILD-TESTED (no Docker daemon available in the authoring environment --
see PLATFORM.md build plan). Review closely against guides/FAIR.markdown before
relying on this.
"""
import json
import os

import numpy as np
import pandas as pd
from fair import FAIR
from fair.io import read_properties
from fair.interface import fill, initialise

DEFAULT_PARAMS = {"scenarios": ["ssp126"]}


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
    scenarios = params.get("scenarios", DEFAULT_PARAMS["scenarios"])

    f = FAIR(ch4_method="thornhill2021")
    f.define_time(1750, 2100, 1)
    f.define_scenarios(scenarios)

    df = pd.read_csv(
        "https://raw.githubusercontent.com/OMS-NetZero/FAIR/refs/heads/master/tests/test_data/4xCO2_cummins_ebm3.csv"
    )
    models = df["model"].unique()
    configs = []
    for model in models:
        for run in df.loc[df["model"] == model, "run"]:
            configs.append(f"{model}_{run}")
    f.define_configs(configs)

    species, properties = read_properties()
    f.define_species(species, properties)
    f.allocate()

    f.fill_species_configs()
    fill(f.species_configs["unperturbed_lifetime"], 10.8537568, specie="CH4")
    fill(f.species_configs["baseline_emissions"], 19.01978312, specie="CH4")
    fill(f.species_configs["baseline_emissions"], 0.08602230754, specie="N2O")

    df_volcanic = pd.read_csv(
        "https://raw.githubusercontent.com/OMS-NetZero/FAIR/refs/heads/master/tests/test_data/volcanic_ERF_monthly_175001-201912.csv",
        index_col="year",
    )
    f.fill_from_rcmip()

    volcanic_forcing = np.zeros(351)
    volcanic_forcing[:271] = (
        df_volcanic[1749:]
        .groupby(np.ceil(df_volcanic[1749:].index) // 1)
        .mean()
        .squeeze()
        .values
    )
    fill(f.forcing, volcanic_forcing[:, None, None], specie="Volcanic")

    initialise(f.concentration, f.species_configs["baseline_concentration"])
    initialise(f.forcing, 0)
    initialise(f.temperature, 0)
    initialise(f.cumulative_emissions, 0)
    initialise(f.airborne_emissions, 0)

    seed = 1355763
    for config in configs:
        model, run = config.split("_")
        condition = (df["model"] == model) & (df["run"] == run)
        fill(
            f.climate_configs["ocean_heat_capacity"],
            df.loc[condition, "C1":"C3"].values.squeeze(),
            config=config,
        )
        fill(
            f.climate_configs["ocean_heat_transfer"],
            df.loc[condition, "kappa1":"kappa3"].values.squeeze(),
            config=config,
        )
        fill(
            f.climate_configs["deep_ocean_efficacy"],
            df.loc[condition, "epsilon"].values[0],
            config=config,
        )
        fill(
            f.climate_configs["gamma_autocorrelation"],
            df.loc[condition, "gamma"].values[0],
            config=config,
        )
        fill(
            f.climate_configs["sigma_eta"],
            df.loc[condition, "sigma_eta"].values[0],
            config=config,
        )
        fill(
            f.climate_configs["sigma_xi"],
            df.loc[condition, "sigma_xi"].values[0],
            config=config,
        )
        fill(f.climate_configs["stochastic_run"], True, config=config)
        fill(f.climate_configs["use_seed"], True, config=config)
        fill(f.climate_configs["seed"], seed, config=config)
        seed += 399

    f.run()

    result = {
        "status": "succeeded",
        "model": "fair",
        "scenarios": scenarios,
        "result": {
            "timebounds": list(f.timebounds),
            "temperature": {
                scenario: f.temperature.loc[dict(scenario=scenario, layer=0)]
                .values.squeeze()
                .tolist()
                for scenario in scenarios
            },
        },
    }

    # See sandboxes/hector/run.py for why this is wrapped: /output is expected
    # to be a mounted volume in the sandbox and isn't writable when running
    # this script directly on a host outside the container.
    try:
        os.makedirs("/output", exist_ok=True)
        with open("/output/result.json", "w") as out:
            json.dump(result, out)
    except PermissionError:
        pass

    print(json.dumps(result))


if __name__ == "__main__":
    main()
