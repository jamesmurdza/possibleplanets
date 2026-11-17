/**
 * Signed session cookie for GitHub-logged-in users (app/account/*,
 * app/api/keys/*) -- a completely separate concern from lib/auth.ts's
 * DASHBOARD_AUTH_COOKIE, which gates the internal /dashboard/* ops console
 * behind one shared hardcoded password. This is per-user: anyone can sign
 * in with their own GitHub account and gets their own session + API keys.
 *
 * Stateless by design (no sessions table) -- the cookie value is just
 * `<userId>.<hmac>`, where hmac = HMAC-SHA256(userId, SESSION_SECRET). A
 * forged userId would need SESSION_SECRET to produce a matching hmac, so
 * verifySessionCookie() only has to recompute and compare, no DB round
 * trip. SESSION_SECRET defaults to a hardcoded dev value (same "for now"
 * tradeoff as DASHBOARD_PASSWORD) -- override it in any real deployment.
 */
import { createHmac, timingSafeEqual } from "crypto";

const SESSION_SECRET = process.env.SESSION_SECRET || "dev-session-secret-change-me";

export const SESSION_COOKIE = "pp_session";

function sign(userId: number): string {
  return createHmac("sha256", SESSION_SECRET).update(String(userId)).digest("hex");
}

export function createSessionCookieValue(userId: number): string {
  return `${userId}.${sign(userId)}`;
}

/** Returns the authenticated user id, or null if the cookie is missing,
 * malformed, or its signature doesn't match (e.g. SESSION_SECRET rotated,
 * or someone just made a userId up). */
export function verifySessionCookie(value: string | undefined | null): number | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const idPart = value.slice(0, dot);
  const sigPart = value.slice(dot + 1);
  const userId = Number(idPart);
  if (!Number.isInteger(userId) || userId <= 0) return null;

  const expected = sign(userId);
  // Constant-time compare -- same reasoning as any MAC check: a naive ===
  // leaks how many leading bytes matched via response timing.
  const a = Buffer.from(sigPart);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? userId : null;
}
