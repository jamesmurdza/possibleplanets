"""
Job store and execution worker.

Minimal version (see PLATFORM.md):
  - Every run is async: submit -> queued -> running -> succeeded/failed.
  - Every run gets its own fresh Daytona sandbox, used once, destroyed after --
    no pooling, no reuse across requests, per the isolation decisions in
    PLATFORM.md. Images are pre-built from each model's Dockerfile, so sandbox
    start is fast (confirmed ~1-2s warm); only the first build of a given image
    is slow, and that happens once, not per request.
  - Job state lives in memory only. That's a known limitation of the minimal
    version: state is lost on gateway restart, and this does not scale past one
    gateway process. A real deployment would move this to a database/queue.
  - Results ARE cached across restarts, separately from the in-memory job
    state -- see cache.py. Before creating a sandbox, a run is looked up by
    (model, params) in Postgres; a hit skips the sandbox entirely and returns
    instantly. Caching is best-effort and fails open (see cache.py) so a DB
    outage never blocks a run, it just stops being cached.
"""
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from enum import Enum

from daytona import CreateSandboxFromImageParams, Image, SessionExecuteRequest

import cache
from models import get_model_or_none

# How often to poll a running sandbox for progress (file read) and completion
# (session command status), for models with supports_progress=True.
PROGRESS_POLL_INTERVAL_SECONDS = 0.5

PROGRESS_FILE_PATH = "/tmp/progress.json"

# Bounds how many sandbox creations can be in flight at once. This is the
# gateway's only concurrency control in the minimal version -- see PLATFORM.md's
# note that the queue's job is to rate-limit concurrent sandbox creation.
MAX_CONCURRENT_RUNS = 4

# Backstop auto-delete, in minutes, applied to every sandbox we create.
# Confirmed by testing that Daytona's own default is auto_delete_interval=-1
# (disabled) -- meaning a sandbox we fail to explicitly delete (e.g. the
# gateway process crashes between create() and the finally-block delete())
# would otherwise sit around indefinitely in STARTED state. Explicitly setting
# this means an orphaned sandbox still gets cleaned up on its own well within
# an hour, even if our own cleanup code never runs.
SANDBOX_AUTO_DELETE_MINUTES = 15

_executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_RUNS)
_jobs_lock = threading.Lock()
_jobs = {}  # run_id -> dict


