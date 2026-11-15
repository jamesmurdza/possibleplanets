"""
Result cache, backed by Postgres (Supabase), keyed on (model, params).

Rationale (see PLATFORM.md's "Result caching" future idea, now implemented):
these models are deterministic given the same native params, and some of them
are expensive -- OSCAR's smallest possible run takes ~6 minutes (confirmed by
testing). Caching means the Nth request for the same (model, params) returns
instantly instead of spinning up another sandbox and re-running the model.

This is an append-only log, not a single-row-per-key cache: every successful
run is inserted as a new row, nothing is ever overwritten or deleted, and a
read always returns the most recent row for that (model, params) key. This is
what makes "refresh" meaningful -- a forced re-run (see jobs.py's
force_refresh) doesn't invalidate/replace the old entry, it just appends a
newer one that normal reads then prefer, so the full history of past results
for a given input is preserved in the table.

Caching is best-effort and fails open: if DATABASE_URL isn't set, or the DB is
unreachable, caching is silently disabled and the gateway behaves exactly as
it did before this existed -- every run goes through the sandbox, same as
always. A DB outage should never take down model runs.
"""
import hashlib
import json
import os
import threading

try:
    import psycopg2
    import psycopg2.extras
    from psycopg2.pool import ThreadedConnectionPool
except ImportError:  # pragma: no cover -- psycopg2 is an optional dependency
    psycopg2 = None
    ThreadedConnectionPool = None

_pool = None
_pool_lock = threading.Lock()
_enabled = False

# Fresh-install schema: id is the real primary key, cache_key is just an
# indexed lookup column (deliberately NOT unique -- this is a log, multiple
# rows can and will share the same cache_key over time).
_SCHEMA = """
CREATE TABLE IF NOT EXISTS run_cache (
    id BIGSERIAL PRIMARY KEY,
    cache_key TEXT NOT NULL,
    model TEXT NOT NULL,
    params JSONB NOT NULL,
    result JSONB NOT NULL,
    -- Real measured wall-clock seconds for the sandbox run that produced
    -- this row (sandbox create + execute) -- NULL for rows written before
    -- this column existed. Never an estimate, same standard as the
    -- progress reporting elsewhere in this project. This is what makes a
    -- per-model run-duration history queryable, since run_cache is already
    -- an append-only log of every real execution (see module docstring).
    duration_seconds DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_cache_cache_key_idx ON run_cache (cache_key);
"""

# Migrates a table created by an earlier version of this module, where
# cache_key was the PRIMARY KEY (one row per key, overwritten via
# ON CONFLICT DO NOTHING) into the append-only log shape above. All
# statements are idempotent / guarded so this is safe to run on every
# startup, whether the table is fresh, already migrated, or still old-shaped.
_MIGRATION = """
ALTER TABLE run_cache DROP CONSTRAINT IF EXISTS run_cache_pkey;
ALTER TABLE run_cache ADD COLUMN IF NOT EXISTS id BIGSERIAL;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'run_cache' AND constraint_type = 'PRIMARY KEY'
    ) THEN
        ALTER TABLE run_cache ADD PRIMARY KEY (id);
    END IF;
END$$;
ALTER TABLE run_cache ADD COLUMN IF NOT EXISTS duration_seconds DOUBLE PRECISION;
CREATE INDEX IF NOT EXISTS run_cache_cache_key_idx ON run_cache (cache_key);
"""


def init_cache(max_connections: int = 8):
    """
    Call once at gateway startup. Sets up a connection pool and ensures the
    cache table exists (and migrates it to the append-only log shape if an
    earlier version of this module already created it). Safe to call even if
    DATABASE_URL isn't set or the DB is unreachable -- caching just stays
    disabled in that case, logged once.
    """
    global _pool, _enabled

    if psycopg2 is None:
        print("[cache] psycopg2 not installed -- caching disabled")
        _enabled = False
        return

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("[cache] DATABASE_URL not set -- caching disabled")
        _enabled = False
        return

    try:
        with _pool_lock:
            _pool = ThreadedConnectionPool(1, max_connections, dsn=database_url)
        conn = _pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute(_SCHEMA)
                cur.execute(_MIGRATION)
            conn.commit()
        finally:
            _pool.putconn(conn)
        _enabled = True
        print("[cache] connected, run_cache table ready (append-only log) -- caching enabled")
    except Exception as exc:  # noqa: BLE001 -- fail open, never block startup
        print(f"[cache] failed to initialize ({exc}) -- caching disabled")
        _pool = None
        _enabled = False


