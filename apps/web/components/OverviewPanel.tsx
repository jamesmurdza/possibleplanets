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

type HoverFilter = { type: "model" | "scenario"; value: string } | null;

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
          data: d.data,
          borderColor: colorWithAlpha(modelColor(model), dimmed ? 0.12 : 0.85),
          borderWidth: isHoverMatch ? 2.75 : 1.4,
          pointRadius: 0,
          spanGaps: false,
          hidden: hiddenByFilter,
          order: 2,
        },
      };
    });

    const visibleData = perRun.filter((p) => !p.hiddenByFilter).map((p) => p.dataset.data as (number | null)[]);
    const average = {
      label: `Average (${visibleData.length} visible run${visibleData.length === 1 ? "" : "s"})`,
      data: averageSeries(visibleData),
      borderColor: "#3a3f4b",
      borderDash: [7, 4],
      borderWidth: 2.25,
      pointRadius: 0,
      spanGaps: false,
      order: 1,
    };

    return {
      labels: aligned.labels,
      datasets: [...perRun.map((p) => p.dataset), average],
      visibleCount: visibleData.length,
      totalCount: perRun.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plottableRuns, jobs, excludedModels, excludedScenarios, hovered]);

  useEffect(() => {
    if (!chartData || !canvasRef.current) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: { labels: chartData.labels, datasets: chartData.datasets },
      options: {
        animation: false,
        aspectRatio: chartAspectRatio(),
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: "year" } },
          y: { title: { display: true, text: "temperature anomaly" } },
        },
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartData]);

  return (
    <div>
      <div className="panel-header">
        <h2 className="panel-title">Overview</h2>
        <button className="text-button" onClick={refresh} disabled={loading}>
          Refresh
        </button>
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
