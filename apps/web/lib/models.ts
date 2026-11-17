/**
 * Model registry for the gateway. Ported 1:1 from apps/gateway/models.py --
 * same models, same native scenario lists, same params_shape/run_command/
 * resources/supports_progress decisions. No cross-model normalization (see
 * PLATFORM.md): each model's entry just points at its own Dockerfile and
 * lists its own native scenario identifiers.
 *
 * `parameters` adds optional, model-native tunable inputs beyond the
 * scenario (e.g. hector's climate sensitivity, oscar's Monte Carlo sample
 * size). This is the full set of keys a request is allowed to pass besides
 * `scenario`/`scenarios` -- lib/runs.ts's submitRun() rejects any other key
 * (400) before doing anything, both to catch typos early and because these
 * values get shell-interpolated into the sandbox command.
 *
 * Caching note (see lib/db.ts's cache_key_for): the cache key is a hash of
 * exactly the params object as submitted (after that validation), with no
 * defaulting applied. A request that omits an optional parameter is NOT
 * treated as equivalent to one that passes its default explicitly -- they
 * get different cache entries. This is deliberate: we haven't verified for
 * every model/parameter that "omitted" and "explicit default" produce
 * identical output (confirmed true for hector's temperature.S/diff/alpha
 * and magicc's core_climatesensitivity by direct testing, but that's not a
 * general guarantee for every future parameter), so the cache doesn't
 * assume it. It also means adding a new parameter later can't silently
 * reinterpret old cache rows -- a request shaped around a wider parameter
 * set just lands in its own, separate cache lane.
 *
 * Path note: this resolves sandboxes/ relative to process.cwd(), NOT
 * __dirname. In a Next.js production build, server code is bundled and
 * __dirname no longer points at the original source location (it resolves
 * to an internal bundle path) -- confirmed by testing. process.cwd() is
 * reliable: it's always the directory `next start`/`next dev` is run from,
 * i.e. apps/web.
 */
import path from "path";

const SANDBOXES_DIR = path.resolve(process.cwd(), "..", "..", "sandboxes");

export type ParamsShape = "scenario" | "scenarios";

export interface NumberParameterSpec {
  key: string;
  label: string;
  type: "number";
  // Shown in the UI as "default: {default}" when a field is left blank --
  // true for every parameter currently defined, where leaving it blank
  // really does behave like passing this value (confirmed per-model: see
  // hector/magicc's comments for the library-default case, and oscar's
  // run.py for the "we apply this ourselves" case). If a future parameter
  // is ever added where that's NOT true -- e.g. a would-be
  // `nonDeterministicUnless` key where omitted and "= default" genuinely
  // differ -- set `placeholderHint` to override the displayed text rather
  // than letting the UI claim an equivalence that isn't real.
  default: number;
  min: number;
  max: number;
  step?: number;
  placeholderHint?: string;
}

export type ParameterSpec = NumberParameterSpec;

export interface ModelMeta {
  family: string;
  // Short, user-facing description and a link to the model's own
  // project/documentation site -- shown as a card when picking a model on
  // the New Run form.
  description: string;
  website: string;
  dockerfile: string;
  scenarios: string[];
  params_shape: ParamsShape;
  // Default is "python3 /app/run.py" (DEFAULT_RUN_COMMAND in lib/runs.ts);
  // only set here for non-Python runtimes (e.g. DICE's Julia image).
  run_command?: string;
  exec_timeout_seconds: number;
  supports_progress: boolean;
  resources?: { cpu?: number; memory?: number; disk?: number };
  // Optional model-native tunable inputs beyond scenario. Empty for models
  // where this hasn't been wired up/verified yet (fair, dice) -- see the
  // module docstring.
  parameters?: ParameterSpec[];
  // If set, this names a parameter key (must appear in `parameters`) whose
  // ABSENCE makes the run non-deterministic -- e.g. oscar's Monte Carlo
  // parameter draw is unseeded `random.choice` (confirmed by reading
  // core_fct/fct_genMC.py) unless a seed is explicitly given. When this key
  // is missing from a request's params, lib/runs.ts skips the cache
  // entirely for that run (no read, no write): caching a single random
  // draw and serving it forever as "the" answer would misrepresent
  // something that's genuinely different every time.
  nonDeterministicUnless?: string;
}

