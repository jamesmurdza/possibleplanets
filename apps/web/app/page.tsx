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

interface ParameterSpec {
  key: string;
  label: string;
  type: "number";
  default: number;
  min: number;
  max: number;
  step?: number;
  // Overrides the generic "default: {default}" placeholder -- see
  // lib/models.ts's docstring on NumberParameterSpec for why that generic
  // text would be actively wrong for a field like oscar's "seed" (blank
  // means "no seed," not "seed = 0", and 0 is itself a valid real seed).
  placeholderHint?: string;
}

interface ModelMeta {
  model: string;
  family: string;
  scenarios: string[];
  params_shape?: "scenario" | "scenarios";
  parameters?: ParameterSpec[];
  non_deterministic_unless?: string;
}

interface RunJob {
  run_id: string;
  model: string;
  params: Record<string, unknown>;
  status: "queued" | "running" | "succeeded" | "failed";
  result: any;
  error: { message?: string } | null;
  cached: boolean;
  progress: { percent: number } | null;
  duration_seconds: number | null;
}

interface ModelDurationStats {
  model: string;
  count: number;
  min_seconds: number;
  median_seconds: number;
  avg_seconds: number;
  max_seconds: number;
}

interface CheckResult {
  cacheable: boolean;
  cached: boolean;
  cached_duration_seconds: number | null;
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
  magicc(result) {
    const native = result.result; // { years, T_atmos } -- see sandboxes/magicc/run.py
    return {
      labels: native.years,
      values: native.T_atmos,
      label: `MAGICC surface temperature anomaly (${result.scenario})`,
    };
  },
};

function chartAspectRatio() {
  return typeof window !== "undefined" && window.innerWidth <= 640 ? 1.4 : 3.4;
}

// `paramValues` holds raw text per parameter key -- "" means the field was
// left untouched, not "set to its default." Only keys with a non-empty,
// valid value are included in the submitted params, so leaving every
// advanced field blank reproduces the exact same request (and the exact
// same cache key) as a model with no advanced parameters at all. See
// lib/models.ts's module docstring for why omitted and explicit-default are
// deliberately never treated as equivalent.
function buildParams(
  meta: ModelMeta,
  scenario: string,
  paramValues: Record<string, string>,
): Record<string, unknown> {
  const params: Record<string, unknown> =
    meta.params_shape === "scenarios" ? { scenarios: [scenario] } : { scenario };

  for (const spec of meta.parameters ?? []) {
    const raw = paramValues[spec.key];
    if (raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (!Number.isNaN(value)) params[spec.key] = value;
  }

  return params;
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
  // Raw per-parameter text input, keyed by ParameterSpec.key -- see
  // buildParams's docstring for why "" (untouched) is never conflated with
  // "set to the default."
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [lastRunParams, setLastRunParams] = useState<Record<string, unknown> | null>(null);
  // Per-model historical duration stats (see /v1/stats) -- fetched once up
  // front, since it doesn't depend on the current form selection, unlike
  // the per-selection cache check below.
  const [statsByModel, setStatsByModel] = useState<Record<string, ModelDurationStats>>({});
  // Result of calling /v1/models/{model}/check for whatever's currently
  // selected -- "would submitting this right now be a cache hit." Debounced
  // and re-fetched on every scenario/model/param change; null while
  // checking or before a model has loaded.
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
        // Non-critical -- the "before you run" estimate just stays absent
        // (never a fabricated number) if this fails. See runModel() etc.'s
        // general stance against faking data that isn't real.
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

  // "Would this exact selection be a cache hit right now?" -- debounced so
  // typing in an Advanced field doesn't fire a request per keystroke, and
  // guarded with a sequence number so a slow, now-stale response can't
  // overwrite a newer one (e.g. switching models quickly while a check for
  // the previous model is still in flight).
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
    setParamValues({}); // fresh model -- every advanced field starts untouched
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
      setLastRunParams(job.params ?? null);
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
    setCheckResult(null); // avoid showing the previous model's badge while the new schema loads
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

  const parameters = modelMeta?.parameters ?? [];
  const nonDeterministicKey = modelMeta?.non_deterministic_unless;
  const nonDeterministicUnset = !!nonDeterministicKey && !paramValues[nonDeterministicKey];

  const modelOptions = models.map((m) => ({ value: m.model, label: `${m.model} (${m.family})` }));
  const scenarioOptions = (modelMeta?.scenarios ?? []).map((s) => ({ value: s, label: s }));

  // What to show BEFORE a run is submitted -- "cached" (real, from a prior
  // run) or "estimated" (real historical median from /v1/stats), never a
  // guessed number. null while the debounced check is still in flight.
  function etaBadge(): { text: string; kind: "cached" | "estimate" | "warn" } | null {
    if (!checkResult) return null;
    if (!checkResult.cacheable) {
      return { text: "Won't be cached (see Advanced)", kind: "warn" };
    }
    // Cached means instant -- how long the ORIGINAL run took doesn't matter
    // here, so that number is deliberately not shown (it's still in the raw
    // download / status-bar params readout for anyone who wants it).
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

          {eta && <span className={`eta-badge eta-badge-${eta.kind}`}>{eta.text}</span>}

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
        {parameters.length > 0 && (
          <details className="advanced-panel">
            <summary>Advanced parameters</summary>
            <div className="advanced-fields">
              {parameters.map((spec) => (
                <label key={spec.key} className="advanced-field">
                  <span className="advanced-field-label">{spec.label}</span>
                  <input
                    type="number"
                    placeholder={spec.placeholderHint ?? `default: ${spec.default}`}
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
          </details>
        )}

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
        {lastRunParams && (
          <span className="status-params" title="Exact params this result was run with -- reuse them for a guaranteed cache hit">
            {JSON.stringify(lastRunParams)}
          </span>
        )}
      </footer>
    </>
  );
}
