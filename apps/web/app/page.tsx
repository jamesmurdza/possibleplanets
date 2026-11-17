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
import type { ModelListItem } from "../lib/clientTypes";

// SSPs are a socioeconomic-storyline scenario framework; RCPs (magicc) and
// DICE's own named policies (base/optimal) are different frameworks
// entirely (see lib/assumptions.ts's scenarioAssumptions) -- there's no
// "canonical SSP shared by all models" to compute if those two are
// included, so they're excluded from this intersection by name, the same
// explicit distinction already made throughout lib/clientApi.ts/
// lib/assumptions.ts.
const NON_SSP_MODELS = new Set(["dice", "magicc"]);

export default function HomePage() {
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [hovered, setHovered] = useState<HoverFilter>(null);
  const { series, loading } = useChartSeries();

  useEffect(() => {
    fetchJson("/v1/models")
      .then((data) => setModels(data.models ?? []))
      .catch(() => {});
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

  return (
    <div className="public-page">
      <PublicHeader />

      <main className="public-main">
        <section className="public-hero">
          <h1>How much will the world warm?</h1>
          <p>
            {models.length || "Several"} independent climate/economic models, run against the same published
            emissions scenarios. This chart shows every model run on record, 2000-2100, with the average across all
            of them dashed.
          </p>
        </section>

        <section className="public-chart-section">
          {loading ? (
            <p className="public-chart-empty">Loading runs...</p>
          ) : (
            <TemperatureChart series={series} windowMin={2000} windowMax={2100} hovered={hovered} />
          )}
        </section>

        <section className="public-cards-section">
          <h2>Models</h2>
          <div className="public-card-grid">
            {models.map((m) => (
              <Link
                key={m.model}
                href={`/models/${m.model}`}
                className="public-card"
                onMouseEnter={() => setHovered({ type: "model", value: m.model })}
                onMouseLeave={() => setHovered(null)}
              >
                <div className="public-card-title">{modelAcronym(m.model)}</div>
                <p className="public-card-description">{modelFullName(m.model)}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="public-cards-section">
          <h2>Emissions scenarios</h2>
          <div className="public-card-grid">
            {sharedSsps.map((s) => (
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
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
