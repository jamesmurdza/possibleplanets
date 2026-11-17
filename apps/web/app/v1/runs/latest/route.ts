import { getLatestSucceededRuns } from "../../../../lib/db";
import { corsJson, corsOptions } from "../../../../lib/cors";

export async function OPTIONS() {
  return corsOptions();
}

/**
 * One row per distinct (model, params) -- the most recently started
 * succeeded run of each, full result included. Replaces the "list 200
 * runs, then fetch each one's result individually" N+1 pattern
 * lib/useRunsData.ts used to do: that pattern fetched a strict superset of
 * what any chart ever plots (every past run, including ones immediately
 * thrown away by client-side dedup) and paid for it in round trips. See
 * lib/db.ts's getLatestSucceededRuns for why DISTINCT ON can do this
 * dedup in the query itself.
 */
export async function GET() {
  try {
    const runs = await getLatestSucceededRuns();
    return corsJson({ runs });
  } catch (err) {
    return corsJson({ detail: `gateway_error: ${String((err as Error)?.message ?? err)}` }, { status: 502 });
  }
}
