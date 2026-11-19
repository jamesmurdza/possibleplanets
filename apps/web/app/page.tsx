"use client";

/**
 * Public home page -- no sidebar, no login. Unlike /dashboard (gated, see
 * proxy.ts), this and everything under /models and /scenarios is meant for
 * anyone to land on directly.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchJson, canonicalScenario } from "../lib/clientApi";
import { useChartSeries } from "../lib/useRunsData";
import TemperatureChart, { type HoverFilter } from "../components/TemperatureChart";
import { PublicHeader, PublicFooter } from "../components/PublicChrome";
import { modelAcronym, modelFullName } from "../lib/modelFullNames";
import { scenarioFullName } from "../lib/scenarioFullNames";
import { sortByResourceUsage } from "../lib/modelOrder";
import { modelColor } from "../lib/clientApi";
import ModelIcon from "../components/ModelIcon";
import type { ModelListItem } from "../lib/clientTypes";

// Lucide's "road" icon (https://lucide.dev/icons/road), reproduced
// inline rather than pulling in the lucide-react package -- same
// "hand-drawn inline SVG" convention every other icon on this page/
// ModelIcon.tsx already follows. One per SSP in the legend row below
// (see SSP_ICON_COLOR's own comment for why they're all this same
// neutral color, not per-scenario).
function RoadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 17v4" />
      <path d="M12 5V3" />
      <path d="M12 9v3" />
      <path d="M2.077 18.449A2 2 0 0 0 4 21h16a2 2 0 0 0 1.924-2.55l-4-14A2 2 0 0 0 16 3H8a2 2 0 0 0-1.924 1.45z" />
    </svg>
  );
}

// Every SSP legend item is this same neutral color, not colored like
// each model's own line -- there's nothing scenario-specific to tie a
// distinct color to the way there is for a model's own chart line.
const SSP_ICON_COLOR = "var(--pp-grey)";

// Matches .public-card-grid's own grid-template-columns (4 columns) and
// its @media (max-width: 800px) override (2 columns) in globals.css --
// kept in sync by hand since CSS values aren't readable from JS without
// a layout measurement. Used only to decide how many cards to show
// before truncating to "..." below, not for any actual layout -- the
// grid's own CSS still does the real column sizing.
const DESKTOP_COLUMNS = 4;
const MOBILE_COLUMNS = 2;
const MOBILE_BREAKPOINT = "(max-width: 800px)";
const VISIBLE_ROWS = 2;

function useColumnsPerRow(): number {
  const [columns, setColumns] = useState(DESKTOP_COLUMNS);
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_BREAKPOINT);
    const update = () => setColumns(mql.matches ? MOBILE_COLUMNS : DESKTOP_COLUMNS);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return columns;
}

// Caps a card list to VISIBLE_ROWS full rows at the current column count.
// If that cuts anything off, the last visible slot is reserved for a
// "..." indicator instead of a card, so the shown count is
// columnsPerRow * VISIBLE_ROWS - 1 in that case, not a partially-truncated
// last row.
function truncateToRows<T>(items: T[], columnsPerRow: number): { visible: T[]; truncated: boolean } {
  const capacity = columnsPerRow * VISIBLE_ROWS;
  if (items.length <= capacity) return { visible: items, truncated: false };
  return { visible: items.slice(0, capacity - 1), truncated: true };
}

// SSPs are a socioeconomic-storyline scenario framework; RCPs (magicc),
// DICE's own named policies (base/optimal), and GCAM's single "Reference"
// scenario are different frameworks entirely (see lib/assumptions.ts's
// scenarioAssumptions) -- there's no "canonical SSP shared by all models"
// to compute if any of these are included, so they're excluded from this
// intersection by name, the same explicit distinction already made
// throughout lib/clientApi.ts/lib/assumptions.ts. Confirmed this was the
// actual bug behind the whole "Emissions scenarios" section vanishing
// from the home page once gcam was added to the model list: gcam's own
// scenario set is just {"Reference"}, so intersecting it against any
// SSP model's set -- with gcam NOT excluded here -- always produced an
// empty result.
const NON_SSP_MODELS = new Set(["dice", "magicc", "gcam"]);

// Fixed skeleton counts while GET /v1/models hasn't resolved yet -- not
// meant to exactly predict the real counts (7 models, up to 8 shared
// SSPs), just enough placeholder cards to fill out the same 4-column
// grid shape (.public-card-grid) the real content will land in, so the
// page doesn't visibly reflow once it loads.
const MODEL_SKELETON_COUNT = 7;
const SCENARIO_SKELETON_COUNT = 8;

function SkeletonCards({ count, withIcon }: { count: number; withIcon?: boolean }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="public-card skeleton" aria-hidden="true">
          {withIcon && (
            <div className="public-model-card-header">
              <span className="skeleton-bar skeleton-icon" />
              <span className="skeleton-bar" style={{ width: "3.5rem" }} />
            </div>
          )}
          {!withIcon && <span className="skeleton-bar" style={{ width: "40%", marginBottom: "0.45rem" }} />}
          <span className="skeleton-bar" style={{ width: "85%" }} />
          <span className="skeleton-bar" style={{ width: "60%", marginTop: "0.3rem" }} />
        </div>
      ))}
    </>
  );
}

export default function HomePage() {
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [hovered, setHovered] = useState<HoverFilter>(null);
  const { series, loading } = useChartSeries();
  const columnsPerRow = useColumnsPerRow();

  useEffect(() => {
    fetchJson("/v1/models")
      .then((data) => setModels(data.models ?? []))
      .catch(() => {})
      .finally(() => setModelsLoading(false));
  }, []);

  // The SSPs every SSP-framework model actually offers -- an intersection,
  // not a union, so every scenario card shown here is guaranteed runnable
  // on every one of those models (confirmed by construction: a scenario
  // only makes this list if its canonical label appears in every SSP
  // model's own native scenario list).
  const sharedSsps = (() => {
    const sspModels = models.filter((m) => !NON_SSP_MODELS.has(m.model));
    if (sspModels.length === 0) return [];
    const sets = sspModels.map((m) => new Set(m.scenarios.map(canonicalScenario)));
    const [first, ...rest] = sets;
    return Array.from(first).filter((s) => rest.every((set) => set.has(s))).sort();
  })();

  const visibleScenarios = truncateToRows(sharedSsps, columnsPerRow);
  const modelsByResourceUsage = sortByResourceUsage(models);

  return (
    <div className="public-page">
      <PublicHeader />

      <main className="public-main">
        <section className="public-hero">
          <h1>How much will the world warm?</h1>
          <p>
            By 2100, global temperatures are likely to be several degrees warmer than pre-industrial levels, with
            the precise amount determined by the emissions path the world chooses to follow. Here is the range of
            outcomes projected by {models.length || "several"} independent models.
          </p>
        </section>

        <section className="public-chart-section">
          {loading ? (
            <div className="skeleton skeleton-chart" aria-hidden="true" />
          ) : (
            <TemperatureChart series={series} windowMin={2000} windowMax={2100} hovered={hovered} />
          )}

          <div className="public-chart-legend">
            {modelsLoading ? (
              <span className="skeleton-bar skeleton-legend-item" aria-hidden="true" />
            ) : (
              <div className="public-chart-legend-group">
                {modelsByResourceUsage.map((m) => (
                  <button
                    key={m.model}
                    type="button"
                    className="public-legend-item"
                    style={{ color: modelColor(m.model) }}
                    onMouseEnter={() => setHovered({ type: "model", value: m.model })}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <span className="public-legend-icon">
                      <ModelIcon model={m.model} />
                    </span>
                    {modelAcronym(m.model)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="public-chart-legend public-chart-legend-ssps">
            {modelsLoading ? (
              <div className="public-chart-legend-group">
                {Array.from({ length: SCENARIO_SKELETON_COUNT }).map((_, i) => (
                  <span key={i} className="skeleton-bar skeleton-legend-item" aria-hidden="true" />
                ))}
              </div>
            ) : (
              <div className="public-chart-legend-group">
                {sharedSsps.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="public-legend-item"
                    style={{ color: SSP_ICON_COLOR }}
                    onMouseEnter={() => setHovered({ type: "scenario", value: s })}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <span className="public-legend-icon">
                      <RoadIcon />
                    </span>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="public-cards-section">
          <h2>Models</h2>
          <div className="public-card-grid">
            {modelsLoading ? (
              <SkeletonCards count={MODEL_SKELETON_COUNT} withIcon />
            ) : (
              modelsByResourceUsage.map((m) => (
                <Link
                  key={m.model}
                  href={`/models/${m.model}`}
                  className="public-card public-model-card"
                  onMouseEnter={() => setHovered({ type: "model", value: m.model })}
                  onMouseLeave={() => setHovered(null)}
                >
                  <div className="public-model-card-header">
                    <span className="public-model-card-icon">
                      <ModelIcon model={m.model} />
                    </span>
                    <span className="public-card-title public-model-card-acronym">{modelAcronym(m.model)}</span>
                  </div>
                  <p className="public-card-description">{modelFullName(m.model)}</p>
                </Link>
              ))
            )}
          </div>
        </section>

        <section className="public-cards-section">
          <h2>Emissions scenarios</h2>
          <div className="public-card-grid">
            {modelsLoading ? (
              <SkeletonCards count={SCENARIO_SKELETON_COUNT} />
            ) : (
              <>
                {visibleScenarios.visible.map((s) => (
                  <Link
                    key={s}
                    href={`/scenarios/${encodeURIComponent(s)}`}
                    className="public-card"
                    onMouseEnter={() => setHovered({ type: "scenario", value: s })}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <div className="public-card-title">{s}</div>
                    <p className="public-card-description">{scenarioFullName(s)}</p>
                  </Link>
                ))}
                {visibleScenarios.truncated && (
                  <div className="public-card public-card-more">
                    <div className="public-card-title">...</div>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
