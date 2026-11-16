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
  });
}
