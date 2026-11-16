import { getModelOrNull } from "../../../../../lib/models";
import { corsJson, corsOptions } from "../../../../../lib/cors";

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(_req: Request, { params }: { params: Promise<{ model: string }> }) {
  const { model } = await params;
  const meta = getModelOrNull(model);
  if (!meta) {
    return corsJson({ detail: `unknown model '${model}'` }, { status: 404 });
  }
  return corsJson({
    model,
    family: meta.family,
    scenarios: meta.scenarios,
    params_shape: meta.params_shape,
    // Optional model-native tunable inputs beyond scenario (empty array for
    // models where this isn't wired up yet -- see lib/models.ts). A caller
    // omitting one of these entirely is NOT equivalent to passing its
    // `default` explicitly for caching purposes -- see lib/models.ts's
    // module docstring.
    parameters: meta.parameters ?? [],
    // Present only for models whose result isn't a pure function of
    // (scenario, parameters) -- the value is the parameter key a caller
    // must supply to get a cacheable, reproducible run (e.g. oscar's
    // "seed"). Omitted entirely for models without this issue.
    ...(meta.nonDeterministicUnless ? { non_deterministic_unless: meta.nonDeterministicUnless } : {}),
  });
}
