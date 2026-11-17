import { getLatestSucceededRuns } from "../../../../lib/db";
import { corsJson, corsOptions } from "../../../../lib/cors";
import { CHART_ADAPTERS } from "../../../../lib/clientApi";
import { MODELS } from "../../../../lib/models";

export async function OPTIONS() {
  return corsOptions();
}

/**
 * True if `params` has no explicit override of any of the model's own
 * tunable parameters -- i.e. this run used every parameter's library
 * default, only choosing a scenario. Per lib/models.ts's module docstring,
 * an omitted parameter is never filled in with its default value in the
 * stored `params` object -- so "used the defaults" and "this key is
 * simply absent" are the same thing to check here, no need to know what
 * any individual default value actually is.
 */
function isDefaultParams(model: string, params: Record<string, unknown>): boolean {
  const meta = MODELS[model];
  if (!meta?.parameters?.length) return true;
  const tunableKeys = new Set(meta.parameters.map((p) => p.key));
  return Object.keys(params).every((k) => !tunableKeys.has(k));
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
 * The *third* fix: DISTINCT ON (model, params) dedupes by exact params
 * object, so a model/scenario combo someone ran once with defaults and
 * once with a tuned parameter (e.g. a custom climate sensitivity) counts
 * as two distinct rows -- both get shipped, showing up as e.g. two
 * separate hector lines for the same SSP2-4.5 scenario on a public chart
 * that's meant to show one representative line per (model, scenario).
 * Dropping any run with a non-default parameter here keeps these public
 * charts to the one canonical, unmodified-defaults run per (model,
 * scenario) -- someone's own custom-parameter exploration stays visible
 * on the dashboard's Runs/Compare tabs (which still read every run,
 * unfiltered), just not folded into the public illustrative charts.
 *
 * Cache-Control is safe to set short-but-nonzero: this only changes when
 * a run finishes, which is rare and not latency-sensitive by a minute.
 */
export async function GET() {
  try {
    const runs = await getLatestSucceededRuns();
    const series = runs.flatMap((r) => {
      if (!isDefaultParams(r.model, (r.params as Record<string, unknown>) ?? {})) return [];
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
