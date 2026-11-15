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

// --- Custom dropdown UI ------------------------------------------------
// Wraps a real (visually hidden) <select> -- app.js's model/schema-loading
// code above still just populates/reads that <select> with plain <option>
// elements and .value, unchanged. This only adds a styled button+listbox on
// top, kept in sync via MutationObserver so no population logic had to move.
function initCustomDropdown(container) {
  const select = container.querySelector("select");
  const toggle = container.querySelector(".dropdown-toggle");
  const valueEl = container.querySelector(".dropdown-value");
  const menu = container.querySelector(".dropdown-menu");

  function renderOptions() {
    menu.innerHTML = "";
    for (const opt of select.options) {
      const li = document.createElement("li");
      li.className = "dropdown-option" + (opt.value === select.value ? " selected" : "");
      li.textContent = opt.textContent;
      li.setAttribute("role", "option");
      li.dataset.value = opt.value;
      li.addEventListener("click", () => {
        if (select.value !== opt.value) {
          select.value = opt.value;
          select.dispatchEvent(new Event("change"));
        }
        close();
      });
      menu.appendChild(li);
    }
    const selectedOption = select.options[select.selectedIndex];
    valueEl.textContent = selectedOption ? selectedOption.textContent : "";
  }

  function open() {
    menu.removeAttribute("hidden");
    container.classList.add("open");
    toggle.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onOutsideClick);
  }

  function close() {
    menu.setAttribute("hidden", "");
    container.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onOutsideClick);
  }

  function onOutsideClick(e) {
    if (!container.contains(e.target)) {
      close();
    }
  }

  toggle.addEventListener("click", () => {
    if (menu.hasAttribute("hidden")) {
      renderOptions();
      open();
    } else {
      close();
    }
  });

  // The <select>'s options/value are owned by app.js's existing
  // loadModels()/loadSchema() logic -- observe it rather than duplicating
  // that logic here, so this stays a pure presentation layer on top.
  new MutationObserver(renderOptions).observe(select, {
    childList: true,
    attributes: true,
    attributeFilter: ["value"],
  });
  select.addEventListener("change", renderOptions);

  renderOptions();
}

document.querySelectorAll("[data-dropdown-for]").forEach(initCustomDropdown);

const modelSelect = document.getElementById("model-select");
const scenarioSelect = document.getElementById("scenario-select");
const runButton = document.getElementById("run-button");
const refreshButton = document.getElementById("refresh-button");
const statusText = document.getElementById("status-text");
const rawLink = document.getElementById("raw-download-link");
const progressBar = document.getElementById("progress-bar");
const loadingOverlay = document.getElementById("loading-overlay");
const loadingText = document.getElementById("loading-text");

// The loading state renders as an overlay ON TOP of the chart area (not a
// strip above it), so a previous chart stays visible, dimmed, underneath
// while a new run is in flight instead of the layout shifting around it.
function showLoading(text, progress) {
  loadingOverlay.removeAttribute("hidden");
  loadingText.textContent = text;

  // `progress` is only ever real data from the model itself (e.g. fair's own
  // tqdm bar, read via the gateway -- see apps/gateway/jobs.py), never a
  // synthetic/estimated value. When a model has nothing real to report (e.g.
  // hector -- confirmed by testing there's no intermediate signal), `progress`
  // stays null and the bar shows as indeterminate rather than faking a percent.
  if (progress && typeof progress.percent === "number") {
    progressBar.value = progress.percent;
  } else {
    progressBar.removeAttribute("value"); // indeterminate style
  }
}

function hideLoading() {
  loadingOverlay.hidden = true;
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
  setStatus("Select a model and scenario, then click Run.");
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
  oscar(result) {
    const native = result.result; // { year, mean_D_Tg, std_D_Tg }
    return {
      labels: native.year,
      values: native.mean_D_Tg,
      label: `OSCAR mean temperature anomaly (${result.scenario}, nMC=${result.nMC})`,
    };
  },
};

