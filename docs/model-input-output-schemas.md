# Model Input/Output Schemas

This document describes the actual input parameters and output data shapes for each of the 7 models in Possible Planets, based on real completed runs pulled from the production database (`runs` table, most recent `status='succeeded'` run per model).

Models are listed simplest to most complex.

---

## Two Layer Model

**Inputs (easily changeable):**
- `scenario` — one of 8 SSP emissions scenarios (example run used `ssp119`)
- `climate_feedback_parameter` — W/m² per °C, range 0.5–3.0, default 1.2467 (controls how fast the planet releases heat back to space)

**Output shape:** simple JSON with parallel arrays
- `years` — array of years (751 entries, 1750–2500)
- `T_atmos` — atmospheric temperature change in °C (e.g. 0, 0.039, 0.064...)

Only one output variable: global temperature over time.

---

## HECTOR

**Inputs (easily changeable):**
- `scenario` — one of 5 SSP scenarios (example run used `ssp370`)
- `climate_sensitivity` — °C per CO2 doubling, range 1.5–6.0, default 3.0
- `ocean_diffusivity` — range 0.5–5.0, default 2.38
- `aerosol_scaling` — range 0–2.0, default 1.0
- `co2_fertilization` — range 0–1.0, default 0.53
- `respiration_q10` — range 1–4, default 1.76

**Output shape:** wide-format JSON table (`{data, index, columns}`), 556 rows (years, starting 1745)
- `temperature.global_tas` — global average surface temperature (°C)
- `simpleNbox.CO2_concentration` — atmospheric CO2 concentration
- `forcing.RF_tot` — total radiative forcing (W/m²)

Three output variables.

---

## MAGICC

**Inputs (easily changeable):**
- `scenario` — one of 4 RCP scenarios (example run used `RCP60`)
- `climate_sensitivity` — °C per CO2 doubling, range 1.5–6.0, default 3.0

**Output shape:** simple JSON with parallel arrays, 336 entries (years 1765–2100)
- `years`
- `T_atmos` — atmospheric temperature change in °C

Only one output variable.

---

## DICE

**Inputs (easily changeable):**
- `scenario` — only choice is `base` or `optimal` (BasePrice vs. OptimalPrice economic policy path). No other tunable parameters exposed.

**Output shape:** simple JSON with parallel arrays, 100 entries (5-year steps, 2015–2510)
- `years`
- `T_atmos` — atmospheric temperature increase (°C)
- `scc` — social cost of carbon ($/ton CO2, e.g. 30.75, 36.79, 43.62...)
- `forcing` — radiative forcing (W/m²)

Three output variables (plus years).

---

## FaIR

**Inputs (easily changeable):**
- `scenarios` — one or more of 8 SSP scenarios (example run used `["ssp460"]`)
- `seed` — random seed (0 to 2³¹−1, default 1355763) controlling the stochastic spread across the 66-member ensemble

**Output shape:** JSON, not long-format CSV
- `timebounds` — array of years (351 entries, 1750–2100)
- `temperature.<scenario_name>` — nested array: one array of 66 ensemble-member values per timestep

Only temperature is present in the inspected run (no other variables found), but structured as a 66-member ensemble rather than a single value.

---

## OSCAR

**Inputs (easily changeable):**
- `scenario` — one of 9 SSP variants (example run used `SSP1-2.6`)
- `nMC` — number of Monte Carlo samples, range 1–50, default 1
- `seed` — random seed, default 0

**Output shape:** simple JSON with parallel arrays, 87 entries (years 2014–2100)
- `year`
- `mean_D_Tg` — mean global temperature change across MC samples (°C, anomaly from 1750)
- `std_D_Tg` — standard deviation across MC samples (0 if `nMC`=1)

Two output variables (mean + spread of one underlying quantity).

---

## GCAM

**Inputs (easily changeable):**
- `scenario` — Reference or SSP1–SSP5 (example run used `SSP3`)
- `config_overrides` — advanced/optional raw key-value overrides to GCAM's internal config file (e.g. `{"max-parallelism": 2}`); not a curated list of sliders, essentially open-ended

**Output shape:** long-format CSV string (`result.result.csv`), ~94,000 rows, columns: `year, run_name, spinup, component, variable, value, units`

GCAM runs its embedded copy of HECTOR internally, so the output is actually HECTOR's full climate-system output — 120 distinct component/variable pairs, including:

- **Greenhouse gases:** CH4, N2O, O3 concentrations; 26 individual halocarbon (CFC/HFC/HCFC/halon, etc.) concentrations
- **Atmospheric chemistry:** OH radical lifetime (`TAU_OH`)
- **Radiative forcing:** total forcing (`RF_tot`) plus ~38 individual contributors (CO2, CH4, N2O, aerosols, albedo, volcanic, ozone, black carbon, sulfur, ammonia, and one per halocarbon)
- **Ocean:** carbon uptake and carbon content (surface/deep), pH, carbonate (CO3), saturation states (OmegaAr/OmegaCa), sea surface temperature, partial pressure of CO2, Revelle factor — tracked separately for high-latitude (HL), low-latitude (LL), deep (DO), and intermediate (IO) ocean boxes
- **Land carbon cycle:** atmospheric CO2, vegetation/detritus/soil/permafrost carbon stocks, frozen-fraction, net primary production (NPP), net biome production (NBP), heterotrophic respiration (RH, including methane-driven RH)
- **Temperature:** global mean surface temp (`global_tas`, `gmst`), land-only temp, sea surface temp, ocean heat flux (mixed layer and interior)
- **Sea level:** sea level rise with and without ice-melt contribution

Note: in the inspected run, the CSV's internal `run_name` field read `ssp119` rather than matching the requested `SSP3` param — a labeling quirk in the current pipeline worth being aware of, not necessarily a sign the wrong scenario was run.

120 output variables total — by far the richest output of any model in the catalog, because it's really HECTOR's full internal state, not a GCAM-specific output set.
