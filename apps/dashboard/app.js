/*
 * Minimal dashboard client (PLATFORM.md): model dropdown, scenario dropdown,
 * run button, one chart, raw-output download link. No cross-model
 * normalization -- each model's native result is rendered by its own small
 * adapter below, same "canonical-free, model-native" decision as the gateway
 * itself (apps/gateway). Comparison/overlay views, scenario-taxonomy
 * translation, etc. are deliberately out of scope here -- see PLATFORM.md's
 * Future Ideas section.
 */

// Override by loading this page as index.html?gateway=http://host:port
const params = new URLSearchParams(window.location.search);
const GATEWAY_URL = params.get("gateway") || guessGatewayUrl();

// This app is commonly accessed through a Daytona sandbox's proxy URL --
// https://{port}-{sandboxId}.daytonaproxy01.net -- rather than localhost.
// In that case, derive the gateway's URL by swapping the dashboard's port
// prefix (e.g. 8080) for the gateway's port (8000), same host/protocol.
// Falls back to localhost:8000 for plain local dev (python -m http.server).
function guessGatewayUrl() {
  const match = window.location.hostname.match(/^\d+-(.+\.daytonaproxy\d*\.net)$/);
  if (match) {
    return `${window.location.protocol}//8000-${match[1]}`;
  }
  return "http://localhost:8000";
}

const modelSelect = document.getElementById("model-select");
const scenarioSelect = document.getElementById("scenario-select");
const runButton = document.getElementById("run-button");
const statusText = document.getElementById("status-text");
const rawLink = document.getElementById("raw-download-link");
const progressBar = document.getElementById("progress-bar");

// `progress` is only ever real data from the model itself (e.g. fair's own
// tqdm bar, read via the gateway -- see apps/gateway/jobs.py), never a
// synthetic/estimated value. When a model has nothing real to report (e.g.
// hector -- confirmed by testing there's no intermediate signal), `progress`
// stays null and the bar shows as indeterminate rather than faking a percent.
function setProgress(progress) {
  if (progress && typeof progress.percent === "number") {
    progressBar.removeAttribute("hidden");
    progressBar.value = progress.percent;
  } else {
    progressBar.removeAttribute("hidden");
    progressBar.removeAttribute("value"); // indeterminate style
  }
}

function hideProgress() {
  progressBar.hidden = true;
}

let currentModelMeta = null; // { model, family, scenarios, params_shape }
let chart = null;
let pollTimer = null;
let rawObjectUrl = null;

function setStatus(text, isError = false) {
  statusText.textContent = text;
  statusText.classList.toggle("error", isError);
}

