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
 *   - advanceRun() is what GET /v1/runs/{run_id} calls on every poll. Each
 *     call does ONE check: read the sandbox's progress file (if the model
 *     supports it) and the session command's exit status, persist whatever
 *     changed, and -- if the command just finished -- parse the result,
 *     write it to the cache, delete the sandbox, and mark the run terminal.
 *     The client's existing ~150ms polling loop is what drives the job
 *     forward, one short stateless call at a time; there is no background
 *     loop or long-lived process doing this on its own.
 *
 *   - Double-finalization is guarded by claimRunForFinalize()'s atomic
 *     UPDATE ... WHERE status = 'running' (see lib/db.ts) -- if two GETs
 *     both see the command just finished, only one of them wins the claim
 *     and proceeds to parse/cache/delete; the other just re-reads the row.
 */
import { Image, Resources, CreateSandboxFromImageParams } from "@daytona/sdk";
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
  RunRow,
} from "./db";

const DEFAULT_RUN_COMMAND = "python3 -u /app/run.py";
const PROGRESS_FILE_PATH = "/tmp/progress.json";
// Backstop auto-delete, in minutes -- same reasoning as the Python version's
// SANDBOX_AUTO_DELETE_MINUTES: a sandbox we fail to explicitly delete (e.g.
// the process crashes mid-run) still gets cleaned up on its own.
const SANDBOX_AUTO_DELETE_MINUTES = 15;

export interface SubmitResult {
  run_id: string;
  error: string | null;
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
    return { error: `unknown model '${modelName}'`, cacheable: false, cached: false, cached_duration_seconds: null };
  }

  const validationError = validateParams(model, params);
  if (validationError) {
    return { error: validationError, cacheable: false, cached: false, cached_duration_seconds: null };
  }

  if (!isCacheable(model, params)) {
    return { error: null, cacheable: false, cached: false, cached_duration_seconds: null };
  }

  const meta = await getCachedMeta(modelName, params);
  return { error: null, cacheable: true, cached: meta.exists, cached_duration_seconds: meta.duration_seconds };
}

export async function submitRun(
  modelName: string,
  params: Record<string, unknown>,
  forceRefresh: boolean,
): Promise<SubmitResult> {
  const model = getModelOrNull(modelName);
  if (!model) {
    return { run_id: "", error: `unknown model '${modelName}'` };
  }

  const validationError = validateParams(model, params);
  if (validationError) {
    return { run_id: "", error: validationError };
  }

  const runId = randomUUID();
  const cacheable = isCacheable(model, params);

  if (!forceRefresh && cacheable) {
    const cached = await getCached(modelName, params);
    if (cached !== null) {
      await insertRun({
        run_id: runId,
        model: modelName,
        params,
        status: "queued",
        sandbox_id: null,
        session_id: null,
        cmd_id: null,
        supports_progress: false,
        deadline_at: new Date(Date.now() + 1000),
      });
      await finishRunSucceeded(runId, cached, 0, true);
      return { run_id: runId, error: null };
    }
  }

  const daytona = getDaytonaClient();

  const image = Image.fromDockerfile(model.dockerfile);
  const createParams: CreateSandboxFromImageParams = {
    image,
    name: `${modelName}-run-${runId.slice(0, 8)}`,
    autoDeleteInterval: SANDBOX_AUTO_DELETE_MINUTES,
  };
  if (model.resources) {
    createParams.resources = model.resources as Resources;
  }

  const sandbox = await daytona.create(createParams, { timeout: 600 });

  const sessionId = `run-${runId.slice(0, 8)}`;
  await sandbox.process.createSession(sessionId);

  const runCommand = model.run_command || DEFAULT_RUN_COMMAND;
  // No `env` param on session commands -- pass it inline as a shell prefix,
  // same approach as the Python gateway. Safe here: params are
  // gateway-controlled JSON (scenario names/lists), not arbitrary user shell
  // input.
  const command = `SCENARIO_PARAMS='${JSON.stringify(params)}' ${runCommand}`;
  const resp = await sandbox.process.executeSessionCommand(sessionId, { command, runAsync: true });

  await insertRun({
    run_id: runId,
    model: modelName,
    params,
    status: "running",
    sandbox_id: sandbox.id,
    session_id: sessionId,
    cmd_id: resp.cmdId,
    supports_progress: !!model.supports_progress,
    deadline_at: new Date(Date.now() + model.exec_timeout_seconds * 1000),
  });

  return { run_id: runId, error: null };
}

export interface RunView {
  run_id: string;
  model: string;
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
}

function toView(row: RunRow): RunView {
  return {
    run_id: row.run_id,
    model: row.model,
    params: row.params,
    // "finalizing" is an internal-only state (see claimRunForFinalize) --
    // surfaced to API consumers as "running" so it isn't a fifth status
    // value they need to handle.
    status: row.status === "finalizing" ? "running" : row.status,
    result: row.result,
    error: row.error,
    cached: row.cached,
    progress: row.progress,
    duration_seconds: row.duration_seconds,
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
    // polling forever against something that no longer exists.
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
  // module's docstring and lib/db.ts's claimRunForFinalize.
  const claimed = await claimRunForFinalize(runId);
  if (!claimed) {
    // Another concurrent poll already won the claim (or already finished).
    row = (await getRun(runId))!;
    return toView(row);
  }

  const exitCode = cmdInfo.exitCode;
  const logs = await sandbox.process.getSessionCommandLogs(row.session_id, row.cmd_id);
  const stdout = logs.stdout || logs.output || "";
  const jsonLine = lastJsonLine(stdout);
  const runSeconds = elapsedSeconds(startedAt);

  await cleanupSandboxAndSession(daytona, sandbox, row.session_id);

  if (exitCode !== 0 || jsonLine === null) {
    await finishRunFailed(
      runId,
      { code: "model_run_failed", message: `exit_code=${exitCode}`, stdout_tail: stdout.slice(-2000) },
      runSeconds,
    );
    row = (await getRun(runId))!;
    return toView(row);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonLine);
  } catch {
    // Keep the actual output around (stdout_tail) -- without it, a parse
    // failure here was previously undiagnosable after the fact, since the
    // sandbox is already deleted above by the time this runs (confirmed by
    // hitting exactly this gap debugging a real oscar run.py failure).
    await finishRunFailed(
      runId,
      { code: "model_run_failed", message: "could not parse model output", stdout_tail: stdout.slice(-2000) },
      runSeconds,
    );
    row = (await getRun(runId))!;
    return toView(row);
  }

  if (parsed.status !== "succeeded") {
    await finishRunFailed(
      runId,
      { code: "model_run_failed", message: parsed.error || "unknown error" },
      runSeconds,
    );
    row = (await getRun(runId))!;
    return toView(row);
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
  await finishRunSucceeded(runId, parsed, runSeconds, false);
  row = (await getRun(runId))!;
  return toView(row);
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
