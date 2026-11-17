/**
 * Each model's acronym (how it's referred to everywhere else in this app
 * -- the lib/models.ts registry key, uppercased) and its real full name,
 * pulled directly from ../models.markdown's own model table (the Jekyll
 * site's own naming, not invented here). OSCAR has no expanded form in
 * that table (it's listed by its acronym alone), and twolayer isn't an
 * acronym at all ("Two-Layer Model" is both its short and full name) --
 * both fall back to their own name rather than a fabricated expansion.
 */
export const MODEL_FULL_NAMES: Record<string, string> = {
  hector: "The Hector Simple Climate Model",
  fair: "Finite Amplitude Impulse-Response",
  oscar: "OSCAR",
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
