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
      implementation: meta.implementation,
      website: meta.website,
      model_version: meta.model_version,
      model_version_number: meta.model_version_number,
    })),
  });
}
