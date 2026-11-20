# gcamdata patches

Two real upstream bugs found while test-running `gcamdata`'s R data
pipeline (`driver_drake()`) inside this project's 8GB sandbox ceiling --
see `docs/sandbox-resource-experiments.md`'s GCAM section for the full
investigation. Both are the same class of bug: a block meant to build a
small `iso`/`year` (or similar) grid for interpolation instead produces
a wildly larger accidental cross-product, because it chains
`repeat_add_columns()` calls on a dataframe that already contains the
column being "added". Each patch below replaces the buggy block with an
equivalent, correctly-sized version -- same inputs, same output columns,
same NA-filled grid, just without the accidental blow-up.

These patches are applied automatically by `sandboxes/gcam/gcamdata.Dockerfile`
(an inline `sed` for the Employment fix, `patch_population_hist.py` for
the Population_hist fix) every time that image builds and runs
`driver_drake()` -- the `.patch` files below are for human reading, not
executed directly. See `docs/gcam/provenance.md`'s Stage 1 for how this
fits into the full source-to-image pipeline, and
`sandboxes/gcam/runtime/README.md` for how to re-run this whole stage
if it's ever needed again.

## `employment.patch`

File: `input/gcamdata/R/zsocio_L100.Employment.R`

The ILO Labor Force Statistics (LFS) half of this chunk used
`left_join_error_no_match()` against a country/ISO mapping table, which
throws if any row fails to match. Some country labels in the raw ILO
employment CSV have no matching row in the mapping file (the mapping
only special-cases three known relabeling issues). The ILO Modelled
Estimates (ILOEST) half of the *same* chunk, a few lines below, already
handles this correctly with a plain `left_join()` + `filter(!is.na(iso))`.
Patch makes the LFS half match that pattern.

Without this patch: `driver()`/`driver_drake()` throws
`left_join_no_match: NA values in new data columns` and stops entirely
partway through the pipeline (this chunk is not resource-related --
reproduces on any run, not just under memory pressure).

## `population-hist.patch`

File: `input/gcamdata/R/zsocio_L100.Population_hist.R`

A block intended to build the full `iso` x `year` grid (for interpolating
historical population to all country/year combinations) instead chains
two `repeat_add_columns()` calls onto a dataframe that **already has**
both an `iso` and a `year` column -- each call multiplies the existing
row count by the number of unique values again, rather than producing
the ~21,600-row (country x year) grid actually intended. The result is
hundreds of millions of rows from what should be a small lookup table.
Patch replaces the whole block with `tidyr::complete(iso, year)`, which
is the standard one-line equivalent: expand to every combination of the
two columns' existing unique values, filling the rest with `NA` -- same
output, several orders of magnitude fewer rows.

Without this patch: `driver()`/`driver_drake()` reliably OOM-kills at
this exact chunk (confirmed via `/sys/fs/cgroup/memory.peak` pinned at
this account's 8GB ceiling), the first resource-related (not purely
logic-error) blocker hit in this pipeline.
