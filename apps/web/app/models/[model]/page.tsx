"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchJson } from "../../../lib/clientApi";
import { modelAssumptions } from "../../../lib/assumptions";
import { modelChangelog } from "../../../lib/changelogs";
import { useChartSeries } from "../../../lib/useRunsData";
import TemperatureChart from "../../../components/TemperatureChart";
import CodeBlock from "../../../components/CodeBlock";
import { PublicHeader, PublicFooter } from "../../../components/PublicChrome";
import { modelAcronym, modelFullName } from "../../../lib/modelFullNames";
import { runGuide } from "../../../lib/runGuides";
import type { ModelListItem } from "../../../lib/clientTypes";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Hover-to-reveal "#" anchor link, like blog.jamesmurdza.com's headers --
// gives every section a stable, shareable URL (#how-to-run-x-locally)
// without cluttering the heading when you're not hovering it. The whole
// heading (not just the "#") is clickable -- it's the same link, just a
// bigger, more discoverable target.
function SectionHeading({ children }: { children: string }) {
  const slug = slugify(children);
  return (
    <h2 id={slug}>
      <a href={`#${slug}`} className="heading-link" aria-label={`Link to "${children}"`}>
        <span className="heading-anchor">#</span>
        {children}
      </a>
    </h2>
  );
}

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
  const guide = runGuide(model);
  const changelog = modelChangelog(model);

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
            <SectionHeading>What this model assumes</SectionHeading>
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

        {changelog && (
          <section className="article-section">
            <SectionHeading>Changelog</SectionHeading>
            <ul className="assumptions-list">
              {changelog.map((entry, i) => (
                <li key={i}>
                  <strong>{entry.version}</strong> &mdash; {entry.summary}
                </li>
              ))}
            </ul>
          </section>
        )}

        {guide &&
          guide.map((section, si) => (
            <section className="article-section" key={si}>
              <SectionHeading>{section.heading}</SectionHeading>
              <ol className="run-guide-steps">
                {section.steps.map((step, i) => (
                  <li key={i} className="run-guide-step">
                    {step.label && <p className="run-guide-step-label">{step.label}</p>}
                    <p>{step.text}</p>
                    {step.code && <CodeBlock code={step.code} language={step.language} />}
                    {step.note && <p>{step.note}</p>}
                  </li>
                ))}
              </ol>
            </section>
          ))}
      </main>
      <PublicFooter />
    </div>
  );
}
