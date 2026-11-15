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

FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN git clone --depth 1 https://github.com/jamesmurdza/OSCAR.git oscar

WORKDIR /app/oscar

RUN pip install --no-cache-dir \
    xarray==2024.3.0 \
    netCDF4==1.6.5 \
    numpy==1.26.4 \
    scipy==1.13.0 \
    matplotlib==3.8.4 \
    networkx==3.3 \
    pandas==2.2.1

COPY run.py .

ENTRYPOINT ["python3", "run.py"]
