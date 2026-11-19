/**
 * Shared browser-side helpers used by all three dashboard panels. Relative
 * paths ("" base) since the dashboard and gateway are same-origin -- see
 * app/page.tsx's original comment on why that's just a convenience for
 * THIS page, not a constraint on the API (CORS is wide open -- lib/cors.ts).
 *
 * No Authorization header attached here (unlike an earlier version of this
 * file, which sent a single shared placeholder key on every request --
 * visible to anyone who opened devtools or grepped the client bundle, so
 * not a real credential at all). The two gateway routes that need auth
 * (POST /v1/models/{model}/runs, GET /v1/runs/{runId}) now accept the
 * existing httpOnly dashboard_auth cookie as this console's own
 * credential -- see lib/apiKey.ts -- which the browser already attaches
 * automatically on every same-origin request once logged into /dashboard,
 * and which client-side JS can't read out to begin with.
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

// Parses Hector's own outputstream.csv text (gcam's result.csv -- see
// sandboxes/gcam/run.py's _read_output_csv docstring for why that's raw
// text rather than pre-parsed rows: this is the one place that does the
// parsing, so a format quirk only needs fixing here). Hector prefixes
// the real header row with a "# Output from hector version ..." comment
// line, so comment lines are skipped rather than naively treated as the
// header. No quoted-field/escaping support -- Hector's own CSV writer
// doesn't produce those, so a plain split is enough.
export function parseHectorCsv(csv: string | null | undefined): Record<string, string>[] {
  if (!csv) return [];
  const lines = csv.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
  if (lines.length < 1) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((key, i) => {
      row[key] = (cells[i] ?? "").trim();
    });
    return row;
  });
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
  twolayer(result) {
    const native = result.result;
    return {
      labels: native.years,
      values: native.T_atmos,
      label: `Two-layer surface temperature anomaly (${result.scenario})`,
    };
  },
  gcam(result) {
    // GCAM's result.csv is Hector's own long-format outputstream.csv,
    // untouched raw text (see sandboxes/gcam/run.py's _read_output_csv
    // docstring -- it deliberately does NOT parse this on the Python
    // side, so the parsing happens here instead, in one place): one row
    // per (variable, year), not nested by variable like hector's own
    // library adapter above. Header row (confirmed from Hector v3.2.0's
    // own src/csv_outputstream_visitor.cpp, not guessed):
    // year,run_name,spinup,component,variable,value,units -- so
    // "global_tas" is the `variable` column (its `component` column is
    // "temperature"), the same quantity hector's adapter reads as
    // native.data["temperature.global_tas"] from its library's nested
    // dict, just flattened differently by Hector's CSV writer. Rows with
    // spinup != "0" are spinup-phase output, not part of the real
    // trajectory.
    const rows = parseHectorCsv(result.result?.csv);
    const temps = rows
      .filter((r) => r.variable === "global_tas" && (r.spinup ?? "0") === "0")
      .map((r) => ({ year: Number(r.year), value: Number(r.value) }))
      .sort((a, b) => a.year - b.year);
    return {
      labels: temps.map((r) => r.year),
      values: temps.map((r) => r.value),
      label: `GCAM (Hector) temperature anomaly (${result.scenario})`,
    };
  },
};

// --- Full data explorer series adapters ---------------------------------
// CHART_ADAPTERS above picks ONE hardcoded series per model for the small
// charts on Overview/Compare/the home page -- deliberately narrow, kept as
// is (still used by those three). The run drawer's data explorer needs the
// opposite: every distinct series a model's native result actually
// contains, so a person can pick whichever ones they want to overlay. One
// adapter per model, returning a flat list -- grouping by `unit` (where
// derivable) is left to the caller (RunsPanel), since what to DO with a
// shared unit (same y-axis, same color family, etc) is a rendering
// decision, not a parsing one.
export interface DataSeries {
  key: string;
  label: string;
  unit?: string;
  x: number[];
  y: number[];
  // Only present for genuinely ensemble-derived series (fair's per-config
  // spread, oscar's std dev) -- same length as x/y, lower/upper bound per
  // point, rendered as a filled band rather than asserting a single "true"
  // value where the model itself only ever produced a distribution.
  band?: { lower: number[]; upper: number[] };
}

/** Hector's own pyhector columns are already named like
 * "temperature.global_tas" / "simpleNbox.CO2_concentration" -- the part
 * before the dot is pyhector's own "component" grouping, which already
 * reads as a reasonable unit/category label without this needing its own
 * lookup table (hector doesn't report units anywhere in its own output, so
 * there's nothing more precise to extract). */
