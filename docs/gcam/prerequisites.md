# Prerequisites

What you need before attempting any part of the GCAM setup.

## Account / platform access

- A Daytona account with:
  - Normal CPU sandbox access (every other model in this project already
    needs this).
  - **GPU sandbox access** -- only needed for the one-time `gcamdata`
    data-generation step (see below). Not needed to just *run* the
    already-built result. Confirm by checking
    `organizations/{id}/available-sandbox-classes` includes a GPU-capable
    class, or just try creating a sandbox with `resources.gpu: 1`.
  - A Docker Hub account + PAT, only if you want to also push/pull the
    public backup image (`possibleplanets/gcam`). Not required for the
    Daytona-only path.

## Hardware ceilings actually confirmed on this account

These are **this specific Daytona account's** real, tested limits, not
documented anywhere official -- discovered by directly requesting
rejected values:

| Sandbox type | CPU ceiling | Memory ceiling | Disk |
|---|---|---|---|
| Plain CPU sandbox | 4 vCPU (hard cap) | **8GB (hard cap)** -- 9-32GB all rejected | tested up to 20GB accepted; `disk: 12` is what's actually used |
| GPU-attached sandbox (`gpu:1`) | 4 vCPU (no higher tier observed) | up to at least 96GB accepted | same |

Swap is disabled at the cgroup level on this account
(`/sys/fs/cgroup/memory.swap.max = 0`) -- not a usable workaround for the
8GB ceiling.

**Why this matters:** `gcam.exe` itself (running against the pre-built
database) fits comfortably in the plain 8GB/4-CPU tier -- same as every
other model here. Only the one-time `gcamdata` R pipeline needs more than
8GB to complete, which is why that step specifically requires a
GPU-attached sandbox (purely for the higher memory ceiling that comes
with it -- the GPU itself does nothing for this workload; R's dplyr/tidyr
joins are CPU-only).

## Software (all handled inside the Dockerfiles -- listed here so you
know what's being installed and why)

For compiling `gcam.exe`:
- `build-essential`, `libboost-dev`, `libeigen3-dev`, `libtbb-dev`,
  `default-jdk` (Debian 12 apt packages all work as-is for this part).

For running `gcamdata`'s R pipeline:
- R **4.4+** specifically -- Debian 12's own `r-base` apt package is
  4.2.2, too old for `gcamdata`'s pinned `renv.lock` (`Matrix`, needed
  transitively by `drake`, requires R >= 4.4). Installed via
  [`rig`](https://github.com/r-lib/rig) rather than apt, because CRAN's
  own documented apt-repo key URL 404s.
- `default-jdk-headless` -- needed by `gcamdata` itself for an
  XML-conversion step (`system2("java", ...)`), undocumented as a
  `gcamdata`-side dependency anywhere official.
- `libharfbuzz-dev`, `libfribidi-dev`, and the `curl` *binary* (not just
  `libcurl-dev`) -- needed for `renv::restore()` to succeed; without
  them it fails on `textshaping`/`ragg` (pulled in transitively by
  `devtools`) or can't fetch package sources at all.

## Time budget to know going in

- Compiling `gcam.exe` from a cold clone: **~9 minutes** (cpu:4).
- `renv::restore()` for the R environment: **~400 seconds** (118
  packages).
- The one-time `gcamdata` pipeline itself: **~75 minutes** (see
  `setup-guide.md` and `trial-log.md` for why, and why that number isn't
  improvable much further within this account's constraints).
- Running `gcam.exe` for a full 21-period scenario: **~30 minutes**
  (cpu:4, plain 8GB sandbox -- the actual per-request-shaped cost once
  everything above is already done).

None of this needs to be repeated once the artifacts in `artifacts.md`
exist -- these numbers only matter if you're setting it up from scratch
or regenerating the database.
