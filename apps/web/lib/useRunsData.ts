"use client";

/**
 * Fetches exactly the data a public chart ever plots: the latest
 * succeeded run per distinct (model, params), already reduced to
 * {labels, values} server-side (GET /v1/runs/latest), in one request.
 *
 * This used to be a client-side "list 200 runs, then fetch each one's
 * full result individually, then dedupe" N+1 pattern -- slow (up to ~200
 * round trips gating the home page's first paint) and wasteful (most of
 * those individually-fetched results were immediately thrown away by the
 * dedupe step). Pushing the dedupe into the query itself
 * (lib/db.ts's getLatestSucceededRuns, via DISTINCT ON) fixed the round
 * trips; pushing the CHART_ADAPTERS extraction into the route too (see
 * that route's comment) fixed the other half -- the browser no longer
 * downloads each run's full native result blob just to immediately
 * reduce it down to one line's worth of points.
 */
import { useEffect, useState } from "react";
import { fetchJson } from "./clientApi";
import type { ChartSeries } from "./clientTypes";

export function useChartSeries() {
  const [series, setSeries] = useState<ChartSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const data = await fetchJson("/v1/runs/latest");
        if (cancelled) return;
        setSeries(data.series ?? []);
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { series, loading, error };
}
