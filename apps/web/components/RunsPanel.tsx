"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "chart.js/auto";
import Dropdown from "./Dropdown";
import Drawer from "./Drawer";
import Modal from "./Modal";
import {
  fetchJson,
  SERIES_ADAPTERS,
  type DataSeries,
  colorWithAlpha,
  summarizeParams,
  summarizeScenario,
  summarizeExtraParams,
  nativeScenarioOf,
  canonicalScenario,
} from "../lib/clientApi";
import type { RunJob, RunListItem, ModelMeta } from "../lib/clientTypes";

const ALL = "__all__";
const STATUS_OPTIONS = [
  { value: ALL, label: "Any status" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
];

// Palette for the data explorer's overlaid series -- cycled by a series'
// index in availableSeries (stable across check/uncheck, unlike indexing
// into the checked subset). Colors are assigned purely by position, so
// the same series keeps its color when its neighbors are toggled.
const SERIES_COLORS = [
  "#2f6feb",
  "#e0415a",
  "#1fa37a",
  "#e0862f",
  "#9b51e0",
  "#1b8f9e",
  "#c2185b",
  "#6b8f3c",
  "#8d6e63",
  "#5c6bc0",
];

// Which single series to pre-check when a run's drawer first opens -- the
// same line CHART_ADAPTERS charts for the small panels (temperature for
// every model here), so opening the drawer still shows what it always
// has; the explorer is additive, not a behavior change for someone who
// never touches the checkboxes. Matched by key against SERIES_ADAPTERS'
// output (e.g. hector/gcam's "temperature.global_tas"), falling back to
// the first temperature.* series (fair keys its series per scenario --
// "temperature.ssp245" etc -- so there's no one fixed key to prefer),
// then to the first series of any kind.
function defaultSeriesKey(model: string, series: DataSeries[]): string {
  const preferred: Record<string, string> = {
    hector: "temperature.global_tas",
    gcam: "temperature.global_tas",
    oscar: "mean_D_Tg",
    dice: "T_atmos",
    magicc: "T_atmos",
    twolayer: "T_atmos",
  };
  const pref = preferred[model];
  const match = pref ? series.find((s) => s.key === pref) : undefined;
  return match?.key ?? series.find((s) => s.key.startsWith("temperature."))?.key ?? series[0].key;
}

// Canonical (not model-native) -- so filtering by "SSP1-2.6" matches both
// hector's "ssp126" and oscar's "SSP1-2.6" runs. See canonicalScenario's
// comment in lib/clientApi.ts for why RCP/base/optimal are left alone.
function scenarioOf(params: Record<string, unknown>): string | undefined {
  const native = nativeScenarioOf(params);
  return native ? canonicalScenario(native) : undefined;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Every duration in this panel (a finished run's duration_seconds, and a
// still-running one's live elapsed time below) renders through this one
// function, always as "Xm Ys" -- including under a minute (e.g. "0m 7s"),
// not a special-cased bare "7s" -- so every row in the Duration column
// reads in the same shape regardless of how long that particular run
// took.
function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

// Live "how long has this been running" for a still-in-progress run --
// just now() - started_at, recomputed on every render. No interval timer
// of its own needed: both the table (refreshList, every 1s -- see
// listPollTimer) and the drawer (pollDetail, every 500ms while a run is
// still in progress -- see detailPollTimer) already re-render this
// component on that same cadence while anything is running/queued, so
// this naturally ticks up in step with those polls rather than drifting
// out of sync with a second, independent setInterval.
function formatElapsed(startedAtIso: string): string {
  const elapsedSeconds = Math.max(0, (Date.now() - new Date(startedAtIso).getTime()) / 1000);
  return formatDuration(elapsedSeconds);
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-pill status-pill-${status}`}>{status}</span>;
}

// Placeholder rows shown in place of the "Loading runs..." text row while
// the first GET /v1/runs is still in flight -- matches the real table's
// column count/shape (8: checkbox, Model, Version, Scenario, Params,
// Status, Duration, Started) so nothing reflows once real rows swap in.
// Uses the dashboard's own --color-* theme (via .dashboard-skeleton-bar,
// not the public site's .skeleton-bar -- that one's background resolves
// against --pp-grey-light, a custom property only defined under
// .public-page, which this dashboard table is never inside). Shared with
// the run drawer's own loading skeleton below.
const SKELETON_ROW_COUNT = 6;

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
        <tr key={i} className="runs-table-skeleton-row" aria-hidden="true">
          <td className="runs-table-checkbox-col" />
          {Array.from({ length: 7 }).map((_, j) => (
            <td key={j}>
              <span className="dashboard-skeleton-bar" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// Run drawer's own loading skeleton -- shown between the drawer opening
// (selectedRunId set) and its first GET /v1/runs/{id} response landing
// (selectedJob still null), instead of a near-empty drawer with just a
// title and a lone "Loading..." label. See its own CSS rules' comment for
// why this mimics the real layout's shape.
const DRAWER_SKELETON_ROW_COUNT = 5;

function DrawerSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="drawer-skeleton-tabs">
        <span className="dashboard-skeleton-bar" />
        <span className="dashboard-skeleton-bar" />
        <span className="dashboard-skeleton-bar" />
      </div>
      {Array.from({ length: DRAWER_SKELETON_ROW_COUNT }).map((_, i) => (
        <div className="drawer-skeleton-row" key={i}>
          <span className="dashboard-skeleton-bar" />
          <span className="dashboard-skeleton-bar" />
        </div>
      ))}
      <div className="drawer-skeleton-chart" />
    </div>
  );
}

// A clickable <th> for the Runs table -- shows an up/down arrow only on
// whichever column is the current sort key (see RunsPanel's toggleSort),
// nothing on the rest. Clicking the already-active column flips direction
// instead of resorting by a different key -- see toggleSort.
function SortableHeader({
  label,
  sortKeyName,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  sortKeyName: string;
  sortKey: string | null;
  sortDir: "asc" | "desc";
  onSort: (key: string) => void;
}) {
  const active = sortKey === sortKeyName;
  return (
    <th>
      <button type="button" className="runs-table-sort-button" onClick={() => onSort(sortKeyName)}>
        {label}
        <span className="runs-table-sort-arrow" aria-hidden="true">
          {active ? (sortDir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

export interface RunsPanelProps {
  // Controlled, not local state -- a New Run submission (see
  // NewRunPanel.tsx's onRunSubmitted) sets this from OUTSIDE this
  // component (switching the dashboard's own tab to "runs" at the same
  // time), not just a row click inside this table.
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  // Switches the dashboard's own tab to "New Run" -- backs the button at
  // the top right of this panel (Runs is the default landing tab now, so
  // starting a run needs to be reachable from here, not just the sidebar).
  onNewRun: () => void;
  // Bumped by the dashboard (see app/dashboard/page.tsx's onRunSubmitted)
  // every time a New Run submission completes, so a just-submitted run
  // shows up immediately on switching to this tab instead of only
  // appearing once refreshList's own poll loop happens to catch it (or
  // never, if nothing else in the list is in progress -- see this
  // component's own useEffect on `runs` below: the 1s poll is keyed on
  // whether anything already IN the list is active, which a run that
  // hasn't been fetched into the list yet doesn't satisfy). This stays
  // mounted across tab switches (app/dashboard/page.tsx toggles
  // display:none, not unmount/remount), so there's no mount effect to
  // rely on here either.
  refreshSignal?: number;
}

export default function RunsPanel({ selectedRunId, onSelectRun, onNewRun, refreshSignal }: RunsPanelProps) {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<RunJob | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [runAgainBusy, setRunAgainBusy] = useState(false);
  const [runAgainErr, setRunAgainErr] = useState<string | null>(null);
  // Collapsed by default -- raw stdout/stderr is a debugging aid (see
  // selectedJob.stdout_tail's own comment), not something to show
  // unasked-for every time a run's drawer opens.
  const [drawerTab, setDrawerTab] = useState<"details" | "output" | "advanced">("details");
  const [maxRunTimeInput, setMaxRunTimeInput] = useState("");
  const [deadlineBusy, setDeadlineBusy] = useState(false);
  const [deadlineErr, setDeadlineErr] = useState<string | null>(null);
  const [filterModel, setFilterModel] = useState(ALL);
  const [filterScenario, setFilterScenario] = useState(ALL);
  const [filterStatus, setFilterStatus] = useState(ALL);
  // Null sortKey means "server's own default order" (started_at DESC,
  // already how GET /v1/runs returns rows -- see lib/db.ts) -- sorting is
  // otherwise purely client-side over the already-fetched/filtered list,
  // same reasoning as filtering above.
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // Checkbox selection for bulk delete -- independent of selectedRunId
  // (which run's drawer is open), see the header comment above.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  // Confirmation step for the delete icon -- never deletes directly on
  // click, since this is a bulk/irreversible action (see deleteSelected's
  // own DELETE calls, there's no undo).
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // The open drawer's model schema -- fetched lazily (only once a run of
  // that model is actually opened) so the field-by-field Params display
  // below knows each parameter's label and which keys exist at all (to
  // show "(default)" for ones the run's own params didn't include).
  const [drawerModelMeta, setDrawerModelMeta] = useState<ModelMeta | null>(null);
  const schemaCache = useRef<Record<string, ModelMeta>>({});

  // Data explorer state (Details tab's chart area) -- which of the
  // currently open run's native series are checked to overlay, and
  // whether that selection is shown as a chart or a raw table. Reset
  // (see the selectedRunId effect below) whenever a different run is
  // opened, not when the series list itself changes shape (e.g. across
  // 500ms polls while a run is still in progress) -- that reset is keyed
  // off selectedRunId specifically so a user's checkbox picks aren't
  // wiped out by every progress poll.
  const [checkedSeriesKeys, setCheckedSeriesKeys] = useState<Set<string>>(new Set());
  const [explorerView, setExplorerView] = useState<"chart" | "table">("chart");
  // Data table's sort -- key is a series key, or "x" for the year column.
  // null = insertion order (x ascending), which is the default.
  const [tableSort, setTableSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const listPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which run pollDetail is currently polling for -- checked when each
  // fetch resolves (see pollDetail below) so a response for a run the user
  // has since clicked away from can't land in `selectedJob` and flash the
  // drawer between two different runs' data. Clearing detailPollTimer.current
  // only stops the *next* scheduled poll; it doesn't cancel a fetch that's
  // already in flight when the user switches runs.
  const activeDetailId = useRef<string | null>(null);
  const advancePollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mirrors `runs` for advanceInProgressRuns below -- that function is
  // scheduled via setTimeout (not re-created every render), so it'd
  // otherwise close over whatever `runs` was on the render that scheduled
  // it, not the latest list.
  const runsRef = useRef<RunListItem[]>([]);

  async function refreshList() {
    try {
      const data = await fetchJson("/v1/runs");
      setRuns(data.runs ?? []);
      runsRef.current = data.runs ?? [];
      setLoadErr(null);
    } catch (err: any) {
      setLoadErr(err.message);
    } finally {
      // Only ever matters for the very first call (the mount effect
      // below) -- every later refreshList (the background poll,
      // advanceInProgressRuns) is a no-op here since loading is already
      // false by then. Set in `finally` so an error on that first load
      // still clears the "Loading runs..." state instead of leaving the
      // table stuck there forever.
      setLoading(false);
    }
  }

  // GET /v1/runs (refreshList above) is a plain DB read -- see its own
  // route comment -- it never itself checks a sandbox against Daytona, so
  // a run's row only ever advances past "queued"/"running" via (a) that
  // run's own webhook POST on completion, or (b) someone polling
  // GET /v1/runs/{run_id} (advanceRun's fallback path), which this table
  // previously only did for whichever single run's drawer happened to be
  // open. A run nobody ever opened the drawer for could sit showing
  // "running" forever even after it actually finished. Fixes that by
  // polling every still-in-progress run's own detail endpoint in the
  // background -- on load and on an interval -- whether or not its drawer
  // is open, so this table's own status/duration stays honest for every
  // row, not just the selected one.
  async function advanceInProgressRuns() {
    const inProgress = runsRef.current.filter((r) => r.status === "queued" || r.status === "running");
    if (inProgress.length === 0) return;
    await Promise.all(inProgress.map((r) => fetchJson(`/v1/runs/${r.run_id}`).catch(() => null)));
    // advanceRun (behind that GET) may have just changed one or more
    // statuses in the DB -- pull the fresh list right away rather than
    // waiting for refreshList's own separate poll to eventually catch up.
    await refreshList();
  }

  useEffect(() => {
    refreshList().then(advanceInProgressRuns);
    // A plain setInterval, started once and never re-armed -- NOT keyed
    // on `runs` the way listPollTimer below is. advanceInProgressRuns
    // itself reads runsRef (always current) and no-ops immediately if
    // nothing's in progress, so there's no need to start/stop this based
    // on activity; keying it on `runs` instead (so it only runs "while
    // active") would backfire: refreshList's own 1s poll changes `runs`
    // every second whenever anything's active, which would clear and
    // reschedule a runs-keyed 5s timer before it ever reached 5 seconds --
    // it would never actually fire.
    advancePollTimer.current = setInterval(advanceInProgressRuns, 5000);
    return () => {
      if (listPollTimer.current) clearTimeout(listPollTimer.current);
      if (detailPollTimer.current) clearTimeout(detailPollTimer.current);
      if (advancePollTimer.current) clearInterval(advancePollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the list itself live while anything in it is still in flight --
  // same ~1s cadence is plenty for a list view (contrast with the ~500ms
  // poll used for the open drawer's own progress).
  useEffect(() => {
    if (listPollTimer.current) clearTimeout(listPollTimer.current);
    const anyActive = runs.some((r) => r.status === "queued" || r.status === "running");
    if (anyActive) {
      listPollTimer.current = setTimeout(refreshList, 1000);
    }
    return () => {
      if (listPollTimer.current) clearTimeout(listPollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  // Fires an immediate refetch whenever the dashboard bumps refreshSignal
  // -- see this prop's own doc comment for why the regular poll loop
  // alone can't be relied on to pick up a just-submitted run. Skipped on
  // the very first render (refreshSignal starts at 0/undefined and the
  // mount effect above already does this same fetch) via the ref below,
  // so this doesn't double-fetch on initial mount.
  const sawRefreshSignal = useRef(false);
  useEffect(() => {
    if (!sawRefreshSignal.current) {
      sawRefreshSignal.current = true;
      return;
    }
    refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // Filtering is purely client-side over the already-fetched list -- the
  // list is already a lightweight, capped-size projection (GET /v1/runs),
  // so there's no need for the server to know about filters.
  const modelOptions = useMemo(() => {
    const names = Array.from(new Set(runs.map((r) => r.model))).sort();
    return [{ value: ALL, label: "All models" }, ...names.map((m) => ({ value: m, label: m }))];
  }, [runs]);

  const scenarioOptions = useMemo(() => {
    const scoped = filterModel === ALL ? runs : runs.filter((r) => r.model === filterModel);
    const scenarios = Array.from(new Set(scoped.map((r) => scenarioOf(r.params)).filter(Boolean))).sort() as string[];
    return [{ value: ALL, label: "All scenarios" }, ...scenarios.map((s) => ({ value: s, label: s }))];
  }, [runs, filterModel]);

  function onFilterModelChange(value: string) {
    setFilterModel(value);
    setFilterScenario(ALL);
  }

  const filteredRuns = runs.filter((r) => {
    if (filterModel !== ALL && r.model !== filterModel) return false;
    if (filterScenario !== ALL && scenarioOf(r.params) !== filterScenario) return false;
    if (filterStatus !== ALL && r.status !== filterStatus) return false;
    return true;
  });

  // A run's own duration for sort purposes -- duration_seconds once
  // finished, otherwise its live elapsed time (same value the Duration
  // column itself shows while running/queued -- see formatElapsed), so
  // sorting by Duration doesn't just always push every still-in-progress
  // row to one end regardless of how long it's actually been running.
  function sortableDurationSeconds(r: RunListItem): number {
    if (typeof r.duration_seconds === "number") return r.duration_seconds;
    if (r.status === "running" || r.status === "queued") {
      return Math.max(0, (Date.now() - new Date(r.started_at).getTime()) / 1000);
    }
    return -1;
  }

  const SORT_ACCESSORS: Record<string, (r: RunListItem) => string | number> = {
    model: (r) => r.model,
    version: (r) => r.model_version_number ?? "",
    scenario: (r) => summarizeScenario(r.params),
    params: (r) => summarizeExtraParams(r.params),
    status: (r) => r.status,
    duration: sortableDurationSeconds,
    started: (r) => new Date(r.started_at).getTime(),
  };

  const sortedRuns = sortKey
    ? [...filteredRuns].sort((a, b) => {
        const av = SORT_ACCESSORS[sortKey](a);
        const bv = SORT_ACCESSORS[sortKey](b);
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      })
    : filteredRuns;

  function toggleSort(key: string) {
    if (sortKey !== key) {
      setSortKey(key);
      // Started defaults to newest-first (matching the server's own
      // ORDER BY started_at DESC -- see lib/db.ts) since that's the
      // existing/expected order; every other column defaults to
      // ascending on its first click, the more conventional default.
      setSortDir(key === "started" ? "desc" : "asc");
    } else {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    }
  }

  // Dropped from `checkedIds` whenever the list is refreshed and a
  // previously-checked run has disappeared from it (deleted by someone
  // else) -- otherwise "N selected" could silently count rows that no
  // longer exist.
  useEffect(() => {
    setCheckedIds((prev) => {
      const stillPresent = new Set(runs.map((r) => r.run_id));
      const next = new Set([...prev].filter((id) => stillPresent.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [runs]);

  function toggleChecked(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleCheckAll() {
    setCheckedIds((prev) => {
      if (prev.size === filteredRuns.length && filteredRuns.length > 0) return new Set();
      return new Set(filteredRuns.map((r) => r.run_id));
    });
  }

  async function deleteSelected() {
    if (checkedIds.size === 0 || deleting) return;
    setShowDeleteConfirm(false);
    setDeleting(true);
    try {
      await Promise.all([...checkedIds].map((id) => fetchJson(`/v1/runs/${id}`, { method: "DELETE" })));
      if (selectedRunId && checkedIds.has(selectedRunId)) onSelectRun(null);
      setCheckedIds(new Set());
      await refreshList();
    } catch (err: any) {
      setLoadErr(err.message);
    } finally {
      setDeleting(false);
    }
  }

  async function pollDetail(id: string) {
    try {
      const job: RunJob = await fetchJson(`/v1/runs/${id}`);
      // The user may have clicked a different run (or closed the drawer)
      // while this fetch was in flight -- activeDetailId has since moved
      // on, so this response is stale. Drop it instead of overwriting
      // selectedJob with the wrong run's data (and don't schedule another
      // poll for an id nothing's tracking anymore).
      if (activeDetailId.current !== id) return;
      setSelectedJob(job);
      setDetailErr(null);
      if (job.status === "queued" || job.status === "running") {
        detailPollTimer.current = setTimeout(() => pollDetail(id), 500);
      }
      // Chart rendering happens in a useEffect below, not here -- the
      // <canvas> only mounts once React commits `selectedJob.status ===
      // "succeeded"` to the DOM, so calling renderChart() synchronously
      // right after setSelectedJob() would race a canvasRef that's still
      // null/stale (confirmed by testing: the canvas existed but stayed
      // its default 300x220 blank size, Chart.js never actually drew into
      // it).
    } catch (err: any) {
      if (activeDetailId.current !== id) return;
      setDetailErr(err.message);
      // Keep polling through a transient failure (e.g. a 502 from a
      // gateway error advanceRun hit) instead of silently giving up after
      // the first one -- without this, one blip permanently froze the
      // drawer on whatever selectedJob it last had, with no way to find
      // out the run actually went on to finish (or fail) afterwards short
      // of closing and reopening the drawer. Guarded by activeDetailId the
      // same way the success path is, so this can't outlive the user
      // switching to a different run or closing the drawer.
      detailPollTimer.current = setTimeout(() => pollDetail(id), 500);
    }
  }

  // Resubmits the currently open run's exact (model, params) as a brand
  // new run -- same endpoint/body shape as NewRunPanel's own "Run"
  // (refresh: true, so this never just returns a cached result -- same
  // "Run always means a real new run" rule as there). Left on the
  // currently open run's drawer rather than switching to the new one --
  // refreshList() below makes the new run show up in the table right
  // away (same refreshSignal-less immediate refetch runAgain can just do
  // directly, since it already lives in this component).
  async function runAgain() {
    if (!selectedJob) return;
    setRunAgainBusy(true);
    setRunAgainErr(null);
    try {
      await fetchJson(`/v1/models/${selectedJob.model}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ params: selectedJob.params, refresh: true }),
      });
      await refreshList();
    } catch (err: any) {
      setRunAgainErr(err.message);
    } finally {
      setRunAgainBusy(false);
    }
  }

  // Drawer's Advanced tab -- PATCHes the currently-open run's deadline
  // (total seconds from its own started_at, same convention as submitRun's
  // initial max_run_time_seconds -- see updateRunDeadline's own doc
  // comment) and applies the server's response immediately so the
  // Details tab's Duration/deadline reflect it without waiting for the
  // next 500ms poll.
  async function updateDeadline() {
    if (!selectedJob) return;
    const seconds = Number(maxRunTimeInput);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      setDeadlineErr("Enter a positive number of seconds");
      return;
    }
    setDeadlineBusy(true);
    setDeadlineErr(null);
    try {
      const job: RunJob = await fetchJson(`/v1/runs/${selectedJob.run_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_run_time_seconds: seconds }),
      });
      if (activeDetailId.current === selectedJob.run_id) setSelectedJob(job);
    } catch (err: any) {
      setDeadlineErr(err.message);
    } finally {
      setDeadlineBusy(false);
    }
  }

  // Driven by selectedRunId (a prop, settable from outside this
  // component) rather than a local "selectRun" click handler owning the
  // whole lifecycle -- a row click just calls onSelectRun(id); this
  // effect is what actually starts polling, whether that id came from a
  // click here or from NewRunPanel just having submitted a run.
  useEffect(() => {
    if (detailPollTimer.current) clearTimeout(detailPollTimer.current);
    setSelectedJob(null);
    setDetailErr(null);
    setDrawerModelMeta(null);
    setRunAgainErr(null);
    setDrawerTab("details");
    setMaxRunTimeInput("");
    setDeadlineErr(null);
    setCheckedSeriesKeys(new Set());
    setExplorerView("chart");
    setTableSort(null);
    activeDetailId.current = selectedRunId;
    if (selectedRunId) pollDetail(selectedRunId);
    return () => {
      if (detailPollTimer.current) clearTimeout(detailPollTimer.current);
      activeDetailId.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId]);

  // Fetches (and caches) the open drawer's model schema -- see
  // drawerModelMeta's own comment. Keyed on the model name, not the whole
  // selectedJob object, so this doesn't refetch on every progress poll.
  useEffect(() => {
    const model = selectedJob?.model;
    if (!model) return;
    if (schemaCache.current[model]) {
      setDrawerModelMeta(schemaCache.current[model]);
      return;
    }
    let cancelled = false;
    fetchJson(`/v1/models/${model}/schema`)
      .then((schema) => {
        if (cancelled) return;
        schemaCache.current[model] = schema;
        setDrawerModelMeta(schema);
      })
      .catch(() => {
        // Non-critical -- the Params row below just falls back to the
        // raw summarizeParams() rendering if this never resolves.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJob?.model]);

  // Every series the open run's model natively produced -- recomputed
  // whenever selectedJob changes (not just once per run), since
  // succeeded-job polls still carry the same `result`, so this is cheap
  // and always in sync with whatever's actually being charted.
  const availableSeries: DataSeries[] = useMemo(() => {
    if (!selectedJob || selectedJob.status !== "succeeded") return [];
    const adapter = SERIES_ADAPTERS[selectedJob.model];
    if (!adapter) return [];
    try {
      return adapter(selectedJob.result);
    } catch {
      return [];
    }
  }, [selectedJob]);

  // Default-check whichever single series CHART_ADAPTERS used to chart
  // for this model (see defaultSeriesKey), so opening a run's drawer
  // still shows the same line it always has -- the explorer is additive,
  // not a behavior change for someone who never touches the checkboxes.
  // Only runs once per run (guarded by checkedSeriesKeys being empty),
  // not on every poll -- see the selectedRunId effect above for where
  // checkedSeriesKeys actually gets reset to empty for a new run.
  useEffect(() => {
    if (availableSeries.length === 0 || checkedSeriesKeys.size > 0 || !selectedJob) return;
    setCheckedSeriesKeys(new Set([defaultSeriesKey(selectedJob.model, availableSeries)]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableSeries]);

  function toggleSeries(key: string) {
    setCheckedSeriesKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const checkedSeries = availableSeries.filter((s) => checkedSeriesKeys.has(s.key));

  // Groups the CHECKED series by unit so same-unit series share one axis
  // (e.g. every "degC" series on the left) while a genuinely different
  // unit (e.g. dice's "USD/tCO2" scc alongside its own "degC" T_atmos)
  // gets its own axis instead of being squashed onto the same scale where
  // one line would visually flatline against the other's range. Units
  // are assigned axis ids in first-seen order and alternate left/right so
  // a third+ unit doesn't pile up unreadably on one side.
  const unitAxisIds = useMemo(() => {
    const ids = new Map<string, string>();
    for (const s of checkedSeries) {
      const unit = s.unit ?? "";
      if (!ids.has(unit)) ids.set(unit, ids.size === 0 ? "y" : `y${ids.size}`);
    }
    return ids;
  }, [checkedSeries]);

  // (Re)draws the overlay chart whenever the selection, checked series,
  // or view changes. Gated on the Details tab AND chart view being
  // active: the canvas stays mounted (see the hidden-container comment
  // below) but Chart.js would size it 0x0 while display:none, so drawing
  // into it then would silently produce a blank chart once you switch
  // back. Redraw on returning to the chart view instead.
  useEffect(() => {
    if (selectedJob?.status === "succeeded" && drawerTab === "details" && explorerView === "chart") {
      renderChart();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJob, availableSeries, checkedSeriesKeys, drawerTab, explorerView]);

  // Stable per-series color, keyed off the series' position in
  // availableSeries (not its position among the CHECKED ones) so a
  // series keeps its color when neighboring checkboxes are toggled.
  function seriesColor(s: DataSeries): string {
    return SERIES_COLORS[availableSeries.indexOf(s) % SERIES_COLORS.length];
  }

  // ALL series grouped by unit -- for the picker's grouped checkbox
  // list (distinct from unitAxisIds, which groups only the CHECKED ones
  // for chart axes).
  const seriesGroups = useMemo(() => {
    const groups = new Map<string, DataSeries[]>();
    for (const s of availableSeries) {
      const unit = s.unit ?? "";
      if (!groups.has(unit)) groups.set(unit, []);
      groups.get(unit)!.push(s);
    }
    return Array.from(groups.entries());
  }, [availableSeries]);

  // The data table's rows: the union of every checked series' x values
  // (a year row per distinct x), each series contributing its y at that
  // x or null where it has no point there (e.g. hector's annual points
  // overlaid with a sparser series). Sorted per tableSort when the user
  // has clicked a column header; nulls sort last in either direction.
  const tableRows = useMemo(() => {
    const xSet = new Set<number>();
    for (const s of checkedSeries) for (const x of s.x) xSet.add(x);
    const rows = Array.from(xSet)
      .sort((a, b) => a - b)
      .map((x) => ({
        x,
        values: checkedSeries.map((s) => {
          const i = s.x.indexOf(x);
          return i === -1 ? null : s.y[i];
        }),
      }));
    if (tableSort) {
      const keyIdx = checkedSeries.findIndex((s) => s.key === tableSort.key);
      const dir = tableSort.dir === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        const va = tableSort.key === "x" ? a.x : keyIdx >= 0 ? a.values[keyIdx] : null;
        const vb = tableSort.key === "x" ? b.x : keyIdx >= 0 ? b.values[keyIdx] : null;
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (va - vb) * dir;
      });
    }
    return rows;
  }, [checkedSeries, tableSort]);

  function toggleTableSort(key: string) {
    setTableSort((prev) => (prev && prev.key === key ? (prev.dir === "asc" ? { key, dir: "desc" } : null) : { key, dir: "asc" }));
  }

  function downloadText(filename: string, text: string, mime: string) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // CSV of exactly what the data table shows (checked series, current
  // sort) -- one year column plus one column per series, unit folded
  // into the header. Raw JSON export below deliberately exports the
  // NATIVE result instead (see its comment) -- this one is the
  // convenient "what I'm looking at" download.
  function exportSeriesCsv() {
    if (!selectedJob) return;
    const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
    const lines = [["year", ...checkedSeries.map((s) => (s.unit ? `${s.label} (${s.unit})` : s.label))].map(q).join(",")];
    for (const row of tableRows) {
      lines.push([String(row.x), ...row.values.map((v) => (v == null ? "" : String(v)))].map(q).join(","));
    }
    downloadText(`${selectedJob.model}-${selectedJob.run_id.slice(0, 8)}-series.csv`, lines.join("\n"), "text/csv");
  }

  // The run's native result verbatim (result.result -- exactly what the
  // model itself produced, untouched by any of the adapters above).
  // This is the "give me EVERYTHING" download: e.g. fair's full
  // per-config ensemble arrays (the spread only summarized into a band
  // in the chart), or gcam's whole raw Hector CSV text. Compact
  // serialization on purpose -- gcam's native result is multi-megabyte
  // string-in-JSON, and pretty-indenting that only bloats the download.
  function exportRawJson() {
    if (!selectedJob) return;
    downloadText(
      `${selectedJob.model}-${selectedJob.run_id.slice(0, 8)}-raw.json`,
      JSON.stringify(selectedJob.result?.result ?? selectedJob.result ?? null),
      "application/json",
    );
  }

  function renderChart() {
    if (!canvasRef.current) return;
    if (chartRef.current) chartRef.current.destroy();
    if (checkedSeries.length === 0) return;

    const datasets: any[] = [];
    checkedSeries.forEach((s) => {
      const color = seriesColor(s);
      const axisId = unitAxisIds.get(s.unit ?? "")!;
      datasets.push({
        label: s.unit ? `${s.label} (${s.unit})` : s.label,
        data: s.x.map((x, j) => ({ x, y: s.y[j] })),
        borderColor: color,
        backgroundColor: color,
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        yAxisID: axisId,
        spanGaps: true,
      });
      // Band rendered as two extra "helper" lines immediately above/below
      // the main line, using Chart.js's own fill-between-adjacent-dataset
      // convention (fill: '-1' means "fill down to the dataset drawn
      // immediately before this one" -- order in the datasets array is
      // what that refers to, not an id) -- simplest way to get a shaded
      // envelope in Chart.js 4 without a second chart type/plugin. The
      // lower bound is added first (no fill of its own), then the upper
      // bound fills back down to it; both are hidden from the legend and
      // drawn with zero border width so only the fill area shows, not two
      // extra visible lines on top of the mean.
      if (s.band) {
        datasets.push({
          label: `${s.label} lower`,
          data: s.x.map((x, j) => ({ x, y: s.band!.lower[j] })),
          borderWidth: 0,
          pointRadius: 0,
          yAxisID: axisId,
          fill: false,
          spanGaps: true,
          hidden: false,
          order: 1,
        });
        datasets[datasets.length - 1].backgroundColor = colorWithAlpha(color, 0.15);
        datasets.push({
          label: `${s.label} band`,
          data: s.x.map((x, j) => ({ x, y: s.band!.upper[j] })),
          borderWidth: 0,
          pointRadius: 0,
          backgroundColor: colorWithAlpha(color, 0.15),
          yAxisID: axisId,
          fill: "-1",
          spanGaps: true,
          order: 1,
        });
      }
    });

    const scales: Record<string, any> = {
      x: { type: "linear", title: { display: true, text: "year" } },
    };
    let side: "left" | "right" = "left";
    for (const [unit, axisId] of unitAxisIds.entries()) {
      scales[axisId] = {
        type: "linear",
        position: side,
        title: { display: true, text: unit || "value" },
        // Only the first (default "y") axis draws its own gridlines --
        // every additional axis on the opposite side would otherwise
        // overlay a second grid on top of the first, which reads as
        // visual noise rather than a useful reference once there's more
        // than one unit checked.
        grid: { drawOnChartArea: axisId === "y" },
      };
      side = side === "left" ? "right" : "left";
    }

    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: { datasets },
      options: {
        animation: false,
        // Deliberately NOT chartAspectRatio() -- that's tuned for the
        // dashboard's own wide main-area chart (3.4), which made this
        // chart tiny squeezed into the drawer's much narrower ~32rem
        // panel (32rem / 3.4 is a sliver). A fixed, much taller ratio
        // reads fine at this panel's width.
        aspectRatio: 1.3,
        interaction: { mode: "nearest", intersect: false },
        scales,
        plugins: {
          tooltip: { mode: "nearest", intersect: false },
          legend: {
            labels: {
              // Hides the band's own two helper datasets from the legend
              // (they're not independently meaningful lines, just the
              // fill boundary for the line charted right before them) --
              // Chart.js has no per-dataset "hidden in legend" flag, so
              // this filters by the label suffix those two datasets were
              // given above.
              filter: (item: any) => !item.text?.endsWith(" lower") && !item.text?.endsWith(" band"),
            },
          },
        },
      },
    });
  }

  const allChecked = filteredRuns.length > 0 && checkedIds.size === filteredRuns.length;

  return (
    <div>
      <div className="panel-header">
        <h2 className="panel-title">Runs</h2>
        <button type="button" className="new-run-button" onClick={onNewRun}>
          <span aria-hidden="true">+</span> New Run
        </button>
      </div>

      {loadErr && <p className="panel-error">{loadErr}</p>}

      <div className="table-toolbar">
        <div className="run-controls runs-filter-row">
          <Dropdown options={modelOptions} value={filterModel} onChange={onFilterModelChange} ariaLabel="Filter by model" />
          <Dropdown options={scenarioOptions} value={filterScenario} onChange={setFilterScenario} ariaLabel="Filter by scenario" />
          <Dropdown options={STATUS_OPTIONS} value={filterStatus} onChange={setFilterStatus} ariaLabel="Filter by status" />
          {(filterModel !== ALL || filterScenario !== ALL || filterStatus !== ALL) && (
            <button
              className="text-button"
              onClick={() => {
                setFilterModel(ALL);
                setFilterScenario(ALL);
                setFilterStatus(ALL);
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        <div className="table-toolbar-actions">
          {selectedJob && (
            <button type="button" className="text-button" onClick={runAgain} disabled={runAgainBusy}>
              {runAgainBusy ? "Submitting..." : "Run again"}
            </button>
          )}
          <button
            type="button"
            className={`icon-button danger${checkedIds.size > 0 ? " active" : ""}`}
            title={checkedIds.size > 0 ? `Delete ${checkedIds.size} selected` : "Select rows to delete"}
            aria-label="Delete selected runs"
            disabled={checkedIds.size === 0 || deleting}
            onClick={() => setShowDeleteConfirm(true)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.5 9a1 1 0 0 0 1 .95h4a1 1 0 0 0 1-.95l.5-9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button type="button" className="icon-button secondary" title="Refresh" aria-label="Refresh" onClick={refreshList}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M13.5 8a5.5 5.5 0 10-1.64 3.93M13.5 8V4.5M13.5 8H10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="table-scroll">
          <table className="runs-table">
            <thead>
              <tr>
                <th className="runs-table-checkbox-col">
                  <input
                    type="checkbox"
                    aria-label="Select all runs"
                    checked={allChecked}
                    onChange={toggleCheckAll}
                  />
                </th>
                <SortableHeader label="Model" sortKeyName="model" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader label="Version" sortKeyName="version" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader
                  label="Scenario"
                  sortKeyName="scenario"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                />
                <SortableHeader label="Params" sortKeyName="params" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader label="Status" sortKeyName="status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader
                  label="Duration"
                  sortKeyName="duration"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                />
                <SortableHeader
                  label="Started"
                  sortKeyName="started"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                />
              </tr>
            </thead>
            <tbody>
              {loading && <SkeletonRows />}
              {!loading && sortedRuns.length === 0 && (
                <tr>
                  <td colSpan={8} className="runs-table-empty">
                    {runs.length === 0 ? 'No runs yet -- start one from "New Run".' : "No runs match these filters."}
                  </td>
                </tr>
              )}
              {sortedRuns.map((r) => (
                <tr
                  key={r.run_id}
                  className={r.run_id === selectedRunId ? "selected" : ""}
                  onClick={() => onSelectRun(r.run_id)}
                >
                  <td className="runs-table-checkbox-col" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select run ${r.run_id}`}
                      checked={checkedIds.has(r.run_id)}
                      onChange={() => toggleChecked(r.run_id)}
                    />
                  </td>
                  <td>{r.model}</td>
                  <td className="mono" title={r.model_version ?? undefined}>
                    {r.model_version_number ?? "--"}
                  </td>
                  <td className="mono">{summarizeScenario(r.params) || "--"}</td>
                  <td className="mono runs-table-params" title={summarizeExtraParams(r.params)}>
                    {summarizeExtraParams(r.params)}
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                    {(r.status === "running" || r.status === "queued") &&
                      r.progress &&
                      typeof r.progress.percent === "number" && (
                        <span className="progress-tag">{r.progress.percent}%</span>
                      )}
                    {r.cached && <span className="cached-tag">cached</span>}
                  </td>
                  <td>
                    {r.status === "running" || r.status === "queued"
                      ? formatElapsed(r.started_at)
                      : typeof r.duration_seconds === "number"
                        ? formatDuration(r.duration_seconds)
                        : "--"}
                  </td>
                  <td>{formatWhen(r.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selectedRunId && (
        <Drawer title={selectedJob ? `${selectedJob.model} run` : "Run"} onClose={() => onSelectRun(null)}>
          {detailErr && <p className="panel-error">{detailErr}</p>}
          {!selectedJob && !detailErr && <DrawerSkeleton />}
          {selectedJob && (
            <div className="drawer-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={drawerTab === "details"}
                className={`drawer-tab${drawerTab === "details" ? " active" : ""}`}
                onClick={() => setDrawerTab("details")}
              >
                Details
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={drawerTab === "output"}
                className={`drawer-tab${drawerTab === "output" ? " active" : ""}`}
                onClick={() => setDrawerTab("output")}
              >
                Output
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={drawerTab === "advanced"}
                className={`drawer-tab${drawerTab === "advanced" ? " active" : ""}`}
                onClick={() => setDrawerTab("advanced")}
              >
                Advanced
              </button>
            </div>
          )}
          {selectedJob && drawerTab === "details" && (
            <div className="drawer-meta">
              <div className="drawer-meta-row">
                <span className="drawer-meta-label">Run ID</span>
                <span className="mono">{selectedJob.run_id}</span>
              </div>
              <div className="drawer-meta-row">
                <span className="drawer-meta-label">Status</span>
                <span>
                  <StatusBadge status={selectedJob.status} />
                  {(selectedJob.status === "running" || selectedJob.status === "queued") &&
                    selectedJob.progress &&
                    typeof selectedJob.progress.percent === "number" && (
                      <span className="progress-tag">{selectedJob.progress.percent}%</span>
                    )}
                  {selectedJob.cached && <span className="cached-tag">cached</span>}
                </span>
              </div>
              <div className="drawer-meta-row">
                <span className="drawer-meta-label">Model</span>
                <span>{selectedJob.model}</span>
              </div>
              <div className="drawer-meta-row">
                <span className="drawer-meta-label">Model version</span>
                <span className="mono">{selectedJob.model_version_number ?? "unknown (run predates version tracking)"}</span>
              </div>
              <div className="drawer-meta-row">
                <span className="drawer-meta-label">Build</span>
                <span className="mono">{selectedJob.model_version ?? "unknown (run predates version tracking)"}</span>
              </div>
              {selectedJob.sandbox_id ? (
                <>
                  <div className="drawer-meta-row">
                    <span className="drawer-meta-label">Snapshot</span>
                    <span className="mono">{selectedJob.daytona_snapshot ?? "unknown"}</span>
                  </div>
                  <div className="drawer-meta-row">
                    <span className="drawer-meta-label">Sandbox ID</span>
                    <span className="mono">{selectedJob.sandbox_id}</span>
                  </div>
                  <div className="drawer-meta-row">
                    <span className="drawer-meta-label">Session ID</span>
                    <span className="mono">{selectedJob.session_id ?? "--"}</span>
                  </div>
                  <div className="drawer-meta-row">
                    <span className="drawer-meta-label">Command ID</span>
                    <span className="mono">{selectedJob.cmd_id ?? "--"}</span>
                  </div>
                </>
              ) : (
                <div className="drawer-meta-row">
                  <span className="drawer-meta-label">Sandbox</span>
                  <span>{selectedJob.cached ? "none (cached result)" : "unknown (run predates sandbox tracking)"}</span>
                </div>
              )}
              {drawerModelMeta ? (
                <>
                  <div className="drawer-meta-row">
                    <span className="drawer-meta-label">Scenario</span>
                    <span className="mono">
                      {(() => {
                        const native = nativeScenarioOf(selectedJob.params);
                        return native ? canonicalScenario(native) : "(default)";
                      })()}
                    </span>
                  </div>
                  {(drawerModelMeta.parameters ?? []).map((spec) => (
                    <div className="drawer-meta-row" key={spec.key}>
                      <span className="drawer-meta-label">{spec.label}</span>
                      <span className="mono">
                        {Object.prototype.hasOwnProperty.call(selectedJob.params, spec.key)
                          ? String((selectedJob.params as Record<string, unknown>)[spec.key])
                          : "(default)"}
                      </span>
                    </div>
                  ))}
                </>
              ) : (
                <div className="drawer-meta-row">
                  <span className="drawer-meta-label">Params</span>
                  <span className="mono">{summarizeParams(selectedJob.params)}</span>
                </div>
              )}
              <div className="drawer-meta-row">
                <span className="drawer-meta-label">Started</span>
                <span>{formatWhen(selectedJob.started_at)}</span>
              </div>
              {typeof selectedJob.duration_seconds === "number" ? (
                <div className="drawer-meta-row">
                  <span className="drawer-meta-label">Duration</span>
                  <span>{formatDuration(selectedJob.duration_seconds)}</span>
                </div>
              ) : (
                // Ticks up in step with pollDetail's own 500ms poll while
                // open, same as the table's own live "Started" column (see
                // formatElapsed's comment) -- started_at is now part of
                // RunJob itself (see its own doc comment), no need to
                // reach into the already-fetched list row for it.
                (selectedJob.status === "running" || selectedJob.status === "queued") && (
                  <div className="drawer-meta-row">
                    <span className="drawer-meta-label">Duration</span>
                    <span>{formatElapsed(selectedJob.started_at)}</span>
                  </div>
                )
              )}
            </div>
          )}
          {/* Kept mounted (just hidden) rather than conditionally rendered
              when the Output tab is active -- canvasRef's chart-drawing
              effect runs off selectedJob changes, not drawerTab, so
              unmounting/remounting the canvas on every tab switch would
              lose the chart until the next poll redraws it. Doesn't need
              to render at all before selectedJob exists in the first
              place -- DrawerSkeleton covers that gap now -- so this is
              never mounted any earlier than it would have been anyway. */}
          {selectedJob && (
            <div style={{ display: drawerTab === "details" ? undefined : "none" }}>
              {/* Run again's own button lives in the table toolbar now
                  (next to the delete icon button), since it already needs
                  selectedJob to be the one it acts on -- just the error
                  from that same action stays here, in the drawer, not
                  floating in the toolbar. */}
              {runAgainErr && <p className="panel-error">{runAgainErr}</p>}
              {/* The centered placeholder below is sized for a short
                  status word, not a sentence -- a failed run's
                  error.message can be an arbitrarily long raw string (e.g.
                  a Daytona 502's whole HTML body, seen in practice), which
                  looked bizarre dumped into the middle of the empty chart
                  area. Keep the placeholder itself short and put the real
                  message in its own normally-flowing paragraph instead. */}
              {selectedJob.status === "failed" && (
                <p className="panel-error">{selectedJob.error?.message || "unknown error"}</p>
              )}
              {selectedJob.status === "succeeded" && availableSeries.length > 0 ? (
                <div className="explorer">
                  <div className="explorer-toolbar">
                    <div className="explorer-view-toggle">
                      <button
                        type="button"
                        className={`explorer-btn${explorerView === "chart" ? " active" : ""}`}
                        onClick={() => setExplorerView("chart")}
                      >
                        Chart
                      </button>
                      <button
                        type="button"
                        className={`explorer-btn${explorerView === "table" ? " active" : ""}`}
                        onClick={() => setExplorerView("table")}
                      >
                        Table
                      </button>
                    </div>
                    <div className="explorer-view-toggle">
                      <button type="button" className="explorer-btn" onClick={exportSeriesCsv} disabled={checkedSeries.length === 0}>
                        Export CSV
                      </button>
                      <button type="button" className="explorer-btn" onClick={exportRawJson}>
                        Export JSON
                      </button>
                    </div>
                  </div>
                  {/* Series picker -- grouped by unit (or hector's
                      component, its closest equivalent) so same-scale
                      quantities sit together. Scrollable: gcam's Hector
                      output has dozens of variables. */}
                  <div className="explorer-series">
                    {seriesGroups.map(([unit, list]) => (
                      <div className="explorer-series-group" key={unit || "value"}>
                        <div className="explorer-series-group-label">{unit || "value"}</div>
                        {list.map((s) => (
                          <label className="explorer-series-item" key={s.key}>
                            <input
                              type="checkbox"
                              checked={checkedSeriesKeys.has(s.key)}
                              onChange={() => toggleSeries(s.key)}
                            />
                            <span className="explorer-series-swatch" style={{ background: seriesColor(s) }} />
                            <span className="explorer-series-label" title={s.label}>
                              {s.label}
                            </span>
                            {s.band && <span className="explorer-series-band-tag">band</span>}
                          </label>
                        ))}
                      </div>
                    ))}
                  </div>
                  {/* Canvas kept mounted (hidden) while the table view is
                      active, same reasoning as this whole block's own
                      hidden-on-other-tabs comment: unmounting it would
                      lose the chart, and Chart.js can't size itself
                      inside a display:none box to redraw there either. */}
                  <div
                    className="explorer-chart-area"
                    style={{ display: explorerView === "chart" ? undefined : "none" }}
                  >
                    <canvas ref={canvasRef} height={380}></canvas>
                  </div>
                  {explorerView === "table" && (
                    <div className="explorer-table-wrap">
                      <table className="explorer-table">
                        <thead>
                          <tr>
                            <th onClick={() => toggleTableSort("x")}>
                              year{tableSort?.key === "x" ? (tableSort.dir === "asc" ? " \u25b2" : " \u25bc") : ""}
                            </th>
                            {checkedSeries.map((s) => (
                              <th key={s.key} onClick={() => toggleTableSort(s.key)}>
                                <span className="explorer-series-swatch" style={{ background: seriesColor(s) }} />
                                <span title={s.unit ? `${s.label} (${s.unit})` : s.label}>
                                  {s.label}
                                  {tableSort?.key === s.key ? (tableSort.dir === "asc" ? " \u25b2" : " \u25bc") : ""}
                                </span>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tableRows.map((row) => (
                            <tr key={row.x}>
                              <td className="mono">{row.x}</td>
                              {row.values.map((v, i) => (
                                <td className="mono" key={checkedSeries[i].key}>
                                  {v == null ? "" : String(v)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : (
                <div className="chart-area">
                  <div className="chart-placeholder">
                    {selectedJob.status === "failed" ? "Failed" : `${selectedJob.status}...`}
                  </div>
                </div>
              )}
            </div>
          )}
          {selectedJob && drawerTab === "output" && (
            (() => {
              // While still running, stdout_tail hasn't been written yet
              // (it's only populated at finalize time) -- fall back to the
              // live snapshot (see RunJob's own live_stdout_tail comment)
              // so a still-in-progress run has something to show here too,
              // instead of this tab just being empty until it finishes.
              const isRunning = selectedJob.status === "running" || selectedJob.status === "queued";
              const rawOutput = isRunning ? selectedJob.live_stdout_tail : selectedJob.stdout_tail;
              return (
                <div className="drawer-raw-output">
                  {rawOutput ? (
                    // The run command's stdout and stderr are combined into
                    // one stream before this app ever sees them (`> file
                    // 2>&1` in buildWrappedCommand, plus most models' own
                    // run.py merging their subprocess's stderr the same
                    // way) -- there's no separate stderr to show, this
                    // already includes it. Tail-capped -- see RunJob's own
                    // stdout_tail/live_stdout_tail comments -- for
                    // debugging a run whose result doesn't make sense, not
                    // reformatted/parsed in any way.
                    <pre className="drawer-raw-output-pre">{rawOutput}</pre>
                  ) : (
                    <p className="chart-hint">{isRunning ? "No output captured yet." : "No output was captured for this run."}</p>
                  )}
                </div>
              );
            })()
          )}
          {selectedJob && drawerTab === "advanced" && (
            <div className="drawer-meta">
              {selectedJob.status === "running" || selectedJob.status === "queued" ? (
                <>
                  <div className="drawer-meta-row">
                    <span className="drawer-meta-label">Current deadline</span>
                    <span className="mono">{selectedJob.deadline_at ? formatWhen(selectedJob.deadline_at) : "unknown"}</span>
                  </div>
                  <p className="chart-hint">
                    Total seconds from when this run started -- entering the same value twice won&apos;t push the
                    deadline out any further.
                  </p>
                  <div className="form-row">
                    <input
                      type="number"
                      min={1}
                      step={1}
                      placeholder="e.g. 3600"
                      value={maxRunTimeInput}
                      onChange={(e) => setMaxRunTimeInput(e.target.value)}
                      aria-label="Max run time in seconds"
                    />
                    <span className="form-field-unit">seconds</span>
                    <button type="button" onClick={updateDeadline} disabled={deadlineBusy || !maxRunTimeInput.trim()}>
                      {deadlineBusy ? "Updating..." : "Update deadline"}
                    </button>
                  </div>
                  {deadlineErr && <p className="panel-error">{deadlineErr}</p>}
                </>
              ) : (
                <p className="chart-hint">This run has already finished -- its deadline can no longer be changed.</p>
              )}
            </div>
          )}
        </Drawer>
      )}

      {showDeleteConfirm && (
        <Modal title="Delete runs?" onClose={() => setShowDeleteConfirm(false)}>
          <p>
            Delete {checkedIds.size} selected run{checkedIds.size === 1 ? "" : "s"}? This also tears down any still-live
            sandbox behind them and can&apos;t be undone.
          </p>
          <div className="form-actions" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="text-button" onClick={() => setShowDeleteConfirm(false)}>
              Cancel
            </button>
            <button type="button" className="text-button danger" onClick={deleteSelected} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
