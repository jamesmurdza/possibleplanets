# GCAM documentation

GCAM (the Global Change Analysis Model, https://github.com/JGCRI/gcam-core)
is an integrated assessment model this project investigated as a candidate
model. Unlike every other model here (plain pip/Pkg installs), GCAM is a
large C++17 project that has to be compiled from source, plus a separate
R-based data pipeline (`gcamdata`) that has to run once to generate its
input database before it can run at all. That made it a much bigger
undertaking than any other model added so far, so it gets its own
documentation set instead of a couple of lines in
`docs/sandbox-resource-experiments.md`.

**Status: works, not yet wired into the app.** GCAM builds, runs a full
21-period scenario (1975-2100) to completion, and is packaged into a
reusable Daytona snapshot (`gcam-production-v1`) and a public Docker Hub
backup (`possibleplanets/gcam:v1`). It is **not** yet integrated into
`apps/web/lib/models.ts`/`run.py` the way every other model is -- that's
the remaining work (see `known-gaps.md`).

## Files in this folder

- **`architecture.md`** -- how GCAM is actually structured (the two-stage
  split between `gcamdata` and `gcam.exe`), and why that split matters for
  how this project uses it.
- **`prerequisites.md`** -- what hardware/software/account access someone
  needs before attempting any of this.
- **`setup-guide.md`** -- the clean, prescriptive path: what a person
  should actually do, step by step, to get GCAM running, with realistic
  time estimates.
- **`trial-log.md`** -- the messy real history: everything tried, what
  worked, what didn't, and the resource/time cost of each attempt. Useful
  if something breaks and you need to know "has this exact error happened
  before."
- **`artifacts.md`** -- where the finished, working results actually live
  (Daytona snapshot, Docker Hub image, committed files in this repo) and
  how to use them directly without re-doing any of the above.
- **`known-gaps.md`** -- what's deliberately left unsolved or unintegrated,
  and why, so nobody re-discovers the same dead end twice.

## Quick orientation

If you just want to **run the already-working result**: see
`artifacts.md`. Nothing below needs to happen again.

If you need to **regenerate the input database** (upstream data changed, a
new bug needs patching): see `setup-guide.md` step 4, and
`sandboxes/gcam/runtime/README.md`'s "Regenerating" section for the exact
commands.

If you're trying to **understand why this took so much more effort than
every other model**: start with `architecture.md`, then `trial-log.md`.
