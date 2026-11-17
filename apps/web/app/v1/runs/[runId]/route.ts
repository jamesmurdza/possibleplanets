import { advanceRun } from "../../../../lib/runs";
import { corsJson, corsOptions } from "../../../../lib/cors";
import { hasValidApiKey } from "../../../../lib/apiKey";

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  // See lib/apiKey.ts -- this poll endpoint requires the same key as run
  // creation, since it's only ever used to check on a run you (or the
  // dashboard) just submitted, never by the public read-only pages.
  if (!hasValidApiKey(req)) {
    return corsJson({ detail: "missing or invalid API key" }, { status: 401 });
  }

  const { runId } = await params;
  try {
    const view = await advanceRun(runId);
    if (!view) {
      return corsJson({ detail: `unknown run_id '${runId}'` }, { status: 404 });
    }
    return corsJson(view);
  } catch (err) {
    return corsJson({ detail: `gateway_error: ${String((err as Error)?.message ?? err)}` }, { status: 502 });
  }
}
