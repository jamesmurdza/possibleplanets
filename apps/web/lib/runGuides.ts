/**
 * "How to run this yourself" guides for every model that has a sandboxes/*
 * Dockerfile. Each model gets exactly two sections (see RunGuideSection
 * below): "How to run <X> locally" (installing and running it yourself,
 * no Daytona involved) and "How to run <X> through the REST API" (calling
 * this project's own hosted gateway instead).
 *
 * Local-setup steps, by model:
 *   - fair/oscar/dice: a plain package-manager path (pip/poetry/Pkg.add)
 *     is enough -- no compiler, no OS-level emulation layer, no source
 *     patch to a dependency.
 *   - hector/magicc/twolayer: a plain package-manager install is confirmed
 *     broken on a bare machine (each sandboxes/<model>/Dockerfile's own
 *     comments document the exact failure: hector needs a C++ toolchain
 *     to compile its core, magicc needs Wine, twolayer needs a source
 *     patch for pandas compatibility), so the step instead builds/runs
 *     that Dockerfile -- the one path actually confirmed to work.
 *
 * Every model's REST section is built by restApiStep(): one curl example
 * that submits a run and polls it to completion against this project's
 * real gateway (deployed at https://possibleplanets.org), followed by
 * apiCostStep()'s per-run cost estimate. `params`/`resultValue` are REAL,
 * not invented -- each is the model's actual native request/response from
 * actually running that model's sandboxes/<model>/run.py (or run.jl)
 * logic. The full, untruncated result is checked into
 * docs/api-examples/<model>.json (docs/api-examples/README.md explains
 * how). The one exception is magicc: Wine couldn't be installed in the
 * authoring environment (ran out of disk twice), so its example is
 * illustrative, not independently re-executed -- flagged as such.
 *
 * Both resource/cost estimates are built from real, cited numbers:
 *   - Local disk/CPU/memory figures: measured directly this session
 *     (`du -sh` on the actual install, real wall-clock timing).
 *   - Daytona $ cost: Daytona's own published per-second pricing applied
 *     to this project's actual configured `resources` for that model
 *     (lib/models.ts) and the real median exec time from
 *     docs/sandbox-resource-experiments.md's CPU sweep.
 */

import { modelAcronym } from "./modelFullNames";

// Daytona's own published per-second rates (https://www.daytona.io/pricing,
// confirmed Nov 2026). Storage's first 5 GiB is free; only oscar's
// configured disk (10 GiB) exceeds that, so billableDiskGiB is 0 for
// every other model.
const DAYTONA_VCPU_PER_SECOND = 0.0504 / 3600;
const DAYTONA_GIB_MEMORY_PER_SECOND = 0.0162 / 3600;
const DAYTONA_GIB_DISK_PER_SECOND = 0.000108 / 3600;

// Only ever called with amount >= 0.01 (see apiCostStep's ternary below),
// so no need to branch on smaller magnitudes here.
function formatUsd(amount: number): string {
  return `$${amount.toFixed(3)} (~${(amount * 100).toFixed(1)}¢)`;
}

// Below $0.01/run, "per run" reads as a string of leading zeros -- scaling
// to 1,000 runs turns it into a plain dollar amount instead (same formula,
// same inputs, just scaled for readability).
function formatUsdPer1000(amount: number): string {
  return `$${(amount * 1000).toFixed(2)}`;
}

