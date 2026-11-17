"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchJson } from "../../../lib/clientApi";
import { modelAssumptions } from "../../../lib/assumptions";
import { useChartSeries } from "../../../lib/useRunsData";
import TemperatureChart from "../../../components/TemperatureChart";
import { PublicHeader, PublicFooter } from "../../../components/PublicChrome";
import { modelAcronym, modelFullName } from "../../../lib/modelFullNames";
import type { ModelListItem } from "../../../lib/clientTypes";

export default function ModelArticlePage() {
  const params = useParams<{ model: string }>();
  const model = params.model;
  const [meta, setMeta] = useState<ModelListItem | null>(null);
  const [notFound, setNotFound] = useState(false);
  const { series, loading } = useChartSeries();

  useEffect(() => {
    fetchJson("/v1/models")
      .then((data) => {
        const found = (data.models ?? []).find((m: ModelListItem) => m.model === model);
        if (!found) setNotFound(true);
        setMeta(found ?? null);
      })
      .catch(() => setNotFound(true));
  }, [model]);

  const ownSeries = series.filter((r) => r.model === model);
  const assumptions = modelAssumptions(model);

  if (notFound) {
    return (
      <div className="public-page">
        <PublicHeader />
        <main className="public-main">
          <p>Unknown model &quot;{model}&quot;.</p>
          <Link href="/">&larr; Back home</Link>
        </main>
      </div>
    );
  }

  return (
    <div className="public-page">
      <PublicHeader />
      <main className="public-main article">
        <Link href="/" className="article-back-link">
          &larr; All models
        </Link>
        <h1 className="article-title">
          {modelAcronym(model)}
          <span className="article-subtitle"> &mdash; {modelFullName(model)}</span>
        </h1>

        {meta && (
          <p className="article-lede">
            {meta.description} {meta.implementation}{" "}
            <a href={meta.website} target="_blank" rel="noopener noreferrer" className="article-website-link">
              Model website &rarr;
            </a>
          </p>
        )}

        <section className="public-chart-section">
          {loading ? (
            <p className="public-chart-empty">Loading runs...</p>
          ) : (
            <TemperatureChart series={ownSeries} windowMin={2000} windowMax={2100} colorBy="scenario" legend />
          )}
        </section>

        {assumptions && (
          <section className="article-section">
            <h2>What this model assumes</h2>
            {/* assumptions.summary (e.g. "A calibrated climate emulator.") is
                a generic one-liner that mostly restates the lede/title --
                not shown here; this section's heading already supplies the
                equivalent framing, and anything substantive lives in the
                bullet items below. Still used as-is in the dashboard's (i)
                info modal, which is a different, more compact context. */}
            <ul className="assumptions-list">
              {assumptions.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </section>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
