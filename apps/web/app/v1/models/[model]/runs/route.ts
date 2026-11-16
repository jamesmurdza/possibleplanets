import { getModelOrNull } from "../../../../../lib/models";
import { submitRun } from "../../../../../lib/runs";
import { corsJson, corsOptions } from "../../../../../lib/cors";

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
    const { run_id, error } = await submitRun(model, runParams, refresh);
    if (error) {
      return corsJson({ detail: error }, { status: 400 });
    }
    return corsJson({ run_id, status: "queued" });
  } catch (err) {
    return corsJson({ detail: `gateway_error: ${String((err as Error)?.message ?? err)}` }, { status: 502 });
  }
}
