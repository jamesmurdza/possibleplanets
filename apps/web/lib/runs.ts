/**
 * Core run-submission + run-advancement logic. This replaces apps/gateway/
 * jobs.py's in-memory job store + background thread-pool worker with a
 * serverless-shaped design (see PLATFORM.md discussion):
 *
 *   - submitRun() does the minimum needed to start work and returns
 *     immediately: cache check, then (on a miss) create the sandbox, start
 *     an async session command, write a `runs` row, and return the run_id.
 *     No request ever blocks waiting for a model to finish -- not even
 *     hector's 3-second run, which the old Python gateway ran via a plain
 *     blocking exec() inside the request.
 *
 *   - The command submitted isn't just the model's own run command --
 *     buildWrappedCommand() wraps it so that, once it exits (successfully,
 *     with a model error, or killed), the sandbox itself POSTs the result
 *     straight back to this app (see WEBHOOK_BASE_URL/completeRunFromWebhook
 *     below) using an interpreter already present in that image (no
 *     Dockerfile/image changes needed for this). That's the PRIMARY way a
 *     run gets finalized now -- it doesn't depend on anyone ever polling.
 *
 *   - advanceRun() is the FALLBACK: what GET /v1/runs/{run_id} calls on
 *     every poll. Each call does ONE check: read the sandbox's progress
 *     file (if the model supports it) and the session command's exit
 *     status, persist whatever changed, and -- if the command just
 *     finished and the webhook above hasn't already finalized it (e.g. its
 *     POST never reached this app) -- do the same parse/cache/delete
 *     finalization itself. A browser that's actively watching a run still
 *     polls this for live progress either way, which doubles as an early
 *     liveness check (a sandbox that vanishes outright gets caught here,
 *     whenever anyone next looks -- see the "sandbox lookup failed" branch
 *     below) even though it's no longer what's load-bearing for
 *     finalization in the common case.
 *
 *   - Double-finalization (from the webhook and a poll both trying, or two
 *     concurrent polls) is guarded by claimRunForFinalize()'s atomic
 *     UPDATE ... WHERE status = 'running' (see lib/db.ts) -- only one
 *     caller ever wins the claim and proceeds to parse/cache/delete; every
 *     other caller just re-reads the row.
 */
import { randomUUID } from "crypto";

import { getDaytonaClient } from "./daytona";
import { getModelOrNull, ModelMeta } from "./models";
import {
  getCached,
  getCachedMeta,
  putCached,
  insertRun,
  getRun,
  updateRunProgress,
  claimRunForFinalize,
  finishRunSucceeded,
  finishRunFailed,
  deleteRunRow,
  findLatestSucceededRun,
  RunRow,
} from "./db";

const DEFAULT_RUN_COMMAND = "python3 -u /app/run.py";
const PROGRESS_FILE_PATH = "/tmp/progress.json";
// Where the wrapped command (see buildWrappedCommand) redirects the real
// run command's stdout+stderr, so the follow-up webhook step can read it
// back -- separate from PROGRESS_FILE_PATH, which is a different file
// run.py itself writes mid-run for live progress, not the final output.
const RUN_OUTPUT_LOG_PATH = "/tmp/run_output.log";
// Backstop auto-delete, in minutes -- same reasoning as the Python version's
// SANDBOX_AUTO_DELETE_MINUTES: a sandbox we fail to explicitly delete (e.g.
// the process crashes mid-run, or the webhook POST below never reaches
// this app) still gets cleaned up on its own, eventually, after it stops.
const SANDBOX_AUTO_DELETE_MINUTES = 15;

// Small margin on top of the model's own exec_timeout_seconds -- NOT a
// "wait around for a human to come back" buffer (the webhook below makes
// that unnecessary: a finished sandbox reports in and gets deleted
// immediately in the common case, whether or not anyone's watching).
// This exists purely so Daytona's own idle-stop timer doesn't land at
// almost the same moment as our own exec_timeout_seconds deadline check
// (advanceRun's deadlinePassed) -- if those two raced, it'd be ambiguous
// (and produce a worse error: "sandbox lookup failed" instead of "run did
// not finish within the allotted time") which one actually ended the run.
// Keeping this small, rather than padding it generously, is deliberate:
// exec_timeout_seconds is itself already supposed to be the real ceiling
// we're willing to wait for a run (see each model's own comment in
// models.ts for how that number was chosen) -- this margin isn't trying
// to second-guess that number or protect against it being wrong.
const AUTO_STOP_SAFETY_MARGIN_MINUTES = 5;

