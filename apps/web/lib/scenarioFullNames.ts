/**
 * Each SSP family's real narrative name from the actual SSP literature
 * (O'Neill et al. 2017, "The roads ahead: Narratives for shared
 * socioeconomic pathways..."), not invented for this app -- these are the
 * names IPCC AR6 and the underlying SSP database themselves use. Keyed by
 * the leading "SSPn" in a canonical label (see lib/clientApi.ts's
 * canonicalScenario) -- the ".../-1.9" etc. suffix is the forcing target,
 * not part of the narrative name.
 *
 * RCPs/DICE's base/optimal aren't SSPs at all (see
 * lib/assumptions.ts's scenarioAssumptions) so they're not in this map --
 * scenarioFullName() returns the label itself for anything unrecognized,
 * same "no data, no fabricated expansion" convention as
 * lib/scenarioDrivers.ts.
 */
const SSP_NARRATIVE_NAMES: Record<string, string> = {
  SSP1: "Sustainability -- Taking the Green Road",
  SSP2: "Middle of the Road",
  SSP3: "Regional Rivalry -- A Rocky Road",
  SSP4: "Inequality -- A Road Divided",
  SSP5: "Fossil-Fueled Development -- Taking the Highway",
};

export function scenarioFullName(canonicalLabel: string): string {
  const family = canonicalLabel.match(/^SSP\d/)?.[0];
  return (family && SSP_NARRATIVE_NAMES[family]) || canonicalLabel;
}