function hectorSeries(result: any): DataSeries[] {
  const native = result.result;
  const index: number[] = native.index;
  return (native.columns as string[]).map((column) => ({
    key: column,
    label: column,
    unit: column.split(".")[0],
    x: index,
    y: native.data[column],
  }));
}

/** FAIR's native result only has one variable (temperature), but per
 * config, not collapsed to one number -- CHART_ADAPTERS.fair averages
 * across configs and throws the spread away. This keeps the mean AND
 * exposes the spread as a min/max band per timestep (not stdev -- FAIR's
 * configs are a Monte-Carlo-like ensemble over fitted climate response
 * parameters, not a Gaussian the way oscar's MC sampling is, so an
 * observed min/max envelope is the honest "full observed range" rather
 * than implying a distribution shape this ensemble doesn't actually have). */
function fairSeries(result: any): DataSeries[] {
  const native = result.result;
  const timebounds: number[] = native.timebounds;
  const series: DataSeries[] = [];
  for (const scenario of Object.keys(native.temperature ?? {})) {
    const perTimestepConfigs: number[][] = native.temperature[scenario];
    const mean = perTimestepConfigs.map((configsAtT) => configsAtT.reduce((a, b) => a + b, 0) / configsAtT.length);
    const lower = perTimestepConfigs.map((configsAtT) => Math.min(...configsAtT));
    const upper = perTimestepConfigs.map((configsAtT) => Math.max(...configsAtT));
    series.push({
      key: `temperature.${scenario}`,
      label: `temperature (${scenario})`,
      unit: "degC",
      x: timebounds,
      y: mean,
      band: { lower, upper },
    });
  }
  return series;
}

/** OSCAR's native result already carries both the per-year mean AND std
 * dev across its Monte Carlo configs (see sandboxes/oscar/run.py) --
 * CHART_ADAPTERS.oscar only charted the mean. Exposed here as a mean line
 * plus a +/-1 std dev band, same "don't collapse an ensemble to a single
 * number if the model already reports its spread" reasoning as fairSeries
 * above. */
function oscarSeries(result: any): DataSeries[] {
  const native = result.result;
  const years: number[] = native.year;
  const mean: number[] = native.mean_D_Tg;
  const std: number[] = native.std_D_Tg;
  const lower = mean.map((m, i) => (m == null || std[i] == null ? null : m - std[i])) as number[];
  const upper = mean.map((m, i) => (m == null || std[i] == null ? null : m + std[i])) as number[];
  return [
    {
      key: "mean_D_Tg",
      label: "temperature anomaly (mean)",
      unit: "degC",
      x: years,
      y: mean,
      band: { lower, upper },
    },
  ];
}

/** DICE's native Results struct carries several arrays beyond T_atmos
 * (see sandboxes/dice/run.jl), all indexed the same way as `years` --
 * social cost of carbon, total forcing, and the model's own utility
 * objective. Units are DICE's own (not normalized against the other
 * models -- same cross-model decision PLATFORM.md already made for the
 * underlying values themselves). */
function diceSeries(result: any): DataSeries[] {
  const native = result.result;
  const years: number[] = native.years;
  const fields: [string, string, string][] = [
    ["T_atmos", "atmospheric temperature anomaly", "degC"],
    ["scc", "social cost of carbon", "USD/tCO2"],
    ["forcing", "radiative forcing", "W/m^2"],
    ["utility", "utility (DICE objective)", ""],
  ];
  return fields
    .filter(([k]) => Array.isArray(native[k]))
    .map(([k, label, unit]) => ({ key: k, label, unit: unit || undefined, x: years, y: native[k] }));
}

