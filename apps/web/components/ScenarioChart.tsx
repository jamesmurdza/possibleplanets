"use client";

/**
 * The scenario's own real emissions pathway (see lib/scenarioDrivers.ts) --
 * deliberately NOT a model's temperature output. A scenario article page
 * is describing what the scenario itself specifies, independent of how
 * any one model responds to it, so this is the one chart that doesn't
 * touch /v1/runs at all.
 */
import { useEffect, useRef } from "react";
import Chart from "chart.js/auto";

export default function ScenarioChart({ years, values }: { years: number[]; values: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: {
        labels: years,
        datasets: [
          {
            label: "CO2 emissions (GtC/yr)",
            data: values,
            borderColor: "#2f6fed",
            borderWidth: 2,
            pointRadius: 0,
          },
        ],
      },
      options: {
        animation: false,
        // Taller than the dashboard's own chartAspectRatio() (3.4) -- this
        // renders inside .public-main's narrower 850px column, where that
        // ratio made the chart look squashed/too short.
        aspectRatio: typeof window !== "undefined" && window.innerWidth <= 640 ? 1.1 : 1.8,
        scales: {
          x: { title: { display: true, text: "year" } },
          y: { title: { display: true, text: "CO2 emissions (GtC/yr)" } },
        },
        plugins: { legend: { display: false } },
      },
    });
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [years, values]);

  return (
    <div className="public-chart">
      <canvas ref={canvasRef} />
    </div>
  );
}
