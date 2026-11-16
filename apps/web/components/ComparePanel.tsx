"use client";

import { useEffect, useRef, useState } from "react";
import Chart from "chart.js/auto";
import Dropdown from "./Dropdown";
import { fetchJson, CHART_ADAPTERS, chartAspectRatio } from "../lib/clientApi";
import type { ModelMeta, ModelListItem, RunJob, RunListItem } from "../lib/clientTypes";

// One group = every succeeded run of the chosen model+scenario that shares
// the same value for the chosen parameter (an omitted parameter is its own
// group, "default" -- never folded into an explicit value's group, same
// never-equivalent principle as caching elsewhere in this app). Only the
// most recently started run in each group is actually plotted.
interface Group {
  value: string;
  run: RunListItem;
}

export default function ComparePanel() {
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [modelName, setModelName] = useState("");
  const [modelMeta, setModelMeta] = useState<ModelMeta | null>(null);
  const [scenario, setScenario] = useState("");
  const [parameterKey, setParameterKey] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasChart, setHasChart] = useState(false);

  const [chartData, setChartData] = useState<{ labels: any[]; datasets: any[] } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    fetchJson("/v1/models")
      .then((data) => {
        setModels(data.models ?? []);
        if (data.models?.length) onModelChange(data.models[0].model);
      })
      .catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onModelChange(name: string) {
    setModelName(name);
    setError(null);
    try {
      const schema = await fetchJson(`/v1/models/${name}/schema`);
      setModelMeta(schema);
      setScenario(schema.scenarios[0] ?? "");
      setParameterKey(schema.parameters?.[0]?.key ?? "");
    } catch (err: any) {
      setError(err.message);
    }
  }

  // Re-group every time model/scenario/parameter changes -- this is the
  // whole point of the redesign: instead of hand-picking individual runs to
  // compare, pick a model + scenario + which parameter varies, and the
  // matching runs are found automatically.
  useEffect(() => {
    if (!modelName || !scenario || !parameterKey) {
      setGroups([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchJson("/v1/runs?limit=200");
        const matching: RunListItem[] = (data.runs ?? []).filter((r: RunListItem) => {
          if (r.model !== modelName || r.status !== "succeeded") return false;
          const s = r.params?.scenario ?? (Array.isArray(r.params?.scenarios) ? r.params.scenarios[0] : undefined);
          return s === scenario;
        });
        const byValue = new Map<string, RunListItem>();
        for (const r of matching) {
          const raw = r.params?.[parameterKey];
          const value = raw === undefined ? "default" : String(raw);
          const existing = byValue.get(value);
          if (!existing || new Date(r.started_at) > new Date(existing.started_at)) {
            byValue.set(value, r);
          }
        }
        if (cancelled) return;
        const next = Array.from(byValue.entries())
          .map(([value, run]) => ({ value, run }))
          .sort((a, b) => (a.value === "default" ? -1 : b.value === "default" ? 1 : a.value.localeCompare(b.value)));
        setGroups(next);
        setError(null);
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelName, scenario, parameterKey]);

  useEffect(() => {
    if (!chartData || !canvasRef.current) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: chartData,
      options: {
        animation: false,
        aspectRatio: chartAspectRatio(),
        scales: {
          x: { title: { display: true, text: "year" } },
          y: { title: { display: true, text: "temperature anomaly" } },
        },
      },
    });
  }, [chartData]);

  async function runComparison() {
    if (groups.length < 2) {
      setError("Need at least 2 distinct values of this parameter among succeeded runs to compare.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const jobs: RunJob[] = await Promise.all(groups.map((g) => fetchJson(`/v1/runs/${g.run.run_id}`)));
      const adapter = CHART_ADAPTERS[modelName];
      if (!adapter) {
        setError(`No chart adapter for model '${modelName}' yet.`);
        return;
      }
      // Each matched run shares the same model+scenario, so they're assumed
      // to share a consistent timeline -- same assumption this project has
      // made for every model so far (fixed start/end year regardless of
      // scenario/parameters).
      const series = jobs.map((job) => adapter(job.result));
      // Stash the data in state and let the useEffect below build the
      // Chart.js chart once the <canvas> actually mounts -- it only mounts
      // when hasChart flips true, so building the chart synchronously here
      // (before React commits that) would race a canvasRef that's still
      // null, same bug fixed earlier in RunsPanel.
      setHasChart(true);
      setChartData({
        labels: series[0].labels,
        datasets: series.map((s, i) => ({
          label: groups[i].value === "default" ? `${parameterKey} = default` : `${parameterKey} = ${groups[i].value}`,
          data: s.values,
          borderWidth: 1.5,
          pointRadius: 0,
        })),
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const modelOptions = models.map((m) => ({ value: m.model, label: `${m.model} (${m.family})` }));
  const scenarioOptions = (modelMeta?.scenarios ?? []).map((s) => ({ value: s, label: s }));
  const parameters = modelMeta?.parameters ?? [];
  const parameterOptions = parameters.map((p) => ({ value: p.key, label: p.label }));

  return (
    <div>
      <div className="panel-header">
        <h2 className="panel-title">Compare</h2>
      </div>

      <section className="panel">
        <div className="panel-body">
          <div className="form-row">
            <label className="form-field">
              <span className="form-field-label">Model</span>
              <Dropdown options={modelOptions} value={modelName} onChange={onModelChange} ariaLabel="Model" />
            </label>
            <label className="form-field">
              <span className="form-field-label">Scenario</span>
              <Dropdown
                options={scenarioOptions}
                value={scenario}
                onChange={(s) => setScenario(s)}
                ariaLabel="Scenario"
              />
            </label>
            <label className="form-field">
              <span className="form-field-label">Compare by parameter</span>
              {parameters.length > 0 ? (
                <Dropdown
                  options={parameterOptions}
                  value={parameterKey}
                  onChange={(k) => setParameterKey(k)}
                  ariaLabel="Parameter"
                />
              ) : (
                <span className="status-text">No tunable parameters for this model.</span>
              )}
            </label>
          </div>

          {parameters.length > 0 && (
            <p className="advanced-note">
              {groups.length === 0
                ? "No succeeded runs of this model+scenario yet."
                : `${groups.length} distinct value${groups.length === 1 ? "" : "s"} of "${parameterKey}" found: ${groups
                    .map((g) => g.value)
                    .join(", ")}.`}
            </p>
          )}

          <div className="form-actions">
            <button className="primary-button" disabled={groups.length < 2 || loading} onClick={runComparison}>
              Compare {groups.length > 0 ? `(${groups.length})` : ""}
            </button>
          </div>
        </div>
      </section>

      {error && <p className="panel-error">{error}</p>}

      {hasChart && (
        <section className="panel detail-panel">
          <div className="panel-body">
            <canvas ref={canvasRef} height={220}></canvas>
          </div>
        </section>
      )}
    </div>
  );
}
