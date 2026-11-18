/**
 * Orders models by real measured computational resource usage, for the
 * homepage's single model row (app/page.tsx) -- cheapest/fastest first.
 *
 * The four numbers per model below (cpu, memoryGiB, seconds,
 * billableDiskGiB) are the exact same real, measured values already
 * passed to each model's `apiCostStep()` call in `runGuides.ts` (which
 * in turn come from docs/sandbox-resource-experiments.md's real
 * Daytona-sandbox timing runs) -- not re-measured or guessed here.
 * `seconds` is each model's real median exec time; cpu/memoryGiB/
 * billableDiskGiB are its configured `lib/models.ts` resources (1
 * CPU/1 GiB when a model has no override, matching apiCostStep's own
 * documented default).
 *
 * Resources are combined into one comparable number using the exact
 * same Daytona per-second pricing weights `runGuides.ts` already uses
 * for its own cost estimate (cpu/memory/disk-seconds), rather than
 * sorting by raw seconds alone -- that keeps "resource usage", not just
 * wall-clock time, as the actual ranking criterion the task asked for.
 * In practice this doesn't change the ordering from sorting by seconds
 * alone for any current model (cpu/memory differences aren't large
 * enough to reorder anything), but it's the more defensible metric if a
 * future model has a lopsided cpu/mem/time profile.
 */
const DAYTONA_VCPU_PER_SECOND = 0.0504 / 3600;
const DAYTONA_GIB_MEMORY_PER_SECOND = 0.0162 / 3600;
const DAYTONA_GIB_DISK_PER_SECOND = 0.000108 / 3600;

interface ResourceProfile {
  cpu: number;
  memoryGiB: number;
  seconds: number;
  billableDiskGiB?: number;
}

// Source for every row: the matching apiCostStep(...) call in
// apps/web/lib/runGuides.ts.
const RESOURCE_PROFILES: Record<string, ResourceProfile> = {
  twolayer: { cpu: 1, memoryGiB: 1, seconds: 1 },
  hector: { cpu: 2, memoryGiB: 1, seconds: 1.25 },
  magicc: { cpu: 2, memoryGiB: 1, seconds: 5.5 },
  fair: { cpu: 2, memoryGiB: 1, seconds: 14.63 },
  dice: { cpu: 2, memoryGiB: 1, seconds: 19.63 },
  oscar: { cpu: 4, memoryGiB: 8, seconds: 522, billableDiskGiB: 5 },
  gcam: { cpu: 4, memoryGiB: 8, seconds: 1860, billableDiskGiB: 7 },
};

function resourceCost(model: string): number {
  const profile = RESOURCE_PROFILES[model];
  // Unknown model (added to lib/models.ts but not yet measured/added
  // here) sorts last, after every model with a real measured profile,
  // rather than defaulting to 0 and jumping to the front as if it were
  // free.
  if (!profile) return Infinity;
  const { cpu, memoryGiB, seconds, billableDiskGiB = 0 } = profile;
  return (
    cpu * DAYTONA_VCPU_PER_SECOND * seconds +
    memoryGiB * DAYTONA_GIB_MEMORY_PER_SECOND * seconds +
    billableDiskGiB * DAYTONA_GIB_DISK_PER_SECOND * seconds
  );
}

export function sortByResourceUsage<T extends { model: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => resourceCost(a.model) - resourceCost(b.model));
}