async function fetchJson(path, options) {
  const res = await fetch(`${GATEWAY_URL}${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function loadModels() {
  setStatus("Loading models...");
  const data = await fetchJson("/v1/models");
  modelSelect.innerHTML = "";
  for (const m of data.models) {
    const opt = document.createElement("option");
    opt.value = m.model;
    opt.textContent = `${m.model} (${m.family})`;
    modelSelect.appendChild(opt);
  }
  await loadSchema(modelSelect.value);
  setStatus("");
}

async function loadSchema(modelName) {
  const schema = await fetchJson(`/v1/models/${modelName}/schema`);
  currentModelMeta = schema;
  scenarioSelect.innerHTML = "";
  for (const s of schema.scenarios) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    scenarioSelect.appendChild(opt);
  }
}

function buildParams(scenario) {
  // Each model's run.py expects a different native shape (see
  // apps/gateway/models.py's params_shape) -- the dashboard just knows how to
  // address that shape, it doesn't try to unify it across models.
  if (currentModelMeta.params_shape === "scenario") {
    return { scenario };
  }
  if (currentModelMeta.params_shape === "scenarios") {
    return { scenarios: [scenario] };
  }
  throw new Error(`unknown params_shape '${currentModelMeta.params_shape}'`);
}

// --- Per-model chart adapters -----------------------------------------
// Each adapter takes the run's native `result` object (from GET /v1/runs/..)
// and returns { labels, values, label } for a single default line, per the
// "pick one sensible default chart per model" decision in PLATFORM.md.

const CHART_ADAPTERS = {
  hector(result) {
    const native = result.result; // { columns, index, data }
    const column = "temperature.global_tas";
    return {
      labels: native.index,
      values: native.data[column],
      label: `HECTOR temperature anomaly (${result.scenario})`,
    };
  },
  fair(result) {
    const native = result.result; // { timebounds, temperature: { scenario: [[config...], ...] } }
    const scenario = result.scenarios[0];
    const perTimestepConfigs = native.temperature[scenario];
    // FAIR runs many stochastic configs per scenario; average across configs
    // for the single default line, same spirit as HECTOR's single series.
    const meanValues = perTimestepConfigs.map((configsAtT) => {
      const sum = configsAtT.reduce((a, b) => a + b, 0);
      return sum / configsAtT.length;
    });
    return {
      labels: native.timebounds,
      values: meanValues,
      label: `FAIR mean temperature anomaly across configs (${scenario})`,
    };
  },
};

function renderChart(modelName, result) {
  const adapter = CHART_ADAPTERS[modelName];
  if (!adapter) {
    setStatus(`No chart adapter for model '${modelName}' yet.`, true);
    return;
  }
  const { labels, values, label } = adapter(result);

  if (chart) {
    chart.destroy();
  }
  chart = new Chart(document.getElementById("result-chart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label,
          data: values,
          borderWidth: 1.5,
          pointRadius: 0,
        },
      ],
    },
    options: {
      animation: false,
      scales: {
        x: { title: { display: true, text: "year" } },
        y: { title: { display: true, text: "temperature anomaly" } },
      },
    },
  });
}

function setRawDownload(fullJobResponse) {
  if (rawObjectUrl) {
    URL.revokeObjectURL(rawObjectUrl);
  }
  const blob = new Blob([JSON.stringify(fullJobResponse, null, 2)], {
    type: "application/json",
  });
  rawObjectUrl = URL.createObjectURL(blob);
  rawLink.href = rawObjectUrl;
  rawLink.download = `${fullJobResponse.model}-${fullJobResponse.run_id}.json`;
  rawLink.hidden = false;
}

async function pollRun(runId, modelName) {
  const job = await fetchJson(`/v1/runs/${runId}`);

  if (job.status === "queued" || job.status === "running") {
    const pct = job.progress && typeof job.progress.percent === "number" ? ` (${job.progress.percent}%)` : "";
    setStatus(`${modelName}: ${job.status}${pct}...`);
    setProgress(job.progress);
    pollTimer = setTimeout(() => pollRun(runId, modelName), 500);
    return;
  }

  runButton.disabled = false;
  hideProgress();

  if (job.status === "succeeded") {
    setStatus(`${modelName}: succeeded${job.cached ? " (cached)" : ""}`);
    renderChart(modelName, job.result);
    setRawDownload(job);
  } else {
    setStatus(`${modelName}: failed - ${job.error?.message || "unknown error"}`, true);
  }
}

async function runModel() {
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  runButton.disabled = true;
  rawLink.hidden = true;

  const modelName = modelSelect.value;
  const scenario = scenarioSelect.value;

  try {
    setStatus(`${modelName}: submitting...`);
    const params = buildParams(scenario);
    const submitted = await fetchJson(`/v1/models/${modelName}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params }),
    });
    pollRun(submitted.run_id, modelName);
  } catch (err) {
    runButton.disabled = false;
    setStatus(`${modelName}: ${err.message}`, true);
  }
}

modelSelect.addEventListener("change", () => {
  loadSchema(modelSelect.value).catch((err) => setStatus(err.message, true));
});

runButton.addEventListener("click", () => {
  runModel();
});

loadModels().catch((err) => {
  setStatus(`Failed to load models from ${GATEWAY_URL}: ${err.message}`, true);
});
