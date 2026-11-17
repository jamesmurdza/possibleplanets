"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchJson, canonicalScenario, scenarioDescription } from "../../../lib/clientApi";
import { scenarioAssumptionsByLabel } from "../../../lib/assumptions";
import { scenarioDriverSeries } from "../../../lib/scenarioDrivers";
import ScenarioChart from "../../../components/ScenarioChart";
import type { ModelListItem } from "../../../lib/clientTypes";

export default function ScenarioArticlePage() {
  const params = useParams<{ scenario: string }>();
  const scenario = decodeURIComponent(params.scenario);
  const [models, setModels] = useState<ModelListItem[]>([]);

  useEffect(() => {
    fetchJson("/v1/models")
      .then((data) => setModels(data.models ?? []))
      .catch(() => {});
  }, []);

  const driver = scenarioDriverSeries(scenario);
  const description = scenarioDescription(scenario);
  const assumptions = scenarioAssumptionsByLabel(scenario);
  const runOnModels = models.filter((m) => m.scenarios.some((s) => canonicalScenario(s) === scenario)).map((m) => m.model);

  if (!driver) {
    return (
      <div className="public-page">
        <PublicHeader />
        <main className="public-main">
          <p>Unknown scenario &quot;{scenario}&quot;.</p>
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
          &larr; All scenarios
        </Link>
        <h1 className="article-title">{scenario}</h1>
        {description && <p className="article-lede">{description}</p>}
        {runOnModels.length > 0 && (
          <p className="article-website-link">Run by: {runOnModels.join(", ")}</p>
        )}

        <section className="article-section">
          <h2>Scenario assumptions</h2>
          <p className="assumptions-summary">{assumptions.summary}</p>
          <ul className="assumptions-list">
            {assumptions.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="article-section">
          <h2>Emissions pathway</h2>
          <p className="public-section-note">
            The scenario&apos;s own projected CO2 emissions -- the same input every model runs on, not any model&apos;s
            output.
          </p>
          <ScenarioChart years={driver.years} values={driver.values} />
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
