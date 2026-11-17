/**
 * GitHub OAuth callback -- exchanges the `code` GitHub just redirected back
 * with for an access token, fetches the signed-in user's public profile,
 * upserts a `users` row (lib/db.ts), and sets the pp_session cookie
 * (lib/session.ts) before redirecting to /account.
 */
import { NextRequest, NextResponse } from "next/server";
import { upsertGithubUser } from "../../../../../lib/db";
import { createSessionCookieValue, SESSION_COOKIE } from "../../../../../lib/session";
import { OAUTH_STATE_COOKIE } from "../route";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.json({ error: "invalid or expired OAuth state" }, { status: 400 });
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "GitHub OAuth is not configured on this deployment" }, { status: 500 });
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: new URL("/api/auth/github/callback", request.url).toString(),
    }),
  });
  const tokenBody = await tokenRes.json().catch(() => ({}));
  const accessToken = tokenBody.access_token;
  if (!accessToken) {
    return NextResponse.json(
      { error: `GitHub token exchange failed: ${tokenBody.error_description || tokenBody.error || "no access_token in response"}` },
      { status: 502 },
    );
  }

  const profileRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json" },
  });
  if (!profileRes.ok) {
    return NextResponse.json({ error: "failed to fetch GitHub profile" }, { status: 502 });
  }
  const profile = await profileRes.json();

  const user = await upsertGithubUser(profile.id, profile.login, profile.avatar_url ?? null);

  const res = NextResponse.redirect(new URL("/account", request.url));
  res.cookies.set(SESSION_COOKIE, createSessionCookieValue(user.id), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
