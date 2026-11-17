"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "chart.js/auto";
import Dropdown from "./Dropdown";
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

export default function RunsPanel() {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<RunJob | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [filterModel, setFilterModel] = useState(ALL);
  const [filterScenario, setFilterScenario] = useState(ALL);
  const [filterStatus, setFilterStatus] = useState(ALL);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const listPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function refreshList() {
    try {
      const data = await fetchJson("/v1/runs?limit=50");
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
  // same ~1s cadence is plenty for a list view (contrast with the ~150ms
  // poll used for a single run's own progress bar).
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

  async function selectRun(id: string) {
    setSelectedId(id);
    setSelectedJob(null);
    setDetailErr(null);
    if (detailPollTimer.current) clearTimeout(detailPollTimer.current);
    pollDetail(id);
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

  return (
    <div>
      <div className="panel-header">
        <h2 className="panel-title">Runs</h2>
        <button className="text-button" onClick={refreshList}>
          Refresh
        </button>
      </div>

      {loadErr && <p className="panel-error">{loadErr}</p>}

      <div className="run-controls" style={{ marginBottom: "0.75rem" }}>
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

      <section className="panel">
        <div className="table-scroll">
          <table className="runs-table">
            <thead>
              <tr>
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
                  <td colSpan={5} className="runs-table-empty">
                    {runs.length === 0 ? 'No runs yet -- start one from "New Run".' : "No runs match these filters."}
                  </td>
                </tr>
              )}
              {filteredRuns.map((r) => (
                <tr
                  key={r.run_id}
                  className={r.run_id === selectedId ? "selected" : ""}
                  onClick={() => selectRun(r.run_id)}
                >
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

      {selectedId && (
        <section className="panel detail-panel">
          <div className="panel-body">
            {detailErr && <p className="panel-error">{detailErr}</p>}
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
          </div>
        </section>
      )}
    </div>
  );
}
