/**
 * Postgres access, ported from apps/gateway/cache.py + the in-memory jobs.py
 * job store -- but reshaped for serverless: jobs.py's `_jobs = {}` global
 * dict only worked because one long-lived uvicorn process stayed alive
 * between a run's POST and its later GET polls. On a serverless platform
 * each invocation can be a fresh, isolated process with empty memory, so job
 * state has to live somewhere that outlives any single invocation --
 * Postgres, same database already used for the result cache.
 *
 * Two tables:
 *   run_cache - unchanged in shape from the Python version: an append-only
 *               log of every real execution, keyed by (model, params) hash.
 *   runs      - NEW. One row per in-flight or finished run, replacing
 *               jobs.py's _jobs dict. See lib/runs.ts for how it's driven.
 *
 * Caching/job-state persistence is required here (not best-effort like the
 * Python version's optional caching) because without it there is no way to
 * recover job state across invocations at all. DATABASE_URL must be set.
 */
import { Pool } from "pg";

let _pool: Pool | null = null;
let _initPromise: Promise<void> | null = null;

function getPool(): Pool {
  if (!_pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL not set -- required for run/job state and caching");
    }
    _pool = new Pool({ connectionString: databaseUrl, max: 8 });
  }
  return _pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_cache (
    id BIGSERIAL PRIMARY KEY,
    cache_key TEXT NOT NULL,
    model TEXT NOT NULL,
    params JSONB NOT NULL,
    result JSONB NOT NULL,
    duration_seconds DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_cache_cache_key_idx ON run_cache (cache_key);

CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    params JSONB NOT NULL,
    status TEXT NOT NULL,
    result JSONB,
    error JSONB,
    cached BOOLEAN NOT NULL DEFAULT false,
    progress JSONB,
    sandbox_id TEXT,
    session_id TEXT,
    cmd_id TEXT,
    supports_progress BOOLEAN NOT NULL DEFAULT false,
    deadline_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_seconds DOUBLE PRECISION,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Migrates a `runs` table created by an earlier version of this schema --
// confirmed necessary by testing: this Supabase database already had a
// `runs` table from an earlier session's work, created before
// `supports_progress`/`deadline_at` existed in this file's CREATE TABLE
// statement above. `CREATE TABLE IF NOT EXISTS` is a no-op against an
// existing table regardless of its column set, so without this, those two
// columns would silently never get added and every real run would fail
// with "column ... does not exist". Safe to run on every startup, whether
// the table is fresh (both ADD COLUMNs are no-ops) or still missing these
// columns.
const MIGRATION = `
ALTER TABLE runs ADD COLUMN IF NOT EXISTS supports_progress BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
`;

// ensureDb() is called at the top of every exported function below rather
// than from a single "startup" hook -- serverless cold-starts can route the
// very first request to any route handler, so there's no equivalent of
// FastAPI's @app.on_event("startup"). This is idempotent and cheap once the
// schema already exists (the pool + promise are cached module-level state).
async function ensureDb(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const pool = getPool();
    await pool.query(SCHEMA);
    await pool.query(MIGRATION);
  })();
  return _initPromise;
}

