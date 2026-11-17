/**
 * Hardcoded-password dashboard gate -- explicitly scoped as a placeholder
 * ("for now gate login with a hardcoded password"), not a real auth
 * system. No user accounts, no hashing, no session store: one shared
 * password, one cookie, checked by proxy.ts on every /dashboard/* request.
 *
 * DASHBOARD_PASSWORD can be overridden via env (so a real deployment isn't
 * stuck with this literal string in source), but defaults to the hardcoded
 * value per the request -- there is deliberately no "forgot password"/
 * reset flow, no per-user anything.
 */
export const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "climate2024";

export const DASHBOARD_AUTH_COOKIE = "dashboard_auth";

// Not a secret token -- just a fixed marker proxy.ts checks for. Since the
// cookie is httpOnly and only ever set by app/api/login/route.ts after
// checking DASHBOARD_PASSWORD server-side, a visitor can't set this
// themselves without already knowing the password.
export const DASHBOARD_AUTH_VALUE = "ok";
