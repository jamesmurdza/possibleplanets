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
 * Caching note (see lib/db.ts's getCachedRun): a cache hit is looked up
 * by exact JSONB equality against the params object as submitted (after
 * that validation), with no defaulting applied. A request that omits an
 * optional parameter is NOT
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
  // Shown after the input itself (not folded into `label`, which sits
  // beside it) -- e.g. "°C per CO2 doubling" for climate sensitivity. Most
  // parameters don't have one (a plain count, a random seed, etc.).
  unit?: string;
}

export type ParameterSpec = NumberParameterSpec;

export interface ModelMeta {
  family: string;
  // Short, user-facing description and a link to the model's own
  // project/documentation site -- shown as a card when picking a model on
  // the New Run form.
  description: string;
  // One sentence on language/license, from ../../models.markdown's own
  // "Source code" column (the Jekyll site's own wording) -- shown as a
  // second line under `description` on a model's public article page.
  implementation: string;
  website: string;
  // No longer read by any runtime code path (submitRun() creates from
  // daytona_snapshot below exclusively) -- kept purely as a pointer to
  // the source this model's snapshot was built from, for whoever next
  // needs to rebuild that snapshot (model code change, dependency bump,
  // etc.): `daytona.create({ image: Image.fromDockerfile(dockerfile) })`
  // + `sandbox.createSnapshot("<model>-production-v1")`, same as how
  // every current snapshot was made.
  dockerfile: string;
  // Every model sets this now (`<model>-production-v1`) -- lib/runs.ts's
  // submitRun() creates the sandbox FROM THIS DAYTONA SNAPSHOT
  // (daytona.create({ snapshot: ... })) instead of building or pulling
  // anything at request time. `dockerfile` above is kept only as a
  // fallback (used if this is ever unset) and to document/exercise the
  // real build locally -- it is NOT what a real production request uses.
  //
  // This replaced building from `dockerfile` directly for two separate,
  // both-confirmed-by-testing reasons:
  //   1. Next.js's build-time file tracing can't follow the dynamically
  //      constructed path (path.join(SANDBOXES_DIR, modelName,
  //      "Dockerfile")) that Image.fromDockerfile(dockerfile) reads --
  //      confirmed by inspecting a real `next build`'s own
  //      route.js.nft.json: zero sandboxes/ files were traced for any
  //      model before outputFileTracingIncludes (next.config.js) was
  //      added. Without that, Netlify's deployed function never had
  //      sandboxes/ at all, so EVERY model's non-cached run 502'd in
  //      production, not just gcam's -- this went unnoticed locally
  //      because `next dev` reads straight from the full source tree,
  //      with no tracing/bundling step to expose the gap.
  //   2. Even with that fixed, building (or pulling an equivalent
  //      pre-built image from a registry) still measures in seconds to
  //      minutes depending on the model -- gcam's own ~5.6GB image took
  //      120-280s to pull from Docker Hub in direct testing. A
  //      serverless function's own execution timeout (Netlify's
  //      included) is measured in seconds, so anything that slow CAN'T
  //      finish inside a request; the platform kills it first, surfacing
  //      as a bare 502 from the edge itself, before this app's own code
  //      ever gets to run its catch block.
  // Creating from a Daytona snapshot sidesteps both: it needs nothing
  // from this app's own deployed filesystem, and took well under a
  // second in direct testing for every model (gcam: 0.5s single sample;
  // the rest weren't independently re-timed after creation, but use the
  // exact same snapshot mechanism).
  //
  // Snapshots are only usable from THIS Daytona organization, which is
  // exactly why Docker Hub backups (possibleplanets/<model>) stay
  // published for the models that have one -- for someone cloning this
  // repo into their own Daytona account, or running a guide's plain
  // `docker run` command -- just not what this app's own submitRun()
  // uses for a real request anymore.
  daytona_snapshot: string;
  // Exactly what this model's own Dockerfile pins (see the pip/Pkg.add/
  // git-clone line each model's Dockerfile comments reference), so a
  // run can be attributed to the real version that produced it even
  // after that pin changes and the snapshot above gets rebuilt --
  // rebuilding a snapshot never updates history for runs already stored
  // in `runs` under the old version. For a model whose
  // Dockerfile clones a git repo WITHOUT pinning a commit (currently
  // oscar, gcam -- `git clone --depth 1` off the default branch, a real,
  // still-open gap noted in each Dockerfile's own comments), this says
  // so plainly rather than inventing a version number that doesn't
  // exist: the code that actually ran is still fixed (frozen into
  // whichever Daytona snapshot build happened to pull), it's only
  // re-building that snapshot later that could silently change it.
  model_version: string;
  // The official model version itself -- the full version number, every
  // decimal place the model's own upstream actually assigns it (e.g.
  // "3.2.0", "2.2.5", "2016R2"), not truncated to major.minor. Distinct
  // from model_version above, which is the exact package/commit pin that
  // produced a given run (and can differ from this -- e.g. a wrapper
  // library's own patch version isn't necessarily the same number as the
  // underlying model's). Each one below was confirmed directly against
  // the real installed snapshot (not read off a Dockerfile's pin, and
  // not guessed from a wrapper package's own version number without
  // checking) -- see each model's own comment for exactly how.
  model_version_number: string;
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
  // True only for gcam so far -- lets a run's params include a
  // "config_overrides" object, an arbitrary {name: value} map applied
  // directly to configuration_ref.xml's own <Value name="...">...</Value>
  // tags before gcam.exe runs (see sandboxes/gcam/run.py's
  // apply_config_overrides). Not a ParameterSpec entry -- there's no
  // fixed list of "safe" keys to enumerate ahead of time; validateParams
  // (lib/runs.ts) just checks this is a plain object and skips its usual
  // per-key numeric-range check for it. A bad override fails loudly from
  // inside run.py itself (unmatched key, or gcam.exe's own failure) --
  // visible in the drawer the same way any other run failure is, which
  // is the actual safety net here instead of pre-validation.
  supportsConfigOverrides?: boolean;
}

