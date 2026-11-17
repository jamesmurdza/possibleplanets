/**
 * Human-readable "what modelling assumptions does this actually make" text
 * for the (i) info modal on each model/scenario card in the New Run form.
 *
 * Deliberately scoped to scientific/methodological assumptions (what the
 * model simplifies, what a scenario framework does and doesn't specify) --
 * NOT this project's own integration details (wrapper plumbing, seed
 * handling, caching, progress signals). Those live in code comments for
 * developers; this is for someone deciding how much to trust a result.
 */

export interface AssumptionSection {
  summary: string;
  items: string[];
}

const MODEL_ASSUMPTIONS: Record<string, AssumptionSection> = {
  hector: {
    summary: "A simple physical climate model.",
    items: [
      "No spatial resolution -- everything is a single global-average value, with no regions or ocean circulation detail.",
      "Climate sensitivity, ocean heat uptake, aerosol forcing, CO2 fertilization, and soil respiration sensitivity are each one fixed global number.",
      "Fully deterministic: the same scenario and parameters always give exactly the same answer, with no uncertainty range.",
    ],
  },
  fair: {
    summary: "A calibrated climate emulator.",
    items: [
      "The temperature shown is the mean across an internal ensemble of 66 parameter sets, not a single physics run.",
      "Methane's warming effect is computed with one specific published calculation method (Thornhill et al. 2021).",
      "No spatial resolution -- only global-average quantities.",
    ],
  },
  oscar: {
    summary: "A compact Earth-system model.",
    items: [
      "Aggregates the world into 5 broad regions, not finer spatial detail.",
      "A single run draws one Monte Carlo sample from its parameter uncertainty, so one run is one plausible trajectory, not a converged range.",
      "Some scenarios can produce non-finite values partway through a run -- a real numerical limit, not a data artifact.",
    ],
  },
  dice: {
    summary: "An integrated economic-climate model.",
    items: [
      "Temperature is a downstream output of an economic optimization, not the model's primary target.",
      "Only two policy paths exist: a no-policy baseline and the path its own cost-benefit optimizer picks as economically best.",
      "Its discount rate and damage-function assumptions drive the result and are a long-standing point of debate in the economics literature.",
      "Reports in 5-year steps, matching its own economic planning horizon.",
    ],
  },
  magicc: {
    summary: "A long-standing reduced-complexity climate model.",
    items: [
      "Scenarios are RCPs: trajectories defined by a target radiative forcing level, not a socioeconomic narrative.",
      "Only climate sensitivity is adjustable here -- its other internal physical parameters use built-in defaults.",
      "No spatial resolution -- only global-average output.",
    ],
  },
};

export function modelAssumptions(model: string): AssumptionSection | null {
  return MODEL_ASSUMPTIONS[model] ?? null;
}

/**
 * Scenario assumptions depend on which framework the scenario belongs to
 * (SSP vs RCP vs DICE's own named policies) -- that framework is the
 * modelling-relevant fact, not which model card it happens to be shown on.
 */
export function scenarioAssumptions(model: string, nativeScenario: string, canonicalLabel: string): AssumptionSection {
  if (model === "dice") {
    return {
      summary: "One of DICE's two named economic policy paths, not an emissions scenario.",
      items: [
        nativeScenario === "base"
          ? "No carbon abatement policy is ever applied."
          : "The path DICE's own cost-benefit optimizer picks as economically best.",
        "Emissions are a byproduct of the economic optimization, not a direct input.",
      ],
    };
  }

  if (model === "magicc") {
    return {
      summary: `${nativeScenario} is a Representative Concentration Pathway (RCP).`,
      items: [
        "Defined by a target radiative forcing trajectory, not a socioeconomic narrative.",
        "Emissions are back-derived to hit that forcing target.",
      ],
    };
  }

  // SSP-framework models (hector, fair, oscar).
  return {
    summary: `${canonicalLabel} is a Shared Socioeconomic Pathway (SSP).`,
    items: [
      "Defined by a socioeconomic storyline (population, growth, technology) plus a forcing-level target.",
      "Emissions are derived from that storyline, not specified directly.",
      "The small chart on this card is the scenario's own projected CO2 emissions pathway, not a model's output.",
    ],
  };
}

/**
 * Same framework classification as scenarioAssumptions, but for the
 * Overview tab's scenario filter list, which shows one label pooled
 * across whichever models reported it -- there's no single model to key
 * off, so this infers the framework from the label's own shape instead
 * (RCPnn / "base"|"optimal" / anything else falls through to SSP).
 */
export function scenarioAssumptionsByLabel(label: string): AssumptionSection {
  if (label === "base" || label === "optimal") {
    return scenarioAssumptions("dice", label, label);
  }
  if (/^RCP/i.test(label)) {
    return scenarioAssumptions("magicc", label, label);
  }
  return scenarioAssumptions("hector", label, label);
}
