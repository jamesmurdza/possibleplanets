"use client";

import { useEffect, useRef, useState } from "react";
import Chart from "chart.js/auto";
import { fetchJson, CHART_ADAPTERS, buildParams, chartAspectRatio, scenarioDescription, canonicalScenario } from "../lib/clientApi";
import { scenarioDriverSeries } from "../lib/scenarioDrivers";
import Sparkline from "./Sparkline";
import type { ModelMeta, ModelListItem, RunJob, ModelDurationStats, CheckResult } from "../lib/clientTypes";

// One simple, distinct glyph per model -- purely decorative wayfinding on
// the model cards, not derived from any real model property. Falls back to
// a plain circle for any model not listed here, so adding a new model to
// lib/models.ts without updating this never breaks rendering.
function ModelIcon({ model }: { model: string }) {
  const common = { viewBox: "0 0 16 16", "aria-hidden": true as const };
  switch (model) {
    case "hector": // bolt -- fastest model in this project
      return (
        <svg {...common}>
          <path d="M8.5 1.5 3 9h3.3L6 14.5 13 6.5H9.3L8.5 1.5z" fill="currentColor" />
        </svg>
      );
    case "fair": // balance/scale
      return (
        <svg {...common}>
          <path
            d="M8 1.5v13M3 4.5h10M3 4.5 1.5 8.5a1.75 1.75 0 0 0 3 0L3 4.5zM13 4.5l-1.5 4a1.75 1.75 0 0 0 3 0L13 4.5zM5.5 14.5h5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "oscar": // orbit/atom -- Monte Carlo ensemble
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="1.4" fill="currentColor" />
          <ellipse cx="8" cy="8" rx="6.2" ry="2.6" fill="none" stroke="currentColor" strokeWidth="1.1" />
          <ellipse
            cx="8"
            cy="8"
            rx="6.2"
            ry="2.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
            transform="rotate(60 8 8)"
          />
          <ellipse
            cx="8"
            cy="8"
            rx="6.2"
            ry="2.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
            transform="rotate(120 8 8)"
          />
        </svg>
      );
    case "dice": // literal die
      return (
        <svg {...common}>
          <rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" />
          <circle cx="10.5" cy="5.5" r="1" fill="currentColor" />
          <circle cx="8" cy="8" r="1" fill="currentColor" />
          <circle cx="5.5" cy="10.5" r="1" fill="currentColor" />
          <circle cx="10.5" cy="10.5" r="1" fill="currentColor" />
        </svg>
      );
    case "magicc": // sparkle
      return (
        <svg {...common}>
          <path
            d="M8 1.5l1.1 3.4L12.5 6l-3.4 1.1L8 10.5l-1.1-3.4L3.5 6l3.4-1.1L8 1.5zM13 9.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6.6-1.9z"
            fill="currentColor"
          />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
  }
}

export default function NewRunPanel() {
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [modelName, setModelName] = useState("");
  const [modelMeta, setModelMeta] = useState<ModelMeta | null>(null);
  const [scenario, setScenario] = useState("");
  const [status, setStatus] = useState("Loading models...");
  const [statusIsError, setStatusIsError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState("");
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [hasChart, setHasChart] = useState(false);
  const [rawUrl, setRawUrl] = useState<string | null>(null);
  const [rawFilename, setRawFilename] = useState("result.json");
  const [showRefresh, setShowRefresh] = useState(false);
  const [runDisabled, setRunDisabled] = useState(false);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [lastRunParams, setLastRunParams] = useState<Record<string, unknown> | null>(null);
  const [statsByModel, setStatsByModel] = useState<Record<string, ModelDurationStats>>({});
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rawObjectUrl = useRef<string | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkSeq = useRef(0);

  useEffect(() => {
    loadModels().catch((err) => {
      setStatus(`Failed to load models: ${err.message}`);
      setStatusIsError(true);
    });
    fetchJson("/v1/stats")
      .then((data) => {
        const byModel: Record<string, ModelDurationStats> = {};
        for (const s of data.stats ?? []) byModel[s.model] = s;
        setStatsByModel(byModel);
      })
      .catch(() => {
        // Non-critical -- the estimate just stays absent (never a
        // fabricated number) if this fails.
      });
    function onResize() {
      if (chartRef.current) {
        const ratio = chartAspectRatio();
        if (chartRef.current.options.aspectRatio !== ratio) {
          chartRef.current.options.aspectRatio = ratio;
          chartRef.current.resize();
        }
      }
    }
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Would this exact selection be a cache hit right now?" -- debounced and
  // sequence-guarded (see app history: typing in an Advanced field
  // shouldn't fire a request per keystroke, and a slow stale response can't
  // overwrite a newer one).
  useEffect(() => {
    if (checkTimer.current) clearTimeout(checkTimer.current);
    if (!modelMeta || !scenario) {
      setCheckResult(null);
      return;
    }
    const mySeq = ++checkSeq.current;
    checkTimer.current = setTimeout(async () => {
      try {
        const params = buildParams(modelMeta, scenario, paramValues);
        const result = await fetchJson(`/v1/models/${modelName}/check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ params }),
        });
        if (mySeq === checkSeq.current) setCheckResult(result);
      } catch {
        if (mySeq === checkSeq.current) setCheckResult(null);
      }
    }, 300);
    return () => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelName, modelMeta, scenario, paramValues]);

  async function loadModels() {
    const data = await fetchJson("/v1/models");
    setModels(data.models);
    if (data.models.length) {
      const first = data.models[0].model;
      setModelName(first);
      await loadSchema(first);
    }
    setStatus("Select a model and scenario, then click Run.");
  }

  async function loadSchema(name: string) {
    const schema = await fetchJson(`/v1/models/${name}/schema`);
    setModelMeta(schema);
    setScenario(schema.scenarios[0] ?? "");
    setParamValues({});
  }

  function setStatusText(text: string, isError = false) {
    setStatus(text);
    setStatusIsError(isError);
  }

  function showLoading(text: string, progress: { percent: number } | null) {
    setLoading(true);
    setLoadingText(text);
    setProgressPercent(progress && typeof progress.percent === "number" ? progress.percent : null);
  }

  function hideLoading() {
    setLoading(false);
  }

  function renderChart(name: string, result: any) {
    const adapter = CHART_ADAPTERS[name];
    if (!adapter) {
      setStatusText(`No chart adapter for model '${name}' yet.`, true);
      return;
    }
    const { labels, values, label } = adapter(result);
    setHasChart(true);

    if (chartRef.current) chartRef.current.destroy();
    if (!canvasRef.current) return;
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

  function setRawDownload(job: RunJob) {
    if (rawObjectUrl.current) URL.revokeObjectURL(rawObjectUrl.current);
    const blob = new Blob([JSON.stringify(job, null, 2)], { type: "application/json" });
    rawObjectUrl.current = URL.createObjectURL(blob);
    setRawUrl(rawObjectUrl.current);
    setRawFilename(`${job.model}-${job.run_id}.json`);
  }

  // Shared terminal/in-progress handling for a job, whether it arrived via
  // a poll (GET /v1/runs/{id}) or inline in the POST response itself (a
  // cache hit -- see submitRun's module comment: that run_id was never
  // written to the `runs` table, so there's nothing to poll for).
  function handleJob(job: RunJob, name: string, runId: string) {
    if (job.status === "queued" || job.status === "running") {
      const pct = job.progress && typeof job.progress.percent === "number" ? ` (${job.progress.percent}%)` : "";
      const text = `${job.status}${pct}...`;
      setStatusText(`${name}: ${text}`);
      showLoading(text, job.progress);
      pollTimer.current = setTimeout(() => pollRun(runId, name), 150);
      return;
    }

    setRunDisabled(false);
    hideLoading();

    if (job.status === "succeeded") {
      const duration = typeof job.duration_seconds === "number" ? ` in ${job.duration_seconds.toFixed(1)}s` : "";
      setStatusText(`${name}: succeeded${job.cached ? " (cached)" : ""}${duration}`);
      renderChart(name, job.result);
      setRawDownload(job);
      setLastRunParams(job.params ?? null);
      setShowRefresh(!!job.cached);
    } else {
      setStatusText(`${name}: failed - ${job.error?.message || "unknown error"}`, true);
    }
  }

  async function pollRun(runId: string, name: string) {
    const job: RunJob = await fetchJson(`/v1/runs/${runId}`);
    handleJob(job, name, runId);
  }

  async function runModel(forceRefresh = false) {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setRunDisabled(true);
    setShowRefresh(false);
    setRawUrl(null);
    setLastRunParams(null);

    if (!modelMeta) return;

    try {
      setStatusText(`${modelName}: submitting...`);
      showLoading("submitting...", null);
      const params = buildParams(modelMeta, scenario, paramValues);
      const submitted = await fetchJson(`/v1/models/${modelName}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ params, refresh: forceRefresh }),
      });
      // A cache hit comes back as a finished job inline (see submitRun's
      // module comment) rather than a run_id to poll -- that run_id was
      // never written to the `runs` table, so polling it would 404.
      if (submitted.status === "succeeded" || submitted.status === "failed") {
        handleJob(submitted as RunJob, modelName, submitted.run_id);
      } else {
        pollRun(submitted.run_id, modelName);
      }
    } catch (err: any) {
      setRunDisabled(false);
      hideLoading();
      setStatusText(`${modelName}: ${err.message}`, true);
    }
  }

  async function onModelChange(name: string) {
    setModelName(name);
    setShowRefresh(false);
    setCheckResult(null);
    try {
      await loadSchema(name);
    } catch (err: any) {
      setStatusText(err.message, true);
    }
  }

  function onScenarioChange(s: string) {
    setScenario(s);
    setShowRefresh(false);
    setCheckResult(null);
  }

  function onParamChange(key: string, raw: string) {
    setParamValues((prev) => ({ ...prev, [key]: raw }));
    setShowRefresh(false);
    setCheckResult(null);
  }

  function etaBadge(): { text: string; kind: "cached" | "estimate" | "warn" } | null {
    if (!checkResult) return null;
    if (!checkResult.cacheable) {
      return { text: "Won't be cached (see Advanced)", kind: "warn" };
    }
    if (checkResult.cached) {
      return { text: "Cached", kind: "cached" };
    }
    const stats = statsByModel[modelName];
    if (stats) {
      return { text: `~${stats.median_seconds.toFixed(1)}s estimated`, kind: "estimate" };
    }
    return { text: "No run history yet", kind: "estimate" };
  }
  const eta = etaBadge();

  const scenarios = modelMeta?.scenarios ?? [];
  const parameters = modelMeta?.parameters ?? [];
  const nonDeterministicKey = modelMeta?.non_deterministic_unless;
  const nonDeterministicUnset = !!nonDeterministicKey && !paramValues[nonDeterministicKey];
  const showResult = loading || hasChart;

  return (
    <div>
      <div className="panel-header">
        <h2 className="panel-title">New Run</h2>
      </div>

      <form
        className="run-form"
        onSubmit={(e) => {
          e.preventDefault();
          runModel(false);
        }}
      >
        <div className="form-field-block">
          <span className="form-field-label">Model</span>
          <div className="model-card-grid" role="radiogroup" aria-label="Model">
            {models.map((m) => (
              <div
                key={m.model}
                className={`model-card${m.model === modelName ? " selected" : ""}`}
                role="radio"
                aria-checked={m.model === modelName}
                tabIndex={0}
                onClick={() => onModelChange(m.model)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onModelChange(m.model);
                  }
                }}
              >
                <div className="model-card-header">
                  <span className="model-card-icon">
                    <ModelIcon model={m.model} />
                  </span>
                  <span className="model-card-name">{m.model}</span>
                </div>
                <p className="model-card-description">{m.description}</p>
                {m.website && (
                  <a
                    className="model-card-link"
                    href={m.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Model website &rarr;
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="form-field-block">
          <span className="form-field-label">Scenario</span>
          <div className="scenario-card-grid" role="radiogroup" aria-label="Scenario">
            {scenarios.map((s) => {
              const desc = scenarioDescription(s);
              const canonical = canonicalScenario(s);
              const driver = scenarioDriverSeries(canonical);
              return (
                <div
                  key={s}
                  className={`scenario-card${s === scenario ? " selected" : ""}`}
                  role="radio"
                  aria-checked={s === scenario}
                  tabIndex={0}
                  onClick={() => onScenarioChange(s)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onScenarioChange(s);
                    }
                  }}
                >
                  <div className="scenario-card-header">
                    <span className="scenario-card-name">{canonical}</span>
                    {driver && (
                      <span className="scenario-card-sparkline" title="Projected CO2 emissions pathway (GtC/yr, 2014-2100)">
                        <Sparkline values={driver.values} />
                      </span>
                    )}
                  </div>
                  {desc && <p className="scenario-card-description">{desc}</p>}
                </div>
              );
            })}
          </div>
        </div>

        {parameters.length > 0 && (
          <div className="form-field-block">
            <span className="form-field-label">Parameters (optional)</span>
            <div className="param-fields-grid">
              {parameters.map((spec) => (
                <label key={spec.key} className="form-field">
                  <span className="form-field-label">{spec.label}</span>
                  <input
                    type="number"
                    placeholder={spec.placeholderHint ?? `${spec.default}`}
                    min={spec.min}
                    max={spec.max}
                    step={spec.step ?? "any"}
                    value={paramValues[spec.key] ?? ""}
                    onChange={(e) => onParamChange(spec.key, e.target.value)}
                  />
                </label>
              ))}
            </div>
            {nonDeterministicKey && (
              <p className="advanced-note">
                {nonDeterministicUnset
                  ? `This model's result isn't reproducible without a "${nonDeterministicKey}" value -- this run will not be cached, and a repeat run may give a different answer.`
                  : `A "${nonDeterministicKey}" is set, so this run is reproducible and will be cached.`}
              </p>
            )}
          </div>
        )}

        <div className="form-actions">
          <button type="submit" className="primary-button" disabled={runDisabled}>
            Run
          </button>
          {eta && <span className={`eta-badge eta-badge-${eta.kind}`}>{eta.text}</span>}
        </div>
      </form>

      {showResult && (
        <>
          <div className="panel-header">
            <h3 className="panel-title">Result</h3>
            <div className="run-controls">
              {showRefresh && (
                <button
                  className="icon-button secondary"
                  title="Re-run without using the cached result"
                  aria-label="Refresh"
                  disabled={runDisabled}
                  onClick={() => runModel(true)}
                >
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
              )}
              {rawUrl && (
                <a
                  className="icon-button secondary"
                  href={rawUrl}
                  download={rawFilename}
                  title="Download raw output (JSON)"
                  aria-label="Download raw output (JSON)"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M8 2v7.5M4.5 7l3.5 3.5L11.5 7M3 13.5h10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </a>
              )}
            </div>
          </div>

          <section className="panel">
            <div className="panel-body">
              <canvas ref={canvasRef} id="result-chart" height={220}></canvas>
              {loading && (
                <div className="loading-overlay">
                  <div className="loading-box">
                    <span className="loading-text">{loadingText}</span>
                    <progress className="progress-bar" max={100} value={progressPercent ?? undefined}></progress>
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      )}

      <div className="panel-footer">
        <span className={`status-text${statusIsError ? " error" : ""}`}>{status}</span>
        {lastRunParams && (
          <span className="status-params" title="Exact params this result was run with -- reuse them for a guaranteed cache hit">
            {JSON.stringify(lastRunParams)}
          </span>
        )}
      </div>
    </div>
  );
}
