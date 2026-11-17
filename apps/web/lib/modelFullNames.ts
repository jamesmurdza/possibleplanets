/**
 * Each model's acronym (how it's referred to everywhere else in this app
 * -- the lib/models.ts registry key, uppercased) and its real full name.
 * Pulled directly from real sources, not invented here: most come from
 * ../models.markdown's own model table (the Jekyll site's own naming);
 * OSCAR isn't listed as an acronym expansion there or anywhere else
 * (confirmed against its own GitHub repo and the GMD journal paper that
 * introduced it) -- it's consistently just described as "a/the compact
 * Earth system model OSCAR", so that description is used here instead of
 * a fabricated letter-by-letter expansion. twolayer isn't an acronym at
 * all ("Two-Layer Model" is both its short and full name).
 */
export const MODEL_FULL_NAMES: Record<string, string> = {
  hector: "The Hector Simple Climate Model",
  fair: "Finite Amplitude Impulse-Response",
  oscar: "A compact Earth system model",
  dice: "Dynamic Integrated Climate Economy model",
  magicc: "Model for the Assessment of Greenhouse Gas Induced Climate Change",
  twolayer: "Two-Layer Model",
};

export function modelAcronym(model: string): string {
  return model.toUpperCase();
}

export function modelFullName(model: string): string {
  return MODEL_FULL_NAMES[model] ?? model;
}
