---
layout: post
title:  "How to run OSCAR in Python"
date:   2025-03-22 18:00:00 +0800
categories: RCM
---
How to run the OSCAR climate model:

## Run with Poetry

If necessary, download and install:
- [Git](https://git-scm.com/downloads)
- [Poetry](https://python-poetry.org/docs/)

Then, on a UNIX, macOS or Windows system run the commands:

```
git clone https://github.com/jamesmurdza/OSCAR.git
cd OSCAR
poetry run install
```

To run an example, run:
```
poetry run python run_scripts/basic_example_1.py
```

## Run with Docker

If necessary, download and install Docker: [Link](https://www.docker.com/products/docker-desktop/).

A prebuilt image is published on Docker Hub, so this doesn't require
cloning any repository or using Poetry -- just pull and run it directly:

```
docker pull possibleplanets/oscar
docker run --rm possibleplanets/oscar
```

This runs the SSP2-4.5 scenario with 1 Monte Carlo sample by default. To
pick a different scenario or sample size, pass `SCENARIO_PARAMS` as an
environment variable:

```
docker run --rm -e SCENARIO_PARAMS='{"scenario": "SSP5-8.5", "nMC": 1}' possibleplanets/oscar
```

Note: OSCAR is noticeably slower than the other models here -- expect
the smallest possible run to take a few minutes, not seconds.

## Video

(Coming soon.)
