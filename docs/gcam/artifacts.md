# Artifacts: where the working result actually lives

If you just want to **use** GCAM as it stands today, nothing in
`setup-guide.md` or `trial-log.md` needs to happen again. Here's what
already exists and how to use it directly.

## 1. Daytona snapshot: `gcam-production-v1`

The primary artifact. Built from `sandboxes/gcam/Dockerfile`, with:
- `cpu: 4, memory: 8, disk: 12, gpu: 0` -- plain, cheap tier, same shape
  as every other model in this project.
- Contains: the compiled `gcam.exe` (294MB), the full generated XML
  input database (221 files, 5.2GB), and the small supporting config
  dirs -- everything needed to run `gcam.exe -C configuration_ref.xml`
  immediately.

Create a sandbox from it:
```js
const sandbox = await daytona.create(
  { snapshot: 'gcam-production-v1', autoDeleteInterval: <minutes> },
  { timeout: 120 },
)
```
Note: you cannot pass `resources` when creating from a named snapshot --
it inherits the snapshot's own baked-in profile above.

## 2. Docker Hub backup: `possibleplanets/gcam`

A public, independent backup that survives even if the Daytona snapshot
is ever lost or expires -- Daytona's own internal registry backing
snapshots is not externally pullable (confirmed: direct pulls return
401).

```
docker pull possibleplanets/gcam:v1
# also tagged :latest
```

Same paths inside: `/app/gcam-core/exe/gcam.exe`,
`/app/gcam-core/input/gcamdata/xml/`.

## 3. Files committed in this repo

- `sandboxes/gcam/Dockerfile` -- the real runtime image definition
  (compiles `gcam.exe` from source, bakes in the pre-generated data from
  `runtime/`).
- `sandboxes/gcam/gcamdata.Dockerfile` -- the one-time data-generation
  builder image (not used to serve runs).
- `sandboxes/gcam/patch_population_hist.py`, inline `sed` in
  `gcamdata.Dockerfile` -- the two real upstream bug fixes, applied
  automatically on every `gcamdata.Dockerfile` build.
- `sandboxes/gcam/patches/*.patch`, `patches/README.md` -- human-readable
  unified-diff versions of the same two fixes, for reading only (not what
  actually gets applied -- the Dockerfile's sed/python does that).
- `sandboxes/gcam/runtime/` -- small committed config (`exe/` configs,
  `input/{solution,policy,climate}/`, ~1.6MB total) plus two **gitignored**
  large files that must exist locally before building
  `sandboxes/gcam/Dockerfile`:
  - `runtime/input/gcamdata/xml/` (5.2GB, 221 files) -- the generated
    database.
  - `runtime/exe/gcam.exe` (294MB) -- kept locally only as a build input
    for the Docker Hub backup image (so it doesn't need recompiling on a
    memory-constrained machine); not part of the committed Dockerfile's
    own build path (that still compiles from source).
- `sandboxes/gcam/runtime/README.md` -- exact regeneration instructions
  for the gitignored files above, if ever needed.

## What's NOT here yet

GCAM is not registered in `apps/web/lib/models.ts` or wired into
`run.py` -- it doesn't show up in the app's model list yet. See
`known-gaps.md`.
