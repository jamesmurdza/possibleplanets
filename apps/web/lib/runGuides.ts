/**
 * "How to run this yourself" guides for every model that has a sandboxes/*
 * Dockerfile. Two different shapes of step, by model:
 *
 * fair/oscar/dice: a plain package-manager path (pip/poetry/Pkg.add) is
 * enough -- no compiled C/C++ extension, no OS-level emulation layer
 * (Wine), no source patch to a dependency. See sandboxes/fair/Dockerfile
 * ("no compiled extension or extra system packages were needed"),
 * sandboxes/oscar/Dockerfile (git clone + plain pip, no compiler),
 * sandboxes/dice/Dockerfile (a plain `Pkg.add` with two version pins, no
 * OS packages).
 *
 * hector/magicc/twolayer: the plain package-manager path is confirmed
 * broken on a bare machine (not a style choice -- each Dockerfile's own
 * comments document the exact failure): hector's pyhector needs
 * libboost-all-dev + a C++ toolchain to compile its bundled Hector core
 * from source; magicc's pymagicc needs Wine (it wraps a real MAGICC6.exe)
 * plus an xarray version pin newer pip resolution gets wrong; twolayer
 * needs a 2-line source patch to the installed openscm-twolayermodel
 * package for pandas>=2.0 compatibility. For these three, the guide step
 * below points at `docker build`/`docker run` against this repo's own
 * sandboxes/<model>/Dockerfile -- the only path actually confirmed
 * working for each, per that Dockerfile's own comments -- rather than
 * repeating a pip command already known to fail.
 *
 * Each model's steps are a minimal real path to a result, not the full
 * guides/*.markdown walkthrough -- e.g. FAIR's own full setup (forcing
 * data, per-config ensemble parameters, etc.) is ~80 lines; reproducing
 * all of it here would contradict "keep minimal". FAIR's step list below
 * instead ends with the shortest snippet that actually executes end to
 * end and prints a number -- verified by running it in a fresh venv
 * (fair==2.2.5) rather than guessed. It uses illustrative (not
 * calibrated) ocean heat capacity/transfer values, since no calibrated
 * ensemble ships inside the `fair` package itself; a link to the full
 * guides/FAIR.markdown walkthrough covers the real calibrated version.
 *
 * Every model's step list ends with restApiStep() -- a curl example
 * against this project's own REST gateway (app/v1/*\/route.ts) as an
 * alternative to local setup. Starting a new run needs a real API key
 * (lib/apiKey.ts), created at /account after signing in with GitHub
 * (app/api/auth/github/*, lib/db.ts's users/api_keys tables) -- so the
 * example's YOUR_API_KEY is a literal placeholder and the shown command
 * genuinely 401s, confirmed by testing against a real Postgres-backed
 * dev server. Already-cached (model, params) skip the key check
 * entirely (lib/runs.ts's submitRun) since nothing new is being started.
 */

// Shown as the last step for every model: this project's own REST gateway
// (apps/web/app/v1/*/route.ts), as an alternative to the local setup above.
// POST /v1/models/{model}/runs and GET /v1/runs/{runId} require an
// Authorization: Bearer <API key> header when the request would actually
// start a new sandbox run -- see lib/apiKey.ts. Real per-account keys now
// exist (sign in with GitHub at /account, lib/db.ts's users/api_keys
// tables, app/api/keys/*), so `YOUR_API_KEY` below is a literal
// placeholder for a key you don't have yet, not a stand-in for a feature
// that doesn't exist -- pasting this exact command genuinely 401s,
// confirmed by testing against a real Postgres-backed dev server, not
// guessed. A request whose (model, params) are already cached skips this
// check entirely and returns the cached result with no key at all, since
// nothing new is being authorized in that case -- see lib/runs.ts's
// submitRun().
function restApiStep(model: string): RunGuideStep {
  return {
    text:
      "Or skip local setup entirely and call this project's own REST gateway, which runs the same model in a fresh sandbox per request. Starting a new run requires an API key -- sign in with GitHub at /account to create one. This exact command uses a placeholder key, so it will return 401 Unauthorized as shown; swap in a real key from /account to make it work. (An already-cached result -- same model and params someone already ran -- skips the key check entirely and returns instantly, since nothing new is being started.)",
    code:
      `curl -X POST https://<this-site>/v1/models/${model}/runs \\\n` +
      `  -H "Authorization: Bearer YOUR_API_KEY" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '{"params": {"scenario": "..."}}'\n` +
      `# -> 401 {"detail": "missing or invalid API key"}  (with a real key from /account: 200)`,
    language: "bash",
  };
}

export interface RunGuideStep {
  text: string;
  code?: string;
  // Prism.js language id for `code`, when present -- picks which syntax
  // highlighting grammar CodeBlock loads. Omit for plain shell one-liners
  // where highlighting wouldn't add anything (still renders as plain
  // <pre>, just un-highlighted).
  language?: "bash" | "python" | "julia";
}

