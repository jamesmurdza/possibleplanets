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

**Status: wired into the app.** GCAM builds, runs a full 21-period
scenario (1975-2100) to completion, is packaged into a reusable Daytona
snapshot (`gcam-production-v6`) and a public Docker Hub backup
(`possibleplanets/gcam:v1`), and is now registered in
`apps/web/lib/models.ts` with a real `sandboxes/gcam/run.py` entrypoint,
the same way every other model is. Only one scenario (`"Reference"`) is
exposed so far -- see `known-gaps.md` for why, and what's left to widen
that. See `oom-fix.md` for why the snapshot is on v5, not v1/v2/v3/v4,
and `config-overrides.md` for v5's own general config-override feature.

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
- **`oom-fix.md`** -- the intermittent-OOM-at-the-final-periods bug:
  diagnosis, live measurements, the `max-parallelism` fix, and how the
  fix was deployed as a new snapshot without re-running the expensive
  `gcamdata` step.
- **`config-overrides.md`** -- the general `config_overrides` mechanism
  (v5): override ANY existing value in `configuration_ref.xml` per
  request, no new snapshot needed per knob.

## Quick orientation

If you just want to **run the already-working result**: see
`artifacts.md`. Nothing below needs to happen again.

If you need to **regenerate the input database** (upstream data changed, a
new bug needs patching): see `setup-guide.md` step 4, and
`sandboxes/gcam/runtime/README.md`'s "Regenerating" section for the exact
commands.

If you're trying to **understand why this took so much more effort than
every other model**: start with `architecture.md`, then `trial-log.md`.
