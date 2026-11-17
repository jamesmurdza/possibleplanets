/**
 * Human-readable "what assumptions does this actually make" text for the
 * (i) info modal on each model/scenario card in the New Run form.
 *
 * Every line here is grounded in something already confirmed elsewhere in
 * this codebase (a run.py/run.jl comment, a lib/models.ts comment, or
 * direct testing done earlier in this project) -- nothing here is new
 * speculation, it's a user-facing restatement of facts already documented
 * for developers. Where a source file has the fuller explanation, these
 * are deliberately the short version, not a replacement for it.
 */

export interface AssumptionSection {
  summary: string;
  items: string[];
}

const MODEL_ASSUMPTIONS: Record<string, AssumptionSection> = {
  hector: {
    summary: "A simple, fast, fully deterministic climate model.",
    items: [
      "Physical parameters (climate sensitivity, ocean diffusivity, aerosol scaling, CO2 fertilization, soil respiration Q10) default to pyhector's own built-in values unless you override them -- confirmed these reproduce pyhector's no-override output bit-for-bit.",
      "Temperature is an anomaly relative to pyhector's own ~1750 baseline, not any specific modern reference period.",
      "Fully deterministic -- no random seed involved. The same scenario and parameters always produce the exact same answer, every time.",
      "Has no real progress signal: pyhector's run() finishes in under a second with no intermediate hook to report, so this project doesn't fake one.",
    ],
  },
  fair: {
    summary: "Averages an ensemble of 66 CMIP6-calibrated configurations, not a single run.",
    items: [
      "The chart shows the MEAN temperature across FAIR's own bundled ensemble of 66 CMIP6-calibrated parameter sets -- not one single model run.",
      "CH4 radiative forcing uses FAIR's \"thornhill2021\" calculation method. FAIR also supports an alternate \"leach2021\" method that this project doesn't currently expose as a choice.",
      "The \"seed\" parameter controls each config's own internal stochastic noise realization -- it changes which noise draw each of the 66 configs gets, not which 66 configs are used (that set is fixed).",
      "Runs from 1750 to 2100, annually.",
    ],
  },
  oscar: {
    summary: "Every run is actually two OSCAR simulations stitched together.",
    items: [
      "Each run concatenates a historical leg (1750 to the scenario's start year, started from a zero-valued initial state) with the scenario leg -- this is why OSCAR's chart starts near 0 in 1750 rather than already-elevated partway through.",
      "Uses a fixed regional aggregation (OSCAR's own \"RCP_5reg\" mode). OSCAR supports other spatial resolutions that aren't exposed here.",
      "Monte Carlo sample size (nMC) defaults to 1, the smallest possible -- a real run can take several minutes even at this minimum, and increasing nMC takes proportionally longer.",
      "Always applies a random seed (explicit, or a fixed default of 0) for the Monte Carlo parameter draw -- OSCAR's own code leaves that draw unseeded by default, which this project corrects for so results stay reproducible.",
      "A few scenario/sample-size combinations (e.g. SSP3-7.0-LowNTCF at nMC=1) can genuinely produce NaN partway through the run -- shown as a real gap in the data, not hidden or silently dropped.",
    ],
  },
  dice: {
    summary: "An economic optimization model, not a physical climate simulation.",
    items: [
      "DICE (the Nordhaus DICE/RICE family, v2016R2 here) is an economic model -- it reports the social cost of carbon and an economic utility measure alongside temperature, and temperature is itself downstream of its economic/emissions optimization, not the primary output.",
      "Only two named scenarios exist: \"base\" (no abatement policy) and \"optimal\" (DICE's own economically-optimal path under its built-in objective function). These aren't emissions scenarios in the SSP/RCP sense.",
      "Starts in 2015 and steps every 5 years out to 2510 -- a much coarser time resolution than every other model in this project, which report annually.",
      "This project's wrapper doesn't expose any of DICE's underlying economic parameters (discount rate, damage function, abatement cost) -- every run uses DICE.jl's own built-in v2016R2 defaults for those.",
    ],
  },
  magicc: {
    summary: "Runs the actual legacy MAGICC6 binary (via Wine), using RCPs, not SSPs.",
    items: [
      "Scenarios are RCP26/45/60/85 -- CMIP5-era radiative forcing pathways, a genuinely different framework from the SSP narratives the other models here use. This project does NOT treat e.g. \"RCP4.5\" and \"SSP2-4.5\" as equivalent, even though some papers use that shorthand.",
      "Runs the actual original MAGICC6 Fortran/C binary under Wine emulation -- not a pure-Python reimplementation of its physics.",
      "Only climate sensitivity is exposed as a tunable parameter. Other MAGICC6 config options (e.g. forcing per CO2 doubling) exist but aren't surfaced here.",
      "Has no real progress signal -- MAGICC6 only writes its output after the entire run finishes, so this project doesn't fake intermediate progress.",
    ],
  },
};

export function modelAssumptions(model: string): AssumptionSection | null {
  return MODEL_ASSUMPTIONS[model] ?? null;
}

/**
 * Scenario assumptions depend on which model's card they're shown on --
 * same canonical SSP label reads differently depending on whether this is
 * an SSP-framework model, magicc's RCP framework, or dice's non-scenario
 * named policies.
 */
export function scenarioAssumptions(model: string, nativeScenario: string, canonicalLabel: string): AssumptionSection {
  if (model === "dice") {
    return {
      summary: "Not an emissions scenario -- one of DICE's two named economic policy paths.",
      items: [
        nativeScenario === "base"
          ? "\"base\" is DICE's business-as-usual path: no carbon abatement policy is applied."
          : "\"optimal\" is the path DICE's own optimizer finds economically best under its built-in objective function (balancing abatement cost against climate damage) -- not a policy anyone has actually proposed.",
        "Not comparable to the SSP/RCP scenarios the other models use -- DICE doesn't model specific emissions trajectories the way those frameworks do.",
      ],
    };
  }

  if (model === "magicc") {
    return {
      summary: `${nativeScenario} is a CMIP5-era Representative Concentration Pathway, not an SSP.`,
      items: [
        "RCPs are a different scenario framework than the SSP narratives hector/fair/oscar use -- defined by CMIP5, not CMIP6, and built around a target radiative forcing level rather than a detailed socioeconomic narrative.",
        "This project does not map RCPs onto SSP labels, even where papers sometimes suggest an approximate correspondence (e.g. \"RCP4.5 ~ SSP2-4.5\") -- that's an approximation some research uses, not an equivalence this project asserts.",
      ],
    };
  }

  // SSP-framework models (hector, fair, oscar): the canonical label is
  // presentation-only (see canonicalScenario in lib/clientApi.ts) -- the
  // actual string submitted to/cached by this specific model is its own
  // native form, which can look different even for the same scenario.
  return {
    summary: `${canonicalLabel} is this project's canonical label for the same SSP narrative across models.`,
    items: [
      nativeScenario === canonicalLabel
        ? `This model's own native scenario string is already "${nativeScenario}" -- no translation needed.`
        : `This model's own native scenario string is "${nativeScenario}", shown here as "${canonicalLabel}" for consistency across models -- that's a display-only relabeling. The actual value submitted/cached is "${nativeScenario}", never the canonical form.`,
      "The small chart on this card is the scenario's own real projected CO2 emissions trajectory (OSCAR's driver data, GtC/yr) -- not a model's output. It's the same for every model's card, since it describes what the scenario itself specifies, not a prediction any one model makes.",
    ],
  };
}
