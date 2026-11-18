import { advanceRun, deleteRunAndCleanup } from "../../../../lib/runs";
import { corsJson, corsOptions, corsGatewayError } from "../../../../lib/cors";
import { hasValidApiKey } from "../../../../lib/apiKey";

export async function OPTIONS() {
  return corsOptions();
}

/**
 * Powers the Runs tab's delete button/checkboxes. Same auth as GET/POST
 * on this run surface (dashboard_auth cookie or a personal API key) --
 * never exposed to the public, read-only pages.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    if (!(await hasValidApiKey(req))) {
      return corsJson({ detail: "missing or invalid API key" }, { status: 401 });
    }
    await deleteRunAndCleanup(runId);
    return corsJson({ run_id: runId, deleted: true });
  } catch (err) {
    return corsGatewayError(err, `DELETE /v1/runs/${runId}`);
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    // See lib/apiKey.ts -- this poll endpoint requires the same key as run
    // creation, since it's only ever used to check on a run you (or the
    // dashboard) just submitted, never by the public read-only pages.
    // Inside this try/catch since it can throw too (e.g. a DB error
    // looking up an API key) -- that should 502 the same way the rest of
    // this route's failures do, not bubble up as an unhandled 500.
    if (!(await hasValidApiKey(req))) {
      return corsJson({ detail: "missing or invalid API key" }, { status: 401 });
    }
    const view = await advanceRun(runId);
    if (!view) {
      return corsJson({ detail: `unknown run_id '${runId}'` }, { status: 404 });
    }
    return corsJson(view);
  } catch (err) {
    return corsGatewayError(err, `GET /v1/runs/${runId}`);
  }
}