const RUN_GUIDES: Record<string, RunGuideStep[]> = {
  fair: [
    {
      text: "FAIR is a plain Python package, with no compiled extension or system packages required.",
      code: "pip install fair",
      language: "bash",
    },
    {
      text: "From there, follow FAIR's own documented example to define a scenario, configure it, and run it -- linked above as this model's website. The shortest version that actually runs end to end looks like this (illustrative, not calibrated, climate parameters):",
      code:
        'from fair import FAIR\nfrom fair.io import read_properties\nfrom fair.interface import initialise, fill\n\nf = FAIR()\nf.define_time(2000, 2050, 1)\nf.define_scenarios(["ssp245"])\nf.define_configs(["central"])\n\nspecies, properties = read_properties()\nf.define_species(species, properties)\nf.allocate()\n\nf.fill_species_configs()\nf.fill_from_rcmip()  # downloads standard SSP emissions/concentrations\n\n# illustrative (not calibrated) ocean heat response\nfill(f.climate_configs["ocean_heat_capacity"], [5, 20, 100], config="central")\nfill(f.climate_configs["ocean_heat_transfer"], [1.0, 2.0, 1.0], config="central")\nfill(f.climate_configs["deep_ocean_efficacy"], 1.29, config="central")\n\ninitialise(f.concentration, f.species_configs["baseline_concentration"])\ninitialise(f.forcing, 0)\ninitialise(f.temperature, 0)\ninitialise(f.cumulative_emissions, 0)\ninitialise(f.airborne_emissions, 0)\n\nf.run()\nprint(f.temperature.sel(layer=0, scenario="ssp245", config="central").values[-5:])',
      language: "python",
    },
    restApiStep("fair"),
  ],
  oscar: [
    {
      text: "OSCAR is distributed as a Git repository managed with Poetry, not a pip package.",
      code: "git clone https://github.com/jamesmurdza/OSCAR.git\ncd OSCAR\npoetry install",
      language: "bash",
    },
    {
      text: "Run one of its own example scripts directly through Poetry, from inside that cloned directory.",
      code: "poetry run python run_scripts/basic_example_1.py",
      language: "bash",
    },
    restApiStep("oscar"),
  ],
  dice: [
    {
      text: "DICE runs on Julia's own package manager. Add the pinned Ipopt solver and the DICE.jl package directly from its repository -- these exact versions avoid a real segfault in a newer Ipopt/DICE.jl combination.",
      code:
        'using Pkg\nPkg.add(Pkg.PackageSpec(name="Ipopt", version="1.0.2"))\nPkg.add(url="https://github.com/possibleplanets/DICE.jl", rev="754e9ba250e549f3f385a9b5e9c7f39117d29b4d")\nPkg.pin(Pkg.PackageSpec(name="Ipopt", version="1.0.2"))',
      language: "julia",
    },
    {
      text: "Solve a named policy path and read its atmospheric temperature series back out.",
      code: "using DICE\nresult = solve(OptimalPrice, v2016R2())\nresult.results.Tₐₜ",
      language: "julia",
    },
    restApiStep("dice"),
  ],
  hector: [
    {
      text: "A plain `pip install pyhector` fails on a bare machine -- it builds Hector's C++ core from source and needs Boost headers it doesn't bundle. This repo's sandboxes/hector/Dockerfile already installs the right system packages, so build and run that image instead of fighting the compile step yourself.",
      code: "docker build -t hector-sandbox sandboxes/hector\ndocker run --rm hector-sandbox",
      language: "bash",
    },
    restApiStep("hector"),
  ],
  magicc: [
    {
      text: "pymagicc wraps a real Windows MAGICC6.exe binary via Wine, and its current pip dependency resolution pulls an xarray version too new for it to import. sandboxes/magicc/Dockerfile installs Wine and pins xarray to a version confirmed to work, so build and run that image rather than installing pymagicc directly.",
      code: "docker build -t magicc-sandbox sandboxes/magicc\ndocker run --rm magicc-sandbox",
      language: "bash",
    },
    restApiStep("magicc"),
  ],
  twolayer: [
    {
      text: "openscm-twolayermodel==0.2.3 calls a pandas API in a form pandas>=2.0 removed, and no pandas version compatible with both this package and Python 3.11 exists on PyPI -- so the installed package itself needs a 2-line patch. sandboxes/twolayer/Dockerfile applies that patch automatically, so build and run that image rather than patching the package by hand.",
      code: "docker build -t twolayer-sandbox sandboxes/twolayer\ndocker run --rm twolayer-sandbox",
      language: "bash",
    },
    restApiStep("twolayer"),
  ],
};

export function runGuide(model: string): RunGuideStep[] | null {
  return RUN_GUIDES[model] ?? null;
}
