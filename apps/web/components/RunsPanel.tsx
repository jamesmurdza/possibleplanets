"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "chart.js/auto";
import Dropdown from "./Dropdown";
import Drawer from "./Drawer";
import Modal from "./Modal";
import { fetchJson, CHART_ADAPTERS, summarizeParams, nativeScenarioOf, canonicalScenario } from "../lib/clientApi";
import type { RunJob, RunListItem, ModelMeta } from "../lib/clientTypes";

const ALL = "__all__";
const STATUS_OPTIONS = [
  { value: ALL, label: "Any status" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
];

// Canonical (not model-native) -- so filtering by "SSP1-2.6" matches both
// hector's "ssp126" and oscar's "SSP1-2.6" runs. See canonicalScenario's
// comment in lib/clientApi.ts for why RCP/base/optimal are left alone.
function scenarioOf(params: Record<string, unknown>): string | undefined {
  const native = nativeScenarioOf(params);
  return native ? canonicalScenario(native) : undefined;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Every duration in this panel (a finished run's duration_seconds, and a
// still-running one's live elapsed time below) renders through this one
// function, always as "Xm Ys" -- including under a minute (e.g. "0m 7s"),
// not a special-cased bare "7s" -- so every row in the Duration column
// reads in the same shape regardless of how long that particular run
// took.
function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

// Live "how long has this been running" for a still-in-progress run --
// just now() - started_at, recomputed on every render. No interval timer
// of its own needed: both the table (refreshList, every 1s -- see
// listPollTimer) and the drawer (pollDetail, every 500ms while a run is
// still in progress -- see detailPollTimer) already re-render this
// component on that same cadence while anything is running/queued, so
// this naturally ticks up in step with those polls rather than drifting
// out of sync with a second, independent setInterval.
function formatElapsed(startedAtIso: string): string {
  const elapsedSeconds = Math.max(0, (Date.now() - new Date(startedAtIso).getTime()) / 1000);
  return formatDuration(elapsedSeconds);
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-pill status-pill-${status}`}>{status}</span>;
}

// A clickable <th> for the Runs table -- shows an up/down arrow only on
// whichever column is the current sort key (see RunsPanel's toggleSort),
// nothing on the rest. Clicking the already-active column flips direction
// instead of resorting by a different key -- see toggleSort.
function SortableHeader({
  label,
  sortKeyName,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  sortKeyName: string;
  sortKey: string | null;
  sortDir: "asc" | "desc";
  onSort: (key: string) => void;
}) {
  const active = sortKey === sortKeyName;
  return (
    <th>
      <button type="button" className="runs-table-sort-button" onClick={() => onSort(sortKeyName)}>
        {label}
        <span className="runs-table-sort-arrow" aria-hidden="true">
          {active ? (sortDir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

export interface RunsPanelProps {
  // Controlled, not local state -- a New Run submission (see
  // NewRunPanel.tsx's onRunSubmitted) sets this from OUTSIDE this
  // component (switching the dashboard's own tab to "runs" at the same
  // time), not just a row click inside this table.
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  // Switches the dashboard's own tab to "New Run" -- backs the button at
  // the top right of this panel (Runs is the default landing tab now, so
  // starting a run needs to be reachable from here, not just the sidebar).
  onNewRun: () => void;
  // Bumped by the dashboard (see app/dashboard/page.tsx's onRunSubmitted)
  // every time a New Run submission completes, so a just-submitted run
  // shows up immediately on switching to this tab instead of only
  // appearing once refreshList's own poll loop happens to catch it (or
  // never, if nothing else in the list is in progress -- see this
  // component's own useEffect on `runs` below: the 1s poll is keyed on
  // whether anything already IN the list is active, which a run that
  // hasn't been fetched into the list yet doesn't satisfy). This stays
  // mounted across tab switches (app/dashboard/page.tsx toggles
  // display:none, not unmount/remount), so there's no mount effect to
  // rely on here either.
  refreshSignal?: number;
}

export default function RunsPanel({ selectedRunId, onSelectRun, onNewRun, refreshSignal }: RunsPanelProps) {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<RunJob | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [filterModel, setFilterModel] = useState(ALL);
  const [filterScenario, setFilterScenario] = useState(ALL);
  const [filterStatus, setFilterStatus] = useState(ALL);
  // Null sortKey means "server's own default order" (started_at DESC,
  // already how GET /v1/runs returns rows -- see lib/db.ts) -- sorting is
  // otherwise purely client-side over the already-fetched/filtered list,
  // same reasoning as filtering above.
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // Checkbox selection for bulk delete -- independent of selectedRunId
  // (which run's drawer is open), see the header comment above.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  // Confirmation step for the delete icon -- never deletes directly on
  // click, since this is a bulk/irreversible action (see deleteSelected's
  // own DELETE calls, there's no undo).
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // The open drawer's model schema -- fetched lazily (only once a run of
  // that model is actually opened) so the field-by-field Params display
  // below knows each parameter's label and which keys exist at all (to
  // show "(default)" for ones the run's own params didn't include).
  const [drawerModelMeta, setDrawerModelMeta] = useState<ModelMeta | null>(null);
  const schemaCache = useRef<Record<string, ModelMeta>>({});

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const listPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advancePollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mirrors `runs` for advanceInProgressRuns below -- that function is
  // scheduled via setTimeout (not re-created every render), so it'd
  // otherwise close over whatever `runs` was on the render that scheduled
  // it, not the latest list.
  const runsRef = useRef<RunListItem[]>([]);

  async function refreshList() {
    try {
      const data = await fetchJson("/v1/runs");
      setRuns(data.runs ?? []);
      runsRef.current = data.runs ?? [];
      setLoadErr(null);
    } catch (err: any) {
      setLoadErr(err.message);
    } finally {
      // Only ever matters for the very first call (the mount effect
      // below) -- every later refreshList (the background poll,
      // advanceInProgressRuns) is a no-op here since loading is already
      // false by then. Set in `finally` so an error on that first load
      // still clears the "Loading runs..." state instead of leaving the
      // table stuck there forever.
      setLoading(false);
    }
  }

  // GET /v1/runs (refreshList above) is a plain DB read -- see its own
  // route comment -- it never itself checks a sandbox against Daytona, so
  // a run's row only ever advances past "queued"/"running" via (a) that
  // run's own webhook POST on completion, or (b) someone polling
  // GET /v1/runs/{run_id} (advanceRun's fallback path), which this table
  // previously only did for whichever single run's drawer happened to be
  // open. A run nobody ever opened the drawer for could sit showing
  // "running" forever even after it actually finished. Fixes that by
  // polling every still-in-progress run's own detail endpoint in the
  // background -- on load and on an interval -- whether or not its drawer
  // is open, so this table's own status/duration stays honest for every
  // row, not just the selected one.
  async function advanceInProgressRuns() {
    const inProgress = runsRef.current.filter((r) => r.status === "queued" || r.status === "running");
    if (inProgress.length === 0) return;
    await Promise.all(inProgress.map((r) => fetchJson(`/v1/runs/${r.run_id}`).catch(() => null)));
    // advanceRun (behind that GET) may have just changed one or more
    // statuses in the DB -- pull the fresh list right away rather than
    // waiting for refreshList's own separate poll to eventually catch up.
    await refreshList();
  }

  useEffect(() => {
    refreshList().then(advanceInProgressRuns);
    // A plain setInterval, started once and never re-armed -- NOT keyed
    // on `runs` the way listPollTimer below is. advanceInProgressRuns
    // itself reads runsRef (always current) and no-ops immediately if
    // nothing's in progress, so there's no need to start/stop this based
    // on activity; keying it on `runs` instead (so it only runs "while
    // active") would backfire: refreshList's own 1s poll changes `runs`
    // every second whenever anything's active, which would clear and
    // reschedule a runs-keyed 5s timer before it ever reached 5 seconds --
    // it would never actually fire.
    advancePollTimer.current = setInterval(advanceInProgressRuns, 5000);
    return () => {
      if (listPollTimer.current) clearTimeout(listPollTimer.current);
      if (detailPollTimer.current) clearTimeout(detailPollTimer.current);
      if (advancePollTimer.current) clearInterval(advancePollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the list itself live while anything in it is still in flight --
  // same ~1s cadence is plenty for a list view (contrast with the ~500ms
  // poll used for the open drawer's own progress).
  useEffect(() => {
    if (listPollTimer.current) clearTimeout(listPollTimer.current);
    const anyActive = runs.some((r) => r.status === "queued" || r.status === "running");
    if (anyActive) {
      listPollTimer.current = setTimeout(refreshList, 1000);
    }
    return () => {
      if (listPollTimer.current) clearTimeout(listPollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  // Fires an immediate refetch whenever the dashboard bumps refreshSignal
  // -- see this prop's own doc comment for why the regular poll loop
  // alone can't be relied on to pick up a just-submitted run. Skipped on
  // the very first render (refreshSignal starts at 0/undefined and the
  // mount effect above already does this same fetch) via the ref below,
  // so this doesn't double-fetch on initial mount.
  const sawRefreshSignal = useRef(false);
  useEffect(() => {
    if (!sawRefreshSignal.current) {
      sawRefreshSignal.current = true;
      return;
    }
    refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // Filtering is purely client-side over the already-fetched list -- the
  // list is already a lightweight, capped-size projection (GET /v1/runs),
  // so there's no need for the server to know about filters.
  const modelOptions = useMemo(() => {
    const names = Array.from(new Set(runs.map((r) => r.model))).sort();
    return [{ value: ALL, label: "All models" }, ...names.map((m) => ({ value: m, label: m }))];
  }, [runs]);

  const scenarioOptions = useMemo(() => {
    const scoped = filterModel === ALL ? runs : runs.filter((r) => r.model === filterModel);
    const scenarios = Array.from(new Set(scoped.map((r) => scenarioOf(r.params)).filter(Boolean))).sort() as string[];
    return [{ value: ALL, label: "All scenarios" }, ...scenarios.map((s) => ({ value: s, label: s }))];
  }, [runs, filterModel]);

  function onFilterModelChange(value: string) {
    setFilterModel(value);
    setFilterScenario(ALL);
  }

  const filteredRuns = runs.filter((r) => {
    if (filterModel !== ALL && r.model !== filterModel) return false;
    if (filterScenario !== ALL && scenarioOf(r.params) !== filterScenario) return false;
    if (filterStatus !== ALL && r.status !== filterStatus) return false;
    return true;
  });

  // A run's own duration for sort purposes -- duration_seconds once
  // finished, otherwise its live elapsed time (same value the Duration
  // column itself shows while running/queued -- see formatElapsed), so
  // sorting by Duration doesn't just always push every still-in-progress
  // row to one end regardless of how long it's actually been running.
  function sortableDurationSeconds(r: RunListItem): number {
    if (typeof r.duration_seconds === "number") return r.duration_seconds;
    if (r.status === "running" || r.status === "queued") {
      return Math.max(0, (Date.now() - new Date(r.started_at).getTime()) / 1000);
    }
    return -1;
  }

  const SORT_ACCESSORS: Record<string, (r: RunListItem) => string | number> = {
    model: (r) => r.model,
    version: (r) => r.model_version_number ?? "",
    params: (r) => summarizeParams(r.params),
    status: (r) => r.status,
    duration: sortableDurationSeconds,
    started: (r) => new Date(r.started_at).getTime(),
  };

  const sortedRuns = sortKey
    ? [...filteredRuns].sort((a, b) => {
        const av = SORT_ACCESSORS[sortKey](a);
        const bv = SORT_ACCESSORS[sortKey](b);
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      })
    : filteredRuns;

  function toggleSort(key: string) {
    if (sortKey !== key) {
      setSortKey(key);
      // Started defaults to newest-first (matching the server's own
      // ORDER BY started_at DESC -- see lib/db.ts) since that's the
      // existing/expected order; every other column defaults to
      // ascending on its first click, the more conventional default.
      setSortDir(key === "started" ? "desc" : "asc");
    } else {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    }
  }

  // Dropped from `checkedIds` whenever the list is refreshed and a
  // previously-checked run has disappeared from it (deleted by someone
  // else) -- otherwise "N selected" could silently count rows that no
  // longer exist.
  useEffect(() => {
    setCheckedIds((prev) => {
      const stillPresent = new Set(runs.map((r) => r.run_id));
      const next = new Set([...prev].filter((id) => stillPresent.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [runs]);

  function toggleChecked(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleCheckAll() {
    setCheckedIds((prev) => {
      if (prev.size === filteredRuns.length && filteredRuns.length > 0) return new Set();
      return new Set(filteredRuns.map((r) => r.run_id));
    });
  }

  async function deleteSelected() {
    if (checkedIds.size === 0 || deleting) return;
    setShowDeleteConfirm(false);
    setDeleting(true);
    try {
      await Promise.all([...checkedIds].map((id) => fetchJson(`/v1/runs/${id}`, { method: "DELETE" })));
      if (selectedRunId && checkedIds.has(selectedRunId)) onSelectRun(null);
      setCheckedIds(new Set());
      await refreshList();
    } catch (err: any) {
      setLoadErr(err.message);
    } finally {
      setDeleting(false);
    }
  }

  async function pollDetail(id: string) {
    try {
      const job: RunJob = await fetchJson(`/v1/runs/${id}`);
      setSelectedJob(job);
      setDetailErr(null);
      if (job.status === "queued" || job.status === "running") {
        detailPollTimer.current = setTimeout(() => pollDetail(id), 500);
      }
      // Chart rendering happens in a useEffect below, not here -- the
      // <canvas> only mounts once React commits `selectedJob.status ===
      // "succeeded"` to the DOM, so calling renderChart() synchronously
      // right after setSelectedJob() would race a canvasRef that's still
      // null/stale (confirmed by testing: the canvas existed but stayed
      // its default 300x220 blank size, Chart.js never actually drew into
      // it).
    } catch (err: any) {
      setDetailErr(err.message);
    }
  }

  // Driven by selectedRunId (a prop, settable from outside this
  // component) rather than a local "selectRun" click handler owning the
  // whole lifecycle -- a row click just calls onSelectRun(id); this
  // effect is what actually starts polling, whether that id came from a
  // click here or from NewRunPanel just having submitted a run.
  useEffect(() => {
    if (detailPollTimer.current) clearTimeout(detailPollTimer.current);
    setSelectedJob(null);
    setDetailErr(null);
    setDrawerModelMeta(null);
    if (selectedRunId) pollDetail(selectedRunId);
    return () => {
      if (detailPollTimer.current) clearTimeout(detailPollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId]);

  useEffect(() => {
    if (selectedJob?.status === "succeeded") {
      renderChart(selectedJob);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJob]);

  // Fetches (and caches) the open drawer's model schema -- see
  // drawerModelMeta's own comment. Keyed on the model name, not the whole
  // selectedJob object, so this doesn't refetch on every progress poll.
  useEffect(() => {
    const model = selectedJob?.model;
    if (!model) return;
    if (schemaCache.current[model]) {
      setDrawerModelMeta(schemaCache.current[model]);
      return;
    }
    let cancelled = false;
    fetchJson(`/v1/models/${model}/schema`)
      .then((schema) => {
        if (cancelled) return;
        schemaCache.current[model] = schema;
        setDrawerModelMeta(schema);
      })
      .catch(() => {
        // Non-critical -- the Params row below just falls back to the
        // raw summarizeParams() rendering if this never resolves.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJob?.model]);

  function renderChart(job: RunJob) {
    const adapter = CHART_ADAPTERS[job.model];
    if (!adapter || !canvasRef.current) return;
    const { labels, values, label } = adapter(job.result);
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: { labels, datasets: [{ label, data: values, borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4 }] },
      options: {
        animation: false,
        // Deliberately NOT chartAspectRatio() -- that's tuned for the
        // dashboard's own wide main-area chart (3.4), which made this
        // chart tiny squeezed into the drawer's much narrower ~32rem
        // panel (32rem / 3.4 is a sliver). A fixed, much taller ratio
        // reads fine at this panel's width.
        aspectRatio: 1.3,
        interaction: { mode: "nearest", intersect: false },
        scales: {
          x: { title: { display: true, text: "year" } },
          y: { title: { display: true, text: "temperature anomaly" } },
        },
        plugins: {
          tooltip: { mode: "nearest", intersect: false },
        },
      },
    });
  }

  const allChecked = filteredRuns.length > 0 && checkedIds.size === filteredRuns.length;

  return (
    <div>
      <div className="panel-header">
        <h2 className="panel-title">Runs</h2>
        <button type="button" className="primary-button" onClick={onNewRun}>
          New Run
        </button>
      </div>

      {loadErr && <p className="panel-error">{loadErr}</p>}

      <div className="table-toolbar">
        <div className="run-controls runs-filter-row">
          <Dropdown options={modelOptions} value={filterModel} onChange={onFilterModelChange} ariaLabel="Filter by model" />
          <Dropdown options={scenarioOptions} value={filterScenario} onChange={setFilterScenario} ariaLabel="Filter by scenario" />
          <Dropdown options={STATUS_OPTIONS} value={filterStatus} onChange={setFilterStatus} ariaLabel="Filter by status" />
          {(filterModel !== ALL || filterScenario !== ALL || filterStatus !== ALL) && (
            <button
              className="text-button"
              onClick={() => {
                setFilterModel(ALL);
                setFilterScenario(ALL);
                setFilterStatus(ALL);
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        <div className="table-toolbar-actions">
          <button
            type="button"
            className={`icon-button danger${checkedIds.size > 0 ? " active" : ""}`}
            title={checkedIds.size > 0 ? `Delete ${checkedIds.size} selected` : "Select rows to delete"}
            aria-label="Delete selected runs"
            disabled={checkedIds.size === 0 || deleting}
            onClick={() => setShowDeleteConfirm(true)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.5 9a1 1 0 0 0 1 .95h4a1 1 0 0 0 1-.95l.5-9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button type="button" className="icon-button secondary" title="Refresh" aria-label="Refresh" onClick={refreshList}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M13.5 8a5.5 5.5 0 10-1.64 3.93M13.5 8V4.5M13.5 8H10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="table-scroll">
          <table className="runs-table">
            <thead>
              <tr>
                <th className="runs-table-checkbox-col">
                  <input
                    type="checkbox"
                    aria-label="Select all runs"
                    checked={allChecked}
                    onChange={toggleCheckAll}
                  />
                </th>
                <SortableHeader label="Model" sortKeyName="model" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader label="Version" sortKeyName="version" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader label="Params" sortKeyName="params" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader label="Status" sortKeyName="status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader
                  label="Duration"
                  sortKeyName="duration"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                />
                <SortableHeader
                  label="Started"
                  sortKeyName="started"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                />
              </tr>
            </thead>
            <tbody>
              {sortedRuns.length === 0 && (
                <tr>
                  <td colSpan={7} className="runs-table-empty">
                    {loading
                      ? "Loading runs..."
                      : runs.length === 0
                        ? 'No runs yet -- start one from "New Run".'
                        : "No runs match these filters."}
                  </td>
                </tr>
              )}
              {sortedRuns.map((r) => (
                <tr
                  key={r.run_id}
                  className={r.run_id === selectedRunId ? "selected" : ""}
                  onClick={() => onSelectRun(r.run_id)}
                >
                  <td className="runs-table-checkbox-col" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select run ${r.run_id}`}
                      checked={checkedIds.has(r.run_id)}
                      onChange={() => toggleChecked(r.run_id)}
                    />
                  </td>
                  <td>{r.model}</td>
                  <td className="mono">{r.model_version_number ?? "--"}</td>
                  <td className="mono runs-table-params" title={summarizeParams(r.params)}>
                    {summarizeParams(r.params)}
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                    {(r.status === "running" || r.status === "queued") &&
                      r.progress &&
                      typeof r.progress.percent === "number" && (
                        <span className="progress-tag">{r.progress.percent}%</span>
                      )}
                    {r.cached && <span className="cached-tag">cached</span>}
                    {r.status === "failed" && r.error?.message && (
                      <span className="error-tag" title={r.error.message}>
                        {r.error.message}
                      </span>
                    )}
                  </td>
                  <td>
                    {r.status === "running" || r.status === "queued"
                      ? formatElapsed(r.started_at)
                      : typeof r.duration_seconds === "number"
                        ? formatDuration(r.duration_seconds)
                        : "--"}
                  </td>
                  <td>{formatWhen(r.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selectedRunId && (
        <Drawer title={selectedJob ? `${selectedJob.model} run` : "Run"} onClose={() => onSelectRun(null)}>
          {detailErr && <p className="panel-error">{detailErr}</p>}
          {selectedJob && (
            <div className="drawer-meta">
              <div className="drawer-meta-row">
                <span className="drawer-meta-label">Run ID</span>
                <span className="mono">{selectedJob.run_id}</span>
              </div>
              <div className="drawer-meta-row">
                <span className="drawer-meta-label">Model</span>
                <span>{selectedJob.model}</span>
              </div>
              <div className="drawer-meta-row">
                <span className="drawer-meta-label">Model version</span>
                <span className="mono">{selectedJob.model_version_number ?? "unknown (run predates version tracking)"}</span>
              </div>
              <div className="drawer-meta-row">
                <span className="drawer-meta-label">Build</span>
                <span className="mono">{selectedJob.model_version ?? "unknown (run predates version tracking)"}</span>
              </div>
              {drawerModelMeta ? (
                <>
                  <div className="drawer-meta-row">
                    <span className="drawer-meta-label">Scenario</span>
                    <span className="mono">
                      {(() => {
                        const native = nativeScenarioOf(selectedJob.params);
                        return native ? canonicalScenario(native) : "(default)";
                      })()}
                    </span>
                  </div>
                  {(drawerModelMeta.parameters ?? []).map((spec) => (
                    <div className="drawer-meta-row" key={spec.key}>
                      <span className="drawer-meta-label">{spec.label}</span>
                      <span className="mono">
                        {Object.prototype.hasOwnProperty.call(selectedJob.params, spec.key)
                          ? String((selectedJob.params as Record<string, unknown>)[spec.key])
                          : "(default)"}
                      </span>
                    </div>
                  ))}
                </>
              ) : (
                <div className="drawer-meta-row">
                  <span className="drawer-meta-label">Params</span>
                  <span className="mono">{summarizeParams(selectedJob.params)}</span>
                </div>
              )}
              {(selectedJob.status === "running" || selectedJob.status === "queued") &&
                selectedJob.progress &&
                typeof selectedJob.progress.percent === "number" && (
                  <div className="drawer-meta-row">
                    <span className="drawer-meta-label">Progress</span>
                    <span>{selectedJob.progress.percent}%</span>
                  </div>
                )}
              {typeof selectedJob.duration_seconds === "number" ? (
                <div className="drawer-meta-row">
                  <span className="drawer-meta-label">Duration</span>
                  <span>{formatDuration(selectedJob.duration_seconds)}</span>
                </div>
              ) : (
                (selectedJob.status === "running" || selectedJob.status === "queued") &&
                // RunJob (this detail response) doesn't carry started_at --
                // reuse the already-fetched list row's copy of it instead
                // of widening that response just for this. Ticks up in
                // step with pollDetail's own 500ms poll while open, same
                // as the table's version (see formatElapsed's comment).
                (() => {
                  const listRow = runs.find((r) => r.run_id === selectedJob.run_id);
                  return listRow ? (
                    <div className="drawer-meta-row">
                      <span className="drawer-meta-label">Duration</span>
                      <span>{formatElapsed(listRow.started_at)}</span>
                    </div>
                  ) : null;
                })()
              )}
            </div>
          )}
          {selectedJob?.status === "succeeded" ? (
            <canvas ref={canvasRef} height={380}></canvas>
          ) : (
            <div className="chart-placeholder">
              {selectedJob
                ? selectedJob.status === "failed"
                  ? `Failed: ${selectedJob.error?.message || "unknown error"}`
                  : `${selectedJob.status}...`
                : "Loading..."}
            </div>
          )}
        </Drawer>
      )}

      {showDeleteConfirm && (
        <Modal title="Delete runs?" onClose={() => setShowDeleteConfirm(false)}>
          <p>
            Delete {checkedIds.size} selected run{checkedIds.size === 1 ? "" : "s"}? This also tears down any still-live
            sandbox behind them and can&apos;t be undone.
          </p>
          <div className="form-actions" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="text-button" onClick={() => setShowDeleteConfirm(false)}>
              Cancel
            </button>
            <button type="button" className="text-button danger" onClick={deleteSelected} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
