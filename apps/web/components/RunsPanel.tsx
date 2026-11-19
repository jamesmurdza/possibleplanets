"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "chart.js/auto";
import Dropdown from "./Dropdown";
import Drawer from "./Drawer";
import Modal from "./Modal";
import { fetchJson, CHART_ADAPTERS, summarizeParams, chartAspectRatio, nativeScenarioOf, canonicalScenario } from "../lib/clientApi";
import type { RunJob, RunListItem } from "../lib/clientTypes";

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

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-pill status-pill-${status}`}>{status}</span>;
}

export interface RunsPanelProps {
  // Controlled, not local state -- a New Run submission (see
  // NewRunPanel.tsx's onRunSubmitted) sets this from OUTSIDE this
  // component (switching the dashboard's own tab to "runs" at the same
  // time), not just a row click inside this table.
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
}

export default function RunsPanel({ selectedRunId, onSelectRun }: RunsPanelProps) {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<RunJob | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [filterModel, setFilterModel] = useState(ALL);
  const [filterScenario, setFilterScenario] = useState(ALL);
  const [filterStatus, setFilterStatus] = useState(ALL);
  // Checkbox selection for bulk delete -- independent of selectedRunId
  // (which run's drawer is open), see the header comment above.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  // Confirmation step for the delete icon -- never deletes directly on
  // click, since this is a bulk/irreversible action (see deleteSelected's
  // own DELETE calls, there's no undo).
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const listPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function refreshList() {
    try {
      const data = await fetchJson("/v1/runs");
      setRuns(data.runs ?? []);
      setLoadErr(null);
    } catch (err: any) {
      setLoadErr(err.message);
    }
  }

  useEffect(() => {
    refreshList();
    return () => {
      if (listPollTimer.current) clearTimeout(listPollTimer.current);
      if (detailPollTimer.current) clearTimeout(detailPollTimer.current);
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
        aspectRatio: chartAspectRatio(),
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
      </div>

      {loadErr && <p className="panel-error">{loadErr}</p>}

      <div className="table-toolbar">
        <div className="run-controls">
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
                <th>Model</th>
                <th>Params</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {filteredRuns.length === 0 && (
                <tr>
                  <td colSpan={6} className="runs-table-empty">
                    {runs.length === 0 ? 'No runs yet -- start one from "New Run".' : "No runs match these filters."}
                  </td>
                </tr>
              )}
              {filteredRuns.map((r) => (
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
                  <td className="mono">{summarizeParams(r.params)}</td>
                  <td>
                    <StatusBadge status={r.status} />
                    {r.cached && <span className="cached-tag">cached</span>}
                  </td>
                  <td>
                    {r.status === "running" || r.status === "queued"
                      ? r.progress && typeof r.progress.percent === "number"
                        ? `${r.progress.percent}%`
                        : "..."
                      : typeof r.duration_seconds === "number"
                        ? `${r.duration_seconds.toFixed(1)}s`
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
                <span className="drawer-meta-label">Model</span>
                <span>{selectedJob.model}</span>
              </div>
              <div className="drawer-meta-row">
                <span className="drawer-meta-label">Version</span>
                <span className="mono">{selectedJob.model_version ?? "unknown (run predates version tracking)"}</span>
              </div>
              <div className="drawer-meta-row">
                <span className="drawer-meta-label">Params</span>
                <span className="mono">{summarizeParams(selectedJob.params)}</span>
              </div>
              {typeof selectedJob.duration_seconds === "number" && (
                <div className="drawer-meta-row">
                  <span className="drawer-meta-label">Duration</span>
                  <span>{selectedJob.duration_seconds.toFixed(1)}s</span>
                </div>
              )}
            </div>
          )}
          {selectedJob?.status === "succeeded" ? (
            <canvas ref={canvasRef} height={220}></canvas>
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