function autoStopMinutes(execTimeoutSeconds: number): number {
  return Math.ceil(execTimeoutSeconds / 60) + AUTO_STOP_SAFETY_MARGIN_MINUTES;
}

// Bounds for a caller-supplied max_run_time_seconds override (New Run
// form's "Advanced" section) -- not just model.exec_timeout_seconds
// clamped to "whatever you want". Floor keeps a run from being killed
// before it could plausibly ever finish anything; ceiling keeps a typo'd
// huge value from holding a sandbox (and its autoStopInterval) open far
// longer than this project ever actually runs anything for real, even
// GCAM's own ~30 minute runs (model.exec_timeout_seconds, see models.ts).
const MIN_RUN_TIME_SECONDS = 10;
const MAX_RUN_TIME_SECONDS = 6 * 60 * 60;

export function clampRunTimeSeconds(seconds: number): number {
  return Math.min(MAX_RUN_TIME_SECONDS, Math.max(MIN_RUN_TIME_SECONDS, Math.round(seconds)));
}

// Netlify sets this to the site's own deployed origin at build and
// function-runtime (confirmed via Netlify's documented environment
// variables), so the sandbox can reach this exact deployment without a
// hardcoded domain baked in. Falls back to the known production domain
// for local dev, where Netlify's own runtime env isn't present.
const WEBHOOK_BASE_URL = process.env.URL || "https://possibleplanets.org";

function webhookUrl(runId: string): string {
  return `${WEBHOOK_BASE_URL}/v1/internal/runs/${runId}/complete`;
}

/**
 * Wraps the model's own run command so that, once it exits -- for ANY
 * reason: success, a model-reported failure, or getting killed -- the
 * sandbox reports the result straight back to this app via an HTTP POST,
 * instead of (only) waiting for someone to poll GET /v1/runs/{run_id}.
 *
 * Deliberately NOT implemented by editing sandboxes/<model>/run.py (or
 * run.jl): that would mean every model's image needs rebuilding/
 * re-publishing for this. Instead, the report-back step is appended here,
 * in the command string itself (constructed fresh per run, never baked
 * into any image), using an interpreter the image already has:
 *   - python3 for every model but dice -- it's already what's running
 *     run.py, so this needs nothing extra (just Python's own stdlib
 *     urllib.request, no new package).
 *   - Julia's own Downloads stdlib (bundled since Julia 1.6, no `Pkg.add`
 *     needed) + the JSON package sandboxes/dice/Dockerfile already
 *     installs (for run.jl's own use) for dice specifically.
 *
 * `> RUN_OUTPUT_LOG_PATH 2>&1` captures the real run command's combined
 * stdout/stderr (same content advanceRun's poll path reads via
 * getSessionCommandLogs) so the follow-up step can read it back and send
 * it along. `EXIT=$?` captures the real run command's own exit code
 * (deliberately captured before the follow-up step can touch $?), and
 * `exit $EXIT` at the very end makes the WHOLE wrapped command's own exit
 * code equal to that -- not the follow-up POST's exit code -- so
 * advanceRun()'s existing poll-based fallback still sees the true outcome
 * if the webhook call itself fails to reach this app for any reason.
 * Nothing here uses `set -e`/`&&`: the follow-up step must still run even
 * when the real run command exits non-zero.
 */
function buildWrappedCommand(runId: string, runCommand: string, params: Record<string, unknown>): string {
  const url = webhookUrl(runId);
  const isJulia = runCommand.trim().startsWith("julia");

  // No single quotes anywhere in either inline script below -- both are
  // passed as a single-quoted shell argument (python3 -c '...'/julia -e
  // '...'), so a literal single quote in the script would terminate that
  // argument early. Double quotes are used for every string instead,
  // which both Python and Julia accept just as well.
  const reportStep = isJulia
    ? `EXIT=$EXIT WEBHOOK_URL='${url}' julia -e '
using JSON, Downloads
stdout_text = read("${RUN_OUTPUT_LOG_PATH}", String)
body = JSON.json(Dict("exit_code" => parse(Int, ENV["EXIT"]), "stdout" => stdout_text))
try
    Downloads.request(ENV["WEBHOOK_URL"]; method="POST", headers=["Content-Type" => "application/json"], input=IOBuffer(body))
catch
end
'`
    : `EXIT=$EXIT WEBHOOK_URL='${url}' python3 -c '
import json, os, urllib.request
with open("${RUN_OUTPUT_LOG_PATH}") as f:
    stdout = f.read()
body = json.dumps({"exit_code": int(os.environ["EXIT"]), "stdout": stdout}).encode()
req = urllib.request.Request(os.environ["WEBHOOK_URL"], data=body, headers={"Content-Type": "application/json"}, method="POST")
try:
    urllib.request.urlopen(req, timeout=15)
except Exception:
    pass
'`;

  return (
    `SCENARIO_PARAMS='${JSON.stringify(params)}' ${runCommand} > ${RUN_OUTPUT_LOG_PATH} 2>&1\n` +
    `EXIT=$?\n` +
    `${reportStep}\n` +
    `exit $EXIT`
  );
}

