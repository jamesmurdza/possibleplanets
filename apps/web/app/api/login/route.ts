import { NextResponse } from "next/server";
import { DASHBOARD_PASSWORD, DASHBOARD_AUTH_COOKIE, DASHBOARD_AUTH_VALUE } from "../../../lib/auth";

export async function POST(request: Request) {
  const { password } = await request.json().catch(() => ({ password: "" }));
  if (password !== DASHBOARD_PASSWORD) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(DASHBOARD_AUTH_COOKIE, DASHBOARD_AUTH_VALUE, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // 7 days -- long enough to not be annoying, short enough that this
    // "for now" cookie doesn't linger forever.
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
