/**
 * Real per-scenario driver trajectories, for the small sparkline shown on
 * each scenario card in the New Run form.
 *
 * This is NOT a model result -- it's the scenario's own defining input
 * (total fossil-fuel + industrial CO2 emissions, "Eff" in OSCAR's own
 * driver dataset, GtC/yr), the same regardless of which model a card
 * belongs to. Deliberately not a model output: a model's *response* to a
 * scenario differs model-to-model, but the scenario itself -- what it
 * specifies happens to emissions over time -- doesn't, so this is the
 * correct thing to show on a scenario-picker card where the model is
 * already a separate selection above it.
 *
 * Extracted once (not computed at request time) by loading OSCAR's own
 * `run_scripts.get_SSP_drivers` module in a throwaway sandbox -- that
 * import alone takes a few seconds and needs no simulation, unlike a real
 * OSCAR run (~6 minutes) -- and reading off `For_scen["Eff"]` for each of
 * the 9 SSP marker scenarios this project supports, summed across OSCAR's
 * regions, through 2100. Downsampled from the native annual series (87
 * points) to every 3rd year (30 points) -- plenty of resolution for a
 * ~60px-wide sparkline, and keeps this file small. Values are real, not
 * interpolated/fabricated -- every point is an actual year from OSCAR's
 * own driver data, just a subsampled one.
 *
 * Keyed by canonical scenario label (see canonicalScenario in clientApi.ts)
 * -- same 9 SSP marker scenarios oscar/hector/fair's SUPPORTED_SCENARIOS
 * cover. RCPs (magicc) and base/optimal (dice) aren't SSP narratives at
 * all (see clientApi.ts's own comment on this), so they're not in this map
 * -- scenarioDriverSeries() returns null for those, same "no data, no
 * card" convention as scenarioDescription().
 */

export const SCENARIO_DRIVER_YEARS = [
  2014, 2017, 2020, 2023, 2026, 2029, 2032, 2035, 2038, 2041, 2044, 2047, 2050, 2053, 2056, 2059, 2062, 2065, 2068,
  2071, 2074, 2077, 2080, 2083, 2086, 2089, 2092, 2095, 2098, 2100,
];

const SCENARIO_DRIVERS: Record<string, number[]> = {
  "SSP1-1.9": [
    9.24, 9.81, 9.96, 8.81, 7.66, 6.51, 5.4, 4.3, 3.21, 2.31, 1.8, 1.29, 0.78, 0.54, 0.31, 0.07, -0.15, -0.36, -0.58,
    -0.79, -1.0, -1.21, -1.42, -1.67, -1.93, -2.19, -2.45, -2.71, -2.97, -3.14,
  ],
  "SSP1-2.6": [
    9.24, 9.83, 9.99, 9.82, 9.65, 9.48, 9.0, 8.38, 7.75, 7.14, 6.55, 5.97, 5.38, 4.84, 4.3, 3.76, 3.25, 2.75, 2.26,
    1.71, 1.06, 0.42, -0.23, -0.68, -1.12, -1.57, -1.69, -1.64, -1.59, -1.56,
  ],
  "SSP2-4.5": [
    9.24, 9.91, 10.2, 10.46, 10.72, 10.98, 11.15, 11.28, 11.4, 11.5, 11.57, 11.64, 11.72, 11.62, 11.52, 11.42, 11.15,
    10.8, 10.45, 10.02, 9.43, 8.84, 8.25, 7.46, 6.68, 5.89, 5.29, 4.79, 4.29, 3.95,
  ],
  "SSP3-7.0": [
    9.24, 10.3, 11.16, 11.85, 12.54, 13.22, 13.78, 14.27, 14.76, 15.22, 15.6, 15.98, 16.37, 16.65, 16.93, 17.2, 17.49,
    17.78, 18.08, 18.37, 18.66, 18.95, 19.24, 19.63, 20.01, 20.39, 20.78, 21.18, 21.57, 21.84,
  ],
  "SSP3-7.0-LowNTCF": [
    9.24, 10.3, 11.17, 11.87, 12.57, 13.27, 13.86, 14.38, 14.91, 15.39, 15.79, 16.2, 16.6, 16.94, 17.28, 17.62, 17.97,
    18.32, 18.68, 19.03, 19.39, 19.75, 20.11, 20.47, 20.84, 21.21, 21.6, 22.0, 22.4, 22.67,
  ],
  "SSP4-3.4": [
    9.24, 9.94, 10.27, 10.09, 9.91, 9.73, 9.31, 8.77, 8.22, 7.63, 6.94, 6.26, 5.57, 4.96, 4.36, 3.75, 3.14, 2.54,
    1.93, 1.32, 0.69, 0.05, -0.58, -1.2, -1.81, -2.43, -2.99, -3.54, -4.08, -4.44,
  ],
  "SSP4-6.0": [
    9.24, 9.94, 10.27, 10.81, 11.34, 11.88, 12.19, 12.39, 12.59, 12.72, 12.74, 12.76, 12.78, 12.7, 12.61, 12.53,
    12.39, 12.21, 12.04, 11.77, 11.3, 10.83, 10.37, 9.82, 9.27, 8.72, 8.13, 7.52, 6.91, 6.5,
  ],
  "SSP5-3.4-OS": [
    9.24, 10.17, 10.84, 11.74, 12.64, 13.54, 14.64, 15.83, 17.02, 17.34, 15.88, 14.43, 12.97, 10.05, 7.12, 4.2, 2.13,
    0.48, -1.16, -2.46, -3.07, -3.69, -4.3, -4.53, -4.76, -5.0, -5.13, -5.2, -5.27, -5.32,
  ],
  "SSP5-8.5": [
    9.24, 10.17, 10.84, 11.74, 12.64, 13.54, 14.64, 15.83, 17.02, 18.25, 19.55, 20.86, 22.16, 23.71, 25.26, 26.81,
    28.25, 29.62, 31.0, 32.27, 33.31, 34.35, 35.4, 35.5, 35.61, 35.71, 35.57, 35.3, 35.04, 34.86,
  ],
};

/** Real driver trajectory (years, values) for a scenario's own canonical
 * label, or null if this scenario isn't one of the 9 SSP markers this data
 * covers (e.g. an RCP or DICE's base/optimal -- see module docstring). */
export function scenarioDriverSeries(canonicalLabel: string): { years: number[]; values: number[] } | null {
  const values = SCENARIO_DRIVERS[canonicalLabel];
  if (!values) return null;
  return { years: SCENARIO_DRIVER_YEARS, values };
}