export interface SubmitResult {
  run_id: string;
  error: string | null;
  // Present only for a cache hit resolved synchronously, without ever
  // creating a `runs` row -- see submitRun's cache-hit branch. A cache
  // lookup isn't a new generation; persisting one would just be a
  // duplicate pointer at a result that's already durably stored in
  // run_cache; the client can render this directly instead of polling
  // GET /v1/runs/{run_id} for a row that was never written. `run_id` above
  // is still populated (a fresh randomUUID, for display/download-filename
  // purposes only) but is NOT a real, lookup-able run.
  inline?: RunView;
  // True only when this call would have needed to start a real sandbox run
  // (a cache miss) and `isAuthed` was false -- see submitRun's signature.
  // The route layer turns this into a 401, distinct from `error` (a 400,
  // e.g. bad params) since they mean different things to a caller.
  unauthorized?: boolean;
}

/**
 * Structural deep-equality, order-independent on object keys (JSON.parse
 * doesn't guarantee two independently-produced objects enumerate keys in
 * the same order, even when "the same" by value -- a plain
 * `JSON.stringify(a) === JSON.stringify(b)` could false-negative on that).
 * Used only to decide whether a just-finished run's result is genuinely new
 * before writing it to run_cache -- see advanceRun below.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false; // primitives already handled by ===
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bObj, k) && deepEqual(aObj[k], bObj[k]));
}

/**
 * Rejects (rather than silently accepting) any param key the model doesn't
 * declare, and range-checks every known numeric parameter. Deliberately
 * does NOT fill in missing keys with their defaults -- see models.ts's
 * module docstring for why: we haven't verified that's always safe, and it
 * would also mean future parameter additions could retroactively change
 * what an old, differently-shaped cache entry is considered equivalent to.
 */
export function validateParams(model: ModelMeta, params: Record<string, unknown>): string | null {
  const allowedKeys = new Set<string>(model.params_shape === "scenario" ? ["scenario"] : ["scenarios"]);
  for (const p of model.parameters ?? []) allowedKeys.add(p.key);

  for (const key of Object.keys(params)) {
    if (!allowedKeys.has(key)) {
      return `unknown parameter '${key}'. allowed: ${[...allowedKeys].sort().join(", ")}`;
    }
  }

  for (const p of model.parameters ?? []) {
    if (!(p.key in params)) continue; // omitted is fine -- no default is assumed, see above
    const value = params[p.key];
    if (typeof value !== "number" || Number.isNaN(value)) {
      return `parameter '${p.key}' must be a number`;
    }
    if (value < p.min || value > p.max) {
      return `parameter '${p.key}' must be between ${p.min} and ${p.max}`;
    }
  }

  return null;
}

/**
 * False when the model declares `nonDeterministicUnless` (see models.ts)
 * and the request doesn't supply that key. A non-cacheable run is never
 * read from or written to run_cache: caching one arbitrary random draw and
 * serving it forever as "the" answer for that (model, params) would
 * misrepresent something that is genuinely different every time it's run.
 *
 * No model currently sets this -- oscar used to (its Monte Carlo draw was
 * opt-in-seeded), but sandboxes/oscar/run.py now always applies a seed
 * (explicit, or a fixed DEFAULT_SEED when omitted), so it's reproducible/
 * cacheable by default like every other model. Kept as general machinery
 * for any future model that's genuinely unseedable.
 */
export function isCacheable(model: ModelMeta, params: Record<string, unknown>): boolean {
  if (!model.nonDeterministicUnless) return true;
  return params[model.nonDeterministicUnless] !== undefined;
}