def is_enabled() -> bool:
    return _enabled


def cache_key_for(model: str, params: dict) -> str:
    # Canonical JSON (sorted keys) so equivalent param dicts with different
    # key order hash the same.
    canonical = json.dumps(params, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(f"{model}:{canonical}".encode()).hexdigest()
    return digest


def get_cached(model: str, params: dict):
    """Returns the MOST RECENT cached native result dict for (model, params),
    or None on a miss or if caching is disabled/unreachable. Never raises --
    a cache lookup failure should just behave like a miss, not break the run.

    Since run_cache is an append-only log, this is deliberately "most recent
    row wins", not "the only row" -- a force_refresh writes a new row rather
    than replacing the old one, and this is what picks that newer one up on
    the next normal (non-refresh) read."""
    if not _enabled or _pool is None:
        return None

    key = cache_key_for(model, params)
    conn = None
    try:
        conn = _pool.getconn()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT result FROM run_cache WHERE cache_key = %s "
                "ORDER BY created_at DESC LIMIT 1",
                (key,),
            )
            row = cur.fetchone()
        return row[0] if row else None
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] get failed ({exc}), treating as miss")
        return None
    finally:
        if conn is not None:
            _pool.putconn(conn)


def get_duration_stats():
    """
    Per-model real-run duration stats, aggregated from run_cache's
    duration_seconds column -- count/min/avg/max over every real execution
    ever logged for that model (rows with duration_seconds IS NULL, i.e.
    written before that column existed, are excluded). Returns [] if caching
    is disabled/unreachable or there's nothing to report yet -- never raises.
    """
    if not _enabled or _pool is None:
        return []

    conn = None
    try:
        conn = _pool.getconn()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT model,
                       COUNT(*),
                       MIN(duration_seconds),
                       AVG(duration_seconds),
                       MAX(duration_seconds)
                FROM run_cache
                WHERE duration_seconds IS NOT NULL
                GROUP BY model
                ORDER BY model
                """
            )
            rows = cur.fetchall()
        return [
            {
                "model": model,
                "count": count,
                "min_seconds": round(min_s, 3),
                "avg_seconds": round(avg_s, 3),
                "max_seconds": round(max_s, 3),
            }
            for model, count, min_s, avg_s, max_s in rows
        ]
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] duration stats query failed ({exc})")
        return []
    finally:
        if conn is not None:
            _pool.putconn(conn)


def put_cached(model: str, params: dict, result: dict, duration_seconds: float = None):
    """Best-effort write-through; failures are logged and swallowed -- a
    cache-write failure should never fail an otherwise-successful run.

    Always inserts a new row (no upsert/ON CONFLICT) -- this is a log, not a
    single slot per key, so every successful run (including forced refreshes)
    adds a new entry rather than overwriting the previous one. get_cached
    always serves the newest row for a given key.

    duration_seconds is the real measured wall-clock time for the sandbox run
    that produced this result (see jobs.py) -- pass None if unknown, never an
    estimate."""
    if not _enabled or _pool is None:
        return

    key = cache_key_for(model, params)
    conn = None
    try:
        conn = _pool.getconn()
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO run_cache (cache_key, model, params, result, duration_seconds)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (key, model, json.dumps(params), json.dumps(result), duration_seconds),
            )
        conn.commit()
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] put failed ({exc}), continuing without caching this result")
    finally:
        if conn is not None:
            _pool.putconn(conn)
