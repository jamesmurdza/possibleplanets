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
  scenarios: string[];
  description: string;
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
  params: Record<string, unknown>;
  status: "queued" | "running" | "succeeded" | "failed";
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
}
