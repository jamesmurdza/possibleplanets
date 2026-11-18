"use client";

import { useEffect, useRef, useState } from "react";
import { fetchJson, buildParams, scenarioDescription, canonicalScenario } from "../lib/clientApi";
import { scenarioDriverSeries } from "../lib/scenarioDrivers";
import { modelAssumptions, scenarioAssumptions, type AssumptionSection } from "../lib/assumptions";
import Sparkline from "./Sparkline";
import Modal, { AssumptionsModalBody } from "./Modal";
import InfoButton from "./InfoButton";
import ModelIcon from "./ModelIcon";
import { sortByResourceUsage } from "../lib/modelOrder";
import type { ModelMeta, ModelListItem, ModelDurationStats, CheckResult } from "../lib/clientTypes";

export default function NewRunPanel({ onRunSubmitted }: { onRunSubmitted: (runId: string) => void }) {
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [modelName, setModelName] = useState("");
  const [modelMeta, setModelMeta] = useState<ModelMeta | null>(null);
  const [scenario, setScenario] = useState("");
  const [status, setStatus] = useState("Loading models...");
  const [statusIsError, setStatusIsError] = useState(false);
  const [runDisabled, setRunDisabled] = useState(false);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [statsByModel, setStatsByModel] = useState<Record<string, ModelDurationStats>>({});
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [infoModal, setInfoModal] = useState<{ title: string; section: AssumptionSection } | null>(null);
  // Shift-click adds a model/scenario to a batch IN ADDITION to the
  // "primary" (plain-click) selection above (modelName/scenario) -- never
  // replaces it. Submitting then fires one run per (model, scenario) pair
  // in the cross product of {modelName, ...extraModels} x {scenario,
  // ...extraScenarios}, not just the single primary pair. Every combo
  // (primary included) now behaves identically on submit: none of them
  // render a chart in this form any more -- submitting just navigates to
  // the Runs tab (see onRunSubmitted/runModel below), same as if the user
  // had clicked "Run" once per combination by hand and then opened the Runs
  // tab themselves.
  const [extraModels, setExtraModels] = useState<Set<string>>(new Set());
  const [extraScenarios, setExtraScenarios] = useState<Set<string>>(new Set());
  // Narrowed scenario list / parameter-key set when more than one model is
  // selected (primary + extras) -- only scenarios/params common to ALL
  // selected models are shown, since a combo whose model doesn't support a
  // given scenario/param would otherwise be submitted broken (or silently
  // skipped -- see submitExtraRuns/resolveNativeScenario). Null means "no
  // restriction" (zero or one model selected).
  const [multiModelScenarios, setMultiModelScenarios] = useState<string[] | null>(null);
  const [multiModelParamKeys, setMultiModelParamKeys] = useState<Set<string> | null>(null);

  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkSeq = useRef(0);
  // Guards loadSchema against exactly the race that caused "scenario
  // doesn't match the model" bugs: clicking model A then quickly clicking
  // model B before A's GET /v1/models/A/schema resolves. Without this, A's
  // response can land AFTER B's and overwrite modelMeta/scenario back to
  // A's values while modelName is already "B" -- the scenario list shown
  // then belongs to a model that's no longer selected. Same pattern as
  // checkSeq above, just for schema loads instead of the cache-check debounce.
  const schemaSeq = useRef(0);
  // Schemas for shift-selected models other than modelName -- fetched lazily
  // (only once a batch run or the common-scenario computation actually
  // needs one), not up front, since most visits never touch multi-select at
  // all.
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

  // When more than one model is selected (primary + shift-clicked extras),
  // narrow the shown scenarios/params to the intersection across all of
  // them -- see multiModelScenarios/multiModelParamKeys's own comment above.
  useEffect(() => {
    if (extraModels.size === 0 || !modelMeta) {
      setMultiModelScenarios(null);
      setMultiModelParamKeys(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const extraMetas = await Promise.all(Array.from(extraModels).map((m) => getModelMetaFor(m)));
        if (cancelled) return;
        const allMetas = [modelMeta, ...extraMetas];

        // Scenario intersection, by canonical label (the same matching
        // resolveNativeScenario uses) so e.g. hector's "ssp126" and oscar's
        // "SSP1-2.6" count as the same scenario.
        const canonicalSets = allMetas.map((m) => new Set(m.scenarios.map((s) => canonicalScenario(s))));
        const commonCanonical = canonicalSets[0]
          ? Array.from(canonicalSets[0]).filter((c) => canonicalSets.every((set) => set.has(c)))
          : [];
        // Render using the primary model's own native scenario spellings,
        // since that's what the scenario cards submit for the primary combo.
        const narrowedScenarios = modelMeta.scenarios.filter((s) => commonCanonical.includes(canonicalScenario(s)));

        // Param-key intersection -- a key only makes sense to show if every
        // selected model actually accepts it.
        const keySets = allMetas.map((m) => new Set((m.parameters ?? []).map((p) => p.key)));
        const commonKeys = new Set(Array.from(keySets[0] ?? []).filter((k) => keySets.every((set) => set.has(k))));

        setMultiModelScenarios(narrowedScenarios);
        setMultiModelParamKeys(commonKeys);
      } catch {
        // If any extra model's schema fails to load, fail open (no
        // restriction) rather than silently hiding everything.
        if (!cancelled) {
          setMultiModelScenarios(null);
          setMultiModelParamKeys(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extraModels, modelMeta]);

  // Keep the primary scenario (and any shift-selected extra scenarios)
  // valid whenever the common-scenario list narrows due to a multi-model
  // selection -- e.g. adding a second model that doesn't support the
  // currently-selected scenario should fall back to the first one that's
  // common to both, not silently keep submitting an invalid combo.
  useEffect(() => {
    if (multiModelScenarios === null) return;
    if (!multiModelScenarios.includes(scenario)) {
      setScenario(multiModelScenarios[0] ?? "");
    }
    setExtraScenarios((prev) => {
      const pruned = new Set(Array.from(prev).filter((s) => multiModelScenarios.includes(s)));
      return pruned.size === prev.size ? prev : pruned;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiModelScenarios]);

  async function loadModels() {
    const data = await fetchJson("/v1/models");
    // Same order as the home page's model row (lightest/fastest to
    // heaviest) -- see lib/modelOrder.ts -- rather than whatever order
    // GET /v1/models happens to return (lib/models.ts's own object key
    // order, which isn't meaningful here).
    const ordered = sortByResourceUsage<ModelListItem>(data.models ?? []);
    setModels(ordered);
    if (ordered.length) {
      const first = ordered[0].model;
      setModelName(first);
      await loadSchema(first);
    }
    setStatus("Select a model and scenario, then click Run.");
  }

  async function loadSchema(name: string) {
    const mySeq = ++schemaSeq.current;
    const schema = await fetchJson(`/v1/models/${name}/schema`);
    // A newer loadSchema call (a later model click) has already started --
    // this response is stale, applying it now would overwrite the newer
    // selection's own schema/scenario. See schemaSeq's own comment above.
    if (mySeq !== schemaSeq.current) return;
    setModelMeta(schema);
    setScenario(schema.scenarios[0] ?? "");
    setParamValues({});
  }

  function setStatusText(text: string, isError = false) {
    setStatus(text);
    setStatusIsError(isError);
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
  // is skipped rather than submitted broken. These show up in the Runs tab
  // like any other submitted run; this form doesn't wait on or show them.
  async function submitExtraRuns(combos: { model: string; scenario: string }[]) {
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
          // Always force a fresh run here too -- clicking "Run" never shows
          // a cached result, for the batch combos any more than the
          // primary one. See runModel's own comment.
          await fetchJson(`/v1/models/${m}/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ params, refresh: true }),
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

  // Submitting no longer renders anything locally -- it either navigates to
  // the Runs tab (via onRunSubmitted) with the new run's drawer open, or --
  // on a genuine submission failure -- shows an inline error and stays on
  // this form so the user can fix and retry. Clicking "Run" always forces a
  // fresh run (refresh: true) -- showing a cached result on a "Run" click
  // would be surprising; cached results are only ever surfaced through the
  // explicit "View cached" button (see viewCachedRun/checkResult.cached).
  async function runModel() {
    setRunDisabled(true);

    if (!modelMeta) {
      setRunDisabled(false);
      return;
    }

    const combos = selectedCombos();
    // The primary pair (modelName, scenario) is always combos[0] -- see
    // selectedCombos. Everything else is a shift-selected extra.
    const extraCombos = combos.slice(1);
    if (extraCombos.length > 0) {
      // Deliberately not awaited -- these submit independently of (and in
      // parallel with) the primary run below; nothing here should make the
      // primary submission wait on unrelated jobs.
      submitExtraRuns(extraCombos);
    }

    try {
      const batchNote = extraCombos.length ? ` (+${extraCombos.length} more -- see Runs tab)` : "";
      setStatusText(`${modelName}: submitting...${batchNote}`);
      const params = buildParams(modelMeta, scenario, paramValues);
      const submitted = await fetchJson(`/v1/models/${modelName}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ params, refresh: true }),
      });
      setRunDisabled(false);
      // refresh: true above means this normally won't be a cache hit (the
      // whole point of forcing a fresh run on "Run" -- see runModel's own
      // comment). Keep this branch anyway as a defensive fallback: a cache
      // hit still comes back as a finished job inline rather than a run_id
      // to poll (see submitRun's module comment), and that inline run_id
      // was never written to the `runs` table, so opening it in the drawer
      // would 404 -- look up the real historical run_id behind the hit
      // instead (the check we already ran has it, see checkResult).
      if (submitted.status === "succeeded") {
        const realRunId = checkResult?.cached_run_id;
        if (realRunId) {
          onRunSubmitted(realRunId);
        } else {
          setStatusText(`${modelName}: succeeded, but couldn't locate its run history -- see the Runs tab.`);
        }
      } else if (submitted.status === "failed") {
        setStatusText(`${modelName}: failed - ${submitted.error?.message || "unknown error"}`, true);
      } else {
        onRunSubmitted(submitted.run_id);
      }
    } catch (err: any) {
      setRunDisabled(false);
      setStatusText(`${modelName}: ${err.message}`, true);
    }
  }

  // "View cached" button next to the ETA badge -- jumps straight to the
  // Runs tab's drawer for the most recent succeeded run with this exact
  // (model, params), without resubmitting anything.
  function viewCachedRun() {
    if (checkResult?.cached_run_id) {
      onRunSubmitted(checkResult.cached_run_id);
    } else {
      setStatusText(`${modelName}: couldn't locate the cached run's history -- see the Runs tab.`, true);
    }
  }

  async function onModelChange(name: string) {
    setModelName(name);
    setCheckResult(null);
    try {
      await loadSchema(name);
    } catch (err: any) {
      setStatusText(err.message, true);
    }
  }

  function onScenarioChange(s: string) {
    setScenario(s);
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
    setCheckResult(null);
  }

  // Always a time estimate, never a "Cached" pill -- clicking "Run" always
  // forces a fresh run (see runModel), so an ETA badge that said "Cached"
  // would be misleading about what's about to happen. Whether this exact
  // (model, params) happens to have a cached result is instead surfaced
  // only via the separate "View cached" button below.
  function etaBadge(): { text: string; kind: "estimate" | "warn" } | null {
    if (!checkResult) return null;
    if (!checkResult.cacheable) {
      return { text: "Won't be cached (see Advanced)", kind: "warn" };
    }
    const stats = statsByModel[modelName];
    if (stats) {
      return { text: `~${stats.median_seconds.toFixed(1)}s estimated`, kind: "estimate" };
    }
    return { text: "No run history yet", kind: "estimate" };
  }
  const eta = etaBadge();

  const scenarios = multiModelScenarios ?? modelMeta?.scenarios ?? [];
  const parameters = (modelMeta?.parameters ?? []).filter((p) => multiModelParamKeys === null || multiModelParamKeys.has(p.key));
  const nonDeterministicKey = modelMeta?.non_deterministic_unless;
  const nonDeterministicUnset = !!nonDeterministicKey && !paramValues[nonDeterministicKey];

  return (
    <div>
      <div className="panel-header">
        <h2 className="panel-title">New Run</h2>
      </div>

      <form
        className="run-form"
        onSubmit={(e) => {
          e.preventDefault();
          runModel();
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
          {checkResult?.cached && (
            <button type="button" className="text-button" onClick={viewCachedRun}>
              View cached
            </button>
          )}
          <span className="form-hint">Shift-click a model or scenario to run it alongside the current selection.</span>
        </div>
      </form>

      <div className="panel-footer">
        <span className={`status-text${statusIsError ? " error" : ""}`}>{status}</span>
      </div>

      {infoModal && (
        <Modal title={infoModal.title} onClose={() => setInfoModal(null)}>
          <AssumptionsModalBody section={infoModal.section} />
        </Modal>
      )}
    </div>
  );
}
