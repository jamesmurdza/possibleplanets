"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchJson, canonicalScenario, scenarioDescription } from "../../../lib/clientApi";
import { scenarioAssumptionsByLabel } from "../../../lib/assumptions";
import { scenarioDriverSeries } from "../../../lib/scenarioDrivers";
import ScenarioChart from "../../../components/ScenarioChart";
import { PublicHeader, PublicFooter } from "../../../components/PublicChrome";
import { scenarioFullName } from "../../../lib/scenarioFullNames";
import { modelAcronym } from "../../../lib/modelFullNames";
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
  // scenarioFullName() falls back to the label itself for anything that
  // isn't a real SSP narrative (DICE's base/optimal, MAGICC's RCPs) -- only
  // show it as a subtitle when it's actually a different, real name.
  const fullName = scenarioFullName(scenario);
  const hasNarrativeName = fullName !== scenario;

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
        <h1 className="article-title">
          {scenario}
          {hasNarrativeName && <span className="article-subtitle">: {fullName}</span>}
        </h1>
        {description && <p className="article-lede">{description}</p>}
        {runOnModels.length > 0 && (
          <div className="article-run-by">
            <span className="article-run-by-label">Run by</span>
            {runOnModels.map((m) => (
              <Link key={m} href={`/models/${m}`} className="article-model-tag">
                {modelAcronym(m)}
              </Link>
            ))}
          </div>
        )}

        <section className="article-section">
          <h2>What this scenario assumes</h2>
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
      <PublicFooter />
    </div>
  );
}
