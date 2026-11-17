import { listRuns } from "../../../lib/db";
import { corsJson, corsOptions } from "../../../lib/cors";

export async function OPTIONS() {
  return corsOptions();
}

/**
 * Lists recent runs (any status -- queued/running/succeeded/failed),
 * newest first. Powers the dashboard's "Runs" and "Compare" tabs, but is
 * just as usable by any other API consumer wanting an activity feed. A
 * single run's full detail (result/error) is GET /v1/runs/{run_id}, not
 * returned here -- see lib/db.ts's listRuns.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;

  try {
    const runs = await listRuns(limit);
    return corsJson({ runs });
  } catch (err) {
    return corsJson({ detail: `gateway_error: ${String((err as Error)?.message ?? err)}` }, { status: 502 });
  }
}