/** magicc/twolayer's native result.ts (as returned by this gateway's own
 * run.py) only ever has the one series (T_atmos) -- see sandboxes/magicc
 * and sandboxes/twolayer run.py's `result` construction, neither computes
 * or returns anything else. Kept as separate named functions (not aliased
 * to one shared implementation) so each can grow independently if a future
 * version of either script starts exposing more of its native output. */
function magiccSeries(result: any): DataSeries[] {
  const native = result.result;
  return [{ key: "T_atmos", label: "surface temperature anomaly", unit: "degC", x: native.years, y: native.T_atmos }];
}

function twolayerSeries(result: any): DataSeries[] {
  const native = result.result;
  return [{ key: "T_atmos", label: "surface temperature anomaly (upper layer)", unit: "degC", x: native.years, y: native.T_atmos }];
}

/** gcam's native result is Hector's own long-format outputstream.csv text
 * (parsed once, here, by the shared parseHectorCsv -- see that function's
 * comment for why GCAM's run.py deliberately leaves this unparsed). Unlike
 * hector's own library adapter above (one row per year, one column per
 * variable), this CSV is one row per (variable, year) pair -- so unlike
 * hectorSeries, this needs an explicit group-by before it has per-variable
 * x/y arrays to return. Header row confirmed from Hector v3.2.0's own
 * src/csv_outputstream_visitor.cpp:
 * year,run_name,spinup,component,variable,value,units -- keys/labels use
 * "component.variable" (e.g. "temperature.global_tas") so they match
 * hectorSeries's own column naming and can't collide if two components
 * ever report the same bare variable name. Units come straight from the
 * `units` column (unlike hectorSeries, which has no units to read and
 * falls back to the component name). Spinup-phase rows (spinup != "0")
 * are excluded -- not part of the real trajectory. */
function gcamSeries(result: any): DataSeries[] {
  const rows = parseHectorCsv(result.result?.csv);
  const byVariable = new Map<string, { year: number; value: number; unit?: string }[]>();
  for (const row of rows) {
    const variable = row.variable;
    if (!variable) continue;
    if ((row.spinup ?? "0") !== "0") continue;
    const key = row.component ? `${row.component}.${variable}` : variable;
    if (!byVariable.has(key)) byVariable.set(key, []);
    byVariable.get(key)!.push({ year: Number(row.year), value: Number(row.value), unit: row.units });
  }
  return Array.from(byVariable.entries()).map(([key, points]) => {
    points.sort((a, b) => a.year - b.year);
    return {
      key,
      label: key,
      unit: points[0]?.unit || undefined,
      x: points.map((p) => p.year),
      y: points.map((p) => p.value),
    };
  });
}

export const SERIES_ADAPTERS: Record<string, (result: any) => DataSeries[]> = {
  hector: hectorSeries,
  fair: fairSeries,
  oscar: oscarSeries,
  dice: diceSeries,
  magicc: magiccSeries,
  twolayer: twolayerSeries,
  gcam: gcamSeries,
};

// --- Cross-model scenario naming -----------------------------------------
// hector/fair use lowercase short codes ("ssp119"), oscar uses IPCC's own
// longer form ("SSP1-1.9") -- same scenarios, just different native string
// formats each model's own run.py/library expects. That native string is
// still exactly what gets submitted/cached (lib/models.ts's caching note
// still applies in full -- this is display/grouping only, never sent to a
// sandbox). This map normalizes every model's native scenario string to one
// canonical label -- oscar's own format, since it already matches IPCC's
// naming -- so the same scenario reads identically and groups together
// across models in the Runs/Compare tabs.
//
// MAGICC's RCP26/45/60/85 are deliberately NOT mapped onto an SSP label
// here: RCPs are a genuinely different scenario framework (radiative
// forcing pathways from CMIP5, not SSP narratives from CMIP6) -- any
// "RCP4.5 ~ SSP2-4.5"-style correspondence is an approximation some papers
// use, not an equivalence this gateway should assert. Same for DICE's
// base/optimal, which aren't emissions scenario codes at all.
const SSP_CANONICAL: Record<string, string> = {
  ssp119: "SSP1-1.9",
  ssp126: "SSP1-2.6",
  ssp245: "SSP2-4.5",
  ssp370: "SSP3-7.0",
  ssp434: "SSP4-3.4",
  ssp460: "SSP4-6.0",
  "ssp534-over": "SSP5-3.4-OS",
  ssp585: "SSP5-8.5",
};

