# FAIR sandbox image
#
# Based on guides/FAIR.markdown (Colab walkthrough). Unlike HECTOR, FAIR's install
# is a plain `pip install fair` -- no compiled extension or extra system packages
# were needed. Build/run-tested successfully via a real Daytona sandbox (see
# PLATFORM.md); versions below are pinned to what was confirmed working.
#
# Also note: the run.py adapted from this guide fixes a real bug found during
# testing -- the guide's `df_volcanic[1749:]` is positional, not label-based,
# slicing (since the index is fractional-year floats), which silently selects
# the wrong rows and crashes downstream. See the NOTE in run.py.
#
# Build:  docker build -t fair-sandbox:v2024.1 .
# Run:    docker run --rm fair-sandbox:v2024.1 python3 run.py

FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    fair==2.2.5 \
    numpy==2.4.6 \
    pandas==3.1.1 \
    matplotlib==3.11.2

COPY run.py .

ENTRYPOINT ["python3", "run.py"]
