/**
 * Auth check for the run-creation / run-status surface of the public v1
 * gateway (POST /v1/models/{model}/runs, GET /v1/runs/{runId}). Two ways
 * to pass:
 *
 *   1. A real per-user API key (lib/db.ts's api_keys table), sent as
 *      `Authorization: Bearer <key>` -- what an external caller uses.
 *      Created/revoked at /account, after signing in with GitHub
 *      (app/api/auth/github/*). Replaces the single shared placeholder
 *      key this file used to export.
 *   2. The existing `dashboard_auth` cookie (lib/auth.ts) -- this project's
 *      OWN dashboard (NewRunPanel etc.) is already gated by that cookie
 *      at the page level (proxy.ts), so it's treated as "this request
 *      came from our own already-authenticated ops console" and doesn't
 *      additionally need a personal API key. This is also why
 *      lib/clientApi.ts no longer needs to attach anything -- the
 *      browser already sends dashboard_auth on every same-origin request
 *      once logged into /dashboard, and (unlike the old placeholder key)
 *      it's httpOnly, so it can't be read out of the client JS bundle.
 *
 * Read-only listing endpoints (GET /v1/models, /v1/runs/latest, /v1/runs,
 * /v1/stats) deliberately do NOT call this -- those are used
 * unauthenticated by the public home/model/scenario pages (see
 * app/page.tsx, app/models/[model]/page.tsx), so gating them would break
 * the public site, not just block external curl calls.
 *
 * Cached results skip this check entirely -- see lib/runs.ts's
 * submitRun(): the auth check there only runs on a cache MISS (i.e. a
 * request that would actually create a sandbox), never on a cache hit.
 * Nothing is being authorized for a cache hit; the answer was already
 * sitting in run_cache from some earlier real, authorized run.
 */
import { findUserByApiKey, UserRow } from "./db";
import { DASHBOARD_AUTH_COOKIE, DASHBOARD_AUTH_VALUE } from "./auth";

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Returns the authenticated user, or `"internal"` for a request carrying
 * a valid dashboard_auth cookie (no per-user identity in that case -- it's
 * this project's own console, not an external API consumer), or null if
 * neither credential is present/valid. */
export async function checkApiAuth(req: Request): Promise<UserRow | "internal" | null> {
  if (cookieValue(req, DASHBOARD_AUTH_COOKIE) === DASHBOARD_AUTH_VALUE) {
    return "internal";
  }
  const header = req.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  return await findUserByApiKey(token);
}

export async function hasValidApiKey(req: Request): Promise<boolean> {
  return (await checkApiAuth(req)) !== null;
}