/** Normalize a model-native scenario string to one canonical label shared
 * across models that represent the same SSP (oscar's own strings are
 * already canonical, so they pass through unchanged; RCPs/DICE's
 * base/optimal also pass through unchanged -- see the comment above). */
export function canonicalScenario(nativeScenario: string): string {
  return SSP_CANONICAL[nativeScenario] ?? nativeScenario;
}

/** Whether a CANONICAL scenario label (see canonicalScenario above) is
 * one of the SSP-framework names ("SSP1-2.6" etc) rather than an RCP
 * (magicc's "RCP26"...), DICE's own "base"/"optimal" policies, or gcam's
 * single "Reference" -- a plain naming check (every real SSP canonical
 * label starts with "SSP"), not a guess. Used by the home page's "SSPs"
 * legend item (TemperatureChart's hovered.type === "ssp") to highlight
 * every SSP-framework line on the chart at once, regardless of which
 * model ran it. */
export function isSspScenario(canonicalLabel: string): boolean {
  return canonicalLabel.startsWith("SSP");
}

// Short, human descriptions for the scenario codes used across models --
// best-effort documentation of well-known SSP/RCP identifiers (IPCC AR6's
// own scenario naming), not something the gateway/sandboxes compute. Keyed
// by canonical label (see canonicalScenario above) -- scenarioDescription()
// canonicalizes before looking up, so it works whether passed a model's
// native string or the canonical one. A scenario not in this map (e.g.
// DICE's "base"/"optimal") just renders its card without a description.
const SCENARIO_DESCRIPTIONS: Record<string, string> = {
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
  return SCENARIO_DESCRIPTIONS[canonicalScenario(scenario)] ?? null;
}

// Same underlying facts as SCENARIO_DESCRIPTIONS above, written as a full
// sentence instead of a card-sized fragment ("Very low emissions -- likely
// holds warming near 1.5°C."). Needed because that map does two jobs --
// NewRunPanel's scenario-picker card blurb (where a short fragment reads
// fine) and the scenario article page's opening lede sentence (where a
// dash-fragment reads like a caption, not prose) -- and one string can't
// comfortably serve both. Scenario article pages should use this instead.
const SCENARIO_LEDES: Record<string, string> = {
  "SSP1-1.9": "SSP1-1.9 is a very-low-emissions pathway, likely to hold warming near 1.5°C.",
  "SSP1-2.6": "SSP1-2.6 is a low-emissions pathway, consistent with strong mitigation and staying below 2°C.",
  "SSP2-4.5": "SSP2-4.5 is an intermediate, middle-of-the-road emissions pathway.",
  "SSP3-7.0": "SSP3-7.0 is a high-emissions pathway, reflecting regional rivalry and weak mitigation.",
  "SSP3-7.0-LowNTCF":
    "SSP3-7.0-LowNTCF follows the same high-emissions path as SSP3-7.0, but with reduced near-term climate forcers.",
  "SSP4-3.4": "SSP4-3.4 is a lower-middle forcing pathway, with a gradual, late transition.",
  "SSP4-6.0": "SSP4-6.0 is a medium-high forcing pathway, with a gradual, late transition.",
  "SSP5-3.4-OS": "SSP5-3.4-OS starts with high near-term emissions, then follows an overshoot drawdown.",
  "SSP5-8.5": "SSP5-8.5 is a very-high-emissions pathway, reflecting fossil-fueled development.",
  RCP26: "RCP26 is a low radiative forcing pathway, peaking around 2.6 W/m².",
  RCP45: "RCP45 is an intermediate stabilization pathway, around 4.5 W/m².",
  RCP60: "RCP60 is a higher stabilization pathway, around 6.0 W/m².",
  RCP85: "RCP85 is a high, rising radiative forcing pathway, around 8.5 W/m².",
  base: "DICE's base scenario is a business-as-usual emissions path, with no abatement policy.",
  optimal: "DICE's optimal scenario is the economically optimal emissions path under its own model.",
};

