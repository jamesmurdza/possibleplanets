# FAIR sandbox image
#
# Based on guides/FAIR.markdown (Colab walkthrough). Unlike HECTOR, FAIR's install
# is a plain `pip install fair` -- no compiled extension or extra system packages
# have been confirmed necessary (not yet build-tested in this environment, since
# no Docker daemon is available here -- see PLATFORM.md build plan).
#
# TODO: once this image has been built and run successfully once, pin the exact
# fair/numpy/pandas versions that worked, the same way HECTOR's image pins
# pyhector==3.2.0.0 -- the guide itself doesn't pin anything, and a floating
# `pip install` can silently pull a different numpy/pandas on every rebuild.
#
# Build:  docker build -t fair-sandbox:v2024.1 .
# Run:    docker run --rm fair-sandbox:v2024.1 python3 run.py

FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    fair \
    numpy \
    pandas \
    matplotlib

COPY run.py .

ENTRYPOINT ["python3", "run.py"]
