/**
 * Starts the GitHub OAuth flow for /account (see lib/session.ts's header
 * comment for how this differs from the /dashboard password gate).
 *
 * GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET come from a GitHub OAuth App
 * (https://github.com/settings/developers) whose "Authorization callback
 * URL" must be set to this deployment's /api/auth/github/callback. Not
 * set here with a dev default like DASHBOARD_PASSWORD/SESSION_SECRET --
 * unlike those, there's no safe placeholder that still does something
 * real, so sign-in just 500s with a clear message until real credentials
 * are configured.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";

export const OAUTH_STATE_COOKIE = "pp_oauth_state";

export async function GET(request: NextRequest) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "GITHUB_CLIENT_ID is not configured -- GitHub sign-in isn't set up on this deployment yet." },
      { status: 500 },
    );
  }

  const state = randomBytes(16).toString("hex");
  const redirectUri = new URL("/api/auth/github/callback", request.url).toString();

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "read:user");
  authorizeUrl.searchParams.set("state", state);

  const res = NextResponse.redirect(authorizeUrl.toString());
  // Short-lived, httpOnly -- only exists to be compared back against
  // GitHub's `state` query param in the callback, as a CSRF guard (so a
  // third party can't trick a logged-out visitor into completing an OAuth
  // flow the attacker initiated).
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10,
  });
  return res;
}
