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
"""
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from enum import Enum

from daytona import CreateSandboxFromImageParams, Image

from models import get_model_or_none

# Bounds how many sandbox creations can be in flight at once. This is the
# gateway's only concurrency control in the minimal version -- see PLATFORM.md's
# note that the queue's job is to rate-limit concurrent sandbox creation.
MAX_CONCURRENT_RUNS = 4

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
            "submitted_at": time.time(),
        }

    _executor.submit(_execute_run, daytona_client, run_id, model_name, model, params)
    return run_id, None


def _execute_run(daytona_client, run_id, model_name, model, params):
    _set_job(run_id, status=Status.RUNNING)

    sandbox = None
    try:
        image = Image.from_dockerfile(model["dockerfile"])
        create_params = CreateSandboxFromImageParams(
            image=image,
            name=f"{model_name}-run-{run_id[:8]}",
        )
        sandbox = daytona_client.create(create_params, timeout=600)

        exec_result = sandbox.process.exec(
            "python3 /app/run.py",
            env={"SCENARIO_PARAMS": json.dumps(params)},
            timeout=model["exec_timeout_seconds"],
        )

        stdout = exec_result.result or ""
        json_line = _last_json_line(stdout)

        if exec_result.exit_code != 0 or json_line is None:
            _set_job(
                run_id,
                status=Status.FAILED,
                error={
                    "code": "model_run_failed",
                    "message": f"exit_code={exec_result.exit_code}",
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

        _set_job(run_id, status=Status.SUCCEEDED, result=parsed)

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
