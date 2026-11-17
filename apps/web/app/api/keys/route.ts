/**
 * Self-serve API key management for the signed-in user (see /account's
 * page.tsx for the UI this backs). Every route here is gated by the
 * pp_session cookie (lib/session.ts) -- these are a user's OWN keys, never
 * cross-user.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifySessionCookie, SESSION_COOKIE } from "../../../lib/session";
import { createApiKey, listApiKeys } from "../../../lib/db";

export async function GET(request: NextRequest) {
  const userId = verifySessionCookie(request.cookies.get(SESSION_COOKIE)?.value);
  if (!userId) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
  const keys = await listApiKeys(userId);
  return NextResponse.json({ keys });
}

export async function POST(request: NextRequest) {
  const userId = verifySessionCookie(request.cookies.get(SESSION_COOKIE)?.value);
  if (!userId) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 100) : null;

  // The plaintext key is returned ONLY in this one response -- see
  // lib/db.ts's createApiKey comment. The UI must show it to the user
  // immediately and tell them it won't be shown again.
  const { plaintext, row } = await createApiKey(userId, label);
  return NextResponse.json({ key: plaintext, ...row });
}
