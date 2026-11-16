"use client";

import { useEffect, useRef, useState } from "react";
import Chart from "chart.js/auto";
import Dropdown from "../components/Dropdown";

// Same-origin now that the gateway and dashboard live in one Next.js app --
// no more guessGatewayUrl() port-swapping against the Daytona proxy
// hostname (see the old apps/dashboard/app.js). Anyone else consuming the
// gateway from a different origin just hits these same /v1/* paths
// directly (see lib/cors.ts) -- this relative-path choice is purely a
// same-origin convenience for this particular page, not a constraint on the
// API itself.
const GATEWAY_URL = "";

interface ModelMeta {
  model: string;
  family: string;
  scenarios: string[];
  params_shape?: "scenario" | "scenarios";
}

interface RunJob {
  run_id: string;
  model: string;
  status: "queued" | "running" | "succeeded" | "failed";
  result: any;
  error: { message?: string } | null;
  cached: boolean;
  progress: { percent: number } | null;
  duration_seconds: number | null;
}

async function fetchJson(path: string, options?: RequestInit) {
  const res = await fetch(`${GATEWAY_URL}${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

// --- Per-model chart adapters -----------------------------------------
// Each adapter takes the run's native `result` object (from GET
// /v1/runs/..) and returns { labels, values, label } for a single default
// line -- same "pick one sensible default chart per model" decision as the
// old dashboard, no cross-model normalization.
const CHART_ADAPTERS: Record<string, (result: any) => { labels: any[]; values: any[]; label: string }> = {
  hector(result) {
    const native = result.result;
    const column = "temperature.global_tas";
    return {
      labels: native.index,
      values: native.data[column],
      label: `HECTOR temperature anomaly (${result.scenario})`,
    };
  },
  fair(result) {
    const native = result.result;
    const scenario = result.scenarios[0];
    const perTimestepConfigs = native.temperature[scenario];
    const meanValues = perTimestepConfigs.map((configsAtT: number[]) => {
      const sum = configsAtT.reduce((a, b) => a + b, 0);
      return sum / configsAtT.length;
    });
    return {
      labels: native.timebounds,
      values: meanValues,
      label: `FAIR mean temperature anomaly across configs (${scenario})`,
    };
  },
  oscar(result) {
    const native = result.result;
    return {
      labels: native.year,
      values: native.mean_D_Tg,
      label: `OSCAR mean temperature anomaly (${result.scenario}, nMC=${result.nMC})`,
    };
  },
  dice(result) {
    const native = result.result;
    return {
      labels: native.years,
      values: native.T_atmos,
      label: `DICE atmospheric temperature anomaly (${result.scenario})`,
    };
  },
};

function chartAspectRatio() {
  return typeof window !== "undefined" && window.innerWidth <= 640 ? 1.4 : 3.4;
}

function buildParams(meta: ModelMeta, scenario: string): Record<string, unknown> {
  if (meta.params_shape === "scenario") return { scenario };
  if (meta.params_shape === "scenarios") return { scenarios: [scenario] };
  throw new Error(`unknown params_shape '${meta.params_shape}'`);
}

export default function Page() {
  const [models, setModels] = useState<{ model: string; family: string }[]>([]);
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

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rawObjectUrl = useRef<string | null>(null);

  useEffect(() => {
    loadModels().catch((err) => {
      setStatus(`Failed to load models: ${err.message}`);
      setStatusIsError(true);
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

    if (chartRef.current) {
      chartRef.current.destroy();
    }
    if (!canvasRef.current) return;
    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: {
        labels,
        datasets: [{ label, data: values, borderWidth: 1.5, pointRadius: 0 }],
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
  }

  function setRawDownload(job: RunJob) {
    if (rawObjectUrl.current) {
      URL.revokeObjectURL(rawObjectUrl.current);
    }
    const blob = new Blob([JSON.stringify(job, null, 2)], { type: "application/json" });
    rawObjectUrl.current = URL.createObjectURL(blob);
    setRawUrl(rawObjectUrl.current);
    setRawFilename(`${job.model}-${job.run_id}.json`);
  }

  async function pollRun(runId: string, name: string) {
    const job: RunJob = await fetchJson(`/v1/runs/${runId}`);

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
      setShowRefresh(!!job.cached);
    } else {
      setStatusText(`${name}: failed - ${job.error?.message || "unknown error"}`, true);
    }
  }

  async function runModel(forceRefresh = false) {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setRunDisabled(true);
    setShowRefresh(false);
    setRawUrl(null);

    if (!modelMeta) return;

    try {
      setStatusText(`${modelName}: submitting...`);
      showLoading("submitting...", null);
      const params = buildParams(modelMeta, scenario);
      const submitted = await fetchJson(`/v1/models/${modelName}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ params, refresh: forceRefresh }),
      });
      pollRun(submitted.run_id, modelName);
    } catch (err: any) {
      setRunDisabled(false);
      hideLoading();
      setStatusText(`${modelName}: ${err.message}`, true);
    }
  }

  async function onModelChange(name: string) {
    setModelName(name);
    setShowRefresh(false);
    try {
      await loadSchema(name);
    } catch (err: any) {
      setStatusText(err.message, true);
    }
  }

  function onScenarioChange(s: string) {
    setScenario(s);
    setShowRefresh(false);
  }

  const modelOptions = models.map((m) => ({ value: m.model, label: `${m.model} (${m.family})` }));
  const scenarioOptions = (modelMeta?.scenarios ?? []).map((s) => ({ value: s, label: s }));

  return (
    <>
      <header className="toolbar">
        <div className="toolbar-brand">
          <span className="toolbar-dot" aria-hidden="true"></span>
          <h1 className="toolbar-title">Climate Models</h1>
        </div>

        <div className="toolbar-controls">
          <Dropdown options={modelOptions} value={modelName} onChange={onModelChange} ariaLabel="Model" />
          <Dropdown options={scenarioOptions} value={scenario} onChange={onScenarioChange} ariaLabel="Scenario" />

          <span className="toolbar-divider" aria-hidden="true"></span>

          <button
            className="icon-button"
            title="Run"
            aria-label="Run"
            disabled={runDisabled}
            onClick={() => runModel(false)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 2.5v11l10-5.5-10-5.5z" fill="currentColor" />
            </svg>
          </button>
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
      </header>

      <main className="content">
        <section className="panel">
          <div className="panel-body">
            <canvas ref={canvasRef} id="result-chart" height={220}></canvas>
            {!hasChart && <div className="chart-placeholder">No result yet</div>}

            {loading && (
              <div className="loading-overlay">
                <div className="loading-box">
                  <span className="loading-text">{loadingText}</span>
                  <progress
                    className="progress-bar"
                    max={100}
                    value={progressPercent ?? undefined}
                  ></progress>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="statusbar">
        <span className={`status-text${statusIsError ? " error" : ""}`}>{status}</span>
      </footer>
    </>
  );
}
