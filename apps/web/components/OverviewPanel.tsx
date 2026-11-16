"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "chart.js/auto";
import {
  fetchJson,
  CHART_ADAPTERS,
  chartAspectRatio,
  nativeScenarioOf,
  canonicalScenario,
  alignSeriesByYear,
  modelColor,
  colorWithAlpha,
  averageSeries,
} from "../lib/clientApi";
import type { RunJob, RunListItem } from "../lib/clientTypes";

// Canonical (not model-native) -- same reasoning as RunsPanel/ComparePanel's
// own scenarioOf: lets the Scenario checkboxes group hector's "ssp119" and
// oscar's "SSP1-1.9" as one filterable entry instead of two.
function scenarioOf(params: Record<string, unknown>): string | undefined {
  const native = nativeScenarioOf(params);
  return native ? canonicalScenario(native) : undefined;
}

// Same purpose as db.ts's own sortKeysDeep (not importable here -- that
// one's server-only, uses node's `crypto`): makes two params objects with
// the same keys in a different order dedupe-key identically.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// chartjs-plugin-zoom touches `window` at import time (checking for touch/
// hammer support), which crashes Next's build-time server prerender of
// this page (confirmed by testing: `next build` failed with "window is not
// defined" until this import was deferred). Registered once the component
// actually mounts in a real browser instead of at module load.
let zoomPluginRegistered = false;
async function ensureZoomPluginRegistered() {
  if (zoomPluginRegistered) return;
  const zoomPlugin = (await import("chartjs-plugin-zoom")).default;
  Chart.register(zoomPlugin);
  zoomPluginRegistered = true;
}

type HoverFilter = { type: "model" | "scenario"; value: string } | null;
type IsolateFilter = { type: "model" | "scenario"; value: string } | null;

// Lines default to a faded version of their own model color, not full
// opacity -- with 31+ runs on screen at once, full-opacity color on every
// line is mostly just visual noise; fading them back leaves the model
// colors identifiable (unlike flattening everything to one neutral gray)
// while still making a hover/isolate match's full-opacity color read as a
// real signal instead of decoration.

// Every model's series goes back to ~1750 (anomaly-from-preindustrial
// convention, see e.g. oscar/run.py) and some run centuries into the
// future (hector/dice/magicc keep going past 2100, up to the 2200s-2300s)
// -- defaulting to that full range squashes the one stretch anyone
// actually cares about (recent history through the scenario period) into
// a sliver of the chart. Default window instead to 1950-2100, clamped to
// whatever the real data covers if it's narrower than that. Zooming out
// (see the zoom plugin options below) still reaches the full range.
const DEFAULT_WINDOW_START = 1950;
const DEFAULT_WINDOW_END = 2100;

