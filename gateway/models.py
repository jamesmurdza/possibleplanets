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

SANDBOXES_DIR = Path(__file__).resolve().parent.parent / "sandboxes"

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
    },
    # "oscar": not yet built/tested -- see PLATFORM.md build plan.
    # "dice": not yet built/tested.
    # "magicc": not yet built/tested.
}


def get_model_or_none(model: str):
    return MODELS.get(model)
