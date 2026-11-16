/**
 * Model registry for the gateway. Ported 1:1 from apps/gateway/models.py --
 * same models, same native scenario lists, same params_shape/run_command/
 * resources/supports_progress decisions. No cross-model normalization (see
 * PLATFORM.md): each model's entry just points at its own Dockerfile and
 * lists its own native scenario identifiers.
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

export interface ModelMeta {
  family: string;
  dockerfile: string;
  scenarios: string[];
  params_shape: ParamsShape;
  // Default is "python3 /app/run.py" (DEFAULT_RUN_COMMAND in lib/runs.ts);
  // only set here for non-Python runtimes (e.g. DICE's Julia image).
  run_command?: string;
  exec_timeout_seconds: number;
  supports_progress: boolean;
  resources?: { cpu?: number; memory?: number; disk?: number };
}

export const MODELS: Record<string, ModelMeta> = {
  hector: {
    family: "RCM",
    dockerfile: path.join(SANDBOXES_DIR, "hector", "Dockerfile"),
    scenarios: ["ssp119", "ssp126", "ssp245", "ssp370", "ssp585"],
    params_shape: "scenario",
    exec_timeout_seconds: 60,
    // Confirmed by testing: pyhector's run() has no progress hook, writes no
    // log file, and completes in well under a second -- nothing real to
    // report. progress stays null rather than faking an estimate.
    supports_progress: false,
  },
  fair: {
    family: "RCM",
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
  },
  oscar: {
    family: "RCM",
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
  },
  dice: {
    family: "IAM",
    dockerfile: path.join(SANDBOXES_DIR, "dice", "Dockerfile"),
    // Only base/optimal -- confirmed by testing that DICE.jl only implements
    // these two for the v2016R2 version run.jl uses.
    scenarios: ["base", "optimal"],
    params_shape: "scenario",
    run_command: "julia /app/run.jl",
    exec_timeout_seconds: 120,
    supports_progress: false,
  },
};

export function getModelOrNull(model: string): ModelMeta | null {
  return MODELS[model] ?? null;
}