export interface CheckResult {
  error: string | null;
  // False only when the model declares `nonDeterministicUnless` and the
  // request is missing that key (see isCacheable) -- a real run would
  // never be read from or written to the cache. True otherwise, whether or
  // not a cached result currently exists.
  cacheable: boolean;
  // True if a cache hit exists RIGHT NOW for these exact params (see
  // models.ts's module docstring: no default-filling, so this is exact).
  cached: boolean;
  // Real measured duration of that cached run, or null if there isn't one,
  // or if there is one but it predates this column existing. Never an
  // estimate -- see lib/db.ts's getCachedMeta.
  cached_duration_seconds: number | null;
  // The real `runs` row id behind this cache hit, for the New Run form's
  // "View cached" button -- a cache hit itself never gets its own row (see
  // submitRun's doc comment), so the UI needs this to know which run_id to
  // open in the Runs tab's drawer. Null whenever `cached` is false, or
  // (rare) if run_cache has an entry but the backing `runs` row aged
  // out/predates per-run tracking entirely -- see findLatestSucceededRun.
  cached_run_id: string | null;
}

/**
 * Answers "if I submitted this right now, would it be instant (cached), or
 * a real run" -- without actually submitting anything. Reuses the exact
 * same validation and cacheability rules submitRun() uses, so this is a
 * genuine preview of what submitRun would do, not a separate guess. The
 * caller (the dashboard, before showing "Run") pairs a `cached: false`
 * result with /v1/stats's historical median duration for a real estimate.
 */
export async function checkRun(modelName: string, params: Record<string, unknown>): Promise<CheckResult> {
  const model = getModelOrNull(modelName);
  if (!model) {
    return {
      error: `unknown model '${modelName}'`,
      cacheable: false,
      cached: false,
      cached_duration_seconds: null,
      cached_run_id: null,
    };
  }

  const validationError = validateParams(model, params);
  if (validationError) {
    return { error: validationError, cacheable: false, cached: false, cached_duration_seconds: null, cached_run_id: null };
  }

  if (!isCacheable(model, params)) {
    return { error: null, cacheable: false, cached: false, cached_duration_seconds: null, cached_run_id: null };
  }

  const meta = await getCachedMeta(modelName, params);
  const cachedRunId = meta.exists ? await findLatestSucceededRun(modelName, params) : null;
  return {
    error: null,
    cacheable: true,
    cached: meta.exists,
    cached_duration_seconds: meta.duration_seconds,
    cached_run_id: cachedRunId,
  };
}

