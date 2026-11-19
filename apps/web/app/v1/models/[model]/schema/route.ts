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
    model_version: meta.model_version,
    model_version_number: meta.model_version_number,
    scenarios: meta.scenarios,
    params_shape: meta.params_shape,
    // The default ceiling a run is allowed to take before advanceRun gives
    // up on it (see lib/runs.ts's submitRun/clampRunTimeSeconds) -- exposed
    // so the New Run form's Advanced section can show it as this field's
    // placeholder, instead of a guessed/hardcoded number.
    exec_timeout_seconds: meta.exec_timeout_seconds,
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
