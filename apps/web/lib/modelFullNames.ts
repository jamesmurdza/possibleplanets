/**
 * Each model's acronym (how it's referred to everywhere else in this app
 * -- the lib/models.ts registry key, uppercased) and its real full name.
 * Pulled directly from real sources, not invented here: most come from
 * ../models.markdown's own model table (the Jekyll site's own naming);
 * OSCAR isn't listed as an acronym expansion there or anywhere else
 * (confirmed against its own GitHub repo and the GMD journal paper that
 * introduced it) -- it's consistently just described as "a/the compact
 * Earth system model OSCAR", so that description is used here instead of
 * a fabricated letter-by-letter expansion.
 */
export const MODEL_FULL_NAMES: Record<string, string> = {
  hector: "The Hector Simple Climate Model",
  fair: "Finite Amplitude Impulse-Response",
  oscar: "A compact Earth system model",
  dice: "Dynamic Integrated Climate Economy model",
  magicc: "Model for the Assessment of Greenhouse Gas Induced Climate Change",
  twolayer: "OpenSCM Two Layer Model",
  gcam: "Global Change Analysis Model",
};

// "twolayer" (the lib/models.ts registry key) isn't an acronym at all --
// uppercasing it reads as a garbled "TWOLAYER" rather than a real short
// name. Override just this one case; everything else still has a genuine
// acronym as its registry key.
//
// Deliberately title-case ("Two Layer"), not shouting caps like every
// other model's acronym here (HECTOR, FAIR, ...) -- those are real
// acronyms, so all-caps reads naturally; "Two Layer" isn't one, and
// showing it as "TWO LAYER" in running guide text/headings read oddly.
// The homepage's small model-row card still displays it in all caps
// visually (app/globals.css's .public-model-card-acronym has its own
// text-transform: uppercase, matching every other card there), without
// needing this shared value to be a shouting-caps string everywhere
// else it's used (the model's own guide page title, runGuides.ts's
// section headings, ScenarioChart's legend labels).
const ACRONYM_OVERRIDES: Record<string, string> = {
  twolayer: "Two Layer",
};

export function modelAcronym(model: string): string {
  return ACRONYM_OVERRIDES[model] ?? model.toUpperCase();
}

export function modelFullName(model: string): string {
  return MODEL_FULL_NAMES[model] ?? model;
}
