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
  getCachedRun,
  insertRun,
  getRun,
  updateRunProgress,
  updateRunDeadline as dbUpdateRunDeadline,
  claimRunForFinalize,
  finishRunSucceeded,
  finishRunFailed,
  deleteRunRow,
  RunRow,
} from "./db";

const DEFAULT_RUN_COMMAND = "python3 -u /app/run.py";
const PROGRESS_FILE_PATH = "/tmp/progress.json";
// Where the wrapped command (see buildWrappedCommand) redirects the real
// run command's stdout+stderr, so the follow-up webhook step can read it
// back -- separate from PROGRESS_FILE_PATH, which is a different file
// run.py itself writes mid-run for live progress, not the final output.
const RUN_OUTPUT_LOG_PATH = "/tmp/run_output.log";
// Written by buildWrappedCommand the INSTANT the real run command exits --
// before the webhook follow-up step even starts, let alone finishes. See
// advanceRun's own comment on why this exists: Daytona's getSessionCommand
// API can apparently fail to ever report an exit code for a command with a
// large enough captured output (confirmed against a real stuck gcam run:
// its process tree had fully exited and /tmp/run_output.log -- 13.7MB --
// had stopped changing 18 minutes earlier, yet getSessionCommand still had
// no exitCode field at all). advanceRun now checks THIS file directly
// instead of depending on that API being reliable for a big-output run.
const RUN_EXIT_CODE_PATH = "/tmp/run_exit_code";
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

// How long a row is allowed to sit in 'finalizing' before advanceRun gives
// up on whoever claimed it and marks it failed outright -- see that
// branch's own comment. A real finalize (parse + cache write + a couple
// DB updates) should complete in well under a second; this is generous
// purely to avoid racing a finalize that's merely slow (a big cache write,
// a slow DB round-trip) rather than genuinely stuck.
const FINALIZING_STUCK_THRESHOLD_MS = 60_000;

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
 * stdout/stderr so the follow-up step can read it back and send it along.
 * `EXIT=$?` captures the real run command's own exit code (deliberately
 * captured before the follow-up step can touch $?), immediately written
 * to RUN_EXIT_CODE_PATH -- see that constant's own comment on why
 * advanceRun reads THAT file rather than trusting Daytona's
 * getSessionCommand API or the webhook's own outbound POST to ever
 * reliably report this for a run with a large captured output. `exit
 * $EXIT` at the very end makes the WHOLE wrapped command's own exit code
 * equal to that too -- not the follow-up POST's exit code -- belt and
 * suspenders alongside RUN_EXIT_CODE_PATH, in case Daytona's own tracking
 * DOES work for a given run. Nothing here uses `set -e`/`&&`: the
 * follow-up step must still run even when the real run command exits
 * non-zero.
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

  // Base64-encoded, not interpolated straight into a single-quoted shell
  // arg -- a literal single quote anywhere in params (a string parameter
  // value, a config_overrides value/path, ...) would otherwise terminate
  // that quoted argument early and corrupt the rest of this command.
  // base64's own alphabet (A-Za-z0-9+/=) never contains a quote, so
  // wrapping THAT in single quotes is always safe regardless of what's
  // inside params. Decoded back into SCENARIO_PARAMS via command
  // substitution before runCommand ever sees it -- run.py's own
  // `os.environ.get("SCENARIO_PARAMS")` + `json.loads` is unaffected,
  // it's still plain JSON text by the time it gets there.
  const paramsB64 = Buffer.from(JSON.stringify(params)).toString("base64");

  return (
    `SCENARIO_PARAMS="$(echo '${paramsB64}' | base64 -d)" ${runCommand} > ${RUN_OUTPUT_LOG_PATH} 2>&1\n` +
    `EXIT=$?\n` +
    `echo "$EXIT" > ${RUN_EXIT_CODE_PATH}\n` +
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
  // duplicate pointer at a result that's already durably stored in the
  // earlier run's own row (see lib/db.ts's getCachedRun); the client can
  // render this directly instead of polling GET /v1/runs/{run_id} for a
  // row that was never written. `run_id` above
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
  if (model.supportsConfigOverrides) allowedKeys.add("config_overrides");

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

  // config_overrides deliberately has NO per-key validation beyond "is
  // this a plain {name: value} object" -- see sandboxes/gcam/run.py's
  // apply_config_overrides and models.ts's supportsConfigOverrides doc
  // comment for why: there's no fixed list of safe keys/types to check
  // against here, and a bad override is meant to fail loudly from
  // inside the model's own run.py instead.
  if (model.supportsConfigOverrides && "config_overrides" in params) {
    const overrides = params.config_overrides;
    if (
      typeof overrides !== "object" ||
      overrides === null ||
      Array.isArray(overrides) ||
      Object.values(overrides).some((v) => typeof v === "object" && v !== null)
    ) {
      return `parameter 'config_overrides' must be a flat object of {name: value}`;
    }
  }

  return null;
}

