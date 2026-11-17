# WORLD3 sandbox image (pyworld3's World3 -- the "Limits to Growth" system-
# dynamics model, ported to Python/numpy).
#
# Confirmed by direct testing on a bare Debian 12 host (no Docker daemon
# available in the authoring environment, same situation as sandboxes/fair):
# `pip install pyworld3` needs no compiled extension (pure Python + numpy,
# unlike hector's pyhector), and a full run (1900-2100, fast mode) completes
# in well under a second.
#
# Build:  docker build -t world3-sandbox:v2024.1 .
# Run:    docker run --rm world3-sandbox:v2024.1 python3 run.py

FROM python:3.11-slim

WORKDIR /app

# Pinned once confirmed working, not floated to "latest" on every rebuild.
RUN pip install --no-cache-dir pyworld3==1.1

COPY run.py .

ENTRYPOINT ["python3", "run.py"]
