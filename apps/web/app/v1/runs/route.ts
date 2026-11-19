import { listRuns } from "../../../lib/db";
import { corsJson, corsOptions, corsGatewayError } from "../../../lib/cors";

export async function OPTIONS() {
  return corsOptions();
}

/**
 * Lists recent runs (any status -- queued/running/succeeded/failed),
 * newest first. Powers the dashboard's "Runs" and "Compare" tabs, but is
 * just as usable by any other API consumer wanting an activity feed. A
 * failed run's `error` here is trimmed to {code, message} (no
 * stdout_tail); a run's full detail (result, and error WITH stdout_tail)
 * is still GET /v1/runs/{run_id}, not returned here -- see lib/db.ts's
 * listRuns.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit"));
  // No default/max cap -- the dashboard's Runs tab wants every run, not a
  // capped page. A caller can still pass ?limit= for a bounded page.
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;

  try {
    const runs = await listRuns(limit);
    return corsJson({ runs });
  } catch (err) {
    return corsGatewayError(err, "GET /v1/runs");
  }
}