/**
 * Merges model.defaultConfigOverrides (see models.ts) UNDER whatever
 * the caller's own params.config_overrides already sets -- an explicit
 * key always wins, this only fills in a key the caller never mentioned
 * at all. Applied unconditionally, dashboard or raw API caller alike,
 * at the very top of both checkRun and submitRun -- BEFORE
 * validateParams, caching, and anything else downstream, so "no
 * override set" and "explicitly set to the same default value" are
 * genuinely the same effective request (same cache key, same
 * validation), not two different-looking params objects that happen to
 * produce the same run. This is how gcam's own "default 2 cores"
 * decision is implemented -- NOT by changing anything in the Daytona
 * snapshot (configuration_ref.xml still ships max-parallelism=1): the
 * snapshot is a fixed artifact, this is just the app's own request
 * construction, changeable with a code edit and no snapshot rebuild.
 */
function withDefaultParams(model: ModelMeta, params: Record<string, unknown>): Record<string, unknown> {
  if (!model.supportsConfigOverrides || !model.defaultConfigOverrides) return params;
  const callerOverrides = (params.config_overrides as Record<string, unknown> | undefined) ?? {};
  return {
    ...params,
    config_overrides: { ...model.defaultConfigOverrides, ...callerOverrides },
  };
}

/**
 * False when the model declares `nonDeterministicUnless` (see models.ts)
 * and the request doesn't supply that key. A non-cacheable run's result is
 * never treated as a cache hit for a later identical request (submitRun/
 * checkRun both gate their getCachedRun lookup on this) -- serving one
 * arbitrary random draw forever as "the" answer for that (model, params)
 * would misrepresent something that is genuinely different every time
 * it's run. The run itself still gets written to `runs` like any other
 * (that part was never conditional on this) -- this only ever gated
 * whether that row is later eligible to answer someone else's request.
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
  // estimate -- see lib/db.ts's getCachedRun.
  cached_duration_seconds: number | null;
  // The real `runs` row id behind this cache hit, for the New Run form's
  // "View cached" button -- a cache hit itself never gets its own row (see
  // submitRun's doc comment), so the UI needs this to know which run_id to
  // open in the Runs tab's drawer. Null whenever `cached` is false.
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

  params = withDefaultParams(model, params);

  const validationError = validateParams(model, params);
  if (validationError) {
    return { error: validationError, cacheable: false, cached: false, cached_duration_seconds: null, cached_run_id: null };
  }

  if (!isCacheable(model, params)) {
    return { error: null, cacheable: false, cached: false, cached_duration_seconds: null, cached_run_id: null };
  }

  const cached = await getCachedRun(modelName, params);
  return {
    error: null,
    cacheable: true,
    cached: cached !== null,
    cached_duration_seconds: cached?.duration_seconds ?? null,
    cached_run_id: cached?.run_id ?? null,
  };
}

export async function submitRun(
  modelName: string,
  params: Record<string, unknown>,
  forceRefresh: boolean,
  // Whether the caller presented valid auth (lib/apiKey.ts's checkApiAuth)
  // -- only consulted below on a cache MISS. A cache hit never touches
  // this: nothing is being authorized when the answer was already sitting
  // in an earlier run's own row (see lib/db.ts's getCachedRun), so an
  // unauthenticated caller can still get cached results, just not
  // trigger a new sandbox run.
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

  params = withDefaultParams(model, params);

  const validationError = validateParams(model, params);
  if (validationError) {
    return { run_id: "", error: validationError };
  }

  const runId = randomUUID();
  const cacheable = isCacheable(model, params);

  if (!forceRefresh && cacheable) {
    const cached = await getCachedRun(modelName, params);
    if (cached !== null) {
      // A cache hit isn't a new generation -- nothing here actually ran,
      // the answer was already sitting in `runs` from some earlier real
      // run of this exact (model, params) -- see lib/db.ts's getCachedRun.
      // Previously this still wrote a `runs` row (queued, then
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
          result: cached.result,
          error: null,
          cached: true,
          progress: { percent: 100 },
          duration_seconds: 0,
          // Nothing actually ran just now, so there's no real started_at
          // for this exact response -- "now" is as good as anything else
          // (the result is immediate either way), and matches this
          // branch's own duration_seconds: 0.
          started_at: new Date().toISOString(),
          // Nothing ran, so there's no deadline to speak of either.
          deadline_at: null,
          // Nothing actually ran just now -- this is an existing answer
          // from some earlier run, not a fresh process invocation, so
          // there's no new stdout to show. The real run that originally
          // produced this result has its own row (and its own
          // stdout_tail) at cached.run_id.
          stdout_tail: null,
          live_stdout_tail: null,
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
  // Same column the Runs table's own "Started" column and sort order read
  // (see lib/db.ts's RunListItem) -- added here so the run drawer can show
  // it too without reaching into the already-fetched list row for it like
  // the Duration fallback below still does.
  started_at: string;
  // The absolute cutoff advanceRun's own deadlinePassed check uses to
  // decide a still-running run has overstayed its welcome -- settable
  // after the fact via PATCH /v1/runs/{run_id} (the drawer's Advanced
  // tab), not just at submit time. Null for a cache-hit inline result
  // (nothing ran, so there's no deadline) or once a run reaches a
  // terminal state (updateRunDeadline refuses to change it past that
  // point -- see its own doc comment -- but the column itself is never
  // cleared, so this stays at whatever it was for a finished run).
  deadline_at: string | null;
  // The model process's raw captured stdout+stderr, tail-capped -- see
  // this app's db.ts stdout_tail column comment. Present for both
  // succeeded and failed runs (falls back to error.stdout_tail for an
  // older failed row written before this column existed), null if
  // there's genuinely nothing captured (e.g. a run that never got far
  // enough to produce any). Meant for debugging a confusing result, not
  // part of the model's own (parsed, structured) `result`.
  stdout_tail: string | null;
  // Best-effort stdout+stderr captured live, straight off the sandbox, for a
  // run that's still "running" -- NOT persisted anywhere (unlike
  // stdout_tail, which is only ever written once at finalize time). Each
  // advanceRun poll re-downloads RUN_OUTPUT_LOG_PATH and attaches the
  // current tail directly to that poll's response; there's no column for
  // this on the runs table. Only ever set while status is "running"/
  // "queued" -- use stdout_tail once the run finishes.
  live_stdout_tail: string | null;
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
    started_at: row.started_at,
    deadline_at: row.deadline_at,
    stdout_tail: row.stdout_tail ?? error?.stdout_tail ?? null,
    // Never persisted -- see RunView's own live_stdout_tail comment.
    // advanceRun fills this in after calling toView, for a still-running
    // row, from whatever it just downloaded off the live sandbox.
    live_stdout_tail: null,
  };
}

export async function advanceRun(runId: string): Promise<RunView | null> {
  let row = await getRun(runId);
  if (!row) return null;

  if (row.status === "succeeded" || row.status === "failed") {
    return toView(row);
  }

  // Someone else is mid-finalize for this exact run right now -- normally
  // nothing for this call to do but report the current (pre-finalize)
  // view, since whoever holds the claim is expected to finish quickly.
  // BUT if it's been stuck here for longer than any real finalize should
  // take, something crashed mid-finalize before finalizeOutcome's own
  // try/catch (see its doc comment) existed to catch it -- a run can be
  // left here forever otherwise, since this branch is the only thing that
  // ever looks at a 'finalizing' row and it was just returning the stale
  // view unconditionally. The sandbox is virtually certain to already be
  // gone by this point (cleanupSandboxAndSession runs before
  // finalizeOutcome in both the poll and webhook paths), so there's no
  // real result left to recover -- just surface it as failed instead of
  // leaving it stuck at whatever progress% it last reported, forever.
  if (row.status === "finalizing") {
    const stuckForMs = Date.now() - Date.parse(row.updated_at);
    if (stuckForMs > FINALIZING_STUCK_THRESHOLD_MS) {
      console.error(`[advanceRun ${runId}] stuck 'finalizing' for ${Math.round(stuckForMs / 1000)}s -- marking failed`);
      // finishRunFailed has no status guard (unlike claimRunForFinalize,
      // which only ever matches 'running') -- fine here, since the worst
      // case of two concurrent polls both hitting this branch is two
      // redundant, identical writes, not a double sandbox-cleanup race.
      await finishRunFailed(runId, { code: "gateway_error", message: "finalize got stuck and never completed" }, 0);
      row = (await getRun(runId))!;
    }
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

  // Live stdout+stderr snapshot -- unconditional (unlike the progress read
  // above, which is gated on supports_progress), since every model writes
  // RUN_OUTPUT_LOG_PATH via the `> ... 2>&1` redirect regardless of whether
  // it also emits structured progress. Best-effort: the file may not exist
  // yet (command hasn't started writing), or the download may transiently
  // fail; neither should fail the poll. Not persisted anywhere (see
  // RunView's own live_stdout_tail comment) -- just attached directly to
  // whatever view this poll ends up returning, below.
  let liveStdoutTail: string | null = null;
  // The FULL file content, not just the tail -- needed if this poll turns
  // out to be the one that finalizes the run (see RUN_EXIT_CODE_PATH's own
  // comment on why this, not getSessionCommandLogs, is now the source of
  // truth for finalizeOutcome's stdout). Comes from the same download as
  // liveStdoutTail -- no reason to fetch the file twice.
  let fullStdout: string | null = null;
  try {
    const raw = await sandbox.fs.downloadFile(RUN_OUTPUT_LOG_PATH);
    if (raw && raw.length) {
      fullStdout = raw.toString();
      liveStdoutTail = fullStdout.slice(-2000);
    }
  } catch {
    // not written yet, or transient -- ignore
  }

  // Whether the real run command has exited -- checked via TWO
  // independent signals, since either alone has been observed to fail:
  //   1. RUN_EXIT_CODE_PATH, written by buildWrappedCommand the instant
  //      the real run command exits (see that constant's own comment --
  //      added after a real gcam run whose 13.7MB output left Daytona's
  //      own exit-code tracking never reporting anything at all, even
  //      though the process had long since exited).
  //   2. cmdInfo.exitCode from Daytona's getSessionCommand, kept as a
  //      fallback for the (presumably common) case where that tracking
  //      DOES work, and for any sandbox created before this file existed.
  // Whichever reports a numeric exit code first wins; sentinelExitCode is
  // preferred when both are present since it reflects the real run
  // command's own exit status (not the whole wrapped script's, which
  // could differ in principle if something upstream of `exit $EXIT` were
  // ever changed) and was observed to be the more reliable of the two.
  let sentinelExitCode: number | null = null;
  try {
    const raw = await sandbox.fs.downloadFile(RUN_EXIT_CODE_PATH);
    if (raw && raw.length) {
      const parsed = parseInt(raw.toString().trim(), 10);
      if (Number.isFinite(parsed)) sentinelExitCode = parsed;
    }
  } catch {
    // not written yet (run command hasn't exited), or transient -- ignore
  }

  let cmdInfo: { exitCode?: number | null } = {};
  try {
    cmdInfo = await sandbox.process.getSessionCommand(row.session_id, row.cmd_id);
  } catch (err) {
    // Same reasoning as the daytona.get() catch above -- this throws too
    // (confirmed by testing: a gcam run whose session had already gone
    // away hit exactly this, not the daytona.get() lookup, so it never
    // got the "sandbox lookup failed" treatment at all. It instead threw
    // all the way up to the route handler, which 502'd without ever
    // marking the run failed -- so the row just sat "running" forever,
    // with nothing in its own `error` column to explain why). Only fail
    // the run here if the sentinel ALSO doesn't already have an answer --
    // a thrown getSessionCommand shouldn't override a perfectly good
    // sentinel-reported exit code.
    if (sentinelExitCode === null) {
      console.error(`[advanceRun ${runId}] session command lookup failed`, err);
      const claimed = await claimRunForFinalize(runId);
      if (claimed) {
        await finishRunFailed(
          runId,
          { code: "gateway_error", message: `session command lookup failed: ${String(err)}`, stdout_tail: liveStdoutTail ?? undefined },
          elapsedSeconds(startedAt),
        );
      }
      row = (await getRun(runId))!;
      return toView(row);
    }
  }

  const exitCode = sentinelExitCode ?? cmdInfo.exitCode;

  if (exitCode === undefined || exitCode === null) {
    if (deadlinePassed) {
      const claimed = await claimRunForFinalize(runId);
      if (claimed) {
        await cleanupSandboxAndSession(daytona, sandbox, row.session_id);
        await finishRunFailed(
          runId,
          {
            code: "gateway_error",
            message: `run did not finish within the allotted time`,
            // Without this, whatever the process had printed so far is
            // gone for good the moment cleanupSandboxAndSession tears the
            // sandbox down above -- we already downloaded it into
            // liveStdoutTail a few lines up, so pass it through instead of
            // losing it.
            stdout_tail: liveStdoutTail ?? undefined,
          },
          elapsedSeconds(startedAt),
        );
      }
      row = (await getRun(runId))!;
      return toView(row);
    }
    // Still running -- re-read so the caller sees the progress update we
    // may have just written above.
    row = (await getRun(runId))!;
    return { ...toView(row), live_stdout_tail: liveStdoutTail };
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

  // fullStdout -- read straight off RUN_OUTPUT_LOG_PATH a few lines up --
  // is now the source of truth, not getSessionCommandLogs: the real run
  // command's own stdout/stderr never reaches that API at all (it's
  // redirected into this file at the shell level, inside the SAME command
  // getSessionCommandLogs is asked about -- it was only ever going to see
  // the follow-up webhook step's own output, which prints nothing on
  // success). Falls back to re-downloading the file fresh only if the
  // earlier read somehow came back empty (e.g. a transient failure on
  // that particular poll).
  let stdout = fullStdout ?? "";
  if (!stdout) {
    try {
      const raw = await sandbox.fs.downloadFile(RUN_OUTPUT_LOG_PATH);
      if (raw && raw.length) stdout = raw.toString();
    } catch {
      // Genuinely nothing captured -- finalizeOutcome's own jsonLine ===
      // null handling covers this (reported as a failure either way).
    }
  }
  const runSeconds = elapsedSeconds(startedAt);

  // Same reasoning as finalizeOutcome's own step logging -- bracket the
  // other two potentially-slow steps on this path too (a sandbox/session
  // teardown is its own couple of Daytona API calls; so is just getting
  // this far, mostly the RUN_OUTPUT_LOG_PATH download above for a large
  // result) so a killed invocation's last Netlify log line says which of
  // "got the full output", "tore down the sandbox", or "finalizeOutcome's
  // own steps" it never got past.
  const tFinalize = Date.now();
  console.log(`[advanceRun ${runId}] got stdout (${stdout.length}B), cleaning up sandbox/session`);
  await cleanupSandboxAndSession(daytona, sandbox, row.session_id);
  console.log(`[advanceRun ${runId}] sandbox/session cleaned up (+${Date.now() - tFinalize}ms), calling finalizeOutcome`);
  await finalizeOutcome(runId, row, exitCode, stdout, runSeconds);
  console.log(`[advanceRun ${runId}] finalizeOutcome returned (+${Date.now() - tFinalize}ms total)`);
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
 * see lastJsonLine), persist it to this run's own row, and mark the run
 * terminal. Must be called only AFTER claimRunForFinalize() has already
 * succeeded for this runId -- this function itself does no claiming.
 *
 * Wraps its own body in a try/catch (confirmed necessary by hitting
 * exactly this with a real gcam run: its result can carry thousands of
 * Hector output rows, and something in parsing/caching/storing a result
 * that large threw). Without this, any exception here -- JSON.parse on a
 * huge string, a DB write exceeding some limit, anything -- left the row
 * stuck at 'finalizing' forever: claimRunForFinalize had already moved it
 * OFF 'running' (so nothing else would ever re-attempt it), but nothing
 * ever moved it on to 'succeeded'/'failed' either. toView maps
 * 'finalizing' to "running" for display, so this looked exactly like a
 * run hanging at whatever progress% it last reported, permanently, even
 * though the model process itself had already finished and printed a
 * complete result.
 */