// Chart.js's `aspectRatio` is a fixed number, not something CSS media
// queries can touch -- on a narrow (phone-width) screen, the same wide
// desktop ratio (3.4) would squash the chart down to a sliver. Pick a
// shorter/taller ratio under a phone-ish breakpoint instead, matching the
// `.statusbar`/`.toolbar` CSS breakpoint at 640px.
function chartAspectRatio() {
  return window.innerWidth <= 640 ? 1.4 : 3.4;
}

function renderChart(modelName, result) {
  const adapter = CHART_ADAPTERS[modelName];
  if (!adapter) {
    setStatus(`No chart adapter for model '${modelName}' yet.`, true);
    return;
  }
  const { labels, values, label } = adapter(result);

  document.getElementById("chart-placeholder").hidden = true;

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
      // Explicit wide aspect ratio (default is 2:1) -- the canvas's height
      // attribute alone doesn't control final rendered size, since Chart.js's
      // maintainAspectRatio:true (the default) recomputes height from width
      // using this ratio on every resize. Re-picked on window resize below so
      // rotating a phone or resizing the window adapts it live.
      aspectRatio: chartAspectRatio(),
      scales: {
        x: { title: { display: true, text: "year" } },
        y: { title: { display: true, text: "temperature anomaly" } },
      },
    },
  });
}

// Debounced resize handler: update the live chart's aspect ratio when
// crossing the phone/desktop breakpoint, rather than leaving it fixed at
// whatever ratio was active when the chart was first drawn.
let resizeTimer = null;
window.addEventListener("resize", () => {
  if (!chart) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const ratio = chartAspectRatio();
    if (chart.options.aspectRatio !== ratio) {
      chart.options.aspectRatio = ratio;
      chart.resize();
    }
  }, 150);
});

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
    const text = `${job.status}${pct}...`;
    setStatus(`${modelName}: ${text}`);
    showLoading(text, job.progress);
    // Tightened from 500ms: confirmed by testing that fast models like fair
    // can complete a progress phase in ~1-2s, so a slower poll could visibly
    // skip from 0% straight to 100%. Matches the gateway's own tightened
    // internal poll interval (apps/gateway/jobs.py).
    pollTimer = setTimeout(() => pollRun(runId, modelName), 150);
    return;
  }

  runButton.disabled = false;
  hideLoading();

  if (job.status === "succeeded") {
    setStatus(`${modelName}: succeeded${job.cached ? " (cached)" : ""}`);
    renderChart(modelName, job.result);
    setRawDownload(job);
    // Only offer "Refresh" when the thing currently on screen actually came
    // from the cache -- see apps/gateway/cache.py's append-only log design:
    // this forces a real run that gets appended as a newer entry.
    refreshButton.hidden = !job.cached;
  } else {
    setStatus(`${modelName}: failed - ${job.error?.message || "unknown error"}`, true);
  }
}

async function runModel(forceRefresh = false) {
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  runButton.disabled = true;
  refreshButton.disabled = true;
  refreshButton.hidden = true;
  rawLink.hidden = true;

  const modelName = modelSelect.value;
  const scenario = scenarioSelect.value;

  try {
    setStatus(`${modelName}: submitting...`);
    showLoading("submitting...", null);
    const params = buildParams(scenario);
    const submitted = await fetchJson(`/v1/models/${modelName}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params, refresh: forceRefresh }),
    });
    pollRun(submitted.run_id, modelName);
  } catch (err) {
    runButton.disabled = false;
    hideLoading();
    setStatus(`${modelName}: ${err.message}`, true);
  } finally {
    refreshButton.disabled = false;
  }
}

modelSelect.addEventListener("change", () => {
  refreshButton.hidden = true; // selection changed, no longer matches what's displayed
  loadSchema(modelSelect.value).catch((err) => setStatus(err.message, true));
});

scenarioSelect.addEventListener("change", () => {
  refreshButton.hidden = true; // same reasoning as the model-select handler above
});

runButton.addEventListener("click", () => {
  runModel(false);
});

refreshButton.addEventListener("click", () => {
  runModel(true);
});

loadModels().catch((err) => {
  setStatus(`Failed to load models from ${GATEWAY_URL}: ${err.message}`, true);
});
