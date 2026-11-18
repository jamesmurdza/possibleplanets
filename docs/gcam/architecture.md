# GCAM architecture (as it matters for this project)

## Two separate programs, not one

GCAM is actually two distinct pieces of software layered on top of each
other:

1. **`gcamdata`** -- an R package. A one-time ETL pipeline
   (`driver()`/`driver_drake()`) that reads ~983 raw CSV files (385MB,
   shipped in the repo itself under `input/gcamdata/inst/extdata/`),
   joins/reshapes them through ~2087 chunks, and writes out GCAM's actual
   input database as ~221 XML files (5.2GB uncompressed, ~430MB
   compressed).
2. **`gcam.exe`** -- a C++17 program (compiled from `cvs/objects/`). The
   actual simulation model. It reads the XML files `gcamdata` produced
   and a small set of its own config/scenario XML files, then solves a
   multi-period economic equilibrium (1975-2100 in 5-year steps = 21
   periods for the reference scenario) and writes restart/output files.

These have completely different resource profiles. `gcamdata` is a
memory-hungry batch R job (see below). `gcam.exe` is CPU-bound,
comparatively light on memory, and runs against static data -- the same
general shape as every other model already in this project.

## Why the split matters: bake once, run many

Critically, `gcamdata`'s output is **not scenario-specific**. Confirmed by
diffing `configuration_ref.xml` against `configuration_ssp.xml`: both
reference the exact same set of generated XML files. Per-scenario
variation lives entirely in small separate `batch_*.xml` files (a handful
of KB each) layered on top at `gcam.exe` run time -- not in the expensive
generated database.

That means `gcamdata`'s pipeline only needs to run **once**, ever (or
again if upstream `gcamdata` data changes, or a bug fix changes its
output). It is not part of this project's normal per-request sandbox flow
at all. The expensive step is pre-baked; what runs per request is just
`gcam.exe` against a static, already-generated database -- cheap, fast,
and resource-light like every other model here.

This is the single most important fact about integrating GCAM: **don't
re-run `gcamdata` per request.** If a future feature needs something that
actually requires new data generation (see "What would require a
refresh" below), that's a rare, deliberate, expensive operation -- not
something to trigger from a user-facing code path.

## What would require a `gcamdata` refresh

- Upstream `gcam-core`/`gcamdata` raw data changes (a new release with
  updated CSVs).
- A new upstream bug needs patching in the R pipeline (as happened twice
  already -- see `trial-log.md`).
- The generated XML directory is simply missing/corrupted locally.

What does **not** require a refresh: selecting a different SSP scenario
(`batch_SSP1_*.xml` vs `batch_SSP5_*.xml` etc.) -- those are small files
read directly by `gcam.exe`, no regeneration needed. If this project's
eventual integration only exposes **scenario selection** (not raw
parameter tuning that would require different source data), the "bake it
once" architecture fully suffices long-term and the memory problem never
needs to be faced again in normal operation.

If a future requirement needs genuinely new *data* generation per
request (not just a different existing scenario file), that would reopen
the `gcamdata` memory problem on a per-request basis -- which is the
expensive, GPU-sandbox-requiring path documented in `trial-log.md`, not
something to do inside a normal request/response cycle.

## Resulting two-image split in this repo

- `sandboxes/gcam/gcamdata.Dockerfile` -- the one-time R builder image.
  Never used to serve a request. Only run manually, rarely, in a
  GPU-attached sandbox (for memory headroom, not GPU compute -- see
  `prerequisites.md`).
- `sandboxes/gcam/Dockerfile` -- the actual runtime image. Compiles
  `gcam.exe` from source (a normal multi-stage Docker build, same shape
  as any compiled-language model would need) and bakes in the
  already-generated XML database via `COPY` from
  `sandboxes/gcam/runtime/`. This is the image any real sandbox for this
  model would be built from.
