# MAGICC sandbox image
#
# Based on guides/MAGICC.markdown's Colab walkthrough (pymagicc wrapping the
# MAGICC6 binary via Wine). Confirmed build/run-tested directly on a Debian
# 12 host (no Docker daemon available in the authoring environment, so this
# is the same "install these exact packages, run it for real" verification
# used elsewhere, just done on bare Debian instead of inside a container --
# see PLATFORM.md build plan):
#
#   dpkg --add-architecture i386 && apt-get install wine wine32 wine64
#   pip install pymagicc
#
# Two real fixes found during that testing, neither mentioned in
# guides/MAGICC.markdown:
#
#   1. --no-install-recommends matters here: the Debian "wine" metapackage's
#      recommended deps pull in ~800 extra packages (gstreamer, mesa, GUI
#      toolkits, etc.) that MAGICC6.exe -- a plain console binary -- never
#      touches. Installing with --no-install-recommends (confirmed by
#      testing: same successful MAGICC6 run, ~5 packages instead of ~800)
#      keeps the image a fraction of the size.
#   2. pymagicc's actual pip dependency resolution currently pulls a
#      too-new xarray (2026.x) whose scmdata (a pymagicc dependency) isn't
#      compatible with: importing pymagicc crashes immediately with
#      `AttributeError: module 'xarray.computation.ops' has no attribute
#      'inject_reduce_methods'`. Confirmed fixed by pinning xarray to the
#      last version confirmed to import and run cleanly (2023.12.0).
#
# The MAGICC6 binary itself ships inside the pymagicc pip package
# (pymagicc/MAGICC6/run/magicc6.exe) -- no separate binary download step
# needed, confirmed present after `pip install`.
#
# Build:  docker build -t magicc-sandbox:v2024.1 .
# Run:    docker run --rm magicc-sandbox:v2024.1 python3 run.py

FROM python:3.11-slim

RUN dpkg --add-architecture i386 && apt-get update && \
    apt-get install -y --no-install-recommends wine wine32 wine64 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pinned once confirmed working together -- see the xarray note above.
RUN pip install --no-cache-dir \
    pymagicc==2.1.5 \
    "xarray==2023.12.0"

COPY run.py .

ENTRYPOINT ["python3", "run.py"]
