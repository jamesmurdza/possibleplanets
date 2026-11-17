"use client";

/**
 * Shared "fetch every succeeded run, then fetch each one's full result"
 * hook -- same two-step fetch (GET /v1/runs, then GET /v1/runs/[runId] for
 * anything not already cached) and same "latest run per exact (model,
 * params) wins" dedupe OverviewPanel.tsx already uses, pulled out so the
 * public home page and the per-model article pages can build their own
 * charts from the same real run history without copy-pasting that logic a
 * third/fourth time.
 */
import { useEffect, useState } from "react";
import { fetchJson } from "./clientApi";
import type { RunJob, RunListItem } from "./clientTypes";

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function useRunsAndJobs() {
  const [allRuns, setAllRuns] = useState<RunListItem[]>([]);
  const [jobs, setJobs] = useState<Record<string, RunJob>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const data = await fetchJson("/v1/runs?limit=200");
        const succeeded: RunListItem[] = (data.runs ?? []).filter((r: RunListItem) => r.status === "succeeded");
        if (cancelled) return;
        setAllRuns(succeeded);
        const fetched: RunJob[] = await Promise.all(succeeded.map((r) => fetchJson(`/v1/runs/${r.run_id}`)));
        if (cancelled) return;
        const next: Record<string, RunJob> = {};
        for (const job of fetched) next[job.run_id] = job;
        setJobs(next);
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

  // Dedup to the single most recently started run per exact (model,
  // params) -- see OverviewPanel.tsx's comment on why this matters (old,
  // already-superseded runs of a scenario that was later fixed shouldn't
  // keep showing up alongside the corrected rerun).
  const plottableRuns = (() => {
    const succeeded = allRuns.filter((r) => jobs[r.run_id]?.status === "succeeded");
    const latestByKey = new Map<string, RunListItem>();
    for (const r of succeeded) {
      const key = `${r.model}:${JSON.stringify(sortKeysDeep(r.params))}`;
      const existing = latestByKey.get(key);
      if (!existing || new Date(r.started_at) > new Date(existing.started_at)) {
        latestByKey.set(key, r);
      }
    }
    const kept = new Set(latestByKey.values());
    return succeeded.filter((r) => kept.has(r));
  })();

  return { plottableRuns, jobs, loading, error };
}
