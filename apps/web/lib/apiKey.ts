/**
 * Placeholder API-key gate for the run-creation / run-status surface of the
 * public v1 gateway (POST /v1/models/{model}/runs, GET /v1/runs/{runId}) --
 * NOT a real per-account auth system yet. There's only one shared key, read
 * from env with a hardcoded dev default, same "for now" scope as
 * lib/auth.ts's DASHBOARD_PASSWORD. This exists so:
 *
 *   1. The model page's "How to run" REST example can show a real-looking
 *      `curl ... -H "Authorization: Bearer <key>"` call and have it
 *      genuinely 401 when copy-pasted with a placeholder key -- there's no
 *      public self-serve key yet, and the doc should say so truthfully
 *      instead of showing a call that would actually just work.
 *   2. There's a slot already wired up for when real accounts + per-user
 *      API keys exist -- swap hasValidApiKey's single-string compare for a
 *      real lookup, call sites don't need to move.
 *
 * The dashboard's own fetchJson (lib/clientApi.ts) attaches this exact key
 * to every request it makes, so the dashboard itself is unaffected -- this
 * only blocks requests that don't send it (e.g. a curl copied from the
 * docs with the literal placeholder text, or no Authorization header at
 * all). The key is intentionally visible in the client bundle (via
 * NEXT_PUBLIC_GATEWAY_API_KEY) -- it is not a secret today, exactly like
 * DASHBOARD_PASSWORD isn't; both are "for now" gates, not real security
 * boundaries, until real accounts land.
 *
 * Read-only listing endpoints (GET /v1/models, GET /v1/runs/latest, GET
 * /v1/runs, GET /v1/stats) deliberately do NOT check this -- those are
 * used unauthenticated by the public home page and model/scenario article
 * pages (see app/page.tsx, app/models/[model]/page.tsx), so gating them
 * would break the public site, not just block external curl calls.
 */
export const GATEWAY_API_KEY =
  process.env.NEXT_PUBLIC_GATEWAY_API_KEY || process.env.GATEWAY_API_KEY || "dev-placeholder-key-5f2a9c";

export function hasValidApiKey(req: Request): boolean {
  const header = req.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 && token === GATEWAY_API_KEY;
}