export function scenarioLede(scenario: string): string | null {
  return SCENARIO_LEDES[canonicalScenario(scenario)] ?? null;
}

/**
 * Aligns multiple chart series onto one shared x-axis by actual year value,
 * not by array index.
 *
 * Bug this fixes: Chart.js's default category scale just lines up
 * `dataset[i]` under `labels[i]` -- it has no idea the labels are years.
 * The Compare tab used to build its overlay chart as `labels:
 * series[0].labels, datasets: series.map(s => s.values)`, which only
 * happens to be correct when every series has the EXACT same year array.
 * That's false whenever series differ in length/range -- e.g. before this
 * was fixed, overlaying hector (556 points, 1745-2300) against oscar (87
 * points, 2014-2100) silently plotted oscar's 87 values under the FIRST 87
 * x-axis labels (~1745-1831) instead of under 2014-2100, visually
 * "shifting" oscar's curve to the wrong place on both axes -- confirmed by
 * inspecting real cached run data, not assumed.
 *
 * Each returned dataset is the same length as the merged, sorted label
 * array, with `null` at any year that series didn't report. Consumers
 * should render these with `spanGaps: true`, not `false` -- confirmed by
 * hitting this directly: dice reports every 5 years while every other
 * model reports annually, so against the shared (annual) label array,
 * EVERY one of dice's real points ends up isolated by 4 synthetic nulls
 * on each side. With spanGaps:false, Chart.js (pointRadius:0) never draws
 * a segment between two points separated by a null, so dice's line was
 * completely invisible -- not missing data, just never connected.
 * spanGaps:true only connects through nulls BETWEEN two real points of
 * the same series (exactly dice's case -- those nulls are an artifact of
 * this function's shared grid, not a real absence of data); it does NOT
 * extend a line beyond where a series actually starts/ends, since
 * leading/trailing nulls have no second real point on the far side to
 * connect to. So the original "honest gap, never fabricated" goal still
 * holds for genuine out-of-range periods -- this only fixes a model
 * reporting at coarser-than-annual resolution.
 */
export function alignSeriesByYear(
  series: { labels: any[]; values: any[]; label: string }[],
): { labels: number[]; datasets: { label: string; data: (number | null)[] }[] } {
  const yearSet = new Set<number>();
  for (const s of series) {
    for (const y of s.labels) yearSet.add(Number(y));
  }
  const years = Array.from(yearSet).sort((a, b) => a - b);

  const datasets = series.map((s) => {
    const byYear = new Map<number, number>();
    s.labels.forEach((y: any, i: number) => {
      const v = s.values[i];
      if (v !== null && v !== undefined) byYear.set(Number(y), v);
    });
    return {
      label: s.label,
      data: years.map((y) => (byYear.has(y) ? byYear.get(y)! : null)),
    };
  });

  return { labels: years, datasets };
}

// Fixed per-model color, so the same model always reads as the same line
// color everywhere it's plotted (Overview tab's checkboxes use a matching
// swatch) -- picked for contrast against each other and against the dark
// dashed "average" line, not derived from anything about the model itself.
export const MODEL_COLORS: Record<string, string> = {
  hector: "#2f6fed",
  fair: "#1fa37a",
  oscar: "#e0862f",
  dice: "#9b51e0",
  magicc: "#e0415a",
  twolayer: "#1b8f9e",
};

/** Falls back to a neutral gray for any model not in MODEL_COLORS, so a
 * future model added to lib/models.ts without updating this never breaks
 * rendering -- same fallback convention as NewRunPanel's ModelIcon. */
export function modelColor(model: string): string {
  return MODEL_COLORS[model] ?? "#767a85";
}

/** `#rrggbb` -> `rgba(r, g, b, alpha)`, for dimming a line on hover
 * without changing its underlying hue (plain CSS opacity isn't an option
 * on a Chart.js borderColor, which wants a real color string). */
