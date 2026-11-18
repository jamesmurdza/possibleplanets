"use client";

import { useEffect, useRef, useState } from "react";
import Chart from "chart.js/auto";
import { fetchJson, CHART_ADAPTERS, buildParams, chartAspectRatio, scenarioDescription, canonicalScenario } from "../lib/clientApi";
import { scenarioDriverSeries } from "../lib/scenarioDrivers";
import { modelAssumptions, scenarioAssumptions, type AssumptionSection } from "../lib/assumptions";
import Sparkline from "./Sparkline";
import Modal, { AssumptionsModalBody } from "./Modal";
import InfoButton from "./InfoButton";
import ModelIcon from "./ModelIcon";
import type { ModelMeta, ModelListItem, RunJob, ModelDurationStats, CheckResult } from "../lib/clientTypes";

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
  const [infoModal, setInfoModal] = useState<{ title: string; section: AssumptionSection } | null>(null);
  // Shift-click adds a model/scenario to a batch IN ADDITION to the
  // "primary" (plain-click) selection above (modelName/scenario) -- never
  // replaces it. Submitting then fires one run per (model, scenario) pair
  // in the cross product of {modelName, ...extraModels} x {scenario,
  // ...extraScenarios}, not just the single primary pair. See runModel's
  // batch-submission comment below for why only the primary pair gets
  // this form's own live progress/chart -- the rest show up in the Runs
  // tab instead (it already polls every run_id globally, see
  // RunsPanel.tsx), same as if the user had clicked "Run" once per
  // combination by hand.
  const [extraModels, setExtraModels] = useState<Set<string>>(new Set());
  const [extraScenarios, setExtraScenarios] = useState<Set<string>>(new Set());

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rawObjectUrl = useRef<string | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkSeq = useRef(0);
  // Schemas for shift-selected models other than modelName -- fetched lazily
  // (only once a batch run actually needs one), not up front, since most
  // visits never touch multi-select at all.
  const schemaCache = useRef<Record<string, ModelMeta>>({});

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

  // Every (model, scenario) combination the current selection implies --
  // just [{modelName, scenario}] in the common, non-batch case. The first
  // entry is always the primary (plain-click) selection; the rest, if any,
  // come from shift-clicked extras.
  function selectedCombos(): { model: string; scenario: string }[] {
    const models = [modelName, ...extraModels];
    const scenarios = [scenario, ...extraScenarios];
    const combos: { model: string; scenario: string }[] = [];
    for (const m of models) {
      for (const s of scenarios) combos.push({ model: m, scenario: s });
    }
    return combos;
  }

  // Fire-and-forget submission for every combo beyond the primary one --
  // each is validated/built against ITS OWN model's schema (fetched lazily,
  // see getModelMetaFor), not modelMeta/paramValues, since a different
  // model's parameter keys won't generally mean the same thing (or even be
  // accepted -- see validateParams in lib/runs.ts). A combo whose model has
  // no scenario equivalent to the one selected (see resolveNativeScenario)
  // is skipped rather than submitted broken. These don't get this form's
  // own progress bar/chart -- they show up in the Runs tab like any other
  // submitted run, same as if "Run" had been clicked once per combo by
  // hand; this form keeps showing the primary combo's own result below.
  async function submitExtraRuns(combos: { model: string; scenario: string }[], forceRefresh: boolean) {
    let skipped = 0;
    await Promise.all(
      combos.map(async ({ model: m, scenario: s }) => {
        try {
          const meta = await getModelMetaFor(m);
          const nativeScenario = resolveNativeScenario(meta, s);
          if (!nativeScenario) {
            skipped++;
            return;
          }
          const params = buildParams(meta, nativeScenario, m === modelName ? paramValues : {});
          await fetchJson(`/v1/models/${m}/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ params, refresh: forceRefresh }),
          });
        } catch {
          skipped++;
        }
      }),
    );
    if (skipped > 0) {
      setStatusText(`${skipped} of ${combos.length} extra run(s) could not be submitted -- see the Runs tab.`, true);
    }
  }

  async function runModel(forceRefresh = false) {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setRunDisabled(true);
    setShowRefresh(false);
    setRawUrl(null);
    setLastRunParams(null);

    if (!modelMeta) return;

    const combos = selectedCombos();
    // The primary pair (modelName, scenario) is always combos[0] -- see
    // selectedCombos. Everything else is a shift-selected extra.
    const extraCombos = combos.slice(1);
    if (extraCombos.length > 0) {
      // Deliberately not awaited -- these submit independently of (and in
      // parallel with) the primary run below; nothing here should make the
      // primary run's own progress bar wait on unrelated jobs.
      submitExtraRuns(extraCombos, forceRefresh);
    }

    try {
      const batchNote = extraCombos.length ? ` (+${extraCombos.length} more -- see Runs tab)` : "";
      setStatusText(`${modelName}: submitting...${batchNote}`);
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

  // Plain click: behaves exactly as before (replaces the primary selection,
  // clears any batch). Shift-click: toggles membership in the batch set
  // instead, leaving the primary selection (and the form built around it --
  // schema, scenario list, parameter fields) untouched. Shift-clicking the
  // card that's already the primary selection is a no-op either way -- it's
  // always implicitly included, there's nothing to toggle.
  function onModelCardClick(e: { shiftKey: boolean }, name: string) {
    if (e.shiftKey) {
      if (name === modelName) return;
      setExtraModels((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      return;
    }
    setExtraModels(new Set());
    setExtraScenarios(new Set());
    onModelChange(name);
  }

  function onScenarioCardClick(e: { shiftKey: boolean }, s: string) {
    if (e.shiftKey) {
      if (s === scenario) return;
      setExtraScenarios((prev) => {
        const next = new Set(prev);
        if (next.has(s)) next.delete(s);
        else next.add(s);
        return next;
      });
      return;
    }
    setExtraScenarios(new Set());
    onScenarioChange(s);
  }

  // Fetches and caches a model's full schema (params/scenarios) -- needed
  // only for a shift-selected model other than modelName, since that's the
  // only one this form doesn't already have loaded.
  async function getModelMetaFor(name: string): Promise<ModelMeta> {
    if (name === modelName && modelMeta) return modelMeta;
    if (schemaCache.current[name]) return schemaCache.current[name];
    const schema = await fetchJson(`/v1/models/${name}/schema`);
    schemaCache.current[name] = schema;
    return schema;
  }

  // A shift-selected scenario card's value is a scenario string native to
  // modelMeta (the primary model) -- a different model may spell the "same"
  // scenario differently (e.g. hector's "ssp126" vs oscar's "SSP1-2.6"), or
  // not support it at all. Matches by canonical label (same helper RunsPanel
  // uses to line up equivalent scenarios across models); returns null if
  // that model has nothing equivalent, so the caller can skip that one
  // combination rather than submit something invalid.
  function resolveNativeScenario(meta: ModelMeta, s: string): string | null {
    if (meta.scenarios.includes(s)) return s;
    const canonical = canonicalScenario(s);
    return meta.scenarios.find((native) => canonicalScenario(native) === canonical) ?? null;
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
                className={`model-card${m.model === modelName ? " selected" : extraModels.has(m.model) ? " selected-extra" : ""}`}
                role="radio"
                aria-checked={m.model === modelName || extraModels.has(m.model)}
                tabIndex={0}
                onClick={(e) => onModelCardClick(e, m.model)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onModelCardClick(e, m.model);
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
                {modelAssumptions(m.model) && (
                  <InfoButton
                    className="card-info-button"
                    label={`${m.model} assumptions`}
                    onClick={() => {
                      const section = modelAssumptions(m.model);
                      if (section) setInfoModal({ title: `${m.model}: assumptions`, section });
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="form-field-block">
          <span className="form-field-label">Emissions scenario</span>
          <div className="scenario-card-grid" role="radiogroup" aria-label="Emissions scenario">
            {scenarios.map((s) => {
              const desc = scenarioDescription(s);
              const canonical = canonicalScenario(s);
              const driver = scenarioDriverSeries(canonical);
              return (
                <div
                  key={s}
                  className={`scenario-card${s === scenario ? " selected" : extraScenarios.has(s) ? " selected-extra" : ""}`}
                  role="radio"
                  aria-checked={s === scenario || extraScenarios.has(s)}
                  tabIndex={0}
                  onClick={(e) => onScenarioCardClick(e, s)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onScenarioCardClick(e, s);
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
                  <InfoButton
                    className="card-info-button"
                    label={`${canonical} assumptions`}
                    onClick={() => {
                      const section = scenarioAssumptions(modelName, s, canonical);
                      setInfoModal({ title: `${canonical}: assumptions`, section });
                    }}
                  />
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
            {extraModels.size + extraScenarios.size > 0 ? `Run ${(1 + extraModels.size) * (1 + extraScenarios.size)}` : "Run"}
          </button>
          {eta && <span className={`eta-badge eta-badge-${eta.kind}`}>{eta.text}</span>}
          <span className="form-hint">Shift-click a model or scenario to run it alongside the current selection.</span>
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

      {infoModal && (
        <Modal title={infoModal.title} onClose={() => setInfoModal(null)}>
          <AssumptionsModalBody section={infoModal.section} />
        </Modal>
      )}
    </div>
  );
}