export const MODELS: Record<string, ModelMeta> = {
  hector: {
    family: "RCM",
    // Wording from ../../models.markdown's own model table -- the Jekyll
    // site's real description of this model, not invented here.
    description: "Hector uses a simplified box structure for its atmosphere, ocean, and land components.",
    implementation: "It's implemented in C++, licensed under the GPLv3.",
    website: "https://jgcri.github.io/hector/",
    dockerfile: path.join(SANDBOXES_DIR, "hector", "Dockerfile"),
    // See daytona_snapshot's own doc comment (gcam's entry) -- every
    // model now creates from its own Daytona snapshot rather than
    // building/reading its Dockerfile at request time. Confirmed by
    // direct testing: this app's production deployment never actually
    // had sandboxes/ available to it at all (Next.js's build-time file
    // tracing can't follow a dynamically-constructed fs path), so every
    // non-cached run of every model but gcam was 502ing in production
    // until this. Snapshot built+pushed from this same repo's
    // sandboxes/hector/Dockerfile.
    daytona_snapshot: "hector-production-v1",
    // Verified directly against the real snapshot (`pip show pyhector`,
    // confirmed 2026-11-18) -- matches the Dockerfile's pin exactly.
    model_version: "pyhector==3.2.0.0",
    // Confirmed directly (not just assumed from pyhector's own version
    // number): pyhector exposes the actual Hector core's version
    // separately from its own wrapper version -- `pyhector.__hector_version__`
    // reports "3.2.0" against this exact snapshot (2026-11-19), which
    // happens to track pyhector's own version here but isn't guaranteed
    // to in general (checked anyway rather than assumed).
    model_version_number: "3.2.0",
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
        label: "Climate sensitivity",
        unit: "°C per CO2 doubling",
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
    description:
      "FAIR is a regionally differentiated model, with a detailed, process-based representation of carbon cycles and greenhouse gas interactions.",
    implementation: "It's implemented in Python, licensed under the Apache-2.0 license.",
    website: "https://docs.fairmodel.net/",
    dockerfile: path.join(SANDBOXES_DIR, "fair", "Dockerfile"),
    // See hector's daytona_snapshot comment for why every model uses one.
    daytona_snapshot: "fair-production-v1",
    // Verified directly against the real snapshot (`pip show fair`,
    // confirmed 2026-11-18) -- matches the Dockerfile's pin exactly.
    model_version: "fair==2.2.5",
    // FaIR's own package version IS its model version -- confirmed via
    // `fair.__version__` against this exact snapshot (2026-11-19),
    // matching the Dockerfile's pin exactly.
    model_version_number: "2.2.5",
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
    description:
      "OSCAR is a hemispherically resolved model, with parameterizations for carbon cycling, atmospheric chemistry, and radiative forcing.",
    implementation: "It's implemented in Python, licensed under the CeCILL-2.1 license.",
    website: "https://github.com/tgasser/OSCAR",
    dockerfile: path.join(SANDBOXES_DIR, "oscar", "Dockerfile"),
    // See hector's daytona_snapshot comment for why every model uses one.
    //
    // v2, not v1 -- confirmed by testing (2026-11-19): production oscar
    // runs started failing intermittently with `FileExistsError: [Errno
    // 17] File exists: 'results/SSP_drivers/'`, a genuine TOCTOU race in
    // OSCAR's own upstream run_scripts/get_SSP_drivers.py (reproduced
    // directly: the exact same code/inputs failed on some attempts and
    // succeeded on others). Fixed at the Dockerfile level (patches the
    // installed file to use `os.makedirs(..., exist_ok=True)`, same
    // technique sandboxes/twolayer/Dockerfile already uses for a different
    // installed-package bug) and confirmed by running 4 fresh sandboxes
    // back-to-back with zero failures before switching this over. Also
    // pins the git clone to the exact commit below now, instead of
    // floating to `main`, to avoid pulling in unrelated upstream drift
    // while fixing this one bug.
    daytona_snapshot: "oscar-production-v2",
    // Pinned explicitly in the Dockerfile now (see daytona_snapshot's own
    // comment above) to the exact commit already verified working end to
    // end by spinning up the real snapshot and running `git rev-parse
    // HEAD` in /app/oscar (confirmed 2026-11-18):
    // 2200dfd30a86a2560edfc301493298680cbf85a9, committed 2025-03-22.
    // Re-verify (and re-run the retroactive runs.model_version backfill)
    // if this snapshot is ever rebuilt from a different commit.
    model_version: "jamesmurdza/OSCAR@2200dfd30a86a2560edfc301493298680cbf85a9",
    // Confirmed directly from OSCAR's own README.md Changelog at this
    // exact pinned commit (2026-11-19): the most recent entry listed is
    // "##### v3.3" -- OSCAR's real upstream versioning (distinct from
    // this fork's own unpinned/uncommitted git history), not inferred
    // from the commit date or guessed. "3.3" is already the full version
    // -- unlike v3.1 (which got .1/.2 patch releases, v3.1.1/v3.1.2),
    // OSCAR's own changelog never assigned v3.3 a third digit.
    model_version_number: "3.3",
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
    description:
      "DICE is a prize-winning economic model, used to estimate the costs of human-induced climate change on the global economy.",
    implementation: "It's implemented in GAMS.",
    website: "https://williamnordhaus.com/dicerice-models",
    dockerfile: path.join(SANDBOXES_DIR, "dice", "Dockerfile"),
    // See hector's daytona_snapshot comment for why every model uses one.
    daytona_snapshot: "dice-production-v1",
    // Verified directly against the real snapshot (`julia -e 'using Pkg;
    // Pkg.status()'`, confirmed 2026-11-18): DICE v0.2.1 pinned to
    // possibleplanets/DICE.jl#754e9ba -- matches the Dockerfile's full-sha
    // pin exactly.
    model_version: "possibleplanets/DICE.jl@754e9ba2",
    // DICE is versioned by vintage year + revision, not major.minor --
    // confirmed directly: run.jl itself calls `version = v2016R2()` (see
    // sandboxes/dice/run.jl's own comment, "v2016R2 is the most recent
    // version in DICE.jl, confirmed 1:1 with GAMS"), i.e. the DICE-2016R2
    // revision, not a guess from the package's own "0.2.1" Pkg version
    // (that's DICE.jl-the-Julia-port's own version, unrelated to which
    // Nordhaus DICE vintage/revision it implements).
    model_version_number: "2016R2",
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
    description:
      "MAGICC is an emissions-based model, using impulse response functions to directly connect greenhouse gas emissions to temperature outcomes.",
    implementation: "Its source code is closed-source, not publicly available.",
    website: "https://magicc.org/",
    dockerfile: path.join(SANDBOXES_DIR, "magicc", "Dockerfile"),
    // See hector's daytona_snapshot comment for why every model uses one.
    daytona_snapshot: "magicc-production-v1",
    // Verified directly against the real snapshot (`pip show pymagicc`,
    // confirmed 2026-11-18) -- matches the Dockerfile's pin exactly.
    model_version: "pymagicc==2.1.5",
    // The bundled binary is literally named magicc6.exe, and pymagicc's
    // own run() defaults to (and this project's run.py never overrides)
    // `magicc_version=6`. The full version is baked into the binary
    // itself -- confirmed by scanning magicc6.exe's own strings for its
    // embedded banner (2026-11-19): "MAGICC6.8.01 BETA, 7th July 2012" --
    // not inferred from the wrapper package's "2.1.5" version (that's
    // pymagicc's own version, not MAGICC's).
    model_version_number: "6.8.01",
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
        label: "Climate sensitivity",
        unit: "°C per CO2 doubling",
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
      "The Two Layer Model is a bare two-layer energy-balance physics engine, driven by a published radiative forcing dataset rather than its own emissions scenarios.",
    implementation: "It's implemented in Python, licensed under the BSD-3-Clause license.",
    website: "https://github.com/openscm/openscm-twolayermodel",
    dockerfile: path.join(SANDBOXES_DIR, "twolayer", "Dockerfile"),
    // See hector's daytona_snapshot comment for why every model uses one.
    daytona_snapshot: "twolayer-production-v1",
    // Verified directly against the real snapshot (`pip show
    // openscm-twolayermodel`, confirmed 2026-11-18) -- matches the
    // Dockerfile's pin exactly.
    model_version: "openscm-twolayermodel==0.2.3",
    // openscm-twolayermodel IS the reference implementation (Held et al.
    // 2010 / Geoffroy et al. 2013's equations have no separate official
    // version numbering of their own) -- its own package version is the
    // model version here. Confirmed via `openscm_twolayermodel.__version__`
    // against this exact snapshot (2026-11-19), matching the Dockerfile's
    // pin exactly.
    model_version_number: "0.2.3",
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
        label: "Climate feedback parameter",
        unit: "W/m² per °C",
        type: "number",
        default: 1.2467,
        min: 0.5,
        max: 3.0,
        step: 0.01,
      },
    ],
  },
  gcam: {
    family: "IAM",
    // Wording adapted from ../../models.markdown's own style for other
    // IAM entries (not a direct quote -- gcam isn't in that table yet).
    description:
      "GCAM is a large integrated assessment model coupling energy, agriculture/land-use, water, and climate (via an embedded Hector run) in a multi-region economic equilibrium.",
    implementation: "It's implemented in C++17, licensed under the ECL-2.0 license.",
    website: "https://github.com/JGCRI/gcam-core",
    dockerfile: path.join(SANDBOXES_DIR, "gcam", "Dockerfile"),
    // See hector's daytona_snapshot comment for why every model uses one.
    // gcam's own build additionally could never succeed from
    // `dockerfile` alone even locally-equivalent tracing fixed, since its
    // final stage COPYs sandboxes/gcam/runtime/input/gcamdata/xml/, a
    // 5.2GB generated database that's deliberately gitignored (too large
    // for git -- see sandboxes/gcam/runtime/README.md) and only ever
    // exists on the one machine that originally generated it.
    //
    // v2, not v1 -- confirmed by direct testing (2026-11-18): the
    // long-deployed gcam-production-v1 snapshot was missing python3
    // entirely (despite the Dockerfile's final stage installing it --
    // v1 must predate that line, or an earlier rebuild dropped it), so
    // every real gcam run's `python3 -u /app/run.py` failed instantly
    // with "command not found" inside the sandbox. Worse, the webhook
    // completion call is ALSO a `python3 -c ...` one-liner (see
    // buildWrappedCommand), so that failed too -- the run never
    // self-reported, and with nothing polling it (GET /v1/runs/{id} is
    // the only thing that ever checks a run against Daytona -- see its
    // own comment), it just sat as "running" forever past its deadline.
    // Rebuilt from the exact same Dockerfile as gcam-production-v2 and
    // confirmed python3/gcam.exe both work before switching this over.
    //
    // v3, not v2 -- v2 intermittently got gcam.exe OOM-killed at the
    // final periods (see docs/gcam/oom-fix.md and known-gaps.md): its
    // configuration_ref.xml's max-parallelism=-1 (all 4 cores) made
    // GCAM's solver keep a full per-thread scratch copy of its state,
    // multiplying memory ~4x and hitting the 8GB cgroup ceiling right
    // at the finish line. v3 is v2's own live sandbox with only
    // configuration_ref.xml patched (max-parallelism -> 1) and
    // re-snapshotted -- no gcamdata/gcam.exe rebuild needed (confirmed
    // identical gcam.exe size/hash, same input database). Verified
    // live on this exact snapshot (2026-11-19): full run completes,
    // anon memory stays under ~7.3GB throughout, 0 oom_kills.
    //
    // v4, not v3 -- v3 still ran the OLD /app/run.py, which parsed
    // Hector's outputstream.csv with a buggy csv.DictReader (silently
    // treated Hector's own leading comment line as the header, leaving
    // every row's real "variable" column missing -- see
    // "Stop parsing GCAM's CSV output in Python" commit). That fix had
    // only ever landed in this repo's sandboxes/gcam/run.py, never in a
    // deployed snapshot, so gcam kept returning malformed rows in
    // production even after the OOM fix. v4 is v3's own live sandbox
    // with /app/run.py overwritten by the repo's current version (now
    // returns Hector's raw CSV text untouched, parsed client-side
    // instead -- see lib/clientApi.ts's gcamSeries) and re-snapshotted,
    // again with no gcamdata/gcam.exe rebuild. Verified end to end
    // (2026-11-19): a full run on this exact snapshot, piped through
    // the real advanceRun/finalizeOutcome/finishRunSucceeded logic by
    // hand into this project's own postgres, produced a `runs` row
    // whose result.result.csv parses into 355 real global_tas points --
    // see run_id bc380140-64bd-4f5c-9ded-c2ffb934202d.
    //
    // v5, not v4 -- carries the apply_config_overrides mechanism in
    // run.py (see supportsConfigOverrides below and
    // docs/gcam/config-overrides.md), no gcamdata/gcam.exe rebuild
    // needed as usual. Verified live (2026-11-19) against this exact
    // snapshot: a config_overrides of {"stop-period": 2,
    // "max-parallelism": 2} produced a patched /tmp/configuration_run.xml
    // with both values changed, gcam.exe itself printing "Running
    // period 2" (confirms the override changed real behavior, not just
    // the file text) and exiting 0 after only 3 periods instead of 21;
    // a bad key (config_overrides: {"totally-not-a-real-key": 1}) failed
    // immediately with a clear "no matching <Value> found" error,
    // before gcam.exe ever launched.
    //
    // v6, not v5 -- bumped configuration_ref.xml's baked-in
    // max-parallelism default from 1 to 2. Measured live (2026-11-19,
    // real gcam-production-v5 snapshot) across all three values on the
    // same 8GB sandbox tier: -1 (4 cores) OOM-kills intermittently near
    // period 20 despite being fastest (~20-24min); 1 core never risks
    // the ceiling (anon maxes ~7.3GB) but takes ~50min; 2 cores reached
    // period 20 (the exact point every -1 failure died) with anon
    // 7.25GB / cgroup peak ~7.9GiB of 8GiB, 0 oom_kills, in ~32min --
    // the best balance found so far, so it's now the default rather
    // than something you have to opt into per run. Still overridable
    // per run via config_overrides or the New Run form's "Cores" field
    // for 1 (max safety) or 4 (max speed, more OOM risk). No
    // gcamdata/gcam.exe/run.py changes -- same patch-and-resnapshot
    // process as v3-v5.
    daytona_snapshot: "gcam-production-v6",
    // Dockerfile clones JGCRI/gcam-core@main unpinned, so the Dockerfile
    // text alone doesn't tell you which release that resolved to -- verified
    // directly instead by spinning up the real snapshot and running
    // `./gcam.exe --version` (confirmed 2026-11-18): "GCAM version 9.1
    // Revision: gcam-v9.1". Re-verify (and re-run the retroactive
    // runs.model_version backfill) if this snapshot is ever rebuilt.
    model_version: "JGCRI/gcam-core@gcam-v9.1",
    // Confirmed directly via `./gcam.exe --version` against this exact
    // snapshot (2026-11-19): "GCAM version 9.1 Revision: gcam-v9.1".
    model_version_number: "9.1",
    // Only "Reference" -- see sandboxes/gcam/run.py's module docstring and
    // docs/gcam/known-gaps.md ("Only configuration_ref.xml was actually
    // run-tested"). The other shipped configs reference additional input
    // files not yet confirmed present here and still have GCAM's own
    // BaseX output database enabled (a separate, unsolved JVM-segfault
    // problem configuration_ref.xml's patch works around) -- not exposed
    // until validated the same way Reference was.
    scenarios: ["Reference"],
    params_shape: "scenario",
    // Default run_command (python3 -u /app/run.py) applies -- gcam's own
    // run.py is Python, same as every model except dice's Julia entrypoint.
    // A full 21-period run (1975-2100) is two to three orders of
    // magnitude longer than every other model here, since this is a real
    // multi-region economic equilibrium solve, not a closed-form/ODE
    // integration -- how long exactly now depends on the cores setting
    // above (daytona_snapshot's own comment): ~20-24min at 4 cores,
    // ~32min at 2 (the default), ~50min at 1. 5000s gives a healthy
    // buffer above even the slowest (1-core) case.
    exec_timeout_seconds: 5000,
    // gcam.exe logs a "Period N: YYYY" line at the start of each of its 21
    // periods (observed directly during this project's validation runs --
    // see sandboxes/gcam/run.py), which run.py tees into /tmp/progress.json
    // the same way sandboxes/oscar/run.py does for its own per-year prints.
    supports_progress: true,
    // Resource profile of the gcam-production-v2 Daytona snapshot this
    // runs in (see docs/gcam/artifacts.md) -- informational only: Daytona
    // rejects resource overrides for snapshot-based sandboxes
    // ("Cannot specify Sandbox resources when using a snapshot", confirmed
    // 2026-11-19), so this is fixed at snapshot-creation time, not at
    // create() time. IMPORTANT: 8GB is NOT comfortably sufficient --
    // direct measurement during a full run (2026-11-19, same snapshot)
    // shows gcam.exe's own anon memory growing 5.4GB @47% -> 7.7GB @80%
    // and the cgroup peak landing exactly on the 8GiB ceiling at the
    // final periods. Runs survive only if the kernel can reclaim enough
    // page cache at that peak (observed: one run completed with peak =
    // ceiling + 8KB, oom_kill 0); when it can't, gcam.exe is OOM-killed
    // mid-final-period with no message of its own -- seen twice in
    // production ("Period 20: 2095" as the last output line, no
    // "All model periods solved correctly."). See docs/gcam/known-gaps.md
    // -- a snapshot rebuilt with more memory is the real fix. disk:12
    // because the image bakes in the full 5.2GB generated XML database
    // plus the 294MB binary.
    resources: { cpu: 4, memory: 8, disk: 12 },
    // No curated ParameterSpec sliders exposed yet -- but see
    // supportsConfigOverrides just below for a general escape hatch that
    // doesn't need one of these added per knob.
    //
    // config_overrides lets a request override ANY existing
    // <Value name="...">...</Value> in configuration_ref.xml (any
    // section -- Files, ScenarioComponents, Strings, Bools, Ints,
    // Doubles), applied by sandboxes/gcam/run.py's
    // apply_config_overrides before gcam.exe runs. Deliberately
    // unrestricted rather than an allowlist: see that function's own
    // docstring for why a bad override is meant to fail loudly and
    // visibly (in the drawer, same as any other run failure) rather
    // than be pre-validated here. This needed exactly one snapshot
    // deploy (gcam-production-v5, which carries the apply_config_overrides
    // mechanism in run.py) -- every individual value anyone wants to
    // try from here on is just a request parameter, no further snapshot
    // rebuild needed.
    supportsConfigOverrides: true,
  },
};

export function getModelOrNull(model: string): ModelMeta | null {
  return MODELS[model] ?? null;
}
