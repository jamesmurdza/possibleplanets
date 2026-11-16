"use client";

import { useEffect, useRef, useState } from "react";
import Chart from "chart.js/auto";
import { fetchJson, CHART_ADAPTERS, summarizeParams, chartAspectRatio } from "../lib/clientApi";
import type { RunJob, RunListItem } from "../lib/clientTypes";

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
      data: { labels, datasets: [{ label, data: values, borderWidth: 1.5, pointRadius: 0 }] },
      options: {
        animation: false,
        aspectRatio: chartAspectRatio(),
        scales: {
          x: { title: { display: true, text: "year" } },
          y: { title: { display: true, text: "temperature anomaly" } },
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
              {runs.length === 0 && (
                <tr>
                  <td colSpan={5} className="runs-table-empty">
                    No runs yet -- start one from "New Run".
                  </td>
                </tr>
              )}
              {runs.map((r) => (
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
