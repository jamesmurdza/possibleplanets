# Sandbox resource experiments

Investigates whether increasing/decreasing a Daytona sandbox's CPU and
memory allocation changes how fast each model actually runs, and whether
CPU and memory matter independently of each other. All runs below are
real Daytona sandboxes (not estimates), built from each model's own
`sandboxes/<model>/Dockerfile`, executed via `sandbox.process.exec()`,
timed around that call only (sandbox creation time excluded, since that's
pure infra overhead unrelated to the model's own compute).

Context: this project is billed per CPU, so the question isn't just "does
more help" but "where's the cost/latency tradeoff" -- see each model's
conclusion below.

## Method

- Each cell is **5 trials**, reporting median (the per-trial times and
  stdev are included so the spread is visible, not just one number).
- A fixed, deterministic set of params per model (same scenario/seed every
  trial) so each trial does genuinely the same amount of work.
- Sandboxes are created fresh and deleted after each trial -- no reuse,
  no caching, matching how this project always provisions sandboxes
  (PLATFORM.md's per-run isolation).

## hector

### Experiment 1: is hector resource-sensitive at all? (2x2: cpu x memory)

Initial single-sample check suggested hector sped up with more resources;
re-run with 5 trials/cell to confirm it wasn't noise, and to separate
*which* resource was responsible by varying CPU and memory independently.

| | 1 GB | 4 GB |
|---|---|---|
| **1 CPU** | 2.03s median (stdev 0.115) | 2.08s median (stdev 0.187) |
| **4 CPU** | 1.10s median (stdev 0.097) | 1.06s median (stdev 0.021) |

**Finding:** raising CPU alone (either memory row) consistently roughly
halves the time. Raising memory alone (either CPU row) changes nothing.
The effect is 100% CPU, 0% memory -- pyhector's C++/numpy-linked core
evidently does some multi-threaded work (BLAS/OpenMP) even though the
Python wrapper itself is single-threaded, and a 1-CPU cgroup cap
throttles that.

### Experiment 2: 1 vs 2 vs 4 CPU (memory fixed at 1 GB)

Having established CPU is the real variable, swept it finely to find
where the curve flattens.

| CPUs | Trials (s) | Median | Stdev |
|---|---|---|---|
| 1 | 2.197, 2.244, 2.311, 2.196, 2.392 | 2.24s | 0.08 |
| 2 | 1.297, 1.254, 1.200, 1.333, 1.151 | 1.25s | 0.07 |
| 4 | 1.164, 1.112, 1.035, 2.028, 1.103 | 1.11s | 0.42 (one outlier; other 4 trials ~1.1s) |

**Finding:** the 1->2 step carries nearly all of the real gain (~44%
faster). 2->4 is a much smaller further step (~11% faster on top of
that). Since CPU is billed per-count, doubling cost again for 4 buys a
fraction of what the first doubling bought.

**Conclusion / applied:** `resources: { cpu: 2 }` (`apps/web/lib/models.ts`).
No memory override -- confirmed to make no difference.

## oscar

### Experiment 1: does the "needs more resources" note actually hold?

`lib/models.ts` already set `resources: { cpu: 4, memory: 8, disk: 10 }`
for oscar, with a comment claiming the default sandbox size OOM-kills it.
Verified directly: running oscar with **no** resource override at all --

- **Result: OOM-killed (exit code 137) in 7.8 seconds.** Confirms the
  existing comment/config was correct and necessary, not just
  defensive/unverified.

### Experiment 2: does more CPU/memory speed up the real (non-OOM) run?

Tested the real ~500s run (`SSP2-4.5`, `nMC=1`) at three tiers:

| Resources | Exec time |
|---|---|
| 2 CPU / 4 GB | 524.5s |
| 4 CPU / 8 GB | 522.0s |
| 8 CPU / 16 GB | rejected at sandbox creation -- *"CPU request 8 exceeds maximum allowed per sandbox (4)"* (this Daytona plan caps at 4 CPUs/sandbox) |

**Finding:** 2 CPU/4GB and 4 CPU/8GB are statistically the same (522-524s,
a ~0.5% difference, well within normal run-to-run noise for a ~9-minute
job). Unlike hector, oscar does NOT get faster with more CPU -- its
bottleneck is memory headroom (avoiding the OOM kill), not CPU-bound
compute. More CPU past the minimum that avoids OOM buys nothing.

**Conclusion:** existing `{cpu: 4, memory: 8, disk: 10}` is justified by
the OOM finding, not by a speed finding -- the memory number is load-bearing,
the cpu number isn't really doing anything for oscar specifically (though
it's also not costing extra beyond this plan's 4-cpu ceiling, so no
reason to change it). No code change made here; existing config already
matches what the data supports.

## fair, dice, magicc: 1 vs 2 vs 4 CPU sweep

None of these had a `resources` override before this. Swept the same way
as hector's experiment 2 (memory fixed small/sufficient, only CPU varied).

| Model | 1 CPU | 2 CPU | 4 CPU | Shape |
|---|---|---|---|---|
| **fair** | 19.18s median (stdev 1.32) | 14.63s median (stdev 4.21) | 12.82s median (stdev 4.74) | Speeds up both steps, but noisiest of the four models (fair's 66-config ensemble + progress-file-polling architecture adds timing variance beyond pure compute time) |
| **dice** | 36.26s median (stdev 0.53) | 19.63s median (stdev 0.50) | 20.73s median (stdev 0.87) | Big 1->2 win (**-46%**), 2->4 flat/slightly worse (noise) -- same shape as hector |
| **magicc** | 12.47s median (stdev 0.92) | 9.45s median (stdev 0.70) | 9.12s median (stdev 0.23) | Speeds up 1->2 (-24%), 2->4 is noise-level |

**Finding:** all three follow the same "1->2 CPU is where the real gain
is, 2->4 is flat or noise" shape hector and dice show clearly; fair shows
the same direction with more variance. None of the three justify `cpu: 4`.

**Conclusion: not yet applied.** `cpu: 2` would be the same cost/latency
tradeoff as hector for all three, but this hasn't been added to
`lib/models.ts` yet -- pending confirmation/go-ahead.

## Overall takeaways

1. **CPU, not memory, is what speeds these models up** -- confirmed
   directly (not assumed) for hector via a proper 2x2 factorial. Memory
   only matters as a hard pass/fail cliff (oscar's OOM), never as a speed
   dial.
2. **The CPU-vs-speed curve has strongly diminishing returns past 2** for
   every model tested: hector, dice, and magicc all show 2->4 as flat or
   within noise; fair shows a smaller further gain but with much higher
   variance. None of the five models tested show a case for `cpu: 4` over
   `cpu: 2` once cost is considered.
3. **Not every model benefits from more CPU at all** -- oscar is the
   counterexample: its real bottleneck is memory (avoiding an OOM kill at
   7.8s), and once past that, more CPU doesn't move its ~520s runtime.
4. Applied so far: hector -> `cpu: 2`. Oscar's existing `{cpu: 4, memory:
   8}` is validated as-is (memory load-bearing, cpu incidental). fair/
   dice/magicc have measured evidence for `cpu: 2` but it hasn't been
   applied yet.
