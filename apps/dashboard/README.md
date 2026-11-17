# Climate Models Dashboard (minimal version)

Static, build-free frontend over `apps/gateway`'s API. Implements the minimal
dashboard from `PLATFORM.md`: one screen, three controls, one chart.

- Model dropdown
- Scenario dropdown (populated from that model's native `/schema`, no
  cross-model scenario-taxonomy translation)
- Run button (submits async, polls until done)
- One default chart per model, plus a raw-JSON download link

No framework, no build step -- just `index.html` + `app.js` + `style.css`,
with Chart.js pulled from a CDN. Each model's native result is rendered by a
small adapter in `app.js` (`CHART_ADAPTERS`); adding a model here means adding
one adapter function, same spirit as adding a model to the gateway's registry.

Explicitly out of scope in this version (see PLATFORM.md's Future Ideas):
cross-model comparison/overlay, scenario-taxonomy translation UI, advanced/raw
parameter editing, run history, sharing.

## Running locally

1. Start the gateway (`apps/gateway`), which must have `daytona_api_key` set:
   ```bash
   cd apps/gateway
   uvicorn app:app --host 0.0.0.0 --port 8000
   ```
2. Serve this directory as static files, e.g.:
   ```bash
   cd apps/dashboard
   python3 -m http.server 8080
   ```
3. Open `http://localhost:8080/index.html`.

By default the dashboard calls the gateway at `http://localhost:8000`. Point
it at a different gateway with a query param:
`http://localhost:8080/index.html?gateway=http://your-gateway-host:8000`.

Tested end to end with a real headless browser (Playwright/Chromium) against
a live gateway and real Daytona sandboxes for both registered models
(hector, fair): model/scenario dropdowns populate, run submits and polls to
completion, the chart renders, and the raw-output download link appears,
with zero browser console errors.