class Status(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


def _set_job(run_id, **fields):
    with _jobs_lock:
        _jobs[run_id].update(fields)


def get_job(run_id):
    with _jobs_lock:
        job = _jobs.get(run_id)
        return dict(job) if job is not None else None


def submit_run(daytona_client, model_name, params):
    """
    Validate the request, create a job record in "queued" state, and hand off
    execution to the thread pool. Returns the run_id immediately -- callers
    poll GET /v1/runs/{run_id} for status/result, per the async-by-default API
    design in PLATFORM.md (every model goes through submit -> poll, regardless
    of how fast that particular model actually runs).
    """
    model = get_model_or_none(model_name)
    if model is None:
        return None, f"unknown model '{model_name}'"

    run_id = str(uuid.uuid4())
    with _jobs_lock:
        _jobs[run_id] = {
            "run_id": run_id,
            "model": model_name,
            "status": Status.QUEUED,
            "result": None,
            "error": None,
            "cached": False,
            # None when the model has no real intermediate signal (e.g.
            # hector -- confirmed by testing there's nothing to report, see
            # models.py). Only populated for models with supports_progress=True.
            "progress": None,
            "submitted_at": time.time(),
        }

    _executor.submit(_execute_run, daytona_client, run_id, model_name, model, params)
    return run_id, None


def _execute_run(daytona_client, run_id, model_name, model, params):
    _set_job(run_id, status=Status.RUNNING)

    cached_result = cache.get_cached(model_name, params)
    if cached_result is not None:
        _set_job(run_id, status=Status.SUCCEEDED, result=cached_result, cached=True, progress={"percent": 100})
        return

    sandbox = None
    try:
        image = Image.from_dockerfile(model["dockerfile"])
        create_params = CreateSandboxFromImageParams(
            image=image,
            name=f"{model_name}-run-{run_id[:8]}",
            auto_delete_interval=SANDBOX_AUTO_DELETE_MINUTES,
        )
        sandbox = daytona_client.create(create_params, timeout=600)

        if model.get("supports_progress"):
            exit_code, stdout = _run_with_progress(sandbox, run_id, model, params)
        else:
            exit_code, stdout = _run_blocking(sandbox, model, params)

        json_line = _last_json_line(stdout)

        if exit_code != 0 or json_line is None:
            _set_job(
                run_id,
                status=Status.FAILED,
                error={
                    "code": "model_run_failed",
                    "message": f"exit_code={exit_code}",
                    "stdout_tail": stdout[-2000:],
                },
            )
            return

        parsed = json.loads(json_line)
        if parsed.get("status") != "succeeded":
            _set_job(
                run_id,
                status=Status.FAILED,
                error={"code": "model_run_failed", "message": parsed.get("error", "unknown error")},
            )
            return

        cache.put_cached(model_name, params, parsed)
        _set_job(run_id, status=Status.SUCCEEDED, result=parsed, cached=False, progress={"percent": 100})

    except Exception as exc:  # noqa: BLE001 -- surface any failure as a job error, not a crashed worker
        _set_job(
            run_id,
            status=Status.FAILED,
            error={"code": "gateway_error", "message": str(exc)},
        )
    finally:
        # Always destroy the sandbox, success or failure -- never reused across
        # requests or tenants (see PLATFORM.md's per-tenant isolation checklist).
        if sandbox is not None:
            try:
                daytona_client.delete(sandbox)
            except Exception:
                pass


def _run_blocking(sandbox, model, params):
    """
    Plain blocking exec, used for models with no real progress signal (e.g.
    hector -- confirmed by testing there's nothing to report mid-run, and it
    finishes in well under a second anyway, so the simpler path is also the
    correct one here).
    """
    exec_result = sandbox.process.exec(
        "python3 /app/run.py",
        env={"SCENARIO_PARAMS": json.dumps(params)},
        timeout=model["exec_timeout_seconds"],
    )
    return exec_result.exit_code, exec_result.result or ""


def _run_with_progress(sandbox, run_id, model, params):
    """
    Session-based async execution + polling, for models whose run.py writes
    real progress to PROGRESS_FILE_PATH (see sandboxes/fair/run.py).

    Confirmed by direct testing that Daytona's session log APIs (both the
    polling `get_session_command_logs` and the async-callback
    `get_session_command_logs_async`) buffer ALL output until the command
    finishes -- they cannot be used to observe progress mid-run, no matter
    what the model prints. A direct filesystem read of a file the running
    process writes to (flushed + fsynced) does reflect live state, confirmed
    by testing: polling caught real intermediate values (e.g. 0% -> 21% ->
    84% -> 100%) while the process was still running.
    """
    session_id = f"run-{run_id[:8]}"
    sandbox.process.create_session(session_id)
    try:
        # No `env` param on session commands (confirmed via the SDK's
        # SessionExecuteRequest fields) -- pass it inline as a shell prefix
        # instead. Safe here: params are gateway-controlled JSON (scenario
        # names/lists), not arbitrary user shell input.
        command = f"SCENARIO_PARAMS='{json.dumps(params)}' python3 -u /app/run.py"
        resp = sandbox.process.execute_session_command(
            session_id, SessionExecuteRequest(command=command, run_async=True)
        )
        cmd_id = resp.cmd_id

        deadline = time.time() + model["exec_timeout_seconds"]
        exit_code = None
        while time.time() < deadline:
            try:
                raw = sandbox.fs.download_file(PROGRESS_FILE_PATH)
                if raw:
                    progress = json.loads(raw.decode())
                    _set_job(run_id, progress=progress)
            except Exception:
                pass  # file not written yet, or a transient read error -- not fatal

            cmd_info = sandbox.process.get_session_command(session_id, cmd_id)
            if cmd_info.exit_code is not None:
                exit_code = cmd_info.exit_code
                break

            time.sleep(PROGRESS_POLL_INTERVAL_SECONDS)

        if exit_code is None:
            raise TimeoutError(f"run.py did not finish within {model['exec_timeout_seconds']}s")

        logs = sandbox.process.get_session_command_logs(session_id, cmd_id)
        return exit_code, logs.stdout or ""
    finally:
        try:
            sandbox.process.delete_session(session_id)
        except Exception:
            pass


def _last_json_line(stdout: str):
    """
    run.py prints its JSON result as the last line of stdout, but some models
    (e.g. FAIR, which prints a progress bar and pooch download messages) write
    other things to stdout first. Scan from the end for the last line that
    looks like a JSON object, same approach used in the manual sandbox tests.
    """
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            return line
    return None
