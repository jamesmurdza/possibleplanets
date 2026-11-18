import { getModelOrNull } from "../../../../../lib/models";
import { checkRun } from "../../../../../lib/runs";
import { corsJson, corsOptions, corsGatewayError } from "../../../../../lib/cors";

export async function OPTIONS() {
  return corsOptions();
}

/**
 * Preview endpoint: "if I submitted this exact (model, params) right now,
 * would it be a cache hit?" -- lets a caller show "cached, instant" vs "no
 * history, here's a real run" BEFORE committing to POST .../runs and
 * spinning up a sandbox. Never creates anything; always safe to call
 * repeatedly (e.g. on every form change) as a cheap DB read.
 */
export async function POST(req: Request, { params }: { params: Promise<{ model: string }> }) {
  const { model } = await params;
  if (!getModelOrNull(model)) {
    return corsJson({ detail: `unknown model '${model}'` }, { status: 404 });
  }

  let body: { params?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const runParams = body.params ?? {};

  try {
    const result = await checkRun(model, runParams);
    if (result.error) {
      return corsJson({ detail: result.error }, { status: 400 });
    }
    return corsJson({
      cacheable: result.cacheable,
      cached: result.cached,
      cached_duration_seconds: result.cached_duration_seconds,
      cached_run_id: result.cached_run_id,
    });
  } catch (err) {
    return corsGatewayError(err, `POST /v1/models/${model}/check`);
  }
}