async function finalizeOutcome(runId: string, row: RunRow, exitCode: number, stdout: string, runSeconds: number) {
  try {
    await finalizeOutcomeInner(runId, row, exitCode, stdout, runSeconds);
  } catch (err) {
    console.error(`[finalizeOutcome ${runId}] threw -- marking failed instead of leaving it stuck "finalizing"`, err);
    await finishRunFailed(
      runId,
      { code: "gateway_error", message: `finalize failed: ${String(err)}`, stdout_tail: stdout.slice(-2000) },
      runSeconds,
    );
  }
}

async function finalizeOutcomeInner(runId: string, row: RunRow, exitCode: number, stdout: string, runSeconds: number) {
  // Step-by-step timing, logged unconditionally (not just on error) --
  // added after a real gcam run (13.7MB captured output) that appeared to
  // just hang, with NOTHING in the Netlify function logs beyond the
  // platform's own generic "Duration/Memory Usage" line. That's the
  // signature of the function being killed by Netlify's own execution
  // timeout, not a JS exception -- a hard platform-level kill never gives
  // finalizeOutcome's own try/catch (see finalizeOutcome's doc comment) a
  // chance to run either, so that catch alone isn't enough to debug this
  // class of failure after the fact. These logs exist so that WHEN it
  // happens again, whatever's the last line in the Netlify log for this
  // runId tells you exactly which step it never got past, instead of
  // nothing at all.
  const t0 = Date.now();
  const log = (step: string) => console.log(`[finalizeOutcome ${runId}] ${step} (+${Date.now() - t0}ms, stdout=${stdout.length}B)`);
  log("start");
  const jsonLine = lastJsonLine(stdout);
  log(`lastJsonLine done, found=${jsonLine !== null}`);

  if (exitCode !== 0 || jsonLine === null) {
    // A non-zero exit does NOT mean there's nothing useful to report --
    // run.py's own failure branch prints a parseable
    // {"status": "failed", "error": ..., "log_tail": ...} and only THEN
    // exits 1 (gcam's run.py does exactly this when gcam.exe itself
    // dies). Parsing that here instead of unconditionally reporting the
    // bare "exit_code=N" is what puts the model's own diagnosis (gcam's
    // real exit code, its cgroup OOM-kill evidence, ...) in front of the
    // user. Confirmed by a real gcam run that died at its final period:
    // gcam.exe's own exit code was sitting in the failure JSON's "error"
    // field, unreachable except as JSON-escaped text buried in the raw
    // output tail, so all the dashboard ever said was "exit_code=1".
    // The readable log_tail (the model's own captured log) is also a
    // much better stdout_tail than the raw output's tail here, which
    // would be mostly the JSON envelope's escaped text.
    let message = exitCode !== 0 ? `exit_code=${exitCode}` : "no result JSON in model output";
    let tail = stdout.slice(-2000);
    if (jsonLine !== null) {
      try {
        const failure = JSON.parse(jsonLine);
        if (failure && typeof failure.error === "string" && failure.error) {
          message = failure.error;
          if (typeof failure.log_tail === "string" && failure.log_tail) {
            tail = failure.log_tail.slice(-2000);
          }
        }
      } catch {
        // Keep the generic message + raw tail -- same fallback as before
        // this parse step existed.
      }
    }
    await finishRunFailed(
      runId,
      { code: "model_run_failed", message, stdout_tail: tail },
      runSeconds,
    );
    return;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonLine);
    log(`JSON.parse done, resultBytes=${jsonLine.length}`);
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
    // Same reasoning as the parse-failure branch above -- keep stdout_tail
    // around rather than dropping it just because the model's own JSON
    // parsed fine but reported a failure (e.g. gcam's run.py prints
    // {"status": "failed", ..., "log_tail": ...} and exits 1, which
    // actually lands in the branch above since that's a non-zero exit --
    // this branch is for exit 0 + self-reported failure specifically, but
    // there's no reason to treat it differently).
    await finishRunFailed(
      runId,
      { code: "model_run_failed", message: parsed.error || "unknown error", stdout_tail: stdout.slice(-2000) },
      runSeconds,
    );
    return;
  }

  // No separate run_cache write anymore -- see lib/db.ts's own module
  // comment on why. finishRunSucceeded below already persists `parsed`
  // (the full result) and `runSeconds` into THIS run's own `runs` row,
  // which is now also the one and only thing getCachedRun reads from for
  // a future (model, params) cache hit -- nothing more to do here. This
  // used to be a second full write of `parsed` (isCacheable-gated, with a
  // deepEqual check against whatever was already cached) -- for gcam's
  // own multi-megabyte result, that was a second multi-megabyte DB write
  // on every single successful run, not just the ones that needed it.
  // Same 2000-char tail cap already used for a failure (finishRunFailed's
  // own stdout_tail above) -- enough to debug a confusing-but-"succeeded"
  // result (what did the model actually print/log) without storing a
  // potentially huge log in full.
  log("writing finishRunSucceeded (the runs row's own result column)");
  await finishRunSucceeded(runId, parsed, runSeconds, false, stdout.slice(-2000));
  log("finishRunSucceeded done -- finalize complete");
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

