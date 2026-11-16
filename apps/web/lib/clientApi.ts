/**
 * Shared browser-side helpers used by all three dashboard panels. Relative
 * paths ("" base) since the dashboard and gateway are same-origin -- see
 * app/page.tsx's original comment on why that's just a convenience for
 * THIS page, not a constraint on the API (CORS is wide open -- lib/cors.ts).
 */
import type { ModelMeta } from "./clientTypes";

export async function fetchJson(path: string, options?: RequestInit) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

// --- Per-model chart adapters -----------------------------------------
// Each adapter takes a run's native `result` object (from GET /v1/runs/..)
// and returns { labels, values, label } for a single line -- same "pick
// one sensible default series per model" decision as the rest of this
// project, no cross-model normalization.
export const CHART_ADAPTERS: Record<string, (result: any) => { labels: any[]; values: any[]; label: string }> = {
  hector(result) {
    const native = result.result;
    const column = "temperature.global_tas";
    return {
      labels: native.index,
      values: native.data[column],
      label: `HECTOR temperature anomaly (${result.scenario})`,
    };
  },
  fair(result) {
    const native = result.result;
    const scenario = result.scenarios[0];
    const perTimestepConfigs = native.temperature[scenario];
    const meanValues = perTimestepConfigs.map((configsAtT: number[]) => {
      const sum = configsAtT.reduce((a, b) => a + b, 0);
      return sum / configsAtT.length;
    });
    return {
      labels: native.timebounds,
      values: meanValues,
      label: `FAIR mean temperature anomaly across configs (${scenario})`,
    };
  },
  oscar(result) {
    const native = result.result;
    return {
      labels: native.year,
      values: native.mean_D_Tg,
      label: `OSCAR mean temperature anomaly (${result.scenario}, nMC=${result.nMC})`,
    };
  },
  dice(result) {
    const native = result.result;
    return {
      labels: native.years,
      values: native.T_atmos,
      label: `DICE atmospheric temperature anomaly (${result.scenario})`,
    };
  },
  magicc(result) {
    const native = result.result;
    return {
      labels: native.years,
      values: native.T_atmos,
      label: `MAGICC surface temperature anomaly (${result.scenario})`,
    };
  },
};

// Short, human descriptions for the scenario codes used across models --
// best-effort documentation of well-known SSP/RCP identifiers (IPCC AR6's
// own scenario naming), not something the gateway/sandboxes compute. A
// scenario not in this map (e.g. DICE's "base"/"optimal") just renders its
// card without a description.
const SCENARIO_DESCRIPTIONS: Record<string, string> = {
  ssp119: "Very low emissions -- likely holds warming near 1.5°C.",
  ssp126: "Low emissions -- strong mitigation, below 2°C.",
  ssp245: "Intermediate emissions -- middle-of-the-road.",
  ssp370: "High emissions -- regional rivalry, weak mitigation.",
  ssp434: "Lower-middle forcing with a gradual, late transition.",
  ssp460: "Medium-high forcing with a gradual, late transition.",
  "ssp534-over": "High near-term emissions, then an overshoot drawdown.",
  ssp585: "Very high emissions -- fossil-fueled development.",
  "SSP1-1.9": "Very low emissions -- likely holds warming near 1.5°C.",
  "SSP1-2.6": "Low emissions -- strong mitigation, below 2°C.",
  "SSP2-4.5": "Intermediate emissions -- middle-of-the-road.",
  "SSP3-7.0": "High emissions -- regional rivalry, weak mitigation.",
  "SSP3-7.0-LowNTCF": "SSP3-7.0 with reduced near-term climate forcers.",
  "SSP4-3.4": "Lower-middle forcing with a gradual, late transition.",
  "SSP4-6.0": "Medium-high forcing with a gradual, late transition.",
  "SSP5-3.4-OS": "High near-term emissions, then an overshoot drawdown.",
  "SSP5-8.5": "Very high emissions -- fossil-fueled development.",
  RCP26: "Low radiative forcing pathway, peaking around 2.6 W/m².",
  RCP45: "Intermediate stabilization pathway, around 4.5 W/m².",
  RCP60: "Higher stabilization pathway, around 6.0 W/m².",
  RCP85: "High, rising radiative forcing pathway, around 8.5 W/m².",
  base: "Business-as-usual emissions path (no abatement policy).",
  optimal: "Economically optimal emissions path under DICE's own model.",
};

export function scenarioDescription(scenario: string): string | null {
  return SCENARIO_DESCRIPTIONS[scenario] ?? null;
}

export function chartAspectRatio() {
  return typeof window !== "undefined" && window.innerWidth <= 640 ? 1.4 : 3.4;
}

// `paramValues` holds raw text per parameter key -- "" means the field was
// left untouched, not "set to its default." Only keys with a non-empty,
// valid value are included in the submitted params -- see lib/models.ts's
// module docstring for why omitted and explicit-default are deliberately
// never treated as equivalent for caching.
export function buildParams(
  meta: ModelMeta,
  scenario: string,
  paramValues: Record<string, string>,
): Record<string, unknown> {
  const params: Record<string, unknown> =
    meta.params_shape === "scenarios" ? { scenarios: [scenario] } : { scenario };

  for (const spec of meta.parameters ?? []) {
    const raw = paramValues[spec.key];
    if (raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (!Number.isNaN(value)) params[spec.key] = value;
  }

  return params;
}

/** Short, human label for a run's params -- e.g. "ssp126" or "RCP26 · climate_sensitivity=4.5" -- used in the Runs list and Compare legend. */
export function summarizeParams(params: Record<string, unknown>): string {
  const scenario = params.scenario ?? (Array.isArray(params.scenarios) ? params.scenarios[0] : undefined);
  const extras = Object.entries(params)
    .filter(([k]) => k !== "scenario" && k !== "scenarios")
    .map(([k, v]) => `${k}=${v}`);
  return [scenario, ...extras].filter(Boolean).join(" · ");
}