export async function submitRun(
  modelName: string,
  params: Record<string, unknown>,
  forceRefresh: boolean,
  // Whether the caller presented valid auth (lib/apiKey.ts's checkApiAuth)
  // -- only consulted below on a cache MISS. A cache hit never touches
  // this: nothing is being authorized when the answer was already sitting
  // in run_cache from an earlier real run, so an unauthenticated caller
  // can still get cached results, just not trigger a new sandbox run.
  isAuthed: boolean,
  // Advanced override for how long this one run is allowed to take,
  // before advanceRun's own deadline check (and the sandbox's matching
  // autoStopInterval) kill it -- see models.ts's exec_timeout_seconds for
  // why that default exists per model. Clamped via clampRunTimeSeconds
  // before use; undefined means "just use the model's own default".
  maxRunTimeSeconds?: number,
): Promise<SubmitResult> {
  const model = getModelOrNull(modelName);
  if (!model) {
    return { run_id: "", error: `unknown model '${modelName}'` };
  }
  const execTimeoutSeconds =
    typeof maxRunTimeSeconds === "number" && Number.isFinite(maxRunTimeSeconds)
      ? clampRunTimeSeconds(maxRunTimeSeconds)
      : model.exec_timeout_seconds;

  const validationError = validateParams(model, params);
  if (validationError) {
    return { run_id: "", error: validationError };
  }

  const runId = randomUUID();
  const cacheable = isCacheable(model, params);

  if (!forceRefresh && cacheable) {
    const cached = await getCached(modelName, params);
    if (cached !== null) {
      // A cache hit isn't a new generation -- nothing here actually ran,
      // the answer was already sitting in run_cache from some earlier
      // real run. Previously this still wrote a `runs` row (queued, then
      // immediately finalized) purely so GET /v1/runs/{run_id} had
      // something to return -- which meant every repeat "Run" click on an
      // already-cached (model, params) kept appending a new row to the
      // `runs` table/history (Overview tab, etc.) that pointed at data
      // that was already durably stored, once per click, forever. Return
      // the finished result inline instead -- the client renders it
      // directly (see NewRunPanel.tsx) without ever polling a run_id that
      // was never written anywhere.
      return {
        run_id: runId,
        error: null,
        inline: {
          run_id: runId,
          model: modelName,
          model_version: model.model_version,
          model_version_number: model.model_version_number,
          params,
          status: "succeeded",
          result: cached,
          error: null,
          cached: true,
          progress: { percent: 100 },
          duration_seconds: 0,
          // Nothing actually ran just now -- this is an existing
          // run_cache answer, not a fresh process invocation, so there's
          // no new stdout to show. The real run that originally produced
          // this result has its own row (and its own stdout_tail) still
          // sitting in `runs`, findable via findLatestSucceededRun.
          stdout_tail: null,
          // Same reasoning as stdout_tail above -- no new sandbox was
          // created for a cache hit, so there's nothing here to show.
          sandbox_id: null,
          session_id: null,
          cmd_id: null,
          daytona_snapshot: null,
        },
      };
    }
  }

  // Reached only on a cache miss (or forceRefresh) -- this is the point
  // where a real sandbox is about to be created, i.e. the only point
  // where auth actually matters. See this function's `isAuthed` param doc.
  if (!isAuthed) {
    return { run_id: "", error: null, unauthorized: true };
  }

  const daytona = getDaytonaClient();

  // Every model creates from its own pre-built Daytona snapshot now, not
  // by building (or pulling) an image at request time -- see
  // models.ts's daytona_snapshot doc comment for the full why (Next.js's
  // file tracing can't see sandboxes/<model>/Dockerfile at all in a real
  // deployment, and even once that's fixed, a build/pull is far too slow
  // to fit inside a serverless function's own execution timeout). A
  // snapshot already has its own fixed cpu/mem/disk baked in from
  // whenever it was created, so there's no `resources` override here
  // (unlike the old Image.fromDockerfile path this replaced).
  const sandbox = await daytona.create(
    {
      snapshot: model.daytona_snapshot,
      name: `${modelName}-run-${runId.slice(0, 8)}`,
      autoStopInterval: autoStopMinutes(execTimeoutSeconds),
      autoDeleteInterval: SANDBOX_AUTO_DELETE_MINUTES,
    },
    { timeout: 600 },
  );

  const sessionId = `run-${runId.slice(0, 8)}`;
  await sandbox.process.createSession(sessionId);

  const runCommand = model.run_command || DEFAULT_RUN_COMMAND;
  // SCENARIO_PARAMS is passed inline as a shell prefix (no `env` param on
  // session commands) -- safe here: params are gateway-controlled JSON
  // (scenario names/lists), not arbitrary user shell input. See
  // buildWrappedCommand's own docstring for why this is more than just the
  // bare run command now.
  const command = buildWrappedCommand(runId, runCommand, params);
  const resp = await sandbox.process.executeSessionCommand(sessionId, { command, runAsync: true });

  await insertRun({
    run_id: runId,
    model: modelName,
    model_version: model.model_version,
    model_version_number: model.model_version_number,
    params,
    status: "running",
    sandbox_id: sandbox.id,
    session_id: sessionId,
    cmd_id: resp.cmdId,
    supports_progress: !!model.supports_progress,
    deadline_at: new Date(Date.now() + execTimeoutSeconds * 1000),
  });

  return { run_id: runId, error: null };
}