export default function OverviewPanel() {
  const [allRuns, setAllRuns] = useState<RunListItem[]>([]);
  const [jobs, setJobs] = useState<Record<string, RunJob>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Excluded" rather than "included" sets: nothing excluded = everything
  // visible by default, including any model/scenario that only shows up
  // after the initial load (a freshly-run new model/scenario combo appears
  // checked, not hidden, without this component needing to notice and
  // re-seed an "included" set).
  const [excludedModels, setExcludedModels] = useState<Set<string>>(new Set());
  const [excludedScenarios, setExcludedScenarios] = useState<Set<string>>(new Set());
  const [hovered, setHovered] = useState<HoverFilter>(null);
  // Clicking a checkbox's label text (not the checkbox itself -- that
  // still just toggles visibility) isolates the chart to ONLY that one
  // model/scenario, overriding the checkboxes entirely while set. Clicking
  // the same one again clears it, going back to whatever the checkboxes
  // say. Only one isolated value at a time, model or scenario.
  const [isolate, setIsolate] = useState<IsolateFilter>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson("/v1/runs?limit=200");
      const succeeded: RunListItem[] = (data.runs ?? []).filter((r: RunListItem) => r.status === "succeeded");
      setAllRuns(succeeded);
      // Only fetch full result bodies for runs this component hasn't
      // already got cached in `jobs` -- a manual Refresh click shouldn't
      // re-download every run's full result again just to pick up any
      // brand new ones.
      const missing = succeeded.filter((r) => !(r.run_id in jobs));
      if (missing.length > 0) {
        const fetched: RunJob[] = await Promise.all(missing.map((r) => fetchJson(`/v1/runs/${r.run_id}`)));
        setJobs((prev) => {
          const next = { ...prev };
          for (const job of fetched) next[job.run_id] = job;
          return next;
        });
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every run this component can actually plot -- has a succeeded job with
  // a chart adapter for its model. Order fixed by allRuns so re-fetching
  // (e.g. Refresh) doesn't reshuffle which line is which color/position.
  //
  // Deduped to the single most recently started run per exact (model,
  // params) -- same "latest wins" convention ComparePanel's grouping
  // already uses. Without this, every past attempt at the identical
  // (model, params) shows up as its own line forever: e.g. oscar's run.py
  // had a bug (fixed earlier) that returned only its 2014-2100 scenario
  // leg instead of the full 1750-2100 series: the old, already-superseded
  // 2014-2100 runs are still sitting in the `runs` table as real past
  // successes, so without deduping they'd keep showing up alongside the
  // fixed 1750-2100 reruns of those exact same scenarios -- which is
  // exactly what looked like oscar lines "starting in a weird place"
  // (confirmed by querying the DB directly: two SSP1-1.9 oscar runs
  // pre-dated the run.py fix and still start at 2014, not 1750).
  const plottableRuns = useMemo(() => {
    const succeeded = allRuns.filter((r) => jobs[r.run_id]?.status === "succeeded" && CHART_ADAPTERS[r.model]);
    const latestByKey = new Map<string, RunListItem>();
    for (const r of succeeded) {
      const key = `${r.model}:${JSON.stringify(sortKeysDeep(r.params))}`;
      const existing = latestByKey.get(key);
      if (!existing || new Date(r.started_at) > new Date(existing.started_at)) {
        latestByKey.set(key, r);
      }
    }
    // Keep allRuns' own order (not Map insertion order) so re-fetching
    // doesn't reshuffle which line is which color/position.
    const kept = new Set(latestByKey.values());
    return succeeded.filter((r) => kept.has(r));
  }, [allRuns, jobs]);

  const allModels = useMemo(() => Array.from(new Set(plottableRuns.map((r) => r.model))).sort(), [plottableRuns]);
  const allScenarios = useMemo(
    () => Array.from(new Set(plottableRuns.map((r) => scenarioOf(r.params)).filter(Boolean))).sort() as string[],
    [plottableRuns],
  );

  function toggle(set: Set<string>, setSet: (s: Set<string>) => void, value: string) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setSet(next);
  }

  function toggleIsolate(type: "model" | "scenario", value: string) {
    setIsolate((prev) => (prev && prev.type === type && prev.value === value ? null : { type, value }));
  }

  const chartData = useMemo(() => {
    if (plottableRuns.length === 0) return null;

    const series = plottableRuns.map((r) => {
      const job = jobs[r.run_id];
      const adapter = CHART_ADAPTERS[r.model];
      const s = adapter(job.result);
      return { labels: s.labels, values: s.values, label: r.run_id };
    });
    const aligned = alignSeriesByYear(series);

    function matchesFilter(filter: HoverFilter, model: string, scenario: string): boolean {
      if (!filter) return false;
      return (filter.type === "model" && filter.value === model) || (filter.type === "scenario" && filter.value === scenario);
    }

    const perRun = aligned.datasets.map((d, i) => {
      const run = plottableRuns[i];
      const model = run.model;
      const scenario = scenarioOf(run.params) ?? "unknown";
      // Isolate (click), when set, overrides the checkboxes entirely --
      // only lines matching it are visible, full stop.
      const hiddenByFilter = isolate
        ? !matchesFilter(isolate, model, scenario)
        : excludedModels.has(model) || excludedScenarios.has(scenario);
      const isHoverMatch = matchesFilter(hovered, model, scenario);
      // While isolated, everything still visible IS the isolated match (by
      // construction of hiddenByFilter above) -- show it in color rather
      // than gray, same as a hover match, instead of leaving an isolated
      // line gray until you also happen to be hovering it.
      const colored = isHoverMatch || !!isolate;
      const dimmed = !!hovered && !isHoverMatch && !isolate;
      return {
        run,
        model,
        scenario,
        hiddenByFilter,
        dataset: {
          label: `${model} · ${scenario}`,
          // {x, y} points (not a plain values array under shared `labels`)
          // -- needed for a real numeric/linear x scale below, which is
          // what lets the zoom plugin zoom/pan to an arbitrary year range
          // instead of just jumping between category-scale label indices.
          data: aligned.labels.map((year, idx) => ({ x: year, y: d.data[idx] })),
          // Gray by default -- color only appears on hover, to actually
          // mean something (see DEFAULT_LINE_COLOR's comment) rather than
          // being decorative on every line all the time.
          borderColor: colorWithAlpha(modelColor(model), colored ? 0.9 : dimmed ? 0.1 : 0.4),
          borderWidth: colored ? 2.75 : 1.2,
          pointRadius: 0,
          spanGaps: false,
          hidden: hiddenByFilter,
          order: 2,
        },
      };
    });

    const visiblePoints = perRun.filter((p) => !p.hiddenByFilter).map((p) => p.dataset.data as { x: number; y: number | null }[]);
    const averageY = averageSeries(visiblePoints.map((points) => points.map((pt) => pt.y)));
    const average = {
      label: `Average (${visiblePoints.length} visible run${visiblePoints.length === 1 ? "" : "s"})`,
      data: aligned.labels.map((year, idx) => ({ x: year, y: averageY[idx] })),
      borderColor: "#3a3f4b",
      borderDash: [7, 4],
      borderWidth: 2.25,
      pointRadius: 0,
      spanGaps: false,
      order: 1,
    };

    const minYear = aligned.labels[0];
    const maxYear = aligned.labels[aligned.labels.length - 1];
    const windowMin = Math.max(minYear, DEFAULT_WINDOW_START);
    const windowMax = Math.min(maxYear, DEFAULT_WINDOW_END);

    return {
      datasets: [...perRun.map((p) => p.dataset), average],
      visibleCount: visiblePoints.length,
      totalCount: perRun.length,
      minYear,
      maxYear,
      // If the default window would be empty/inverted (e.g. every run's
      // data ends before 1950), fall back to the full real range instead.
      windowMin: windowMin < windowMax ? windowMin : minYear,
      windowMax: windowMin < windowMax ? windowMax : maxYear,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plottableRuns, jobs, excludedModels, excludedScenarios, hovered, isolate]);

  useEffect(() => {
    if (!chartData || !canvasRef.current) return;
    let cancelled = false;
    ensureZoomPluginRegistered().then(() => {
      if (cancelled || !chartData || !canvasRef.current) return;
      renderChart(chartData);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartData]);

  function renderChart(chartData: any) {
    if (!canvasRef.current) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: { datasets: chartData.datasets },
      options: {
        animation: false,
        aspectRatio: chartAspectRatio(),
        plugins: {
          legend: { display: false },
          // Wheel/pinch zoom and click-drag pan, both x-axis only (the
          // interesting "zoom in" case here is a narrower year range, not
          // a narrower temperature range). Clamped to the real data's own
          // min/max so you can't pan/zoom into empty space beyond it.
          zoom: {
            limits: { x: { min: chartData.minYear, max: chartData.maxYear } },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" },
            pan: { enabled: true, mode: "x" },
          },
        },
        scales: {
          x: {
            type: "linear",
            min: chartData.windowMin,
            max: chartData.windowMax,
            title: { display: true, text: "year" },
            ticks: { stepSize: 10 },
          },
          y: { title: { display: true, text: "temperature anomaly" } },
        },
      },
    });
  }

  return (
    <div>
      <div className="panel-header">
        <h2 className="panel-title">Overview</h2>
        <div className="run-controls">
          <button className="text-button" onClick={() => chartRef.current?.resetZoom()}>
            Reset zoom
          </button>
          <button className="text-button" onClick={refresh} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      {error && <p className="panel-error">{error}</p>}

      {plottableRuns.length === 0 ? (
        <section className="panel">
          <div className="panel-body">
            <p className="advanced-note">
              {loading ? "Loading runs..." : 'No succeeded runs yet -- start one from "New Run".'}
            </p>
          </div>
        </section>
      ) : (
        <>
          <section className="panel">
            <div className="panel-body">
              <canvas ref={canvasRef} height={260}></canvas>
              <p className="chart-hint">Scroll/pinch to zoom, drag to pan -- "Reset zoom" above returns to this default view.</p>
            </div>
          </section>

          <section className="panel detail-panel">
            <div className="panel-body">
              <p className="advanced-note">
                Showing {chartData?.visibleCount} of {chartData?.totalCount} runs (dashed = average). Click a name
                below to isolate it.
              </p>
              <div className="overview-filters">
                <div className="overview-filter-group">
                  <span className="form-field-label">Models</span>
                  {allModels.map((m) => (
                    <label
                      key={m}
                      className={`overview-filter-checkbox${isolate?.type === "model" && isolate.value === m ? " isolated" : ""}`}
                      onMouseEnter={() => setHovered({ type: "model", value: m })}
                      onMouseLeave={() => setHovered(null)}
                    >
                      <input
                        type="checkbox"
                        checked={!excludedModels.has(m)}
                        onChange={() => toggle(excludedModels, setExcludedModels, m)}
                      />
                      <span className="overview-filter-swatch" style={{ background: modelColor(m) }} />
                      <span
                        className="overview-filter-text"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleIsolate("model", m);
                        }}
                      >
                        {m}
                      </span>
                    </label>
                  ))}
                </div>
                <div className="overview-filter-group overview-filter-group-columns">
                  <span className="form-field-label">Scenarios</span>
                  {allScenarios.map((s) => (
                    <label
                      key={s}
                      className={`overview-filter-checkbox${isolate?.type === "scenario" && isolate.value === s ? " isolated" : ""}`}
                      onMouseEnter={() => setHovered({ type: "scenario", value: s })}
                      onMouseLeave={() => setHovered(null)}
                    >
                      <input
                        type="checkbox"
                        checked={!excludedScenarios.has(s)}
                        onChange={() => toggle(excludedScenarios, setExcludedScenarios, s)}
                      />
                      <span
                        className="overview-filter-text"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleIsolate("scenario", s);
                        }}
                      >
                        {s}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