export const MODELS: Record<string, ModelMeta> = {
  hector: {
    family: "RCM",
    // Wording from ../../models.markdown's own model table -- the Jekyll
    // site's real description of this model, not invented here.
    description: "Model with a simplified box structure for atmosphere, ocean, and land components.",
    website: "https://jgcri.github.io/hector/",
    dockerfile: path.join(SANDBOXES_DIR, "hector", "Dockerfile"),
    scenarios: ["ssp119", "ssp126", "ssp245", "ssp370", "ssp585"],
    params_shape: "scenario",
    exec_timeout_seconds: 60,
    // Confirmed by testing: pyhector's run() has no progress hook, writes no
    // log file, and completes in well under a second -- nothing real to
    // report. progress stays null rather than faking an estimate.
    supports_progress: false,
    // Confirmed by a controlled 2x2 experiment (5 trials per cell, real
    // Daytona sandboxes, timing only the exec call): CPU count alone
    // explains hector's run time -- 1cpu/1gb and 1cpu/4gb both median
    // ~2.0-2.1s, 4cpu/1gb and 4cpu/4gb both median ~1.06-1.07s. Memory
    // made no measurable difference in either row; CPU alone roughly
    // halved it in both columns, so only cpu is bumped here, memory is
    // left at the default rather than copying oscar's {cpu:4, memory:8}
    // pattern without evidence memory does anything for this model.
    //
    // cpu:2, not cpu:4 -- a follow-up 1/2/4 cpu sweep (5 trials each)
    // found the 1->2 step carries nearly all of the real gain (2.24s ->
    // 1.25s median, ~44% faster) while 2->4 is a much smaller further
    // step (1.25s -> 1.11s, ~11% faster). Since cost scales with cpu
    // count, cpu:2 is the better cost/latency tradeoff -- doubling the
    // cost again for 4 only buys a fraction of what the first doubling
    // bought.
    resources: { cpu: 2 },
    // Confirmed by testing (comparing pyhector.run() with no override
    // against the same values passed explicitly via `config`): these are
    // real, independent knobs pyhector exposes, and overriding them with
    // their own default values reproduces bit-identical output to not
    // overriding them at all. Defaults/ranges are pyhector's own
    // (`pyhector._default_config["temperature"]`/`["simpleNbox"]`).
    parameters: [
      {
        key: "climate_sensitivity",
        label: "Climate sensitivity (°C per CO2 doubling)",
        type: "number",
        default: 3.0,
        min: 1.5,
        max: 6.0,
        step: 0.1,
      },
      {
        key: "ocean_diffusivity",
        label: "Ocean heat diffusivity",
        type: "number",
        default: 2.38,
        min: 0.5,
        max: 5.0,
        step: 0.01,
      },
      {
        key: "aerosol_scaling",
        label: "Aerosol forcing scaling",
        type: "number",
        default: 1.0,
        min: 0.0,
        max: 2.0,
        step: 0.05,
      },
      {
        key: "co2_fertilization",
        label: "CO2 fertilization strength",
        type: "number",
        default: 0.53,
        min: 0.0,
        max: 1.0,
        step: 0.01,
      },
      {
        key: "respiration_q10",
        label: "Soil respiration temperature sensitivity (Q10)",
        type: "number",
        default: 1.76,
        min: 1.0,
        max: 4.0,
        step: 0.1,
      },
    ],
  },
  fair: {
    family: "RCM",
    // Wording from ../../models.markdown's own model table.
    description: "Regionally differentiated model with detailed process-based representation of carbon cycles and greenhouse gas interactions.",
    website: "https://docs.fairmodel.net/",
    dockerfile: path.join(SANDBOXES_DIR, "fair", "Dockerfile"),
    scenarios: [
      "ssp119",
      "ssp126",
      "ssp245",
      "ssp370",
      "ssp434",
      "ssp460",
      "ssp534-over",
      "ssp585",
    ],
    params_shape: "scenarios",
    exec_timeout_seconds: 180,
    // run.py monkey-patches FAIR's own tqdm bar to write /tmp/progress.json
    // as it runs -- a real intermediate signal, read via the sandbox fs API.
    supports_progress: true,
    // Confirmed by a 1/2/4 cpu sweep (5 trials each, real sandboxes, see
    // docs/sandbox-resource-experiments.md): 1cpu ~19.2s median, 2cpu
    // ~14.6s median (-24%), 4cpu ~12.8s median (-10% further). Same
    // diminishing-returns shape as hector/dice/magicc -- cpu:2 captures
    // most of the real gain without doubling cost again for a much
    // smaller further step.
    resources: { cpu: 2 },
    // Confirmed by reading the installed fair library's source
    // (energy_balance_model.py): each config's stochastic internal
    // variability noise is seeded (`random_state=self.seed`), and run.py
    // (see its own comment) sets `climate_configs["stochastic_run"]=True`
    // for every one of the 66 CMIP6 configs, with a per-config seed derived
    // from this base value. A different seed changes which noise
    // realization each config's run contributes while leaving the
    // ensemble's set of deterministic configs unchanged -- a real,
    // verified knob, not a no-op. ("How many configs to run" is still not
    // exposed -- that's a separate, bigger change to run.py's hardcoded
    // 66-config ensemble, not yet made/tested.)
    parameters: [
      {
        key: "seed",
        label: "Random seed (for reproducibility)",
        type: "number",
        default: 1355763,
        min: 0,
        max: 2 ** 31 - 1,
        step: 1,
      },
    ],
  },
  oscar: {
    family: "RCM",
    // Wording from ../../models.markdown's own model table.
    description: "Hemispherically resolved model with parameterizations for carbon cycling, atmospheric chemistry, and radiative forcing.",
    website: "https://github.com/tgasser/OSCAR",
    dockerfile: path.join(SANDBOXES_DIR, "oscar", "Dockerfile"),
    scenarios: [
      "SSP1-1.9",
      "SSP1-2.6",
      "SSP2-4.5",
      "SSP3-7.0",
      "SSP3-7.0-LowNTCF",
      "SSP4-3.4",
      "SSP4-6.0",
      "SSP5-3.4-OS",
      "SSP5-8.5",
    ],
    params_shape: "scenario",
    // Measured end-to-end against a real Daytona sandbox: ~430-510s total at
    // nMC=1, the smallest possible sample. Generous buffer above that.
    exec_timeout_seconds: 700,
    supports_progress: true,
    // Confirmed by testing: OSCAR gets OOM-killed (exit code 137) while
    // loading its parameter files on the default sandbox size.
    resources: { cpu: 4, memory: 8, disk: 10 },
    parameters: [
      {
        key: "nMC",
        label: "Monte Carlo samples",
        type: "number",
        default: 1,
        min: 1,
        max: 50,
        step: 1,
      },
      {
        key: "seed",
        label: "Random seed (for reproducibility)",
        type: "number",
        // Unlike most models' parameters, this one isn't really about
        // tuning a physical knob -- it's about which of OSCAR's Monte
        // Carlo parameter draws gets used. run.py always applies a seed
        // (DEFAULT_SEED when this is omitted), so leaving it blank really
        // does behave identically to passing 0 explicitly -- confirmed by
        // construction: run.py uses `params.get("seed", DEFAULT_SEED)`,
        // the exact same fallback either way. No placeholderHint override
        // needed here (contrast with the comment that used to be here, from
        // before oscar always seeded by default).
        default: 0,
        min: 0,
        max: 2 ** 31 - 1,
        step: 1,
      },
    ],
    // Previously had `nonDeterministicUnless: "seed"` here: OSCAR's Monte
    // Carlo parameter draw (core_fct/fct_genMC.py's `random.choice`) isn't
    // seeded by OSCAR itself, so without run.py taking care of it, two
    // requests with identical scenario/nMC could legitimately produce
    // different results. Fixed at the run.py level instead (see
    // DEFAULT_SEED there) -- oscar always seeds now, explicit seed or a
    // fixed default, so it's reproducible/cacheable by default like every
    // other model, rather than needing a gateway-level opt-in.
  },
  dice: {
    family: "IAM",
    // Wording from ../../models.markdown's own model table (fixing that
    // table's own typo, "human-indunced" -> "human-induced").
    description: "Prize-winning economic model used to estimate the costs of human-induced climate change on the global economy.",
    website: "https://williamnordhaus.com/dicerice-models",
    dockerfile: path.join(SANDBOXES_DIR, "dice", "Dockerfile"),
    // Only base/optimal -- confirmed by testing that DICE.jl only implements
    // these two for the v2016R2 version run.jl uses.
    scenarios: ["base", "optimal"],
    params_shape: "scenario",
    run_command: "julia /app/run.jl",
    exec_timeout_seconds: 120,
    supports_progress: false,
    // Confirmed by a 1/2/4 cpu sweep (5 trials each, real sandboxes, see
    // docs/sandbox-resource-experiments.md): 1cpu ~36.3s median, 2cpu
    // ~19.6s median (-46%), 4cpu ~20.7s median (flat/slightly worse,
    // noise) -- same shape as hector, the 1->2 step carries the real gain.
    resources: { cpu: 2 },
    // No extra parameters: DICE.jl's solve(scenario, version) doesn't
    // expose a hook for overriding other economic parameters (discount
    // rate, damage function, etc.) through this wrapper -- see run.jl.
  },
  magicc: {
    family: "RCM",
    // Wording from ../../models.markdown's own model table.
    description: "Emissions-based model using impulse response functions to directly connect greenhouse gas emissions to temperature outcomes.",
    website: "https://magicc.org/",
    dockerfile: path.join(SANDBOXES_DIR, "magicc", "Dockerfile"),
    // pymagicc's own four RCP scenarios -- confirmed via
    // `pymagicc.rcps["scenario"].unique()`. A different, smaller taxonomy
    // than the SSP names hector/fair/oscar use; no cross-model mapping
    // (see PLATFORM.md).
    scenarios: ["RCP26", "RCP45", "RCP60", "RCP85"],
    params_shape: "scenario",
    // Measured directly (pymagicc.run() invoking the bundled MAGICC6.exe
    // via Wine, confirmed on a real Debian 12 host): ~5-6s per scenario,
    // including Python/pymagicc import time. Generous buffer above that.
    exec_timeout_seconds: 90,
    // Confirmed by reading pymagicc's source: MAGICC6 (run via Wine) writes
    // its own progress to stdout/output files only after the full run
    // finishes, same limitation already confirmed for hector/dice -- no
    // real mid-run signal to report via the file-polling mechanism used
    // for fair/oscar.
    supports_progress: false,
    // Confirmed by a 1/2/4 cpu sweep (5 trials each, real sandboxes, see
    // docs/sandbox-resource-experiments.md): 1cpu ~12.5s median, 2cpu
    // ~9.5s median (-24%), 4cpu ~9.1s median (flat, noise-level further
    // change) -- same diminishing-returns shape as the other models.
    resources: { cpu: 2 },
    // Confirmed by testing: `pymagicc.run(scenario, core_climatesensitivity=X)`
    // really changes the result (2100 warming under RCP26 moved from
    // 1.56degC at the default 3.0 to 2.26degC at 4.5), and passing the
    // documented default value explicitly reproduces the no-override run
    // bit-for-bit.
    parameters: [
      {
        key: "climate_sensitivity",
        label: "Climate sensitivity (°C per CO2 doubling)",
        type: "number",
        default: 3.0,
        min: 1.5,
        max: 6.0,
        step: 0.1,
      },
    ],
  },
  twolayer: {
    family: "RCM",
    // Wording from ../../models.markdown's own model table.
    description:
      "Bare two-layer energy-balance physics engine; driven by a published radiative forcing dataset rather than its own emissions scenarios.",
    website: "https://github.com/openscm/openscm-twolayermodel",
    dockerfile: path.join(SANDBOXES_DIR, "twolayer", "Dockerfile"),
    // Same 8 SSPs sandboxes/fair exposes -- confirmed present as rows in
    // the bundled rcmip-erf.csv (RCMIP v4.0.0, trimmed). Unlike hector/
    // fair/oscar, this model has no scenario handling of its own: it's
    // driven directly by an Effective Radiative Forcing (ERF) series, so
    // "scenario" here means "which bundled ERF series to load", not a
    // native model concept the way ssp126 is to pyhector.
    scenarios: ["ssp119", "ssp126", "ssp245", "ssp370", "ssp434", "ssp460", "ssp534-over", "ssp585"],
    params_shape: "scenario",
    // Measured directly (bare Debian 12 host): loading the bundled CSV +
    // running TwoLayerModel completes in well under a second per scenario,
    // including import time. Generous buffer above that.
    exec_timeout_seconds: 60,
    // No progress hook exposed by openscm-twolayermodel -- same situation
    // already confirmed for hector/dice/magicc.
    supports_progress: false,
    // Confirmed by testing (comparing TwoLayerModel() with no override
    // against `lambda0` passed explicitly at its own documented default,
    // 3.74/3 W/m^2/degC): bit-identical output. Overriding it with a lower
    // value (0.8) produced a real, large difference (ssp245's 2500 value
    // moved from ~3.48 to ~5.10 degC) -- a real knob, not a no-op.
    parameters: [
      {
        key: "climate_feedback_parameter",
        label: "Climate feedback parameter (W/m² per °C)",
        type: "number",
        default: 1.2467,
        min: 0.5,
        max: 3.0,
        step: 0.01,
      },
    ],
  },
};

export function getModelOrNull(model: string): ModelMeta | null {
  return MODELS[model] ?? null;
}
