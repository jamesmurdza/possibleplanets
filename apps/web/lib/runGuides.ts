/**
 * "How to run this yourself" guides for the models that genuinely don't
 * need Docker to run -- no compiled C/C++ extension, no OS-level emulation
 * layer (Wine), no source patch to a dependency, just the language's own
 * package manager. See the Dockerfile comments this is grounded in:
 * sandboxes/fair/Dockerfile ("no compiled extension or extra system
 * packages were needed"), sandboxes/oscar/Dockerfile (git clone + plain
 * pip, no compiler), sandboxes/dice/Dockerfile (a plain `Pkg.add` with two
 * version pins, no OS packages). hector (needs libboost-all-dev + a C++
 * toolchain), magicc (needs Wine), and twolayer (needs a source patch to
 * the installed package) are deliberately NOT here -- Docker earns its
 * keep for those three.
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
 */

export interface RunGuideStep {
  text: string;
  code?: string;
}

const RUN_GUIDES: Record<string, RunGuideStep[]> = {
  fair: [
    {
      text: "FAIR is a plain Python package, with no compiled extension or system packages required.",
      code: "pip install fair",
    },
    {
      text: "From there, follow FAIR's own documented example to define a scenario, configure it, and run it -- linked above as this model's website. The shortest version that actually runs end to end looks like this (illustrative, not calibrated, climate parameters):",
      code:
        'from fair import FAIR\nfrom fair.io import read_properties\nfrom fair.interface import initialise, fill\n\nf = FAIR()\nf.define_time(2000, 2050, 1)\nf.define_scenarios(["ssp245"])\nf.define_configs(["central"])\n\nspecies, properties = read_properties()\nf.define_species(species, properties)\nf.allocate()\n\nf.fill_species_configs()\nf.fill_from_rcmip()  # downloads standard SSP emissions/concentrations\n\n# illustrative (not calibrated) ocean heat response\nfill(f.climate_configs["ocean_heat_capacity"], [5, 20, 100], config="central")\nfill(f.climate_configs["ocean_heat_transfer"], [1.0, 2.0, 1.0], config="central")\nfill(f.climate_configs["deep_ocean_efficacy"], 1.29, config="central")\n\ninitialise(f.concentration, f.species_configs["baseline_concentration"])\ninitialise(f.forcing, 0)\ninitialise(f.temperature, 0)\ninitialise(f.cumulative_emissions, 0)\ninitialise(f.airborne_emissions, 0)\n\nf.run()\nprint(f.temperature.sel(layer=0, scenario="ssp245", config="central").values[-5:])',
    },
  ],
  oscar: [
    {
      text: "OSCAR is distributed as a Git repository managed with Poetry, not a pip package.",
      code: "git clone https://github.com/jamesmurdza/OSCAR.git\ncd OSCAR\npoetry install",
    },
    {
      text: "Run one of its own example scripts directly through Poetry, from inside that cloned directory.",
      code: "poetry run python run_scripts/basic_example_1.py",
    },
  ],
  dice: [
    {
      text: "DICE runs on Julia's own package manager. Add the pinned Ipopt solver and the DICE.jl package directly from its repository -- these exact versions avoid a real segfault in a newer Ipopt/DICE.jl combination.",
      code:
        'using Pkg\nPkg.add(Pkg.PackageSpec(name="Ipopt", version="1.0.2"))\nPkg.add(url="https://github.com/possibleplanets/DICE.jl", rev="754e9ba250e549f3f385a9b5e9c7f39117d29b4d")\nPkg.pin(Pkg.PackageSpec(name="Ipopt", version="1.0.2"))',
    },
    {
      text: "Solve a named policy path and read its atmospheric temperature series back out.",
      code: "using DICE\nresult = solve(OptimalPrice, v2016R2())\nresult.results.Tₐₜ",
    },
  ],
};

export function runGuide(model: string): RunGuideStep[] | null {
  return RUN_GUIDES[model] ?? null;
}