export interface RunView {
  run_id: string;
  model: string;
  // See lib/models.ts's own model_version doc comment and RunRow's --
  // null only for a row written before this column existed.
  model_version: string | null;
  // See lib/models.ts's own model_version_number doc comment -- the
  // official model version (e.g. "3.2", "2016"), distinct from the exact
  // package/commit pin above.
  model_version_number: string | null;
  // Exactly the params object this run was submitted with -- no defaults
  // filled in (see models.ts's module docstring). Surfaced so a caller can
  // see/record precisely what reproduces this result, e.g. for the
  // "recent/cached runs" browsing feature.
  params: unknown;
  status: string;
  result: unknown;
  error: unknown;
  cached: boolean;
  progress: { percent: number } | null;
  duration_seconds: number | null;
  // The model process's raw captured stdout+stderr, tail-capped -- see
  // this app's db.ts stdout_tail column comment. Present for both
  // succeeded and failed runs (falls back to error.stdout_tail for an
  // older failed row written before this column existed), null if
  // there's genuinely nothing captured (e.g. a run that never got far
  // enough to produce any). Meant for debugging a confusing result, not
  // part of the model's own (parsed, structured) `result`.
  stdout_tail: string | null;
  // The Daytona sandbox this run actually executed in -- null for a
  // cache-hit inline result (see submitRun's own inline branch; nothing
  // ran, so there's no sandbox) or a row written before per-run sandbox
  // tracking existed. Still present after the sandbox itself has been
  // torn down (cleanupSandboxAndSession deletes the live Daytona
  // resource once a run finishes, but never clears this column) -- it's
  // kept purely as a historical reference, not a live handle; there's no
  // guarantee `daytona.get(sandbox_id)` would still succeed by the time
  // anyone looks at this.
  sandbox_id: string | null;
  session_id: string | null;
  cmd_id: string | null;
  // Which pre-built Daytona snapshot that sandbox was created from (see
  // models.ts's own daytona_snapshot doc comment) -- looked up from the
  // CURRENT lib/models.ts registry entry for this run's model, so for an
  // older run this may not exactly match what was actually used if that
  // model's snapshot has since been rebuilt/renamed (model_version/
  // model_version_number are the fields actually frozen at submit time
  // for that reason -- see their own comments). Null if the model's been
  // removed from the registry entirely since this run.
  daytona_snapshot: string | null;
}

function toView(row: RunRow): RunView {
  const error = row.error as { code: string; message: string; stdout_tail?: string } | null;
  return {
    run_id: row.run_id,
    model: row.model,
    model_version: row.model_version,
    model_version_number: row.model_version_number,
    params: row.params,
    // "finalizing" is an internal-only state (see claimRunForFinalize) --
    // surfaced to API consumers as "running" so it isn't a fifth status
    // value they need to handle.
    status: row.status === "finalizing" ? "running" : row.status,
    result: row.result,
    sandbox_id: row.sandbox_id,
    session_id: row.session_id,
    cmd_id: row.cmd_id,
    daytona_snapshot: getModelOrNull(row.model)?.daytona_snapshot ?? null,
    error: row.error,
    cached: row.cached,
    progress: row.progress,
    duration_seconds: row.duration_seconds,
    stdout_tail: row.stdout_tail ?? error?.stdout_tail ?? null,
  };
}

