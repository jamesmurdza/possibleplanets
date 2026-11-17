/**
 * Gates /dashboard/* behind a login -- the public site (home page, model
 * articles, scenario articles) stays fully open; only the existing
 * dashboard (New Run/Runs/Compare/Overview) requires auth. "middleware.ts"
 * was renamed to "proxy.ts" in Next.js 16 (same behavior, new name/export
 * -- see node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md)
 *
 * Hardcoded-password auth, per explicit instruction ("for now gate login
 * with a hardcoded password") -- see app/api/login/route.ts for the actual
 * check. This only verifies a cookie is PRESENT and has the expected
 * value; it's deliberately not a real session store, same "for now" scope
 * as the password itself.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { DASHBOARD_AUTH_COOKIE, DASHBOARD_AUTH_VALUE } from "./lib/auth";

export function proxy(request: NextRequest) {
  const cookie = request.cookies.get(DASHBOARD_AUTH_COOKIE);
  if (cookie?.value === DASHBOARD_AUTH_VALUE) {
    return NextResponse.next();
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: "/dashboard/:path*",
};
