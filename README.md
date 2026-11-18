# Possible Planets

A dashboard for running and comparing climate/economic models (HECTOR,
FAIR, OSCAR, DICE, MAGICC, the Two Layer Model, GCAM) in isolated
Daytona sandboxes.

This repo used to also host a Jekyll static site at its root (the
public-facing site, before it moved to Next.js) -- that's been removed;
see `PLATFORM.md`'s stale-doc note for the history. The real app now
lives entirely in `apps/web`.

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
  gateway/       superseded by apps/web/lib/runs.ts -- see PLATFORM.md
  dashboard/     superseded by apps/web -- see PLATFORM.md
sandboxes/       per-model Dockerfile + run.py, one subdir per model
docs/            reference docs (sandbox resource experiments, GCAM investigation, etc.)
PLATFORM.md      original platform spec/plan (see its own stale-doc note)
```