// Rounds to a whole number of seconds -- these are real measured medians,
// but "19.63 seconds" reads as more precise than a single real run
// actually is (run-to-run variance is easily a second either way), so
// "about 20 seconds" is the honest level of precision to show. Past a
// minute, drop seconds entirely and round to the nearest minute --
// showing "522 seconds (around 9 minutes)" pairs an exact-looking
// number with a rounded one for no reason once minutes are the unit a
// reader actually cares about.
function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  if (seconds >= 60) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${rounded} second${rounded === 1 ? "" : "s"}`;
}

/**
 * Final step of every model's "Run through the API" section: a plain-
 * language cost estimate that names the exact resources it's based on
 * (cpu/memory match lib/models.ts's actual `resources` for this model;
 * memory omitted there means no override was applied, so 1 GiB is used,
 * matching the untouched baseline cell in
 * docs/sandbox-resource-experiments.md's own 2x2 experiment). Disk only
 * factors into the cost for oscar (10 GiB configured, 5 free -> 5
 * billable) but isn't called out in the sentence itself -- it's a minor
 * contributor next to CPU/memory/time.
 */
function apiCostStep(model: string, cpu: number, memoryGiB: number, seconds: number, billableDiskGiB = 0): RunGuideStep {
  const cost =
    cpu * DAYTONA_VCPU_PER_SECOND * seconds +
    memoryGiB * DAYTONA_GIB_MEMORY_PER_SECOND * seconds +
    billableDiskGiB * DAYTONA_GIB_DISK_PER_SECOND * seconds;
  const costPhrase = cost >= 0.01 ? `${formatUsd(cost)} per run` : `${formatUsdPer1000(cost)} per 1,000 runs`;
  return {
    label: "Cost",
    text:
      `This model runs on ${cpu} vCPU${cpu === 1 ? "" : "s"} and ${memoryGiB} GiB of memory for about ` +
      `${formatDuration(seconds)} per run, which costs roughly ${costPhrase} on Daytona. Results that are ` +
      `already cached are free, since no new sandbox is created.`,
  };
}

/**
 * Final step of every model's "How to run locally" section: a plain-
 * language resource estimate for running it on your own machine (not a
 * Daytona sandbox) -- disk footprint from a real `du -sh`, timing from a
 * real measured run, both from this session's own install.
 */
function localResourceStep(text: string): RunGuideStep {
  return { label: "Resource footprint", text };
}

// Real (not invented) domain this app is actually deployed at.
const SITE_ORIGIN = "https://possibleplanets.org";

// Illustrative run_id -- the real endpoint returns a fresh randomUUID()
// (lib/runs.ts) on every call, never this literal value.
const EXAMPLE_RUN_ID = "a1b2c3d4-5e6f-4789-9abc-def012345678";

/**
 * Builds the one curl example every model's REST section uses: submit a
 * run with a real API key, then poll it to completion. Mirrors the real
 * GET /v1/runs/{run_id} response shape (status/result/duration_seconds).
 * `resultValue` is the model's real native `result` value; `resultNote`
 * is a one-line real headline number. `durationSeconds` matches the exact
 * median apiCostStep() uses for the same model, so the two stay
 * consistent.
 */
function restApiStep(model: string, params: string, resultValue: string, resultNote: string, durationSeconds: number): RunGuideStep {
  const indentedResult = resultValue
    .split("\n")
    .map((line, i) => (i === 0 ? line : `    ${line}`))
    .join("\n");

  return {
    label: "Call it over HTTP",
    text: "Submit a run with your API key, then poll it until it finishes.",
    code:
      `curl -X POST ${SITE_ORIGIN}/v1/models/${model}/runs \\\n` +
      `  -H "Authorization: Bearer YOUR_API_KEY" \\\n` +
      `  -d '{"params": ${params}}'\n` +
      `# -> {"run_id": "${EXAMPLE_RUN_ID}", "status": "queued"}\n` +
      `\n` +
      `curl ${SITE_ORIGIN}/v1/runs/${EXAMPLE_RUN_ID} \\\n` +
      `  -H "Authorization: Bearer YOUR_API_KEY"\n` +
      `# -> {\n` +
      `#   "status": "succeeded",\n` +
      `#   "result": ${indentedResult},\n` +
      `#   "duration_seconds": ${durationSeconds}\n` +
      `# }\n` +
      `# ${resultNote}`,
    language: "bash",
    note: "Cached results don't need an API key.",
  };
}

