import { getModelOrNull } from "../../../../../lib/models";
import { submitRun } from "../../../../../lib/runs";
import { corsJson, corsOptions, corsGatewayError } from "../../../../../lib/cors";
import { hasValidApiKey } from "../../../../../lib/apiKey";

export async function OPTIONS() {
  return corsOptions();
}

export async function POST(req: Request, { params }: { params: Promise<{ model: string }> }) {
  const { model } = await params;
  if (!getModelOrNull(model)) {
    return corsJson({ detail: `unknown model '${model}'` }, { status: 404 });
  }

  let body: { params?: Record<string, unknown>; refresh?: boolean };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const runParams = body.params ?? {};
  const refresh = body.refresh ?? false;

  try {
    // Computed up front, but only enforced INSIDE submitRun, on a cache
    // miss -- see lib/apiKey.ts / lib/runs.ts's submitRun for why an
    // already-cached result doesn't need this at all. Inside this same
    // try/catch as submitRun itself -- it can throw too (e.g. a DB error
    // looking up an API key), and that should 502 the same way a
    // submitRun failure does, not bubble up as an unhandled 500.
    const isAuthed = await hasValidApiKey(req);
    const { run_id, error, inline, unauthorized } = await submitRun(model, runParams, refresh, isAuthed);
    if (unauthorized) {
      return corsJson({ detail: "missing or invalid API key" }, { status: 401 });
    }
    if (error) {
      return corsJson({ detail: error }, { status: 400 });
    }
    // A cache hit -- return the finished result directly (same shape GET
    // /v1/runs/{run_id} would return) instead of a run_id to poll, since
    // this run_id was never written to the `runs` table (see submitRun's
    // module comment on why a cache lookup isn't a new generation).
    if (inline) {
      return corsJson(inline);
    }
    return corsJson({ run_id, status: "queued" });
  } catch (err) {
    return corsGatewayError(err, `POST /v1/models/${model}/runs`);
  }
}
