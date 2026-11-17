"""
Model registry for the gateway.

Minimal version (see PLATFORM.md): no cross-model normalization. Each model's
entry just points at the Dockerfile that defines its sandbox image and lists the
model's own native scenario identifiers, exactly as confirmed working by manual
testing (sandboxes/hector, sandboxes/fair). Adding OSCAR/DICE/MAGICC later is a
matter of adding another entry here once that model's image has been built and
tested the same way.
"""
from pathlib import Path

SANDBOXES_DIR = Path(__file__).resolve().parent.parent.parent / "sandboxes"

MODELS = {
    "hector": {
        "family": "RCM",
        "dockerfile": str(SANDBOXES_DIR / "hector" / "Dockerfile"),
        # Confirmed scenario names from sandboxes/hector/run.py's SUPPORTED_SCENARIOS.
        "scenarios": ["ssp119", "ssp126", "ssp245", "ssp370", "ssp585"],
        # run.py expects a single scenario string under "scenario".
        "params_shape": "scenario",
        # Measured: warm sandbox start ~1.3s, run ~2s (see timing notes).
        "exec_timeout_seconds": 60,
        # Confirmed by testing: pyhector's run() has no progress hook, writes
        # no log file, and completes in well under a second -- there is no
        # real intermediate signal to report. Runs via plain blocking exec();
        # progress stays null rather than faking an estimate (see jobs.py).
        "supports_progress": False,
    },
    "fair": {
        "family": "RCM",
        "dockerfile": str(SANDBOXES_DIR / "fair" / "Dockerfile"),
        # Native SSP scenarios used in guides/FAIR.markdown's example.
        "scenarios": [
            "ssp119",
            "ssp126",
            "ssp245",
            "ssp370",
            "ssp434",
            "ssp460",
            "ssp534-over",
            "ssp585",
        ],
        # run.py expects a list of scenarios under "scenarios".
        "params_shape": "scenarios",
        # Measured: warm sandbox start ~1.2s, run ~21s (66 parallel configs).
        "exec_timeout_seconds": 180,
        # run.py monkey-patches FAIR's own tqdm progress bar (confirmed real,
        # by reading FAIR's source) to write /tmp/progress.json as it runs.
        # jobs.py reads that file directly via the sandbox filesystem API,
        # since Daytona's session log APIs were confirmed (by testing) to
        # buffer all output until the command finishes and can't be used for
        # live progress.
        "supports_progress": True,
    },
    "oscar": {
        "family": "RCM",
        "dockerfile": str(SANDBOXES_DIR / "oscar" / "Dockerfile"),
        # Confirmed native scenario names from sandboxes/oscar/run.py's
        # SUPPORTED_SCENARIOS -- AR6-style marker SSPs, NOT the "ssp245"-style
        # names HECTOR/FAIR use. No cross-model taxonomy mapping (PLATFORM.md).
        "scenarios": [
            "SSP1-1.9",
            "SSP1-2.6",
            "SSP2-4.5",
            "SSP3-7.0",
            "SSP3-7.0-LowNTCF",
            "SSP4-3.4",
            "SSP4-6.0",
            "SSP5-3.4-OS",
            "SSP5-8.5",
        ],
        # run.py expects a single scenario string under "scenario".
        "params_shape": "scenario",
        # Measured end-to-end against a real Daytona sandbox (see
        # sandboxes/oscar/Dockerfile): ~477s total at nMC=1, the smallest
        # possible sample. Generous buffer above that measured total.
        "exec_timeout_seconds": 700,
        # Confirmed by reading OSCAR's own source (core_fct/cls_main.py):
        # its main loop prints a real "year = <N>" line once per simulated
        # year. sandboxes/oscar/run.py intercepts those specific writes (not
        # a synthetic estimate) and reports progress against a real total
        # step count computed from the actual forcing data -- same
        # file-polling mechanism as fair's tqdm-based signal.
        "supports_progress": True,
        # Confirmed by testing: OSCAR gets OOM-killed (exit code 137) while
        # loading its parameter files on the default sandbox size. 8GiB/4CPU
        # was confirmed sufficient for a full run.
        "resources": {"cpu": 4, "memory": 8, "disk": 10},
    },
    "dice": {
        "family": "IAM",
        "dockerfile": str(SANDBOXES_DIR / "dice" / "Dockerfile"),
        # run.jl's SCENARIO_MAP keys -- DICE.jl's own named policy scenarios
        # (Scenarios.jl), not an emissions-pathway taxonomy like the RCMs'
        # SSP names. No cross-model mapping (PLATFORM.md).
        #
        # Only base/optimal, NOT the full Scenarios.jl list -- confirmed by
        # testing (a real failed run) that DICE.jl only implements these two
        # for the v2016R2 version run.jl uses; the others (Limit2Degrees,
        # Stern, SternCalibrated, Copenhagen) are v2013R-RockyRoad-only and
        # error out against v2016R2. See run.jl's SCENARIO_MAP comment.
        "scenarios": ["base", "optimal"],
        # run.jl expects a single scenario string under "scenario".
        "params_shape": "scenario",
        # Non-Python runtime -- the gateway's default "python3 /app/run.py"
        # doesn't apply here. See jobs.py's DEFAULT_RUN_COMMAND.
        "run_command": "julia /app/run.jl",
        # Measured against a real Daytona sandbox: ~31s (mostly Julia/JuMP
        # JIT warmup; the actual Ipopt solve is ~2-3s, confirmed by the
        # solver's own "Total seconds in IPOPT" report). Generous buffer.
        "exec_timeout_seconds": 120,
        # Confirmed by reading DICE.jl's solve(): no progress hook exposed to
        # callers (Ipopt's own iteration log goes straight to stdout, not a
        # file, and Daytona's session log APIs buffer stdout until the
        # command finishes -- same limitation already confirmed for hector/
        # fair). Nothing real to report mid-run via the file-polling
        # mechanism used elsewhere, so this stays False.
        "supports_progress": False,
    },
    # "magicc": not yet built/tested.
}


def get_model_or_none(model: str):
    return MODELS.get(model)
