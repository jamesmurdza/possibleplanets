"use client";

/**
 * Fetches exactly the runs a public chart ever plots: the latest
 * succeeded run per distinct (model, params), full result included, in
 * one request (GET /v1/runs/latest). This used to be a client-side "list
 * 200 runs, then fetch each one's full result individually, then dedupe"
 * N+1 pattern -- slow (up to ~200 round trips gating the home page's first
 * paint) and wasteful (most of those individually-fetched results were
 * immediately thrown away by the dedupe step). Pushing the dedupe into
 * the query itself (lib/db.ts's getLatestSucceededRuns, via DISTINCT ON)
 * means the server does it once, correctly, with no arbitrary limit to
 * guess at -- see the home page's "brainstorm slow chart" discussion this
 * was written for.
 */
import { useEffect, useState } from "react";
import { fetchJson } from "./clientApi";
import type { RunJob, RunListItem } from "./clientTypes";

export function useRunsAndJobs() {
  const [plottableRuns, setPlottableRuns] = useState<RunListItem[]>([]);
  const [jobs, setJobs] = useState<Record<string, RunJob>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const data = await fetchJson("/v1/runs/latest");
        const rows: { run_id: string; model: string; params: unknown; result: unknown; started_at: string }[] =
          data.runs ?? [];
        if (cancelled) return;

        const nextRuns: RunListItem[] = rows.map((r) => ({
          run_id: r.run_id,
          model: r.model,
          params: r.params as Record<string, unknown>,
          status: "succeeded",
          cached: false,
          progress: { percent: 100 },
          duration_seconds: null,
          started_at: r.started_at,
          updated_at: r.started_at,
        }));
        const nextJobs: Record<string, RunJob> = {};
        for (const r of rows) {
          nextJobs[r.run_id] = {
            run_id: r.run_id,
            model: r.model,
            params: r.params as Record<string, unknown>,
            status: "succeeded",
            result: r.result,
            error: null,
            cached: false,
            progress: { percent: 100 },
            duration_seconds: null,
          };
        }
        setPlottableRuns(nextRuns);
        setJobs(nextJobs);
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

  return { plottableRuns, jobs, loading, error };
}
