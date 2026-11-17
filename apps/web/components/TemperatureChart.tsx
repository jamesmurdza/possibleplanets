"use client";

/**
 * Shared "per-run lines + a dashed cross-run average" temperature chart,
 * for the public home page (all models/scenarios) and each model's own
 * article page (just that model's runs). Deliberately simpler than
 * OverviewPanel's version -- no isolate/hover/zoom interactivity, since
 * this is meant to read as a plain illustrative chart on a public page,
 * not a dashboard tool.
 */
import { useEffect, useMemo, useRef } from "react";
import Chart from "chart.js/auto";
import {
  CHART_ADAPTERS,
  alignSeriesByYear,
  modelColor,
  colorWithAlpha,
  averageSeries,
  nativeScenarioOf,
  canonicalScenario,
} from "../lib/clientApi";
import type { RunJob, RunListItem } from "../lib/clientTypes";

export type HoverFilter = { type: "model" | "scenario"; value: string } | null;

function scenarioOf(params: Record<string, unknown>): string | undefined {
  const native = nativeScenarioOf(params);
  return native ? canonicalScenario(native) : undefined;
}

export default function TemperatureChart({
  runs,
  jobs,
  windowMin,
  windowMax,
  aspectRatio,
  hovered,
}: {
  runs: RunListItem[];
  jobs: Record<string, RunJob>;
  /** Optional fixed x-axis window (e.g. the home page's 2000-2100) --
   * omit to show each series' own full real range. */
  windowMin?: number;
  windowMax?: number;
  /** Width:height ratio. Defaults taller than the dashboard's own
   * chartAspectRatio() (3.4, tuned for its wider main area) -- this
   * component mostly renders inside .public-main's narrower 850px column,
   * where that ratio makes the chart look squashed/too short. */
  aspectRatio?: number;
  /** Mirrors OverviewPanel.tsx's own hover-to-highlight -- when set,
   * matching lines get full color/width and everything else fades,
   * instead of every line always sitting at the same half-opacity. */
  hovered?: HoverFilter;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  const plottable = useMemo(() => runs.filter((r) => CHART_ADAPTERS[r.model]), [runs]);

  const chartData = useMemo(() => {
    if (plottable.length === 0) return null;
    const series = plottable.map((r) => {
      const job = jobs[r.run_id];
      const adapter = CHART_ADAPTERS[r.model];
      const s = adapter(job.result);
      return { labels: s.labels, values: s.values, label: r.run_id };
    });
    const aligned = alignSeriesByYear(series);

    const perRun = aligned.datasets.map((d, i) => {
      const run = plottable[i];
      const model = run.model;
      const scenario = scenarioOf(run.params);
      const isMatch = !!hovered && (hovered.type === "model" ? hovered.value === model : hovered.value === scenario);
      const dimmed = !!hovered && !isMatch;
      return {
        label: model,
        data: aligned.labels.map((year, idx) => ({ x: year, y: d.data[idx] })),
        borderColor: colorWithAlpha(modelColor(model), isMatch ? 0.95 : dimmed ? 0.12 : 0.55),
        borderWidth: isMatch ? 2.5 : 1.2,
        pointRadius: 0,
        spanGaps: true,
        order: 2,
      };
    });

    const averageY = averageSeries(perRun.map((p) => p.data.map((pt) => pt.y)));
    const average = {
      label: `Average (${perRun.length} run${perRun.length === 1 ? "" : "s"})`,
      data: aligned.labels.map((year, idx) => ({ x: year, y: averageY[idx] })),
      borderColor: "#3a3f4b",
      borderDash: [7, 4],
      borderWidth: 2.25,
      pointRadius: 0,
      spanGaps: true,
      order: 1,
    };

    return { datasets: [...perRun, average] };
  }, [plottable, jobs, hovered]);

  // Creates the chart once per (windowMin/windowMax/aspectRatio/canvas
  // presence) -- deliberately NOT re-run on every `hovered` change. A
  // hover is purely a per-dataset color/width tweak (see chartData's own
  // useMemo above); destroying and recreating the whole Chart.js instance
  // for that briefly collapses and resizes the canvas, which on a chart
  // sitting above the card grid shows up as the page jumping/scrolling
  // under the cursor on every hover -- confirmed this was the real cause,
  // not a CSS layout issue on the cards themselves.
  useEffect(() => {
    if (!chartData || !canvasRef.current) return;
    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: { datasets: chartData.datasets as any },
      options: {
        animation: false,
        aspectRatio: aspectRatio ?? (typeof window !== "undefined" && window.innerWidth <= 640 ? 1.1 : 1.8),
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "year" },
            min: windowMin,
            max: windowMax,
            // Chart.js's default tick formatter adds thousands separators
            // to a linear scale's numbers (e.g. "2,000") -- fine for most
            // data, wrong for a year. Format as a plain integer instead.
            ticks: { callback: (value) => Math.round(Number(value)).toString() },
          },
          y: { title: { display: true, text: "temperature anomaly" } },
        },
        plugins: {
          legend: { display: false },
        },
      },
    });
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!chartData, windowMin, windowMax, aspectRatio]);

  // Hover (and any other dataset-only change) updates the existing
  // instance in place instead of recreating it -- no resize flash.
  useEffect(() => {
    if (!chartData || !chartRef.current) return;
    chartRef.current.data.datasets = chartData.datasets as any;
    chartRef.current.update();
  }, [chartData]);

  if (!chartData) return <p className="public-chart-empty">No runs to plot yet.</p>;

  return (
    <div className="public-chart">
      <canvas ref={canvasRef} />
    </div>
  );
}
