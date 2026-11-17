"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "chart.js/auto";
import Dropdown from "./Dropdown";
import { fetchJson, CHART_ADAPTERS, chartAspectRatio, nativeScenarioOf, canonicalScenario, alignSeriesByYear, yAxisTitle } from "../lib/clientApi";
import type { ModelMeta, ModelListItem, RunJob, RunListItem } from "../lib/clientTypes";

type Axis = "model" | "scenario" | "parameter";

const AXIS_OPTIONS = [
  { value: "model", label: "Model" },
  { value: "scenario", label: "Scenario" },
  { value: "parameter", label: "Parameter" },
];

// Canonical (not model-native) -- this is exactly what makes the "Model"
// compare axis work at all: hector's "ssp119" and oscar's "SSP1-1.9" need
// to read as the SAME scenario to find/group runs across models. See
// canonicalScenario's comment in lib/clientApi.ts for why RCP/base/optimal
// are deliberately left alone, not force-mapped onto an SSP label.
function scenarioOf(params: Record<string, unknown>): string | undefined {
  const native = nativeScenarioOf(params);
  return native ? canonicalScenario(native) : undefined;
}

// One group = every succeeded run matching the fixed dimensions that
// shares the same value along the chosen compare axis (model, scenario, or
// a parameter). An omitted parameter is its own "default" group, never
// folded into an explicit value's group -- same never-equivalent principle
// as caching elsewhere in this app. Only the most recently started run in
// each group is actually plotted.
interface Group {
  label: string;
  run: RunListItem;
}

