# TWOLAYER sandbox image (openscm-twolayermodel's TwoLayerModel).
#
# Unlike hector/fair/oscar, TwoLayerModel does not bundle its own emissions
# scenarios -- it's a bare energy-balance physics engine that takes an
# Effective Radiative Forcing (ERF) time series as its driver (confirmed by
# reading openscm_twolayermodel/base.py's run_scenarios() signature:
# driver_var defaults to "Effective Radiative Forcing"). rcmip-erf.csv is a
# trimmed copy of the RCMIP v4.0.0 forcing dataset -- the exact same file
# openscm-twolayermodel's own upstream notebook
# (docs/source/usage/running-scenarios.ipynb) uses as its worked example,
# not a dataset invented for this project. Trimmed here to the 8 rows this
# sandbox actually uses (region=World, variable=Effective Radiative Forcing,
# scenario in the same 8 SSPs sandboxes/fair/run.py exposes) to keep the
# image small -- the full upstream file is ~5MB across hundreds of
# variables/scenarios this sandbox never reads.
#
# Confirmed by direct testing on a bare Debian 12 host: the real driver was
# whichever pandas/numpy got installed, not the model's own logic --
# openscm-twolayermodel==0.2.3 (pinned 2021) calls the pre-pandas-2.0
# 3-argument form of `MultiIndex.set_levels([x], "level_name")`
# (openscm_twolayermodel/base.py:147-148), which pandas >=2.0 rejects
# ("set_levels() takes 2 positional arguments but 3 were given"). Pinning an
# old-enough pandas instead doesn't work either: pandas<2.0 wheels for
# Python 3.11 either don't exist (1.3.x/1.4.x predate cp311) or are missing
# `Index.infer_objects()` (1.5.3), which scmdata's own ScmRun.timeseries()
# needs. The fix applied below -- patching the two call sites to pass
# `level=` as a keyword -- is a 2-line forward-compat fix for a real,
# confirmed upstream/pandas-version mismatch, not a guess.
#
# Build:  docker build -t twolayer-sandbox:v2024.1 .
# Run:    docker run --rm twolayer-sandbox:v2024.1 python3 run.py

FROM python:3.11-slim

WORKDIR /app

# Pinned once confirmed working together by direct testing (see above) --
# not floated to "latest" on every rebuild.
RUN pip install --no-cache-dir \
    pandas==2.0.3 \
    numpy==1.24.4 \
    openscm-twolayermodel==0.2.3

# See the module-level comment above: patches the two MultiIndex.set_levels
# call sites in the installed package to pass `level=` as a keyword,
# matching pandas>=2.0's signature.
RUN python3 - <<'PATCH'
import re
path = "/usr/local/lib/python3.11/site-packages/openscm_twolayermodel/base.py"
with open(path) as f:
    src = f.read()
patched = (
    src
    .replace('out.index.set_levels([unit], "unit")', 'out.index.set_levels([unit], level="unit")')
    .replace('out.index.set_levels([variable], "variable")', 'out.index.set_levels([variable], level="variable")')
)
assert patched != src, "expected patch targets not found -- openscm-twolayermodel source may have changed"
with open(path, "w") as f:
    f.write(patched)
PATCH

COPY rcmip-erf.csv .
COPY run.py .

ENTRYPOINT ["python3", "run.py"]
