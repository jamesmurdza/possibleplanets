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

Run with:
  uvicorn app:app --host 0.0.0.0 --port 8000
Requires `daytona_api_key` in the environment.
"""
import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from daytona import Daytona, DaytonaConfig

import jobs
from models import MODELS, get_model_or_none

app = FastAPI(title="Climate Models Gateway", version="0.1.0")

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
    }
