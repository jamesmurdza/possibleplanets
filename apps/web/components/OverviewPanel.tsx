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
  const plottableRuns = useMemo(
    () => allRuns.filter((r) => jobs[r.run_id]?.status === "succeeded" && CHART_ADAPTERS[r.model]),
    [allRuns, jobs],
  );

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

  const chartData = useMemo(() => {
    if (plottableRuns.length === 0) return null;

    const series = plottableRuns.map((r) => {
      const job = jobs[r.run_id];
      const adapter = CHART_ADAPTERS[r.model];
      const s = adapter(job.result);
      return { labels: s.labels, values: s.values, label: r.run_id };
    });
    const aligned = alignSeriesByYear(series);

    const perRun = aligned.datasets.map((d, i) => {
      const run = plottableRuns[i];
      const model = run.model;
      const scenario = scenarioOf(run.params) ?? "unknown";
      const hiddenByFilter = excludedModels.has(model) || excludedScenarios.has(scenario);
      const isHoverMatch = !!hovered && ((hovered.type === "model" && hovered.value === model) || (hovered.type === "scenario" && hovered.value === scenario));
      const dimmed = !!hovered && !isHoverMatch;
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
          borderColor: colorWithAlpha(modelColor(model), dimmed ? 0.12 : 0.85),
          borderWidth: isHoverMatch ? 2.75 : 1.4,
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
  }, [plottableRuns, jobs, excludedModels, excludedScenarios, hovered]);

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
                Showing {chartData?.visibleCount} of {chartData?.totalCount} runs -- the dashed line is the average
                across whichever runs are currently visible.
              </p>
              <div className="overview-filters">
                <div className="overview-filter-group">
                  <span className="form-field-label">Models</span>
                  {allModels.map((m) => (
                    <label
                      key={m}
                      className="overview-filter-checkbox"
                      onMouseEnter={() => setHovered({ type: "model", value: m })}
                      onMouseLeave={() => setHovered(null)}
                    >
                      <input
                        type="checkbox"
                        checked={!excludedModels.has(m)}
                        onChange={() => toggle(excludedModels, setExcludedModels, m)}
                      />
                      <span className="overview-filter-swatch" style={{ background: modelColor(m) }} />
                      {m}
                    </label>
                  ))}
                </div>
                <div className="overview-filter-group">
                  <span className="form-field-label">Scenarios</span>
                  {allScenarios.map((s) => (
                    <label
                      key={s}
                      className="overview-filter-checkbox"
                      onMouseEnter={() => setHovered({ type: "scenario", value: s })}
                      onMouseLeave={() => setHovered(null)}
                    >
                      <input
                        type="checkbox"
                        checked={!excludedScenarios.has(s)}
                        onChange={() => toggle(excludedScenarios, setExcludedScenarios, s)}
                      />
                      {s}
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