export interface RunGuideStep {
  // Short bold lead-in shown above the step body, e.g. "Install" or
  // "Cost" -- lets a reader scan step titles instead of parsing a
  // paragraph to find the verb. Optional on the type only so a future
  // one-off step isn't forced to invent a label that doesn't fit.
  label?: string;
  // The instruction/fact itself, as one or more complete sentences.
  text: string;
  code?: string;
  // Prism.js language id for `code`, when present.
  language?: "bash" | "python" | "julia";
  // Secondary aside, kept short -- e.g. the REST step's caching caveat.
  note?: string;
}

export interface RunGuideSection {
  heading: string;
  steps: RunGuideStep[];
}

function sections(model: string, localSteps: RunGuideStep[], apiSteps: RunGuideStep[]): RunGuideSection[] {
  const name = modelAcronym(model);
  return [
    { heading: `How to run ${name} locally`, steps: localSteps },
    { heading: `How to run ${name} through the REST API`, steps: apiSteps },
  ];
}

const RUN_GUIDES: Record<string, RunGuideSection[]> = {
  fair: sections(
    "fair",
    [
      {
        label: "Install",
        text: "FAIR is a plain Python package. It needs no compiled extension and no system packages.",
        code: "pip install fair",
        language: "bash",
      },
      {
        label: "Run a minimal example",
        text:
          "Define a scenario, configure it, and run it. This is the shortest version that runs end to end, using " +
          "illustrative (not calibrated) climate parameters -- see FAIR's own docs (linked above) for the full " +
          "calibrated walkthrough.",
        code:
          'from fair import FAIR\nfrom fair.io import read_properties\nfrom fair.interface import initialise, fill\n\nf = FAIR()\nf.define_time(2000, 2050, 1)\nf.define_scenarios(["ssp245"])\nf.define_configs(["central"])\n\nspecies, properties = read_properties()\nf.define_species(species, properties)\nf.allocate()\n\nf.fill_species_configs()\nf.fill_from_rcmip()  # downloads standard SSP emissions/concentrations\n\n# illustrative (not calibrated) ocean heat response\nfill(f.climate_configs["ocean_heat_capacity"], [5, 20, 100], config="central")\nfill(f.climate_configs["ocean_heat_transfer"], [1.0, 2.0, 1.0], config="central")\nfill(f.climate_configs["deep_ocean_efficacy"], 1.29, config="central")\n\ninitialise(f.concentration, f.species_configs["baseline_concentration"])\ninitialise(f.forcing, 0)\ninitialise(f.temperature, 0)\ninitialise(f.cumulative_emissions, 0)\ninitialise(f.airborne_emissions, 0)\n\nf.run()\nprint(f.temperature.sel(layer=0, scenario="ssp245", config="central").values[-5:])',
        language: "python",
      },
      localResourceStep(
        "Installing FAIR takes about 450MB of disk space (mostly numpy/scipy/pandas/xarray, not FAIR's own code). " +
          "Running the full ssp245 ensemble above (66 climate configs) takes about 13 to 19 seconds on 1 to 2 " +
          "CPUs, with no meaningful memory requirement.",
      ),
    ],
    [
      restApiStep(
        "fair",
        '{"scenarios": ["ssp245"]}',
        '{\n' +
          '    "timebounds": [1750.0, 1751.0, ..., 2099.0, 2100.0],  // 351 years\n' +
          '    "temperature": { "ssp245": [ [0.0, ...66 configs...], ..., [2.38, 2.29, 2.58, 4.13, ...] ] }\n' +
          '  }',
        "year 2100, mean across 66 climate configs: 3.61°C",
        14.63,
      ),
      apiCostStep("fair", 2, 1, 14.63),
    ],
  ),
  oscar: sections(
    "oscar",
    [
      {
        label: "Install",
        text: "OSCAR is distributed as a Git repository managed with Poetry, not a pip package.",
        code: "git clone https://github.com/jamesmurdza/OSCAR.git\ncd OSCAR\npoetry install",
        language: "bash",
      },
      {
        label: "Run a minimal example",
        text: "Run one of its own example scripts directly through Poetry, from inside that cloned directory.",
        code: "poetry run python run_scripts/basic_example_1.py",
        language: "bash",
      },
      localResourceStep(
        "Installing OSCAR takes about 770MB of disk space. A full run takes 6 to 9 minutes on 4 CPUs with 8GB of " +
          "memory. Without that memory, it gets OOM-killed in under 10 seconds just loading its parameter files.",
      ),
    ],
    [
      restApiStep(
        "oscar",
        '{"scenario": "SSP2-4.5", "nMC": 1}',
        '{\n' +
          '    "year": [1750, 1751, ..., 2099, 2100],  // 351 years\n' +
          '    "mean_D_Tg": [0.0, -0.0028, ..., 2.517, 2.521],\n' +
          '    "std_D_Tg": [0.0, 0.0, ..., 0.0, 0.0]  // 0 at nMC=1 -- only one sample, nothing to vary\n' +
          '  }',
        "mean_D_Tg at year 2100 = 2.52°C",
        522,
      ),
      apiCostStep("oscar", 4, 8, 522, 5),
    ],
  ),
  dice: sections(
    "dice",
    [
      {
        label: "Install",
        text:
          "Add the pinned Ipopt solver and the DICE.jl package directly from its repository. These exact " +
          "versions avoid a real segfault in a newer Ipopt/DICE.jl combination.",
        code:
          'using Pkg\nPkg.add(Pkg.PackageSpec(name="Ipopt", version="1.0.2"))\nPkg.add(url="https://github.com/possibleplanets/DICE.jl", rev="754e9ba250e549f3f385a9b5e9c7f39117d29b4d")\nPkg.pin(Pkg.PackageSpec(name="Ipopt", version="1.0.2"))',
        language: "julia",
      },
      {
        label: "Run a minimal example",
        text: "Solve a named policy path and read its atmospheric temperature series back out.",
        code:
          "using DICE\nresult = solve(OptimalPrice, v2016R2())\nresult.results.Tₐₜ\n# [0.85, 1.016, 1.184, 1.354, 1.524, ..., 4.001, 3.997, 3.993, 3.989]  (°C, from ~1900)\n# 100 values total, years 2015-2510 in 5-year steps",
        language: "julia",
      },
      localResourceStep(
        "Installing Julia, Ipopt, and DICE.jl takes about 1.1 to 1.2GB of disk space. The first solve on a fresh " +
          "install spends several minutes precompiling Julia packages; after that, each solve takes about 8 to " +
          "17 seconds on 1 to 2 CPUs. No commercial solver license is needed.",
      ),
    ],
    [
      restApiStep(
        "dice",
        '{"scenario": "optimal"}',
        '{\n' +
          '    "years": [2015, 2020, ..., 2505, 2510],  // 100 steps, every 5 years\n' +
          '    "T_atmos": [0.85, 1.016, 1.184, ..., 3.993, 3.989],  // same real run as above\n' +
          '    "scc": [...], "forcing": [...], "utility": [...]  // also real fields, see run.jl\n' +
          '  }',
        "T_atmos at year 2100 = 3.48°C, peaking at 4.15°C around year 2240",
        19.63,
      ),
      apiCostStep("dice", 2, 1, 19.63),
    ],
  ),
  hector: sections(
    "hector",
    [
      {
        label: "Build and run",
        text:
          "Build and run this repo's own sandboxes/hector/Dockerfile, which installs the system packages pyhector " +
          "needs to compile its C++ core from source -- a plain `pip install pyhector` fails on a bare machine " +
          "without them.",
        code: "docker build -t hector-sandbox sandboxes/hector\ndocker run --rm hector-sandbox",
        language: "bash",
      },
      localResourceStep(
        "Building the Docker image installs about 800MB of dependencies, mostly Boost headers and a C/C++ " +
          "compiler used once to build Hector's core. After that, each run takes about 1 to 2 seconds on 1 to 2 " +
          "CPUs, with no meaningful memory requirement.",
      ),
    ],
    [
      restApiStep(
        "hector",
        '{"scenario": "ssp245"}',
        '{\n' +
          '    "columns": ["temperature.global_tas", "simpleNbox.CO2_concentration", "forcing.RF_tot"],\n' +
          '    "index": [1745, 1746, ..., 2299, 2300],  // 556 years\n' +
          '    "data": {\n' +
          '      "temperature.global_tas": [0.0, 0.0, ..., 2.7623, 2.7599],\n' +
          '      "simpleNbox.CO2_concentration": [277.15, 277.19, ..., 517.66, 517.27],\n' +
          '      "forcing.RF_tot": [0.0, 0.0, ..., 3.9049, 3.8998]\n' +
          '    }\n' +
          '  }',
        "year 2100: temperature.global_tas = 2.72°C",
        1.25,
      ),
      apiCostStep("hector", 2, 1, 1.25),
    ],
  ),
  magicc: sections(
    "magicc",
    [
      {
        label: "Build and run",
        text:
          "Build and run this repo's own sandboxes/magicc/Dockerfile, which installs Wine (pymagicc wraps a real " +
          "Windows MAGICC6.exe binary via it) and pins xarray to a version confirmed to work -- pymagicc's current " +
          "pip dependency resolution otherwise pulls a newer xarray it can't import.",
        code: "docker build -t magicc-sandbox sandboxes/magicc\ndocker run --rm magicc-sandbox",
        language: "bash",
      },
      localResourceStep(
        "Wine alone needs at least 2 to 3GB of free disk space, on top of pymagicc's own small (tens of MB) " +
          "footprint. That didn't fit in the environment used to write this guide, which had only about 1.6GB " +
          "free, so budget more than that if you're installing it yourself.",
      ),
    ],
    [
      restApiStep(
        "magicc",
        '{"scenario": "RCP45"}',
        '{\n' +
          '    "years": [1765, 1766, ..., 2499, 2500],\n' +
          '    "T_atmos": [0.0, 0.01, ..., 2.6, 2.6]  // ILLUSTRATIVE -- see docs/api-examples/README.md\n' +
          '  }',
        "illustrative data, not an independently re-executed run -- see docs/api-examples/README.md",
        5.5,
      ),
      apiCostStep("magicc", 2, 1, 5.5),
    ],
  ),
  twolayer: sections(
    "twolayer",
    [
      {
        label: "Build and run",
        text:
          "Build and run this repo's own sandboxes/twolayer/Dockerfile, which patches a 2-line pandas API call " +
          "openscm-twolayermodel==0.2.3 makes that pandas>=2.0 removed -- no pandas version compatible with both " +
          "this package and Python 3.11 exists on PyPI, so the installed package itself needs the patch.",
        code: "docker build -t twolayer-sandbox sandboxes/twolayer\ndocker run --rm twolayer-sandbox",
        language: "bash",
      },
      localResourceStep(
        "Installing openscm-twolayermodel takes about 208MB of disk space, the smallest footprint of any model " +
          "here. A run completes in well under a second, with no meaningful CPU or memory requirement.",
      ),
    ],
    [
      restApiStep(
        "twolayer",
        '{"scenario": "ssp245"}',
        '{\n' +
          '    "years": [1750, 1751, 1752, ..., 2499, 2500],  // 751 years\n' +
          '    "T_atmos": [0.0, 0.0392, 0.0637, ..., 3.485, 3.4847]\n' +
          '  }',
        "year 2100: T_atmos = 2.84°C",
        1,
      ),
      apiCostStep("twolayer", 1, 1, 1),
    ],
  ),
};

export function runGuide(model: string): RunGuideSection[] | null {
  return RUN_GUIDES[model] ?? null;
}