export interface UpdateDeadlineResult {
  view: RunView | null;
  error: string | null;
}

/**
 * Lets the drawer's Advanced tab raise (or lower) a still-in-flight run's
 * deadline -- i.e. model.exec_timeout_seconds/the New Run form's own
 * max_run_time_seconds override, just settable after the fact instead of
 * only at submit time. `newExecTimeoutSeconds` is total seconds from the
 * run's own `started_at`, exactly like submitRun's initial deadline_at
 * computation (`started_at + execTimeoutSeconds`) -- NOT "N more seconds
 * from now" -- so entering the same number twice is idempotent instead of
 * creeping the deadline forward on every edit.
 *
 * Also has to extend the sandbox's own Daytona-side autoStopInterval,
 * which is a SEPARATE backstop from our deadline_at column (see
 * autoStopMinutes' own comment) -- raising deadline_at alone would still
 * let Daytona itself stop the sandbox out from under a run we just told
 * to keep going longer. setAutostopInterval's own clock is anchored
 * differently than deadline_at's, though (per its SDK doc comment, it's
 * IDLE minutes since the sandbox's LAST ACTIVITY -- i.e. effectively
 * "now", since calling it is itself activity -- not minutes since
 * `started_at`), so matching deadline_at's actual absolute cutoff DOES
 * need elapsed time subtracted here: passing the same clamped total
 * would anchor an idle-cutoff of `now + clamped minutes`, which drifts
 * later than `started_at + clamped seconds` by however long the run's
 * already been going -- correct direction to fail safe in (never
 * cuts the run off early), but not an accurate match for what the
 * drawer says it's setting. Using the seconds actually remaining in the
 * new budget keeps both clocks pointed at (approximately) the same
 * real moment.
 */
