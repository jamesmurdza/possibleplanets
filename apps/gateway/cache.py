"""
Result cache, backed by Postgres (Supabase), keyed on (model, params).

Rationale (see PLATFORM.md's "Result caching" future idea, now implemented):
these models are deterministic given the same native params, and some of them
are expensive -- OSCAR's smallest possible run takes ~6 minutes (confirmed by
testing). Caching means the Nth request for the same (model, params) returns
instantly instead of spinning up another sandbox and re-running the model.

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

_SCHEMA = """
CREATE TABLE IF NOT EXISTS run_cache (
    cache_key TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    params JSONB NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


def init_cache(max_connections: int = 8):
    """
    Call once at gateway startup. Sets up a connection pool and ensures the
    cache table exists. Safe to call even if DATABASE_URL isn't set or the DB
    is unreachable -- caching just stays disabled in that case, logged once.
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
            conn.commit()
        finally:
            _pool.putconn(conn)
        _enabled = True
        print("[cache] connected, run_cache table ready -- caching enabled")
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
    """Returns the cached native result dict, or None on a miss or if caching
    is disabled/unreachable. Never raises -- a cache lookup failure should
    just behave like a miss, not break the run."""
    if not _enabled or _pool is None:
        return None

    key = cache_key_for(model, params)
    conn = None
    try:
        conn = _pool.getconn()
        with conn.cursor() as cur:
            cur.execute("SELECT result FROM run_cache WHERE cache_key = %s", (key,))
            row = cur.fetchone()
        return row[0] if row else None
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] get failed ({exc}), treating as miss")
        return None
    finally:
        if conn is not None:
            _pool.putconn(conn)


def put_cached(model: str, params: dict, result: dict):
    """Best-effort write-through; failures are logged and swallowed -- a
    cache-write failure should never fail an otherwise-successful run."""
    if not _enabled or _pool is None:
        return

    key = cache_key_for(model, params)
    conn = None
    try:
        conn = _pool.getconn()
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO run_cache (cache_key, model, params, result)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (cache_key) DO NOTHING
                """,
                (key, model, json.dumps(params), json.dumps(result)),
            )
        conn.commit()
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] put failed ({exc}), continuing without caching this result")
    finally:
        if conn is not None:
            _pool.putconn(conn)
