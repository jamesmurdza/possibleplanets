import { MODELS } from "../../../lib/models";
import { corsJson, corsOptions } from "../../../lib/cors";

export async function OPTIONS() {
  return corsOptions();
}

export async function GET() {
  return corsJson({
    models: Object.entries(MODELS).map(([name, meta]) => ({
      model: name,
      family: meta.family,
      scenarios: meta.scenarios,
      description: meta.description,
      website: meta.website,
    })),
  });
}
