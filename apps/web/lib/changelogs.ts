/**
 * Simple version-history ("changelog") text for each model's public article
 * page (app/models/[model]/page.tsx), rendered right under "What this model
 * assumes" in the same format.
 *
 * Scoped to important/recent versions only, not an exhaustive history --
 * these models (especially hector, fair, magicc, gcam) have dozens of point
 * releases; listing every one would bury the versions that actually matter.
 * Sourced from each project's own release notes/changelog/README, not
 * invented -- see the comment above each entry for where it came from.
 */

export interface ChangelogEntry {
  version: string;
  summary: string;
}

const MODEL_CHANGELOGS: Record<string, ChangelogEntry[]> = {
  // Sourced from JGCRI/hector's GitHub releases and the Hector v3.2.0
  // paper (Vega-Westhoff et al., GMD 17, 4855-4875, 2024).
  hector: [
    {
      version: "v3.2.0 (2024)",
      summary:
        "Corrected aerosol forcing coefficients (based on Zelinka et al. 2023) and enabled a recalibrated permafrost module.",
    },
    {
      version: "v3.1 (2023)",
      summary: "Added global mean surface temperature as a direct model output.",
    },
    {
      version: "v3.0",
      summary: "Rewrote Hector's internals in modern C++ and restructured it around a plug-in component architecture.",
    },
    {
      version: "v2.0",
      summary: "Early open-source release of Hector as a standalone reduced-complexity climate model from JGCRI/PNNL.",
    },
  ],
  // Sourced from OMS-NetZero/FAIR's GitHub releases and CHANGELOG.rst.
  fair: [
    {
      version: "v2.2.2 (2024)",
      summary:
        "Fixed a bug in direct aerosol forcing scaling and quieted unnecessary warning/debug logging.",
    },
    {
      version: "v2.1.0 (2021)",
      summary:
        "The FaIR v2.0 rewrite (Leach et al., GMD 14, 3007-3036, 2021): a vectorized, fully recalibrated reimplementation replacing the original FaIR v1.x impulse-response model.",
    },
    {
      version: "v1.0",
      summary: "Original Finite Amplitude Impulse Response (FaIR) model (Smith et al. 2018).",
    },
  ],
  // Sourced from the OSCAR README on the production snapshot (oscar-production-v2,
  // commit 2200dfd), confirmed directly against the installed /app/oscar/README.md.
  oscar: [
    {
      version: "v3.3",
      summary:
        "Updated global temperature response and effective radiative forcing parameters to IPCC AR6 WG1 Chapter 7 (based on 35 CMIP6 models); switched internal output to mid-year averages; fixed an emissions-summation bug.",
    },
    {
      version: "v3.2",
      summary:
        "Added MESSAGE 11-region aggregation and ODR calibration; improved the ocean carbon cycle (Bern-SCM-based) and adaptive time-stepping.",
    },
    {
      version: "v3.1.1",
      summary: "The exact version used in the IPCC AR6 assessment.",
    },
    {
      version: "v3.0",
      summary: "Last update of the OSCAR v2 line, intended to be as close to OSCAR v3.0 as possible.",
    },
  ],
  // Sourced from Nordhaus's own DICE revision naming (the model's run.jl
  // calls version = v2016R2()) and the published DICE-2016R2 paper
  // (Nordhaus, "Revisiting the social cost of carbon," PNAS 2017).
  dice: [
    {
      version: "DICE-2016R2",
      summary:
        "Nordhaus's 2017 revision -- updated damage function, carbon cycle, and discounting relative to DICE-2013; the version this project runs.",
    },
    {
      version: "DICE-2013R",
      summary: "Revised carbon cycle and updated damage/abatement cost parameters relative to DICE-2007.",
    },
    {
      version: "DICE-2007",
      summary: "Earlier widely-cited revision of Nordhaus's Dynamic Integrated Climate-Economy model.",
    },
  ],
  // Sourced from pymagicc's CHANGELOG.rst and PR history (openscm/pymagicc on
  // GitHub), plus the magicc.org MAGICC7 page; MAGICC6's own version string
  // was confirmed directly by scanning the installed magicc6.exe binary.
  magicc: [
    {
      version: "MAGICC 6.8.01",
      summary:
        "The MAGICC6 generation (Meinshausen, Raper & Wigley, ACP 11, 1417-1456, 2011); this project runs this exact binary, confirmed from its own embedded version banner.",
    },
    {
      version: "pymagicc adds MAGICC7 support",
      summary:
        "pymagicc PR #168 added compatibility with the newer MAGICC7 binaries and restructured pymagicc's bundled MAGICC6 directory layout to match MAGICC7's.",
    },
  ],
  // Sourced from openscm-twolayermodel's own CHANGELOG (Keep a Changelog
  // format) and PyPI release history.
  twolayer: [
    {
      version: "v0.2.3",
      summary: "Most recent release of the two-layer model implementation; the version this project runs.",
    },
    {
      version: "v0.2.0",
      summary: "Added the project's JOSS paper draft describing the implementation.",
    },
    {
      version: "v0.1.0",
      summary:
        "Initial release implementing the Held et al. (2010) and Geoffroy et al. (2013) two-layer energy-balance models.",
    },
  ],
  // Sourced from JGCRI/gcam-core's GitHub releases and jgcri.github.io/gcam-doc's
  // "Recent updates" page.
  gcam: [
    {
      version: "GCAM 7.1",
      summary: "Added forestry product-pool detail, a hydrogen-economy update, and ammonia trade.",
    },
    {
      version: "GCAM 7.0 (2023)",
      summary:
        "Added global iron-and-steel trade and a macro-economic (KLEM) module, and updated the bundled Hector to v3.",
    },
    {
      version: "GCAM 6.0",
      summary: "Added an expanded residential floorspace model.",
    },
  ],
};

export function modelChangelog(model: string): ChangelogEntry[] | null {
  return MODEL_CHANGELOGS[model] ?? null;
}
