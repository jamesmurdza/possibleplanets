# OSCAR sandbox image
#
# guides/OSCAR.markdown uses Poetry (`poetry run install` -- almost certainly a
# typo for `poetry install`). This image skips Poetry entirely and pip-installs
# the exact dependency versions already pinned in the repo's pyproject.toml,
# which is simpler and gives the same reproducibility.
#
# pyproject.toml declares `requires-python = ">=3.10,<3.11"`. Confirmed by
# testing that the pinned dependency versions (xarray==2024.3.0 etc.) install
# and run fine on 3.11 too, but this image uses 3.10 to match what upstream
# actually declares and tested, rather than relying on that happening to work.
#
# IMPORTANT (confirmed by testing, not documented anywhere upstream): OSCAR is
# much slower than the other RCMs in this project. A single historical run
# (1750-2014, nMC=1) took ~210s and the SSP scenario run to 2100 took another
# ~145s on this sandbox's hardware -- roughly 6 minutes total for the smallest
# possible Monte Carlo sample (nMC=1). This is drastically slower than HECTOR
# (~2s) or FAIR (~21s) -- do not assume OSCAR is "light" like those.
#
# Build:  docker build -t oscar-sandbox:v2024.1 .
# Run:    docker run --rm oscar-sandbox:v2024.1 python3 run.py
#
# IMPORTANT (confirmed by testing a real run in a Daytona sandbox): OSCAR's
# own code (e.g. core_fct/fct_loadP.py) loads its data files with bare
# relative paths like 'input_data/parameters/...', relative to the process's
# CWD, not to __file__ -- so the OSCAR repo's checkout dir must be the CWD
# when it runs. The gateway (apps/gateway/jobs.py) always invokes
# `python3 /app/run.py`, the same path convention HECTOR/FAIR's images use,
# so run.py itself os.chdir()s into the cloned repo before importing
# anything from it, rather than this image deviating from that convention.
#
# IMPORTANT (confirmed by testing: production oscar runs started failing
# intermittently with `FileExistsError: [Errno 17] File exists:
# 'results/SSP_drivers/'`): run_scripts/get_SSP_drivers.py creates its
# output folder with the classic TOCTOU-racy
#   if not os.path.isdir(folder_out): os.mkdir(folder_out)
# instead of the atomic `os.makedirs(folder_out, exist_ok=True)` -- a real,
# reproducible upstream bug (confirmed directly: the exact same fresh
# snapshot/code failed on some runs and succeeded on others with no input
# difference), not something caused by anything in this project. Patched
# below, the same way sandboxes/twolayer/Dockerfile already patches an
# installed third-party source file post-clone.
#
# Pinned to the exact commit already confirmed working end-to-end (see
# lib/models.ts's model_version comment for how this was verified against
# the real, already-deployed snapshot) instead of floating to whatever
# `main` is today -- avoids pulling in unrelated upstream drift while
# fixing this one bug.

FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN git clone https://github.com/jamesmurdza/OSCAR.git oscar \
    && cd oscar && git checkout 2200dfd30a86a2560edfc301493298680cbf85a9

RUN pip install --no-cache-dir \
    xarray==2024.3.0 \
    netCDF4==1.6.5 \
    numpy==1.26.4 \
    scipy==1.13.0 \
    matplotlib==3.8.4 \
    networkx==3.3 \
    pandas==2.2.1

# See the module-level comment above: makes the output-folder creation in
# the installed OSCAR checkout atomic/race-safe instead of a racy
# check-then-create.
RUN python3 - <<'PATCH'
path = "/app/oscar/run_scripts/get_SSP_drivers.py"
with open(path) as f:
    src = f.read()
old = "if not os.path.isdir(folder_out):\n    os.mkdir(folder_out)"
new = "os.makedirs(folder_out, exist_ok=True)"
assert old in src, "expected patch target not found -- OSCAR's get_SSP_drivers.py may have changed"
src = src.replace(old, new)
with open(path, "w") as f:
    f.write(src)
PATCH

COPY run.py .

ENTRYPOINT ["python3", "run.py"]
