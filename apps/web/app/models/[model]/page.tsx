"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchJson } from "../../../lib/clientApi";
import { modelAssumptions } from "../../../lib/assumptions";
import { useRunsAndJobs } from "../../../lib/useRunsData";
import TemperatureChart from "../../../components/TemperatureChart";
import type { ModelListItem } from "../../../lib/clientTypes";

export default function ModelArticlePage() {
  const params = useParams<{ model: string }>();
  const model = params.model;
  const [meta, setMeta] = useState<ModelListItem | null>(null);
  const [notFound, setNotFound] = useState(false);
  const { plottableRuns, jobs, loading } = useRunsAndJobs();

  useEffect(() => {
    fetchJson("/v1/models")
      .then((data) => {
        const found = (data.models ?? []).find((m: ModelListItem) => m.model === model);
        if (!found) setNotFound(true);
        setMeta(found ?? null);
      })
      .catch(() => setNotFound(true));
  }, [model]);

  const ownRuns = plottableRuns.filter((r) => r.model === model);
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
        <h1 className="article-title">{model}</h1>
        {meta && (
          <>
            <p className="article-lede">{meta.description}</p>
            <a href={meta.website} target="_blank" rel="noopener noreferrer" className="article-website-link">
              Model website &rarr;
            </a>
          </>
        )}

        {assumptions && (
          <section className="article-section">
            <h2>Modelling assumptions</h2>
            <p className="assumptions-summary">{assumptions.summary}</p>
            <ul className="assumptions-list">
              {assumptions.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="article-section">
          <h2>Temperature projections</h2>
          {loading ? (
            <p className="public-chart-empty">Loading runs...</p>
          ) : (
            <TemperatureChart runs={ownRuns} jobs={jobs} />
          )}
        </section>
      </main>
    </div>
  );
}

function PublicHeader() {
  return (
    <header className="public-header">
      <Link href="/" className="public-header-title">
        Simple Climate Models
      </Link>
      <a href="/login" className="public-header-link">
        Dashboard login
      </a>
    </header>
  );
}