function cacheKeyFor(model: string, params: unknown): string {
  const canonical = JSON.stringify(sortKeysDeep(params));
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(`${model}:${canonical}`).digest("hex");
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export async function getCached(model: string, params: unknown): Promise<unknown | null> {
  await ensureDb();
  const key = cacheKeyFor(model, params);
  const { rows } = await getPool().query(
    "SELECT result FROM run_cache WHERE cache_key = $1 ORDER BY created_at DESC LIMIT 1",
    [key],
  );
  return rows.length ? rows[0].result : null;
}

export async function putCached(
  model: string,
  params: unknown,
  result: unknown,
  durationSeconds: number | null,
): Promise<void> {
  await ensureDb();
  const key = cacheKeyFor(model, params);
  await getPool().query(
    "INSERT INTO run_cache (cache_key, model, params, result, duration_seconds) VALUES ($1, $2, $3, $4, $5)",
    [key, model, JSON.stringify(params), JSON.stringify(result), durationSeconds],
  );
}

export async function getDurationStats(): Promise<
  Array<{
    model: string;
    count: number;
    min_seconds: number;
    median_seconds: number;
    avg_seconds: number;
    max_seconds: number;
  }>
> {
  await ensureDb();
  const { rows } = await getPool().query(`
    SELECT model,
           COUNT(*) AS count,
           MIN(duration_seconds) AS min_s,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_seconds) AS median_s,
           AVG(duration_seconds) AS avg_s,
           MAX(duration_seconds) AS max_s
    FROM run_cache
    WHERE duration_seconds IS NOT NULL
    GROUP BY model
    ORDER BY model
  `);
  return rows.map((r: any) => ({
    model: r.model,
    count: Number(r.count),
    min_seconds: round3(r.min_s),
    median_seconds: round3(r.median_s),
    avg_seconds: round3(r.avg_s),
    max_seconds: round3(r.max_s),
  }));
}

function round3(n: unknown): number {
  return Math.round(Number(n) * 1000) / 1000;
}

export interface RunRow {
  run_id: string;
  model: string;
  params: unknown;
  status: "queued" | "running" | "finalizing" | "succeeded" | "failed";
  result: unknown | null;
  error: { code: string; message: string; stdout_tail?: string } | null;
  cached: boolean;
  progress: { percent: number } | null;
  sandbox_id: string | null;
  session_id: string | null;
  cmd_id: string | null;
  supports_progress: boolean;
  deadline_at: string | null;
  started_at: string;
  duration_seconds: number | null;
}

export async function insertRun(row: {
  run_id: string;
  model: string;
  params: unknown;
  status: string;
  sandbox_id: string | null;
  session_id: string | null;
  cmd_id: string | null;
  supports_progress: boolean;
  deadline_at: Date;
}): Promise<void> {
  await ensureDb();
  await getPool().query(
    `INSERT INTO runs (run_id, model, params, status, sandbox_id, session_id, cmd_id, supports_progress, deadline_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.run_id,
      row.model,
      JSON.stringify(row.params),
      row.status,
      row.sandbox_id,
      row.session_id,
      row.cmd_id,
      row.supports_progress,
      row.deadline_at.toISOString(),
    ],
  );
}

export async function getRun(runId: string): Promise<RunRow | null> {
  await ensureDb();
  const { rows } = await getPool().query("SELECT * FROM runs WHERE run_id = $1", [runId]);
  return rows.length ? (rows[0] as RunRow) : null;
}

export async function updateRunProgress(runId: string, progress: { percent: number }): Promise<void> {
  await ensureDb();
  await getPool().query(
    "UPDATE runs SET progress = $1, updated_at = now() WHERE run_id = $2 AND status = 'running'",
    [JSON.stringify(progress), runId],
  );
}

/**
 * Atomic claim: only the caller whose UPDATE actually matches a still-running
 * row gets to finalize (parse the result, write the cache, delete the
 * sandbox). Guards against two concurrent GET /v1/runs/{id} polls both
 * observing "the sandbox command just finished" at the same time and racing
 * to finalize twice -- see lib/runs.ts.
 */
export async function claimRunForFinalize(runId: string): Promise<RunRow | null> {
  await ensureDb();
  const { rows } = await getPool().query(
    "UPDATE runs SET status = 'finalizing', updated_at = now() WHERE run_id = $1 AND status = 'running' RETURNING *",
    [runId],
  );
  return rows.length ? (rows[0] as RunRow) : null;
}

export async function finishRunSucceeded(
  runId: string,
  result: unknown,
  durationSeconds: number,
  cached: boolean,
): Promise<void> {
  await ensureDb();
  await getPool().query(
    `UPDATE runs SET status = 'succeeded', result = $1, progress = $2, cached = $3,
       duration_seconds = $4, updated_at = now() WHERE run_id = $5`,
    [JSON.stringify(result), JSON.stringify({ percent: 100 }), cached, durationSeconds, runId],
  );
}

export async function finishRunFailed(
  runId: string,
  error: { code: string; message: string; stdout_tail?: string },
  durationSeconds: number,
): Promise<void> {
  await ensureDb();
  await getPool().query(
    `UPDATE runs SET status = 'failed', error = $1, duration_seconds = $2, updated_at = now() WHERE run_id = $3`,
    [JSON.stringify(error), durationSeconds, runId],
  );
}

export async function markRunRunning(runId: string): Promise<void> {
  await ensureDb();
  await getPool().query(
    "UPDATE runs SET status = 'running', updated_at = now() WHERE run_id = $1 AND status = 'queued'",
    [runId],
  );
}
