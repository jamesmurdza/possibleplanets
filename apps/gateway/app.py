"""
Minimal API gateway over the model sandboxes (PLATFORM.md).

Endpoints:
  GET  /v1/models                       - list available models
  GET  /v1/models/{model}/schema        - that model's native scenario list
  POST /v1/models/{model}/runs          - submit a run, returns {run_id, status}
  GET  /v1/runs/{run_id}                - poll for status/result

Every run is async regardless of model speed, and every run gets its own fresh
Daytona sandbox that is destroyed after use -- see jobs.py and PLATFORM.md for
why. This is the minimal version: only hector and fair are registered in
models.py so far (OSCAR/DICE/MAGICC come later, per the build plan).

Results are cached by (model, params) in Postgres (see cache.py) -- a repeat
request for the same model+params returns instantly instead of spinning up
another sandbox. Caching is optional: if DATABASE_URL isn't set, the gateway
runs exactly as before, just without caching.

Run with:
  uvicorn app:app --host 0.0.0.0 --port 8000
Requires `daytona_api_key` (or `DAYTONA_API_KEY`) in the environment.
Optional: `DATABASE_URL` (a Postgres connection string) to enable caching.
"""
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from daytona import Daytona, DaytonaConfig

import cache
import jobs
from models import MODELS, get_model_or_none

app = FastAPI(title="Climate Models Gateway", version="0.1.0")


@app.on_event("startup")
def _startup():
    # Best-effort: if DATABASE_URL isn't set or the DB is unreachable, caching
    # just stays disabled -- see cache.py. Never blocks the gateway starting.
    cache.init_cache()

# CORS is opt-in, off by default. When this runs behind the Daytona sandbox's
# proxy (the default way this is accessed -- see apps/dashboard), the proxy
# itself already injects a correct, origin-specific Access-Control-Allow-Origin
# header. Adding our own on top (even with the same value) makes the response
# carry the header twice, which browsers reject outright as an invalid CORS
# response -- confirmed by testing: a wildcard "*" from this middleware plus
# the proxy's echoed origin produced two values and every browser fetch from
# the dashboard failed with "Failed to fetch" / a CORS policy error.
#
# Set ENABLE_CORS=1 only when running the gateway directly (not through the
# Daytona proxy) with the dashboard on a different origin/port, e.g. plain
# local dev with `python -m http.server` and `uvicorn` on different ports.
if os.environ.get("ENABLE_CORS") == "1":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

_daytona_client = None


def get_daytona_client():
    global _daytona_client
    if _daytona_client is None:
        api_key = os.environ.get("daytona_api_key") or os.environ.get("DAYTONA_API_KEY")
        if not api_key:
            raise RuntimeError("daytona_api_key not set in environment")
        _daytona_client = Daytona(DaytonaConfig(api_key=api_key))
    return _daytona_client


class RunRequest(BaseModel):
    # Model-native params, passed through untouched to the sandbox as
    # SCENARIO_PARAMS -- no cross-model normalization in the minimal version
    # (see PLATFORM.md's output-shape decision, applied here to input too).
    # e.g. hector: {"scenario": "ssp126"}, fair: {"scenarios": ["ssp126"]}
    params: dict = {}


@app.get("/v1/models")
def list_models():
    return {
        "models": [
            {
                "model": name,
                "family": meta["family"],
                "scenarios": meta["scenarios"],
            }
            for name, meta in MODELS.items()
        ]
    }


@app.get("/v1/models/{model}/schema")
def model_schema(model: str):
    meta = get_model_or_none(model)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"unknown model '{model}'")
    return {
        "model": model,
        "family": meta["family"],
        "scenarios": meta["scenarios"],
        "params_shape": meta["params_shape"],
    }


@app.post("/v1/models/{model}/runs")
def create_run(model: str, body: RunRequest):
    if get_model_or_none(model) is None:
        raise HTTPException(status_code=404, detail=f"unknown model '{model}'")

    run_id, error = jobs.submit_run(get_daytona_client(), model, body.params)
    if error:
        raise HTTPException(status_code=400, detail=error)
    return {"run_id": run_id, "status": jobs.Status.QUEUED}


@app.get("/v1/runs/{run_id}")
def get_run(run_id: str):
    job = jobs.get_job(run_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown run_id '{run_id}'")
    return {
        "run_id": job["run_id"],
        "model": job["model"],
        "status": job["status"],
        "result": job["result"],
        "error": job["error"],
        # True if this result came from the cache instead of a real sandbox
        # run -- surfaced so API consumers (and the dashboard) aren't misled
        # about whether a run actually executed, per PLATFORM.md's preference
        # for being explicit about what happened rather than hiding mechanics.
        "cached": job.get("cached", False),
    }