export async function advanceRun(runId: string): Promise<RunView | null> {
  let row = await getRun(runId);
  if (!row) return null;

  if (row.status === "succeeded" || row.status === "failed") {
    return toView(row);
  }

  // Someone else is mid-finalize for this exact run right now -- nothing for
  // this call to do but report the current (pre-finalize) view.
  if (row.status === "finalizing") {
    return toView(row);
  }

  if (!row.sandbox_id || !row.session_id || !row.cmd_id) {
    // Shouldn't happen (every non-cache-hit row gets these at insert time),
    // but fail closed rather than crash the poll.
    return toView(row);
  }

  const daytona = getDaytonaClient();
  const startedAt = new Date(Date.parse(row.started_at));
  const deadlinePassed = row.deadline_at ? Date.parse(row.deadline_at) < Date.now() : false;

  let sandbox;
  try {
    sandbox = await daytona.get(row.sandbox_id);
  } catch (err) {
    // Sandbox vanished unexpectedly -- surface as a failure rather than
    // polling forever against something that no longer exists. Logged
    // server-side too (see lib/cors.ts's corsGatewayError comment) --
    // this failure otherwise only ever lives in the `runs` row's own
    // `error` column, never anywhere that'd get noticed proactively.
    console.error(`[advanceRun ${runId}] sandbox lookup failed`, err);
    const claimed = await claimRunForFinalize(runId);
    if (claimed) {
      await finishRunFailed(runId, { code: "gateway_error", message: `sandbox lookup failed: ${String(err)}` }, 0);
    }
    row = (await getRun(runId))!;
    return toView(row);
  }

  // Real progress (e.g. fair's own tqdm bar, written by run.py to
  // PROGRESS_FILE_PATH) -- never a synthetic/estimated value. Best-effort:
  // the file may not exist yet, or the read may transiently fail; neither is
  // fatal to the poll.
  if (row.supports_progress) {
    try {
      const raw = await sandbox.fs.downloadFile(PROGRESS_FILE_PATH);
      if (raw && raw.length) {
        const progress = JSON.parse(raw.toString());
        await updateRunProgress(runId, progress);
      }
    } catch {
      // not written yet, or transient -- ignore
    }
  }

  const cmdInfo = await sandbox.process.getSessionCommand(row.session_id, row.cmd_id);

  if (cmdInfo.exitCode === undefined || cmdInfo.exitCode === null) {
    if (deadlinePassed) {
      const claimed = await claimRunForFinalize(runId);
      if (claimed) {
        await cleanupSandboxAndSession(daytona, sandbox, row.session_id);
        await finishRunFailed(
          runId,
          { code: "gateway_error", message: `run did not finish within the allotted time` },
          elapsedSeconds(startedAt),
        );
      }
      row = (await getRun(runId))!;
      return toView(row);
    }
    // Still running -- re-read so the caller sees the progress update we
    // may have just written above.
    row = (await getRun(runId))!;
    return toView(row);
  }

  // Command finished. Atomically claim the right to finalize -- see this
  // module's docstring and lib/db.ts's claimRunForFinalize. (The webhook
  // may have already claimed and finalized this in the time since this
  // poll started -- that's exactly what this claim is for.)
  const claimed = await claimRunForFinalize(runId);
  if (!claimed) {
    // Another concurrent poll (or the webhook) already won the claim.
    row = (await getRun(runId))!;
    return toView(row);
  }

  const exitCode = cmdInfo.exitCode;
  const logs = await sandbox.process.getSessionCommandLogs(row.session_id, row.cmd_id);
  const stdout = logs.stdout || logs.output || "";
  const runSeconds = elapsedSeconds(startedAt);

  await cleanupSandboxAndSession(daytona, sandbox, row.session_id);
  await finalizeOutcome(runId, row, exitCode, stdout, runSeconds);
  row = (await getRun(runId))!;
  return toView(row);
}

/**
 * Called from the webhook route (app/v1/internal/runs/[runId]/complete)
 * when the sandbox itself reports in -- the primary way a run finishes
 * now, not a fallback. Mirrors advanceRun()'s own "command finished"
 * branch, just with `exitCode`/`stdout` handed to it directly in the POST
 * body instead of being fetched from Daytona, and no sandbox object
 * available going in (so cleanup looks it up by sandbox_id, best-effort --
 * if it's already gone, or the lookup itself fails, there's nothing left
 * to clean up anyway).
 */
export async function completeRunFromWebhook(
  runId: string,
  exitCode: number,
  stdout: string,
): Promise<RunView | null> {
  let row = await getRun(runId);
  if (!row) return null;

  if (row.status === "succeeded" || row.status === "failed") {
    return toView(row);
  }

  const claimed = await claimRunForFinalize(runId);
  if (!claimed) {
    // A concurrent poll already won the claim (or already finished) --
    // same race advanceRun() itself already guards against.
    row = (await getRun(runId))!;
    return toView(row);
  }

  const startedAt = new Date(Date.parse(row.started_at));
  const runSeconds = elapsedSeconds(startedAt);

  if (row.sandbox_id) {
    try {
      const daytona = getDaytonaClient();
      const sandbox = await daytona.get(row.sandbox_id);
      await cleanupSandboxAndSession(daytona, sandbox, row.session_id ?? "");
    } catch {
      // Already gone, or the lookup itself failed -- nothing left to clean
      // up either way; this call still needs to finalize the run below.
    }
  }

  await finalizeOutcome(runId, row, exitCode, stdout, runSeconds);
  row = (await getRun(runId))!;
  return toView(row);
}

/**
 * Shared by advanceRun() (poll path) and completeRunFromWebhook() (push
 * path): given a finished command's exit code and captured stdout, parse
 * run.py/run.jl's own JSON result (its last line that looks like one --
 * see lastJsonLine), write it to run_cache, and mark the run terminal.
 * Must be called only AFTER claimRunForFinalize() has already succeeded
 * for this runId -- this function itself does no claiming.
 */
