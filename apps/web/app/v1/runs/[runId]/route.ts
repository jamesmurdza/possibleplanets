import { advanceRun, deleteRunAndCleanup, updateRunDeadline } from "../../../../lib/runs";
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

/**
 * Powers the run drawer's Advanced tab -- lets a still-in-flight run's
 * deadline be raised (or lowered) after the fact, instead of only being
 * settable at submit time via the New Run form's own max_run_time_seconds.
 * Same auth as GET/DELETE on this run surface.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    if (!(await hasValidApiKey(req))) {
      return corsJson({ detail: "missing or invalid API key" }, { status: 401 });
    }
    let body: { max_run_time_seconds?: number };
    try {
      body = await req.json();
    } catch {
      return corsJson({ detail: "invalid JSON body" }, { status: 400 });
    }
    if (typeof body.max_run_time_seconds !== "number" || !Number.isFinite(body.max_run_time_seconds)) {
      return corsJson({ detail: "max_run_time_seconds must be a number" }, { status: 400 });
    }
    const { view, error } = await updateRunDeadline(runId, body.max_run_time_seconds);
    if (!view) {
      return corsJson({ detail: `unknown run_id '${runId}'` }, { status: 404 });
    }
    if (error) {
      return corsJson({ detail: error }, { status: 409 });
    }
    return corsJson(view);
  } catch (err) {
    return corsGatewayError(err, `PATCH /v1/runs/${runId}`);
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
