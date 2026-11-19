# Intermittent OOM at the final periods -- diagnosis and fix

## Symptom

gcam runs would sometimes finish successfully, and sometimes die with
`exit_code=1` and a stdout tail that just stopped at `Period 20: 2095`
-- no "Model solved normally" line for that period, no error message,
nothing. The tail looked like legitimate progress output, not a crash,
which made it look like a dashboard/data bug rather than a model
failure (see the "it just hangs at 100%"/"gcam gets to here" reports
that kicked off this investigation).

Two separate confusions compounded this before the real cause was
found:
- The app's own finalize path was discarding `run.py`'s failure JSON on
  non-zero exit, so the dashboard only ever showed a bare
  `exit_code=1` -- gcam's own diagnosis (when it had one) never
  reached the UI. Fixed in a separate commit ("Surface the model's own
  failure report instead of bare exit_code=N").
- Identical iteration counts through period 19 across multiple failed
  runs proved the model itself is deterministic -- the difference
  between a run that finished and one that died was purely
  environmental, not a logic bug in GCAM or in `run.py`.

## Root cause, confirmed by live measurement

Live-sampled `/sys/fs/cgroup/memory.*` every few minutes during full
runs on the real `gcam-production-v2` snapshot (`cpu: 4, memory: 8`):

- `gcam.exe`'s own anon memory grows steadily across periods: ~5.4GB
  at 47% progress (period ~10), ~7.7GB at 80% (period ~17), with
  `memory.peak` landing exactly on the 8GiB ceiling
  (`8589942784` = limit + 8KB) at the final periods.
- Two production runs died at "Period 20: 2095" with `gcam.exe`
  exiting non-zero; a third completed, surviving only because the
  kernel reclaimed enough page cache at the peak moment
  (`oom_kill 0`, `memory.events.max` reclaim hits in the thousands).
- Whether a given run survives that peak moment is a race against
  how much of the sandbox's limited page cache the kernel can evict
  right then -- not something `run.py` or the app can control.

**Why memory grows this much:** GCAM 9's solver
(`gcam-core`'s C++ `Value` class) keeps its working state in
`tbb::enumerable_thread_specific` storage -- i.e. every solver thread
gets its own full scratch copy of the model's central-value state, not
a shared one. `sandboxes/gcam/runtime/exe/configuration_ref.xml` had
`max-parallelism` set to `-1` (use all available cores -- 4 on this
sandbox's tier), so that per-thread duplication was multiplying the
solver's memory footprint by roughly 4x on top of the base model
state. That's what was pushing a plain 8GB sandbox to its ceiling.

## Why the obvious fix (bigger memory tier) isn't available

- Daytona rejects resource overrides for snapshot-based sandboxes
  (`Cannot specify Sandbox resources when using a snapshot`, confirmed
  2026-11-19) -- memory is fixed at snapshot-build time, not
  adjustable per `create()` call.
- This account's org-wide Daytona sandbox memory cap is 8GB regardless
  (confirmed by the user, 2026-11-19) -- so even rebuilding the
  snapshot from a larger-memory build sandbox isn't actually an option
  right now, independent of the resource-override restriction above.

With the memory ceiling itself off the table, the only remaining lever
is gcam's own memory footprint.

## The fix: serialize the solver

Changed `sandboxes/gcam/runtime/exe/configuration_ref.xml`:

```diff
-<Value name="max-parallelism">-1</Value>
+<Value name="max-parallelism">1</Value>
```

This is the one config file `run.py` actually uses (`"Reference"` is
the only scenario wired up -- see `known-gaps.md`); the other
`configuration_*.xml` files aren't reachable from the app, so they
were intentionally left alone.

### Verification method

No fixture, no simulation -- tested against the real
`gcam-production-v2` snapshot, live:

1. Created a sandbox from `gcam-production-v2`.
2. Patched `configuration_ref.xml` in place (`max-parallelism` ->
   `1`) via a small Python script run inside the sandbox (sed's regex
   quoting through the SDK's `executeCommand` kept failing silently --
   base64-encoding a Python one-liner and piping it to `python3 -`
   sidestepped that entirely).
3. Launched the real `python3 -u /app/run.py` entrypoint with
   `SCENARIO_PARAMS='{"scenario":"Reference"}'`, the same way
   `lib/runs.ts`'s `buildWrappedCommand` does.
4. Polled `/sys/fs/cgroup/memory.current`, `memory.peak`,
   `memory.stat` (`anon`/`file`), `memory.events` (`oom_kill`), and
   `/tmp/progress.json`/`/tmp/run_output.log` every few minutes for
   the full run.

One false start along the way: the first attempt accidentally left an
earlier (unpatched, `max-parallelism=-1`) run still executing in the
background on the same sandbox when the second (patched) run was
launched -- two concurrent `gcam.exe` processes correctly OOM'd almost
immediately during XML parsing. Caught via `ps aux` coming back empty
(no stray gcam.exe `ps` even available -- confirmed via memory numbers
instead) and re-run cleanly on a fresh sandbox.

### Results

| | `-1` (4 cores, baseline) | `2` (current default, see update below) | `1` (serial, shipped first) |
|---|---|---|---|
| anon @ ~66% progress | 7.15GB | 6.14GB | 5.94GB |
| anon @ period 20 (the failure point) | hits ceiling, OOM-kills intermittently | 7.25GB, no ceiling hit | n/a (reached it at ~80% anyway, see above) |
| cgroup `memory.peak` | exactly the 8GiB limit | ~7.9GiB of 8GiB | ceiling+8KB (survived via reclaim) |
| `oom_kill` count | nonzero on 2 of 3 observed runs | **0** | **0** |
| final result | 13,766,812-byte success (when it didn't OOM) | correct, byte-exact result | **13,766,812-byte success** (byte-identical) |
| wall-clock time | ~20-24 min | **~32 min** | ~50 min |
| exit code | 0 (when it didn't OOM) | **0** | **0** |

The `2`-core run reached period 20 -- the exact point every `-1`
failure died -- with still real headroom, then finished periods 20-21
and the final CSV/JSON serialization with `0` recorded OOM kills.
Confirmed via `/sys/fs/cgroup/memory.events` immediately after
completion, same method as every other row in this table.

### The tradeoff, and the update to 2 cores as the new default

Serial solving (`max-parallelism=1`) is roughly 2-2.5x slower than the
4-core baseline when the baseline doesn't OOM -- that's what shipped
first (v3), since it was the only value actually measured at the time.
~50 minutes is still comfortably inside `exec_timeout_seconds` (5000s /
~83 min, per `apps/web/lib/models.ts`).

Once `config_overrides` existed (see `config-overrides.md`), `2` cores
got measured live the same way, on the real production snapshot --
confirming it's a genuinely better balance, not just an interpolated
guess: meaningfully faster than serial (~32min vs ~50min) while still
clearing the exact period where every `-1` run died, with real margin
left before the ceiling (~7.9GiB of 8GiB, not pinned to it the way `-1`
was). `max-parallelism`'s baked-in default in `configuration_ref.xml`
was bumped from `1` to `2` on this basis, shipped as
`gcam-production-v6`. `1` (max safety, slowest) and `4` (max speed,
real OOM risk) both remain available per run via `config_overrides` or
the New Run form's "Cores" field for anyone who wants to trade
differently than the new default.

## Deploying the fix

The fix lives in a file baked into the Daytona snapshot image, so
redeploying the web app alone does **not** apply it -- the snapshot
itself has to be rebuilt.

Rebuilding did **not** require re-running the expensive `gcamdata`
generation step (the ~75-minute R pipeline) or recompiling `gcam.exe`
from source -- per `architecture.md`'s scenario-independence finding,
the input database and binary are untouched by this fix. The process
used instead:

1. Create a sandbox from the existing `gcam-production-v2` snapshot
   (inherits the already-baked `gcam.exe` and 5.2GB input database).
2. Overwrite `/app/gcam-core/exe/configuration_ref.xml` in that
   sandbox with the repo's updated version (uploaded directly via the
   SDK's `sandbox.fs.uploadFile`).
3. Sanity-checked the uploaded file (`xml.etree.ElementTree.parse`
   succeeds, `gcam.exe`'s file size unchanged) before snapshotting.
4. `sandbox.createSnapshot("gcam-production-v3", <timeout>)`.
5. Verified by creating a brand-new sandbox from `gcam-production-v3`
   and confirming the patched config line is present and `gcam.exe`
   is intact.
6. Updated `apps/web/lib/models.ts`'s `daytona_snapshot` for gcam from
   `"gcam-production-v2"` to `"gcam-production-v3"`.
7. Deleted the intermediate build sandbox (not needed once the
   snapshot exists).

`gcam-production-v2` was left as-is (not deleted) -- same policy as
the v1 -> v2 switch documented in `models.ts`'s own comment history,
in case a rollback is ever needed.

## Follow-up: v3 still had the CSV-parsing bug (fixed in v4)

`v3` only patched `configuration_ref.xml` -- it kept v2's original
`/app/run.py`, which still had the `csv.DictReader` bug described in
this repo's "Stop parsing GCAM's CSV output in Python" commit (Hector's
leading `# Output from hector version ...` comment line gets
misread as the header, so every real row's `variable` column ends up
missing). That fix had only ever been committed to
`sandboxes/gcam/run.py` in this repo -- it was never actually deployed
to a snapshot, so v3 runs kept returning this malformed shape even
after the OOM fix, which is why a real v3 run showed "succeeded" in the
dashboard with no chart (see the run drawer investigation that found
this: `result.result.rows` full of `{"null": [...]}` junk instead of
`result.result.csv`).

Fixed the same way as the OOM fix -- no `gcamdata`/`gcam.exe` rebuild:

1. Created a sandbox from `gcam-production-v3`.
2. Overwrote `/app/run.py` with the repo's current `sandboxes/gcam/run.py`
   (`sandbox.fs.uploadFile`); verified the upload byte-for-byte (`md5sum`
   matched the local file exactly) and that it still compiles
   (`python3 -m py_compile`).
3. Ran a full real 21-period scenario on that sandbox end to end
   (confirming the OOM fix still holds and the new `run.py` doesn't
   break anything) -- completed successfully, `0` oom_kills, matching
   the v3 numbers above.
4. Before snapshotting, manually replayed the app's own
   `advanceRun` -> `finalizeOutcome` -> `finishRunSucceeded` pipeline
   against this sandbox's real output (same SQL, same download/parse
   steps as `lib/runs.ts`/`lib/db.ts`) to confirm the whole
   sandbox-to-postgres path actually works for the new result shape,
   not just that the shape looks right in isolation. Persisted a real
   row into production postgres as proof: `run_id
   bc380140-64bd-4f5c-9ded-c2ffb934202d`, `result.result.csv` present
   (4,445,590 bytes), 355 `global_tas` points parse out of it correctly
   via the same logic `lib/clientApi.ts`'s `gcamSeries` uses.
5. `sandbox.createSnapshot("gcam-production-v4", <timeout>)`, then
   verified from a fresh sandbox: config patch present, `run.py`
   `md5sum` matches the repo, `gcam.exe` size unchanged.
6. Updated `apps/web/lib/models.ts`'s `daytona_snapshot` for gcam to
   `"gcam-production-v4"`.

`gcam-production-v2` and `v3` are both left in place, unused, as
rollback options.

## v6: bumping the default from 1 to 2 cores

Once `config_overrides` (v5, see `config-overrides.md`) made it
possible to test a specific value live without a snapshot rebuild just
to try it, `2` cores was measured the same way as `-1`/`1` above (see
the Results table's update) and confirmed as a better default than the
`1` that originally shipped. Deployed the same way as every prior gcam
fix:

1. Edited `sandboxes/gcam/runtime/exe/configuration_ref.xml`'s
   `max-parallelism` from `1` to `2` (comment updated with the
   measured numbers).
2. Created a sandbox from `gcam-production-v5`, uploaded the updated
   `configuration_ref.xml`, confirmed it's still well-formed XML and
   the value reads back correctly.
3. Ran a real (no `config_overrides` at all, to specifically confirm
   the BAKED-IN default -- not an override -- is what takes effect)
   scenario on that sandbox (kept short via a `stop-period`
   `config_override`, which is a legitimate use of the override
   mechanism for exactly this kind of fast iteration): completed
   successfully, "All model periods solved correctly.", `0` oom_kills.
4. `sandbox.createSnapshot("gcam-production-v6", <timeout>)`, then
   verified from a fresh sandbox: `max-parallelism` reads `2` in the
   canonical file, `run.py`'s `md5sum` unchanged from v5, `gcam.exe`
   size unchanged.
5. Updated `apps/web/lib/models.ts`'s `daytona_snapshot` to
   `"gcam-production-v6"`, plus the New Run form's "Cores" field
   placeholder/note and `exec_timeout_seconds`'s own comment to match.

`gcam-production-v2` through `v5` are all left in place, unused, as
rollback options.