async function finalizeOutcome(runId: string, row: RunRow, exitCode: number, stdout: string, runSeconds: number) {
  const jsonLine = lastJsonLine(stdout);

  if (exitCode !== 0 || jsonLine === null) {
    await finishRunFailed(
      runId,
      { code: "model_run_failed", message: `exit_code=${exitCode}`, stdout_tail: stdout.slice(-2000) },
      runSeconds,
    );
    return;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonLine);
  } catch {
    // Keep the actual output around (stdout_tail) -- without it, a parse
    // failure here was previously undiagnosable after the fact, since the
    // sandbox is already deleted by the caller before this runs (confirmed
    // by hitting exactly this gap debugging a real oscar run.py failure).
    await finishRunFailed(
      runId,
      { code: "model_run_failed", message: "could not parse model output", stdout_tail: stdout.slice(-2000) },
      runSeconds,
    );
    return;
  }

  if (parsed.status !== "succeeded") {
    await finishRunFailed(runId, { code: "model_run_failed", message: parsed.error || "unknown error" }, runSeconds);
    return;
  }

  // Real measured wall-clock time for this specific run (sandbox create +
  // execute), not an estimate -- persisted into run_cache too, same as the
  // Python version, so duration has a durable history across restarts.
  // Skipped entirely for a non-cacheable run (see isCacheable/
  // nonDeterministicUnless in models.ts) -- never write a single random
  // draw into the cache as if it were "the" answer for these params.
  //
  // Also skipped whenever this run's own result is identical to what's
  // already the latest cached row for this (model, params) -- reached via
  // the force-refresh path (submitRun's normal cache check is bypassed by
  // force_refresh, see above), which legitimately re-runs a deterministic
  // model that's already cached (e.g. to verify a run.py fix actually
  // changed the output, or just to re-time it). run_cache is an
  // append-only log by design (see db.ts's module docstring) so refresh
  // CAN add a new row when the output genuinely differs -- but when it
  // doesn't, appending an exact duplicate of the row already there buys
  // nothing and just grows the table forever on repeat no-op refreshes.
  const model = getModelOrNull(row.model);
  if (model && isCacheable(model, row.params as Record<string, unknown>)) {
    const existing = await getCached(row.model, row.params as Record<string, unknown>);
    if (existing === null || !deepEqual(existing, parsed)) {
      await putCached(row.model, row.params, parsed, runSeconds);
    }
  }
  // Same 2000-char tail cap already used for a failure (finishRunFailed's
  // own stdout_tail above) -- enough to debug a confusing-but-"succeeded"
  // result (what did the model actually print/log) without storing a
  // potentially huge log in full.
  await finishRunSucceeded(runId, parsed, runSeconds, false, stdout.slice(-2000));
}

/**
 * Powers the Runs tab's delete button/checkboxes. If the run is still
 * in flight (sandbox potentially still running), best-effort tears that
 * down too -- same cleanup helper the normal finalize path uses -- so
 * deleting a run someone's bored of doesn't leave a billable sandbox
 * running forever. Always deletes the `runs` row regardless of whether
 * that cleanup succeeds (e.g. the sandbox already vanished on its own);
 * there's nothing else worth keeping once the row itself is gone.
 */
export async function deleteRunAndCleanup(runId: string): Promise<void> {
  const row = await getRun(runId);
  if (!row) return;

  const stillLive = row.status !== "succeeded" && row.status !== "failed";
  if (stillLive && row.sandbox_id) {
    try {
      const daytona = getDaytonaClient();
      const sandbox = await daytona.get(row.sandbox_id);
      await cleanupSandboxAndSession(daytona, sandbox, row.session_id ?? "");
    } catch {
      // Already gone, or the lookup itself failed -- nothing left to clean
      // up either way; the row still needs to go.
    }
  }

  await deleteRunRow(runId);
}

async function cleanupSandboxAndSession(daytona: ReturnType<typeof getDaytonaClient>, sandbox: any, sessionId: string) {
  try {
    await sandbox.process.deleteSession(sessionId);
  } catch {
    // best-effort
  }
  try {
    await daytona.delete(sandbox);
  } catch {
    // best-effort
  }
}

function elapsedSeconds(startedAt: Date): number {
  return Math.round(((Date.now() - startedAt.getTime()) / 1000) * 1000) / 1000;
}

/**
 * run.py prints its JSON result as the last line of stdout, but some models
 * (e.g. FAIR, which prints a progress bar and pooch download messages)
 * write other things to stdout first. Scan from the end for the last line
 * that looks like a JSON object -- same approach as the Python gateway.
 */
function lastJsonLine(stdout: string): string | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{")) return line;
  }
  return null;
}
