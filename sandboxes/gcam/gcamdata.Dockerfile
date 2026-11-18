# gcamdata builder image -- NOT the runtime image for this project.
#
# This image exists for exactly one purpose: generate GCAM's XML input
# database (the ~78 files under input/gcamdata/xml/) by running gcamdata's
# R data pipeline (driver_drake()) ONE TIME, outside the normal per-request
# sandbox flow. See docs/sandbox-resource-experiments.md's GCAM section for
# the full investigation this image is built from.
#
# gcamdata's output is NOT scenario-specific -- confirmed by diffing
# configuration_ref.xml against configuration_ssp.xml: both reference the
# exact same input/gcamdata/xml/ files, with per-scenario variation living
# entirely in small separate "batch" XML files layered on top. So this only
# needs to run once, ever (or again if gcam-core/gcamdata's upstream data
# changes, or this image's patches change) -- not per sandbox, per request,
# or per scenario. The resulting XML files get committed into
# sandboxes/gcam/xml/ and COPY'd into the real runtime Dockerfile; this
# image itself is never used to serve a model run.
#
# Why this needs its own image instead of running ad hoc in a throwaway
# sandbox: driver_drake() genuinely needs more than this account's 8GB
# CPU-sandbox ceiling to complete (see docs) -- so this gets built and run
# in a GPU-attached sandbox purely to unlock a higher memory ceiling (GPU
# sandboxes aren't capped at 8GB the way CPU-only ones are). The GPU itself
# does nothing here; R's dplyr/tidyr joins are CPU-only. This is strictly
# a memory-ceiling workaround, not GPU acceleration.
#
# Two real upstream gcamdata bugs patched here (see patches/README.md for
# the full explanation of each):
#   - zsocio_L100.Employment.R: a left_join_error_no_match() throws on
#     unmapped ILO country labels; fixed to match the tolerant left_join()
#     pattern the very next block in the same file already uses.
#   - zsocio_L100.Population_hist.R: a grid-building block chains two
#     repeat_add_columns() calls onto data that already has both columns
#     being added, squaring the row count into the hundreds of millions
#     instead of the intended ~21,600-row grid; replaced with the
#     equivalent tidyr::complete(iso, year).
#
# Build:  docker build -f gcamdata.Dockerfile -t gcamdata-builder .
# Run:    docker run --rm -v $(pwd)/xml-output:/app/gcam-core/input/gcamdata/xml \
#           gcamdata-builder
# (the CMD below runs driver_drake() and leaves its XML output in place for
# a bind mount or `docker cp` to pull out)

FROM debian:12-slim

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    git \
    curl \
    ca-certificates \
    python3 \
    default-jdk-headless \
    libcurl4-openssl-dev \
    libssl-dev \
    libxml2-dev \
    zlib1g-dev \
    libfontconfig1-dev \
    libfreetype6-dev \
    libpng-dev \
    libtiff5-dev \
    libjpeg-dev \
    gfortran \
    pkg-config \
    libharfbuzz-dev \
    libfribidi-dev \
    && rm -rf /var/lib/apt/lists/*

# R 4.2.2 (Debian 12's own r-base) is too old -- gcamdata's renv.lock pins
# packages (Matrix, transitively required by drake) that need R >= 4.4.
# CRAN's own documented apt-repo key URL 404s as of this writing, so this
# uses rig (https://github.com/r-lib/rig) to fetch a prebuilt R 4.4.3
# directly from Posit's CDN instead.
RUN curl -fsSL https://github.com/r-lib/rig/releases/download/v0.11.1/rig-linux-x86_64-0.11.1.tar.gz -o /tmp/rig.tar.gz \
    && tar -xzf /tmp/rig.tar.gz -C /usr/local \
    && rm /tmp/rig.tar.gz \
    && rig add 4.4

WORKDIR /app

RUN git clone --depth 1 --filter=blob:none --sparse https://github.com/JGCRI/gcam-core.git /app/gcam-core \
    && cd /app/gcam-core && git sparse-checkout set input/gcamdata

# Applied directly (not via patches/*.patch -- those are for human reading;
# this is the exact live-tested fix, byte-for-byte).
RUN sed -i '0,/left_join_error_no_match(ILO_country_iso_mapping, by = "country")/{s/left_join_error_no_match(ILO_country_iso_mapping, by = "country")/left_join(ILO_country_iso_mapping, by = "country") %>% filter(!is.na(iso))/}' \
    /app/gcam-core/input/gcamdata/R/zsocio_L100.Employment.R

COPY patch_population_hist.py /tmp/
RUN python3 /tmp/patch_population_hist.py

WORKDIR /app/gcam-core/input/gcamdata

RUN R -e 'install.packages("renv", repos="https://cloud.r-project.org")' \
    && R -e 'renv::restore(confirm=FALSE)'

# jobs=1 + memory_strategy="autoclean" is load-bearing: default drake
# parallelism keeps multiple chunks' output resident in memory at once,
# which is strictly worse for this memory-bound pipeline. Sequential +
# autoclean is what got furthest (127 XML files) within 8GB in testing;
# this image's whole point is to remove that ceiling via GPU-attached
# memory instead, but there's no reason to also fight drake's own
# scheduling on top of that.
CMD ["R", "-e", "devtools::load_all(); driver_drake(jobs=1, memory_strategy='autoclean', garbage_collection=TRUE, caching='worker')"]
