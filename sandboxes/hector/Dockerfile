# HECTOR sandbox image
#
# Bakes in what was discovered testing the guide manually (guides/HECTOR.markdown):
# the Colab instructions (`!pip install pyhector`) assume a pip-ready environment
# with Boost already present. On a bare Debian base, `pip install pyhector` fails
# compiling its C++ core with:
#   fatal error: boost/iostreams/filtering_stream.hpp: No such file or directory
# because pyhector builds Hector's C++ source from an sdist and needs Boost headers
# at build time. Installing libboost-all-dev fixes it.
#
# Build:  docker build -t hector-sandbox:v2024.1 .
# Run:    docker run --rm hector-sandbox:v2024.1 python3 run.py

FROM python:3.11-slim

# Boost headers + a C++ toolchain are required to build pyhector's compiled
# extension from source (confirmed necessary by testing; not mentioned in the
# upstream pyhector docs or in guides/HECTOR.markdown).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libboost-all-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pin pyhector's version once confirmed working, instead of floating to
# "latest" on every image rebuild, to keep results reproducible across builds.
RUN pip install --no-cache-dir pyhector==3.2.0.0

COPY run.py .

ENTRYPOINT ["python3", "run.py"]
