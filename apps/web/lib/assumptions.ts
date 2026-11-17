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
    summary: "A simple physical climate model -- fast because it simplifies, not because it's less real.",
    items: [
      "Reduces the climate system to a small set of global carbon-cycle and energy-balance equations -- no spatial resolution (no regions, no ocean circulation detail), unlike a full GCM.",
      "Climate sensitivity, ocean heat diffusivity, aerosol forcing scaling, CO2 fertilization, and soil respiration temperature-sensitivity (Q10) are each single global numbers here, not spatially or regionally varying.",
      "Deterministic: given a scenario and parameters, there's exactly one answer, with no representation of internal variability or uncertainty.",
    ],
  },
  fair: {
    summary: "A calibrated emulator: it's built to reproduce the range of full climate models' behavior, not to simulate physics from first principles.",
    items: [
      "The temperature shown is the MEAN across an ensemble of 66 parameter sets, each independently calibrated to match a different CMIP6 model's behavior -- it represents a central estimate across structural climate-model uncertainty, not one model's physics.",
      "Methane's radiative forcing is computed using one specific published method (Thornhill et al. 2021); other valid published methods exist and would shift CH4-driven warming slightly.",
      "Like hector, it has no spatial resolution -- global-mean quantities only.",
    ],
  },
  oscar: {
    summary: "A compact Earth-system model with Monte Carlo parameter uncertainty and simple regional structure.",
    items: [
      "Aggregates the world into a small number of broad regions (5), not fine spatial detail -- a deliberate speed/complexity tradeoff versus a full Earth-system model.",
      "A single run uses one Monte Carlo draw from OSCAR's parameter uncertainty distributions by default, so default output is one plausible trajectory, not a converged uncertainty range -- running more samples would reveal the spread around it.",
      "Some scenario/parameter combinations are physically marginal enough that OSCAR's own internals produce non-finite values partway through -- a real limitation of the scenario for this model, not a data artifact.",
    ],
  },
  dice: {
    summary: "An integrated economic-climate model -- temperature here is a side effect of an economic optimization, not the primary target.",
    items: [
      "Couples a simplified climate module to an economic growth/damage model; its main purpose is computing the economically optimal carbon price and abatement path, with temperature as one downstream output among several.",
      "Only two policy paths exist: \"base\" (no climate policy at all) and \"optimal\" (whatever path DICE's own cost-benefit optimizer picks under its built-in assumptions about discounting and damages) -- neither is a specific emissions scenario the way SSPs/RCPs are.",
      "Those discounting and damage-function assumptions are highly consequential and contested in the economics literature (DICE is well-known for being sensitive to the discount rate chosen) -- this project uses its standard published defaults.",
      "Reports in 5-year steps, reflecting the model's own economic planning horizon rather than a yearly physical simulation.",
    ],
  },
  magicc: {
    summary: "A long-standing reduced-complexity climate model, run here on CMIP5-era scenarios rather than the newer CMIP6 ones.",
    items: [
      "Scenarios are RCPs (Representative Concentration Pathways) -- the CMIP5-generation framework built around a target radiative forcing level, not the newer SSP socioeconomic narratives the other models here use. RCPs and SSPs are not interchangeable, even where a given RCP and SSP target similar forcing.",
      "Only climate sensitivity is adjustable here; MAGICC's other internal physical parameters (e.g. ocean heat uptake, carbon cycle feedbacks) use its own built-in defaults.",
      "Like hector and fair, it's a global/simple-regional reduced-complexity model, not a spatially resolved GCM.",
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
      summary: "Not an emissions scenario -- one of DICE's two named economic policy paths.",
      items: [
        nativeScenario === "base"
          ? "\"base\": no carbon abatement policy is ever applied -- emissions follow the model's unconstrained economic growth path."
          : "\"optimal\": the path DICE's own cost-benefit optimizer picks as economically best, under its built-in discounting and damage-function assumptions -- not a policy anyone has actually proposed or committed to.",
        "Isn't comparable to the SSP/RCP scenarios the other models use -- those specify emissions trajectories directly, while DICE derives emissions as a byproduct of its economic optimization.",
      ],
    };
  }

  if (model === "magicc") {
    return {
      summary: `${nativeScenario} is a CMIP5-era Representative Concentration Pathway, not an SSP.`,
      items: [
        "RCPs specify a target radiative forcing trajectory directly, without an underlying socioeconomic narrative -- SSPs (used by hector/fair/oscar) instead start from a socioeconomic storyline and derive emissions from it.",
        "RCPs and SSPs with similar numbers (e.g. RCP4.5 and SSP2-4.5) are not the same scenario -- any resemblance is approximate, not an equivalence.",
      ],
    };
  }

  // SSP-framework models (hector, fair, oscar).
  return {
    summary: `${canonicalLabel} is a Shared Socioeconomic Pathway -- a socioeconomic storyline with emissions derived from it, not a directly specified forcing target.`,
    items: [
      "SSPs combine a narrative about future population, economic growth, and technology with a forcing-level target (the number after the dash) -- two scenarios with the same forcing target can still differ in how they get there.",
      "The small chart on this card shows the scenario's actual projected CO2 emissions pathway, not any model's temperature output -- it's the same input every model here runs on for this scenario.",
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
