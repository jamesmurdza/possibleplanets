import { getModelOrNull } from "../../../../../lib/models";
import { submitRun } from "../../../../../lib/runs";
import { corsJson, corsOptions } from "../../../../../lib/cors";
import { hasValidApiKey } from "../../../../../lib/apiKey";

export async function OPTIONS() {
  return corsOptions();
}

export async function POST(req: Request, { params }: { params: Promise<{ model: string }> }) {
  // Run creation requires an API key -- see lib/apiKey.ts for why only
  // this route and GET /v1/runs/{runId} check it, not the read-only
  // listing endpoints.
  if (!hasValidApiKey(req)) {
    return corsJson({ detail: "missing or invalid API key" }, { status: 401 });
  }

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
    const { run_id, error, inline } = await submitRun(model, runParams, refresh);
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
    return corsJson({ detail: `gateway_error: ${String((err as Error)?.message ?? err)}` }, { status: 502 });
  }
}
