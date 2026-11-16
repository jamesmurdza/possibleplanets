"use client";

import { useEffect, useRef, useState } from "react";
import Chart from "chart.js/auto";
import Dropdown from "./Dropdown";
import { fetchJson, CHART_ADAPTERS, summarizeParams, chartAspectRatio } from "../lib/clientApi";
import type { RunJob, RunListItem } from "../lib/clientTypes";

export default function ComparePanel() {
  const [models, setModels] = useState<{ model: string; family: string }[]>([]);
  const [modelName, setModelName] = useState("");
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [hasChart, setHasChart] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    fetchJson("/v1/models")
      .then((data) => {
        setModels(data.models ?? []);
        if (data.models?.length) setModelName(data.models[0].model);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!modelName) return;
    setSelected(new Set());
    fetchJson("/v1/runs?limit=200")
      .then((data) => {
        const succeeded = (data.runs ?? []).filter(
          (r: RunListItem) => r.model === modelName && r.status === "succeeded",
        );
        setRuns(succeeded);
      })
      .catch((err) => setError(err.message));
  }, [modelName]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runComparison() {
    if (selected.size < 2) {
      setError("Select at least 2 runs to compare.");
      return;
    }
    setError(null);
    setComparing(true);
    try {
      const jobs: RunJob[] = await Promise.all(Array.from(selected).map((id) => fetchJson(`/v1/runs/${id}`)));
      const adapter = CHART_ADAPTERS[modelName];
      if (!adapter) {
        setError(`No chart adapter for model '${modelName}' yet.`);
        return;
      }
      // Each selected run's own labels are used for the FIRST dataset's
      // x-axis; other datasets just supply values aligned by index. This
      // assumes same-model runs share a consistent timeline, which is true
      // for every model in this project (same fixed start/end year
      // regardless of scenario/parameters) -- not a general guarantee for
      // models not yet built this way.
      const series = jobs.map((job) => adapter(job.result));
      if (chartRef.current) chartRef.current.destroy();
      if (!canvasRef.current) return;
      setHasChart(true);
      chartRef.current = new Chart(canvasRef.current, {
        type: "line",
        data: {
          labels: series[0].labels,
          datasets: series.map((s, i) => ({
            label: summarizeParams(jobs[i].params) || s.label,
            data: s.values,
            borderWidth: 1.5,
            pointRadius: 0,
          })),
        },
        options: {
          animation: false,
          aspectRatio: chartAspectRatio(),
          scales: {
            x: { title: { display: true, text: "year" } },
            y: { title: { display: true, text: "temperature anomaly" } },
          },
        },
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setComparing(false);
    }
  }

  const modelOptions = models.map((m) => ({ value: m.model, label: `${m.model} (${m.family})` }));

  return (
    <div>
      <div className="panel-header">
        <h2 className="panel-title">Compare</h2>
        <div className="run-controls">
          <Dropdown options={modelOptions} value={modelName} onChange={setModelName} ariaLabel="Model" />
          <button className="text-button" disabled={selected.size < 2 || comparing} onClick={runComparison}>
            Compare {selected.size > 0 ? `(${selected.size})` : ""}
          </button>
        </div>
      </div>

      {error && <p className="panel-error">{error}</p>}

      <section className="panel">
        <div className="table-scroll">
          <table className="runs-table">
            <thead>
              <tr>
                <th></th>
                <th>Params</th>
                <th>Duration</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr>
                  <td colSpan={4} className="runs-table-empty">
                    No succeeded runs for this model yet.
                  </td>
                </tr>
              )}
              {runs.map((r) => (
                <tr key={r.run_id} className={selected.has(r.run_id) ? "selected" : ""} onClick={() => toggle(r.run_id)}>
                  <td>
                    <input type="checkbox" checked={selected.has(r.run_id)} onChange={() => toggle(r.run_id)} />
                  </td>
                  <td className="mono">{summarizeParams(r.params)}</td>
                  <td>{typeof r.duration_seconds === "number" ? `${r.duration_seconds.toFixed(1)}s` : "--"}</td>
                  <td>{new Date(r.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel detail-panel">
        <div className="panel-body">
          <canvas ref={canvasRef} height={220}></canvas>
          {!hasChart && <div className="chart-placeholder">Select 2+ runs of the same model, then Compare</div>}
        </div>
      </section>
    </div>
  );
}
