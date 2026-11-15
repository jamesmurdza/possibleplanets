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

PROGRESS_FILE = "/tmp/progress.json"


def _write_progress(percent):
    """
    Best-effort progress write, read back by the gateway via a separate
    filesystem read (not stdout/exec logs -- confirmed by testing that
    Daytona's session log APIs buffer everything until the command finishes,
    so they can't report progress mid-run; a direct file read can).
    """
    try:
        with open(PROGRESS_FILE, "w") as f:
            json.dump({"percent": percent}, f)
            f.flush()
            os.fsync(f.fileno())
    except Exception:
        pass


def _patch_fair_progress_bar():
    """
    FAIR's own fair.py does `from tqdm.auto import tqdm` at module level and
    iterates its main loop with `for i_timepoint in tqdm(range(...))`
    (confirmed by reading the installed library's source). Since that `tqdm`
    name is looked up from the module's globals at call time, re-assigning
    `fair.fair.tqdm` to a subclass before calling f.run() intercepts every
    real update from FAIR's own progress bar -- this is FAIR's actual
    per-timestep progress, not a synthetic estimate.
    """
    import fair.fair as fair_internal
    from tqdm.auto import tqdm as _tqdm

    class _ProgressWritingTqdm(_tqdm):
        def update(self, n=1):
            super().update(n)
            if self.total:
                _write_progress(int(100 * self.n / self.total))

    fair_internal.tqdm = _ProgressWritingTqdm


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
    # NOTE: guides/FAIR.markdown uses plain bracket slicing (`df_volcanic[1749:]`),
    # which is POSITIONAL here, not label-based, because the index is a float
    # (fractional-year) index that doesn't exactly match the integer 1749. That
    # silently selects the wrong 1491 rows (confirmed by testing: the sliced data
    # starts at year ~1895.75, not 1749) and produces only 125 groups instead of
    # the 271 the next line assumes, crashing with a broadcast error. `.loc[1749:]`
    # is the correct label-based slice and yields the expected 3240/271 shapes.
    volcanic_forcing[:271] = (
        df_volcanic.loc[1749:]
        .groupby(np.ceil(df_volcanic.loc[1749:].index) // 1)
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

    _write_progress(0)
    _patch_fair_progress_bar()
    f.run()
    _write_progress(100)

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
