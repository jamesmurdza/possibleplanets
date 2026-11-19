# Possible Planets

A public site + dashboard for running and comparing climate/economic
models -- HECTOR, FaIR, OSCAR, DICE, MAGICC, the Two Layer Model, and
GCAM -- each executed for real inside its own isolated Daytona sandbox,
not simulated or mocked.

Live at [possibleplanets.com](https://possibleplanets.com) /
[possibleplanets.org](https://possibleplanets.org), deployed on Netlify.

This repo used to also host a Jekyll static site at its root (the old
public-facing site, before it moved to Next.js) and a separate Python
FastAPI gateway + static-HTML dashboard (`apps/gateway`, `apps/dashboard`,
before that logic moved into `apps/web`'s own Next.js API routes) --
both have been removed; see `PLATFORM.md`'s stale-doc note for that
history. The real app now lives entirely in `apps/web` (Node/
TypeScript -- there is no Python anywhere in this repo anymore, aside
from the model code itself inside `sandboxes/*/run.py`).

## What's actually in `apps/web`

A single Next.js app serving three things:

- **The public site** (`app/page.tsx`, `app/models/[model]`,
  `app/scenarios/[scenario]`) -- a model/scenario catalog with charts,
  "what this model assumes" writeups, per-model changelogs, and
  copy-pasteable REST/code run guides. No login required.
- **The dashboard** (`app/dashboard`, gated via `proxy.ts` + GitHub
  OAuth or a password) -- start new runs, watch them execute, browse
  and filter past runs, compare runs on one chart, manage API keys.
- **The API** (`app/v1/*` -- `models`, `runs`, `runs/[runId]`,
  `runs/latest`, `stats`; `app/api/*` -- auth/session/API-key routes).
  Starting a run kicks off a Daytona sandbox (`lib/daytona.ts`) running
  the matching `sandboxes/<model>/run.py` (or `run.jl` for DICE), polls
  it, and records the result in Postgres (`lib/db.ts`, `lib/runs.ts`).

Key `lib/` modules worth knowing about:

- `models.ts` -- the model registry: display info, each model's
  install pin (`model_version`) and the model's own official version
  number (`model_version_number`), and which Daytona snapshot runs it.
  Every version claim in here is backed by a comment explaining exactly
  how it was verified against the real installed snapshot (not guessed
  from a Dockerfile or a wrapper package's own version).
- `assumptions.ts` / `changelogs.ts` / `runGuides.ts` /
  `scenarioFullNames.ts` / `modelFullNames.ts` -- the real-world
  reference content ("what this model assumes," version history, how to
  run it yourself, full names) shown on each model/scenario page.
- `daytona.ts` / `runs.ts` / `db.ts` -- sandbox orchestration, run
  lifecycle (status polling, duration, error capture), and persistence.
- `auth.ts` / `session.ts` / `apiKey.ts` / `cors.ts` -- dashboard auth
  (GitHub OAuth or password) and API-key auth for programmatic access.

## Setup

```bash
cd apps/web
npm install
npm run dev
```

Visit `http://localhost:3000`. The public site works with no further
setup; the dashboard and API routes need environment variables (see
`.env.local`, not committed):

- `DATABASE_URL` -- Postgres connection string for the `runs` table.
- `DAYTONA_API_KEY` -- to actually launch model sandboxes.
- `SESSION_SECRET` -- signs dashboard session cookies.
- `DASHBOARD_PASSWORD` -- password-based dashboard login (alternative
  to GitHub OAuth below).
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` -- GitHub OAuth login for
  the dashboard.

## Repo layout

```
apps/
  web/             the real, live Next.js app -- public site + dashboard + /v1 API
sandboxes/         per-model Dockerfile(s) + run.py/run.jl, one subdir per model
                   (dice, fair, gcam, hector, magicc, oscar, twolayer)
docs/              reference docs -- sandbox resource experiments, the GCAM
                   investigation (architecture/setup/known gaps/trial log),
                   and provenance for the REST example outputs shown in the UI
PLATFORM.md        original platform spec/plan (see its own stale-doc note)
netlify.toml       Netlify build/deploy config for apps/web
```

## Models

| Model | What it is |
|---|---|
| HECTOR | Simple physical climate model (JGCRI) |
| FaIR | Calibrated climate emulator (Finite Amplitude Impulse-Response) |
| OSCAR | Compact Earth-system model |
| DICE | Nordhaus's Dynamic Integrated Climate-Economy model (Julia, IPOPT solve) |
| MAGICC | Simple climate model, run via its MAGICC6 binary |
| Two Layer Model | OpenSCM's two-layer energy-balance model |
| GCAM | Global Change Analysis Model (JGCRI) -- by far the heaviest/slowest to run |

Each one's real install pin, official version number, and how both were
verified live in `apps/web/lib/models.ts`.