export function colorWithAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Pointwise mean across however many of the given (already year-aligned,
 * see alignSeriesByYear) series are currently visible, `null` at any index
 * where NONE of them has a value -- an honest gap, never a fabricated
 * value, same convention as alignSeriesByYear's own null-filling.
 */
export function averageSeries(seriesData: (number | null)[][]): (number | null)[] {
  if (seriesData.length === 0) return [];
  const length = seriesData[0].length;
  const result: (number | null)[] = [];
  for (let i = 0; i < length; i++) {
    let sum = 0;
    let count = 0;
    for (const data of seriesData) {
      const v = data[i];
      if (v !== null && v !== undefined) {
        sum += v;
        count++;
      }
    }
    result.push(count > 0 ? sum / count : null);
  }
  return result;
}

export function chartAspectRatio() {
  return typeof window !== "undefined" && window.innerWidth <= 640 ? 1.4 : 3.4;
}

// `paramValues` holds raw text per parameter key -- "" means the field was
// left untouched, not "set to its default." Only keys with a non-empty,
// valid value are included in the submitted params -- see lib/models.ts's
// module docstring for why omitted and explicit-default are deliberately
// never treated as equivalent for caching.
/**
 * configOverridesText is only ever meaningful for a model with
 * meta.supports_config_overrides (currently just gcam) -- silently
 * ignored otherwise, so callers don't need to gate passing it
 * themselves (e.g. a multi-model batch submission reusing the same
 * text across models that may not all support it). THROWS (not a
 * silent drop) on invalid JSON or a non-flat-object shape -- unlike the
 * numeric parameters above, which just skip a value that doesn't parse,
 * a config override typo is exactly the kind of mistake that should
 * block submission with a clear message instead of quietly running
 * without the override the user thought they were setting. Callers
 * must catch this.
 */
export function buildParams(
  meta: ModelMeta,
  scenario: string,
  paramValues: Record<string, string>,
  configOverridesText?: string,
): Record<string, unknown> {
  const params: Record<string, unknown> =
    meta.params_shape === "scenarios" ? { scenarios: [scenario] } : { scenario };

  for (const spec of meta.parameters ?? []) {
    const raw = paramValues[spec.key];
    if (raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (!Number.isNaN(value)) params[spec.key] = value;
  }

  if (meta.supports_config_overrides && configOverridesText && configOverridesText.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configOverridesText);
    } catch {
      throw new Error("config overrides: not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("config overrides: must be a flat JSON object of {name: value}");
    }
    params.config_overrides = parsed;
  }

  return params;
}

/** Pulls a run's model-native scenario string out of its params, whichever
 * shape (`scenario` vs `scenarios[0]`) this model uses. */
export function nativeScenarioOf(params: Record<string, unknown>): string | undefined {
  if (typeof params?.scenario === "string") return params.scenario;
  if (Array.isArray(params?.scenarios) && typeof params.scenarios[0] === "string") return params.scenarios[0];
  return undefined;
}

/** Short, human label for a run's params -- e.g. "SSP1-2.6" or "RCP26 · climate_sensitivity=4.5" -- used in the Runs list and Compare legend. Scenario is shown in its canonical form (see canonicalScenario) so the same scenario reads identically regardless of which model ran it. */
export function summarizeParams(params: Record<string, unknown>): string {
  const scenario = summarizeScenario(params);
  const extras = summarizeExtraParams(params);
  return [scenario, extras].filter(Boolean).join(" · ");
}

/** Just the scenario half of summarizeParams, in its canonical form -- "" if this run's params carry no scenario at all (shouldn't normally happen, but every params_shape ultimately reduces to one). */
export function summarizeScenario(params: Record<string, unknown>): string {
  const native = nativeScenarioOf(params);
  return native ? canonicalScenario(native) : "";
}

/** Just the non-scenario half of summarizeParams -- e.g. "climate_sensitivity=4.5", or "" for a run with no extra params set (the Runs table's Params column shows "(default)" in that case, not this function's job). */
export function summarizeExtraParams(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([k]) => k !== "scenario" && k !== "scenarios")
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
}
