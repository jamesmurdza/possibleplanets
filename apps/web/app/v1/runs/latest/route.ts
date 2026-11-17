import { getLatestSucceededRuns } from "../../../../lib/db";
import { corsJson, corsOptions } from "../../../../lib/cors";
import { CHART_ADAPTERS } from "../../../../lib/clientApi";

export async function OPTIONS() {
  return corsOptions();
}

/**
 * One row per distinct (model, params) -- the most recently started
 * succeeded run of each, pre-reduced to exactly {labels, values} a chart
 * plots. Replaces the "list 200 runs, then fetch each one's result
 * individually" N+1 pattern lib/useRunsData.ts used to do (see
 * lib/db.ts's getLatestSucceededRuns for that part of the fix).
 *
 * The *second* fix here: this used to ship each run's full native
 * `result` blob to the browser, which then ran CHART_ADAPTERS itself to
 * pick out {labels, values} -- for FAIR that blob is a per-timestep array
 * across every ensemble config, not just the mean the chart actually
 * draws. Running the same adapter here instead means the client never
 * downloads data it immediately throws away. Runs for a model with no
 * adapter (nothing currently, but same convention as
 * TemperatureChart's old client-side `plottable` filter) are dropped
 * rather than shipped uselessly.
 *
 * Cache-Control is safe to set short-but-nonzero: this only changes when
 * a run finishes, which is rare and not latency-sensitive by a minute.
 */
export async function GET() {
  try {
    const runs = await getLatestSucceededRuns();
    const series = runs.flatMap((r) => {
      const adapter = CHART_ADAPTERS[r.model];
      if (!adapter) return [];
      try {
        const { labels, values } = adapter(r.result);
        return [{ run_id: r.run_id, model: r.model, params: r.params, started_at: r.started_at, labels, values }];
      } catch {
        return [];
      }
    });
    return corsJson({ series }, { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" } });
  } catch (err) {
    return corsJson({ detail: `gateway_error: ${String((err as Error)?.message ?? err)}` }, { status: 502 });
  }
}
