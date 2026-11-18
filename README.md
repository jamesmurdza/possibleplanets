# Possible Planets

A dashboard for running and comparing climate/economic models (HECTOR,
FAIR, OSCAR, DICE, MAGICC, the Two Layer Model, GCAM) in isolated
Daytona sandboxes.

This repo used to also host a Jekyll static site at its root (the
public-facing site, before it moved to Next.js) and a separate Python
FastAPI gateway + static-HTML dashboard (`apps/gateway`, `apps/dashboard`,
before that logic moved into `apps/web`'s own Next.js API routes) --
both have been removed; see `PLATFORM.md`'s stale-doc note for the
history. The real app now lives entirely in `apps/web` (Node/
TypeScript, no Python anywhere in this repo anymore).

## Setup

```bash
cd apps/web
npm install
npm run dev
```

Visit `http://localhost:3000`.

## Repo layout

```
apps/
  web/           the real, live Next.js app (API routes + dashboard + public site)
sandboxes/       per-model Dockerfile + run.py, one subdir per model
docs/            reference docs (sandbox resource experiments, GCAM investigation, etc.)
PLATFORM.md      original platform spec/plan (see its own stale-doc note)
```