export default function ComparePanel() {
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [axis, setAxis] = useState<Axis>("parameter");

  // Fixed-dimension selections -- which ones matter depends on `axis`:
  // "model" compare varies model, so only scenario is fixed; "scenario"
  // compare varies scenario, so only model is fixed; "parameter" compare
  // varies one parameter's value, so both model and scenario are fixed.
  const [modelName, setModelName] = useState("");
  const [modelMeta, setModelMeta] = useState<ModelMeta | null>(null);
  const [scenario, setScenario] = useState("");
  const [parameterKey, setParameterKey] = useState("");

  const [allRuns, setAllRuns] = useState<RunListItem[]>([]);
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
    refreshRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshRuns() {
    try {
      const data = await fetchJson("/v1/runs?limit=200");
      setAllRuns((data.runs ?? []).filter((r: RunListItem) => r.status === "succeeded"));
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function onModelChange(name: string) {
    setModelName(name);
    setError(null);
    try {
      const schema = await fetchJson(`/v1/models/${name}/schema`);
      setModelMeta(schema);
      const firstScenario = schema.scenarios[0];
      setScenario(firstScenario ? canonicalScenario(firstScenario) : "");
      setParameterKey(schema.parameters?.[0]?.key ?? "");
    } catch (err: any) {
      setError(err.message);
    }
  }

  // Every scenario string seen among succeeded runs of the currently
  // selected model -- used for the Scenario dropdown when comparing by
  // model/parameter. Scoped to actual run data (not just the model's full
  // schema list) so picking one is guaranteed to have something to compare.
  const scenariosForModel = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRuns) {
      if (r.model !== modelName) continue;
      const s = scenarioOf(r.params);
      if (s) set.add(s);
    }
    return Array.from(set).sort();
  }, [allRuns, modelName]);

  // Every scenario string seen among succeeded runs of ANY model -- used
  // for the Scenario dropdown when comparing by model (the fixed dimension
  // there is scenario, independent of which model each run belongs to).
  const scenariosAnyModel = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRuns) {
      const s = scenarioOf(r.params);
      if (s) set.add(s);
    }
    return Array.from(set).sort();
  }, [allRuns]);

  useEffect(() => {
    if (axis === "model" && !scenario && scenariosAnyModel.length) {
      setScenario(scenariosAnyModel[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis, scenariosAnyModel]);

  // Re-group every time the axis or any fixed selection changes -- the
  // whole point of this panel is: pick what varies (model, scenario, or a
  // parameter) and what's held fixed, and the matching runs are found
  // automatically instead of hand-picking individual runs.
  const groups: Group[] = useMemo(() => {
    const byKey = new Map<string, RunListItem>();

    function consider(key: string, r: RunListItem) {
      const existing = byKey.get(key);
      if (!existing || new Date(r.started_at) > new Date(existing.started_at)) {
        byKey.set(key, r);
      }
    }

    if (axis === "model") {
      if (!scenario) return [];
      for (const r of allRuns) {
        if (scenarioOf(r.params) !== scenario) continue;
        consider(r.model, r);
      }
    } else if (axis === "scenario") {
      if (!modelName) return [];
      for (const r of allRuns) {
        if (r.model !== modelName) continue;
        const s = scenarioOf(r.params);
        if (s) consider(s, r);
      }
    } else {
      if (!modelName || !scenario || !parameterKey) return [];
      for (const r of allRuns) {
        if (r.model !== modelName || scenarioOf(r.params) !== scenario) continue;
        const raw = r.params?.[parameterKey];
        consider(raw === undefined ? "default" : String(raw), r);
      }
    }

    return Array.from(byKey.entries())
      .map(([label, run]) => ({ label, run }))
      .sort((a, b) => (a.label === "default" ? -1 : b.label === "default" ? 1 : a.label.localeCompare(b.label)));
  }, [axis, allRuns, modelName, scenario, parameterKey]);

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
          y: { title: { display: true, text: yAxisTitle(modelName) } },
        },
      },
    });
  }, [chartData]);

  function labelFor(g: Group): string {
    if (axis === "model") return g.label;
    if (axis === "scenario") return g.label;
    return g.label === "default" ? `${parameterKey} = default` : `${parameterKey} = ${g.label}`;
  }

  async function runComparison() {
    if (groups.length < 2) {
      setError("Need at least 2 distinct values to compare -- try a different selection, or run more models first.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const jobs: RunJob[] = await Promise.all(groups.map((g) => fetchJson(`/v1/runs/${g.run.run_id}`)));
      const series = jobs.map((job, i) => {
        const adapter = CHART_ADAPTERS[job.model];
        if (!adapter) throw new Error(`No chart adapter for model '${job.model}' yet.`);
        const s = adapter(job.result);
        return { ...s, label: labelFor(groups[i]) };
      });
      // Aligned by actual year value, not array index/position -- series
      // can differ in length/range (e.g. comparing by model: hector's
      // 1745-2300 vs oscar's 1750-2100), so naively zipping arrays by
      // index would plot one series under the wrong years entirely. See
      // alignSeriesByYear's comment for the real bug this fixes.
      const aligned = alignSeriesByYear(series);
      setHasChart(true);
      setChartData({
        labels: aligned.labels,
        datasets: aligned.datasets.map((d) => ({
          label: d.label,
          data: d.data,
          borderWidth: 1.5,
          pointRadius: 0,
          // See alignSeriesByYear's comment in lib/clientApi.ts -- dice
          // reports every 5 years, not annually like the rest, so this
          // has to be true or dice's line never draws at all.
          spanGaps: true,
        })),
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const modelOptions = models.map((m) => ({ value: m.model, label: `${m.model} (${m.family})` }));
  const scenarioOptionsForModel = scenariosForModel.map((s) => ({ value: s, label: s }));
  const scenarioOptionsAnyModel = scenariosAnyModel.map((s) => ({ value: s, label: s }));
  const parameters = modelMeta?.parameters ?? [];
  const parameterOptions = parameters.map((p) => ({ value: p.key, label: p.label }));

  const summaryText = (() => {
    if (axis === "model") {
      if (!scenario) return "Pick a scenario.";
      return groups.length === 0
        ? `No succeeded runs of scenario "${scenario}" yet.`
        : `${groups.length} model${groups.length === 1 ? "" : "s"} found for "${scenario}": ${groups.map((g) => g.label).join(", ")}.`;
    }
    if (axis === "scenario") {
      if (!modelName) return "Pick a model.";
      return groups.length === 0
        ? `No succeeded runs of "${modelName}" yet.`
        : `${groups.length} scenario${groups.length === 1 ? "" : "s"} found for ${modelName}: ${groups.map((g) => g.label).join(", ")}.`;
    }
    if (parameters.length === 0) return `"${modelName}" has no tunable parameters.`;
    return groups.length === 0
      ? "No succeeded runs of this model+scenario yet."
      : `${groups.length} distinct value${groups.length === 1 ? "" : "s"} of "${parameterKey}" found: ${groups.map((g) => g.label).join(", ")}.`;
  })();

  return (
    <div>
      <div className="panel-header">
        <h2 className="panel-title">Compare</h2>
        <button className="text-button" onClick={refreshRuns}>
          Refresh
        </button>
      </div>

      <section className="panel">
        <div className="panel-body">
          <div className="form-field-block">
            <span className="form-field-label">Compare by</span>
            <div className="axis-toggle" role="radiogroup" aria-label="Compare by">
              {AXIS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`axis-toggle-option${axis === opt.value ? " selected" : ""}`}
                  aria-pressed={axis === opt.value}
                  onClick={() => setAxis(opt.value as Axis)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-row">
            {axis === "model" && (
              <label className="form-field">
                <span className="form-field-label">Scenario (fixed)</span>
                <Dropdown options={scenarioOptionsAnyModel} value={scenario} onChange={setScenario} ariaLabel="Scenario" />
              </label>
            )}

            {axis === "scenario" && (
              <label className="form-field">
                <span className="form-field-label">Model (fixed)</span>
                <Dropdown options={modelOptions} value={modelName} onChange={onModelChange} ariaLabel="Model" />
              </label>
            )}

            {axis === "parameter" && (
              <>
                <label className="form-field">
                  <span className="form-field-label">Model (fixed)</span>
                  <Dropdown options={modelOptions} value={modelName} onChange={onModelChange} ariaLabel="Model" />
                </label>
                <label className="form-field">
                  <span className="form-field-label">Scenario (fixed)</span>
                  <Dropdown
                    options={scenarioOptionsForModel}
                    value={scenario}
                    onChange={setScenario}
                    ariaLabel="Scenario"
                  />
                </label>
                {parameters.length > 0 && (
                  <label className="form-field">
                    <span className="form-field-label">Parameter (varies)</span>
                    <Dropdown
                      options={parameterOptions}
                      value={parameterKey}
                      onChange={setParameterKey}
                      ariaLabel="Parameter"
                    />
                  </label>
                )}
              </>
            )}
          </div>

          <p className="advanced-note">{summaryText}</p>

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
