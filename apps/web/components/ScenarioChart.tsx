"use client";

/**
 * A scenario's own real emissions pathway (see lib/scenarioDrivers.ts) --
 * NOT a model's output -- plotted alongside every model's actual
 * temperature response to running it, on a second y-axis. The emissions
 * driver is the one input every one of those model lines shares; showing
 * them together is the point of a scenario article page (what the
 * scenario specifies, and what each model does with it), not something a
 * model-independent emissions-only chart or a temperature-only chart
 * could show on its own.
 *
 * Each dataset keeps its own native x range (driver data runs 2014-2100;
 * a model run may start/end elsewhere) -- no alignSeriesByYear needed
 * here, unlike TemperatureChart's cross-run average line, since nothing
 * here needs every series on one shared grid of points.
 */
import { useEffect, useRef } from "react";
import Chart from "chart.js/auto";
import { modelColor } from "../lib/clientApi";
import { modelAcronym } from "../lib/modelFullNames";
import type { ChartSeries } from "../lib/clientTypes";

export default function ScenarioChart({
  years,
  values,
  series,
  windowMin,
  windowMax,
}: {
  /** The scenario's own emissions driver (GtC/yr) -- see lib/scenarioDrivers.ts. */
  years: number[];
  values: number[];
  /** Every model run actually submitted for this scenario (any model, any
   * params) -- the scenario page filters /v1/runs/latest down to this
   * scenario before passing it in. */
  series: ChartSeries[];
  windowMin?: number;
  windowMax?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    if (chartRef.current) chartRef.current.destroy();

    // Dashed, not solid -- the one visual cue that doesn't depend on
    // reading the legend or an axis label: every model (temperature,
    // right axis) is a solid line, the scenario's own emissions driver
    // (left axis) is the one dashed line, so "which axis is this line
    // using" is visible at a glance instead of only inferable from color.
    const EMISSIONS_COLOR = "#2f6fed";
    const TEMPERATURE_AXIS_COLOR = "#3a3f4b";

    const driverDataset = {
      label: "CO2 emissions (GtC/yr)",
      data: years.map((year, i) => ({ x: year, y: values[i] })),
      borderColor: EMISSIONS_COLOR,
      borderWidth: 2.5,
      borderDash: [6, 4],
      pointRadius: 0,
      pointHoverRadius: 4,
      yAxisID: "y",
      order: 1,
    };

    const modelDatasets = series.map((s) => ({
      label: `${modelAcronym(s.model)} temperature anomaly`,
      data: s.labels.map((year, i) => ({ x: Number(year), y: s.values[i] })),
      borderColor: modelColor(s.model),
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      spanGaps: true,
      yAxisID: "y1",
      order: 2,
    }));

    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: { datasets: [driverDataset, ...modelDatasets] as any },
      options: {
        animation: false,
        // Taller than the dashboard's own chartAspectRatio() (3.4) -- this
        // renders inside .public-main's narrower column, where that ratio
        // made the chart look squashed/too short.
        aspectRatio: typeof window !== "undefined" && window.innerWidth <= 640 ? 1.1 : 1.8,
        // "index" + intersect:false -- hovering anywhere along a given
        // year shows every line's value at that year, not just whichever
        // one you're pixel-precisely over. With pointRadius:0 (no visible
        // points), Chart.js's default intersect:true mode made the
        // tooltip nearly impossible to trigger at all.
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "year" },
            min: windowMin,
            max: windowMax,
            // Chart.js's default tick formatter adds thousands separators
            // to a linear scale's numbers (e.g. "2,000") -- fine for most
            // data, wrong for a year.
            ticks: { callback: (value) => Math.round(Number(value)).toString() },
          },
          y: {
            position: "left",
            title: { display: true, text: "CO2 emissions (GtC/yr)", color: EMISSIONS_COLOR },
            ticks: { color: EMISSIONS_COLOR },
          },
          y1: {
            position: "right",
            title: { display: true, text: "temperature anomaly (°C)", color: TEMPERATURE_AXIS_COLOR },
            ticks: { color: TEMPERATURE_AXIS_COLOR },
            // Only the left axis's gridlines are drawn -- two overlapping
            // grids would just be visual noise, not extra information.
            grid: { drawOnChartArea: false },
          },
        },
        plugins: {
          legend: { display: true, position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { mode: "index", intersect: false },
        },
      },
    });
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [years, values, series, windowMin, windowMax]);

  return (
    <div className="public-chart">
      <canvas ref={canvasRef} />
    </div>
  );
}
