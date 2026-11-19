"use client";

/**
 * Shared "per-run lines + a dashed cross-run average" temperature chart,
 * for the public home page (all models/scenarios) and each model's own
 * article page (just that model's runs). Deliberately simpler than
 * OverviewPanel's version -- no isolate/hover/zoom interactivity, since
 * this is meant to read as a plain illustrative chart on a public page,
 * not a dashboard tool.
 *
 * Takes already-reduced ChartSeries (GET /v1/runs/latest, see that
 * route's comment) rather than raw runs+jobs -- CHART_ADAPTERS now runs
 * server-side, so this component no longer needs it or each run's full
 * native result blob.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "chart.js/auto";
import {
  alignSeriesByYear,
  modelColor,
  colorWithAlpha,
  averageSeries,
  nativeScenarioOf,
  canonicalScenario,
  isSspScenario,
} from "../lib/clientApi";
import type { ChartSeries } from "../lib/clientTypes";

// "ssp" (no `value`) is the home page's single "SSPs" legend item --
// matches every line whose scenario is an SSP-framework name, regardless
// of which model ran it (see isSspScenario), rather than one specific
// model/scenario the way the other two variants do.
export type HoverFilter = { type: "model" | "scenario"; value: string } | { type: "ssp" } | null;

function scenarioOf(params: Record<string, unknown>): string | undefined {
  const native = nativeScenarioOf(params);
  return native ? canonicalScenario(native) : undefined;
}

// Shared by both the per-dataset dim/highlight logic below and the
// tooltip filter further down -- a run "matches" a HoverFilter exactly
// the same way in both places, so this is the one place that decides it.
function matchesHover(hovered: HoverFilter | undefined, model: string, scenario: string | undefined): boolean {
  if (!hovered) return false;
  if (hovered.type === "model") return hovered.value === model;
  if (hovered.type === "scenario") return hovered.value === scenario;
  return !!scenario && isSspScenario(scenario);
}

// Used only when colorBy="scenario" (a model's own article page, where
// every line is already the same model -- modelColor() would make every
// line identical). Purely a display palette, not derived from anything
// about the scenarios themselves, so a fixed cycling list is fine; falls
// back to repeating once there are more distinct scenarios than colors.
const SCENARIO_PALETTE = ["#2f6fed", "#1fa37a", "#e0862f", "#9b51e0", "#e0415a", "#1b8f9e", "#c2a52e", "#5c6bc0"];

export default function TemperatureChart({
  series,
  windowMin,
  windowMax,
  aspectRatio,
  hovered,
  tooltipFilter,
  colorBy = "model",
  legend = false,
}: {
  series: ChartSeries[];
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
  /** What the tooltip is restricted to -- defaults to `hovered` itself
   * when omitted (so every existing caller keeps "tooltip follows
   * whatever's highlighted" behavior unchanged). The home page passes
   * this separately from `hovered` so that mouse-hovering a different
   * legend item can still preview that item's highlight/dim (via
   * `hovered`) while a click-pinned item keeps the tooltip locked to
   * just itself regardless of what's being hovered -- see app/page.tsx's
   * own pinned/hovered split. */
  tooltipFilter?: HoverFilter;
  /** "model" (default, for the home page's mixed-model chart) colors/
   * labels each line by its model. "scenario" (for a model's own article
   * page, where `series` is already filtered to one model) colors/labels
   * each line by its scenario instead -- otherwise every line on a
   * single-model chart would render in the exact same color. */
  colorBy?: "model" | "scenario";
  /** Off by default -- the home page's chart can have dozens of per-run
   * lines plus the dashed average, where a legend would be a wall of
   * near-duplicate entries, not useful. Model article pages (one line per
   * scenario, `colorBy="scenario"`) pass this true -- a handful of
   * distinct, meaningful entries worth labeling. */
  legend?: boolean;
}) {
  const effectiveTooltipFilter = tooltipFilter !== undefined ? tooltipFilter : hovered;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  // The 640px breakpoint below, tracked reactively -- NOT read inline as
  // `window.innerWidth` inside the chart-creation effect below, which was
  // the bug: that effect only runs once (its deps don't include window
  // width), so whichever ratio matched the window size AT MOUNT stuck
  // forever. A page loaded wide, then the window narrowed past 640px: the
  // canvas's actual pixel width still shrinks (Chart.js's own
  // ResizeObserver handles that part fine), but the aspect ratio stayed
  // the wide-screen 1.8, so the chart kept getting squashed flatter
  // instead of growing taller/more-mobile-shaped the way the narrow
  // breakpoint's 1.1 ratio intends -- "shrinks but doesn't expand".
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth <= 640);
  useEffect(() => {
    function onResize() {
      setIsNarrow(window.innerWidth <= 640);
      // Chart.js's own ResizeObserver watches the <canvas>'s parent, but
      // doesn't reliably catch every resize in a flex/grid layout (e.g.
      // this chart's own container) -- narrowing the window then widening
      // it back left the canvas stuck at the narrower pixel width it last
      // observed, never growing back out. Forcing a resize() on every
      // window resize event (not just the 640px breakpoint crossing
      // handled below) makes sure Chart.js re-measures its container and
      // actually re-expands.
      chartRef.current?.resize();
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const effectiveAspectRatio = aspectRatio ?? (isNarrow ? 1.1 : 1.8);

  const chartData = useMemo(() => {
    if (series.length === 0) return null;
    const aligned = alignSeriesByYear(series.map((s) => ({ labels: s.labels, values: s.values, label: s.run_id })));

    // Stable scenario -> color assignment, in first-seen order -- only
    // used when colorBy="scenario".
    const scenarioColors = new Map<string, string>();
    if (colorBy === "scenario") {
      for (const r of series) {
        const s = scenarioOf(r.params) ?? "unknown";
        if (!scenarioColors.has(s)) {
          scenarioColors.set(s, SCENARIO_PALETTE[scenarioColors.size % SCENARIO_PALETTE.length]);
        }
      }
    }

    const perRun = aligned.datasets.map((d, i) => {
      const run = series[i];
      const model = run.model;
      const scenario = scenarioOf(run.params);
      const isMatch = matchesHover(hovered, model, scenario);
      const dimmed = !!hovered && !isMatch;
      const label = colorBy === "scenario" ? scenario ?? "unknown" : model;
      const baseColor = colorBy === "scenario" ? scenarioColors.get(scenario ?? "unknown")! : modelColor(model);
      return {
        label,
        data: aligned.labels.map((year, idx) => ({ x: year, y: d.data[idx] })),
        borderColor: colorWithAlpha(baseColor, isMatch ? 0.95 : dimmed ? 0.12 : 0.55),
        borderWidth: isMatch ? 2.5 : 1.2,
        pointRadius: 0,
        pointHoverRadius: 4,
        spanGaps: true,
        order: 2,
        // Not real Chart.js dataset properties -- read back in the
        // tooltip filter below (via chartRef's live data, see
        // hoveredRef) to decide whether this run matches the current
        // HoverFilter, without re-deriving model/scenario from a
        // tooltip item's label (which is just display text, and for
        // colorBy="scenario" doesn't even include the model).
        __model: model,
        __scenario: scenario,
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
      pointHoverRadius: 4,
      spanGaps: true,
      order: 1,
      // Always shown in the tooltip regardless of any active
      // HoverFilter -- see the tooltip filter below.
      __isAverage: true,
    };

    return { datasets: [...perRun, average] };
  }, [series, hovered, colorBy]);

  // Read inside the tooltip filter below instead of closing over
  // `effectiveTooltipFilter` directly -- the chart-creation effect (right
  // below) deliberately only runs once (see its own comment), so a filter
  // callback defined inside it would otherwise always see whatever that
  // value was at mount time. Kept current by the hover-update effect
  // further down, the same place that already pushes new dataset colors
  // into the live chart instance.
  const tooltipFilterRef = useRef<HoverFilter>(effectiveTooltipFilter ?? null);

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
        aspectRatio: effectiveAspectRatio,
        // "nearest" + intersect:false -- this chart can have dozens of
        // thin, pointRadius:0 lines overlapping, so requiring a
        // pixel-exact hover (Chart.js's intersect:true default) made the
        // tooltip nearly impossible to trigger. "nearest" (rather than
        // ScenarioChart's "index", which shows every dataset at once --
        // fine for its handful of lines, overwhelming for this chart's
        // dozens) surfaces just the one closest line under the cursor.
        interaction: { mode: "nearest", intersect: false },
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
          legend: { display: legend, position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            mode: "nearest",
            intersect: false,
            // While a tooltipFilter is active, only show tooltip entries
            // for runs that actually match it, same "model"/"scenario"/
            // "ssp" semantics as the dim/highlight logic above
            // (matchesHover) -- not every nearby line regardless of
            // what's highlighted. The average line is always shown. See
            // this component's own tooltipFilter prop doc comment for
            // why this is a separate value from `hovered` (the one that
            // drives dim/highlight) rather than the same one.
            filter: (item) => {
              const h = tooltipFilterRef.current;
              if (!h) return true;
              const ds = item.dataset as any;
              if (ds.__isAverage) return true;
              return matchesHover(h, ds.__model, ds.__scenario);
            },
          },
        },
      },
    });
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!chartData, windowMin, windowMax, aspectRatio, legend]);

  // Keeps an already-created chart's aspect ratio in sync with the
  // reactive breakpoint tracked above, in place -- same "update the
  // existing instance, don't destroy/recreate" reasoning as the
  // hover-update effect right below this one, so crossing the 640px
  // breakpoint doesn't cause the same resize-flash/scroll-jump a full
  // recreate would.
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.options.aspectRatio = effectiveAspectRatio;
    chartRef.current.resize();
  }, [effectiveAspectRatio]);

  // Hover (and any other dataset-only change) updates the existing
  // instance in place instead of recreating it -- no resize flash.
  useEffect(() => {
    tooltipFilterRef.current = effectiveTooltipFilter ?? null;
    if (!chartData || !chartRef.current) return;
    chartRef.current.data.datasets = chartData.datasets as any;
    chartRef.current.update();
  }, [chartData, effectiveTooltipFilter]);

  if (!chartData) return <p className="public-chart-empty">No runs to plot yet.</p>;

  return (
    <div className="public-chart">
      <canvas ref={canvasRef} />
    </div>
  );
}
