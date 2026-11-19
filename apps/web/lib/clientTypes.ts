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
  // The model's own default run-time ceiling, in seconds -- see
  // lib/models.ts's exec_timeout_seconds. Shown as the New Run form's
  // Advanced "max run time" field's placeholder.
  exec_timeout_seconds: number;
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
  // The model process's raw captured stdout+stderr, tail-capped -- see
  // lib/db.ts's stdout_tail column comment. Present for both succeeded
  // and failed runs; null if nothing was captured, or for a run that
  // predates this column. Meant for debugging a confusing result (the
  // run drawer's own "Raw output" section), not part of `result` itself.
  stdout_tail: string | null;
  // Best-effort stdout+stderr captured live off the sandbox for a run
  // that's still "running"/"queued" -- see lib/runs.ts's RunView doc
  // comment on this same field. Not persisted anywhere; each poll response
  // carries its own fresh snapshot. Use stdout_tail above once the run
  // finishes.
  live_stdout_tail: string | null;
  // Sandbox details -- see lib/runs.ts's RunView doc comments for each.
  // All null for a cache-hit inline result (nothing ran) or a run that
  // predates this tracking.
  sandbox_id: string | null;
  session_id: string | null;
  cmd_id: string | null;
  daytona_snapshot: string | null;
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