export async function updateRunDeadline(runId: string, newExecTimeoutSeconds: number): Promise<UpdateDeadlineResult> {
  const row = await getRun(runId);
  if (!row) return { view: null, error: null };

  if (row.status !== "queued" && row.status !== "running") {
    return { view: toView(row), error: "run has already finished -- its deadline can no longer be changed" };
  }

  const clamped = clampRunTimeSeconds(newExecTimeoutSeconds);
  const startedAt = new Date(Date.parse(row.started_at));
  const newDeadlineAt = new Date(startedAt.getTime() + clamped * 1000);

  await dbUpdateRunDeadline(runId, newDeadlineAt);

  if (row.sandbox_id) {
    try {
      const daytona = getDaytonaClient();
      const sandbox = await daytona.get(row.sandbox_id);
      // Seconds remaining FROM NOW in the new total budget, not the total
      // itself -- see this function's own doc comment. Floored at 0 (a
      // shrunk deadline that's already in the past still needs a valid
      // non-negative interval here; advanceRun's deadlinePassed check is
      // what actually ends the run in that case, on its next poll -- this
      // is still just the backstop, same as before).
      const remainingSeconds = Math.max(0, clamped - elapsedSeconds(startedAt));
      await sandbox.setAutostopInterval(autoStopMinutes(remainingSeconds));
    } catch (err) {
      // Best-effort -- deadline_at (checked by advanceRun's own
      // deadlinePassed, independent of Daytona's autoStopInterval) is the
      // row's real source of truth either way; this is belt-and-suspenders
      // against Daytona's own idle-stop firing first. Logged, not
      // surfaced as a request failure, since the deadline_at update above
      // already succeeded.
      console.error(`[updateRunDeadline ${runId}] setAutostopInterval failed`, err);
    }
  }

  const updated = (await getRun(runId))!;
  return { view: toView(updated), error: null };
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
