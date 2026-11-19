/**
 * Shared shapes for the dashboard's client components (NewRunPanel,
 * RunsPanel, ComparePanel) -- mirrors the API's actual JSON shapes
 * (lib/models.ts, lib/runs.ts, lib/db.ts) so all three panels agree on
 * what a run/model/parameter looks like without each redefining it.
 */
export interface ParameterSpec {
  key: string;
  label: string;
  type: "number";
  default: number;
  min: number;
  max: number;
  step?: number;
  placeholderHint?: string;
}

export interface ModelMeta {
  model: string;
  family: string;
  model_version: string;
  // The official model version (e.g. "3.2", "2016", "9.1") -- distinct
  // from model_version above, see lib/models.ts's own doc comment.
  model_version_number: string;
  scenarios: string[];
  params_shape?: "scenario" | "scenarios";
  parameters?: ParameterSpec[];
  non_deterministic_unless?: string;
}

// Shape returned by GET /v1/models -- used for the model-picker cards on
// the New Run form (description + website aren't in the per-model schema
// response, just the list).
export interface ModelListItem {
  model: string;
  family: string;
  model_version: string;
  model_version_number: string;
  scenarios: string[];
  description: string;
  implementation: string;
  website: string;
}

/**
 * What GET /v1/runs/latest returns per run -- already reduced to one
 * line's worth of points server-side (see that route), not a full RunJob.
 */
export interface ChartSeries {
  run_id: string;
  model: string;
  params: Record<string, unknown>;
  started_at: string;
  labels: (string | number)[];
  values: number[];
}

export interface RunJob {
  run_id: string;
  model: string;
  model_version: string | null;
  model_version_number: string | null;
  params: Record<string, unknown>;
  status: "queued" | "running" | "succeeded" | "failed";
  result: any;
  error: { message?: string } | null;
  cached: boolean;
  progress: { percent: number } | null;
  duration_seconds: number | null;
}

export interface RunListItem {
  run_id: string;
  model: string;
  model_version: string | null;
  model_version_number: string | null;
  params: Record<string, unknown>;
  status: "queued" | "running" | "succeeded" | "failed";
  // {code, message} only (no stdout_tail) -- see lib/db.ts's RunListItem
  // comment. Only ever present when status is "failed".
  error: { code: string; message: string } | null;
  cached: boolean;
  progress: { percent: number } | null;
  duration_seconds: number | null;
  started_at: string;
  updated_at: string;
}

export interface ModelDurationStats {
  model: string;
  count: number;
  min_seconds: number;
  median_seconds: number;
  avg_seconds: number;
  max_seconds: number;
}

export interface CheckResult {
  cacheable: boolean;
  cached: boolean;
  cached_duration_seconds: number | null;
  // The real runs.run_id behind a cache hit -- used by the "View cached"
  // button to open that run's drawer. Null unless `cached` is true.
  cached_run_id: string | null;
}
