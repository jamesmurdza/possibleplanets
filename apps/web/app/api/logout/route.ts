import { NextResponse } from "next/server";
import { DASHBOARD_AUTH_COOKIE } from "../../../lib/auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(DASHBOARD_AUTH_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
