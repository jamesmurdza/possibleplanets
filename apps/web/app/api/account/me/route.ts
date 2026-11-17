import { NextRequest, NextResponse } from "next/server";
import { verifySessionCookie, SESSION_COOKIE } from "../../../../lib/session";
import { getUserById } from "../../../../lib/db";

export async function GET(request: NextRequest) {
  const userId = verifySessionCookie(request.cookies.get(SESSION_COOKIE)?.value);
  if (!userId) {
    return NextResponse.json({ user: null });
  }
  const user = await getUserById(userId);
  return NextResponse.json({ user });
}
