import { NextRequest, NextResponse } from "next/server";
import { verifySessionCookie, SESSION_COOKIE } from "../../../../lib/session";
import { revokeApiKey } from "../../../../lib/db";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = verifySessionCookie(request.cookies.get(SESSION_COOKIE)?.value);
  if (!userId) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
  const { id } = await params;
  const keyId = Number(id);
  if (!Number.isInteger(keyId)) {
    return NextResponse.json({ error: "invalid key id" }, { status: 400 });
  }
  // revokeApiKey is scoped to (userId, keyId) -- see lib/db.ts; a key id
  // that exists but belongs to someone else silently no-ops rather than
  // leaking whether it exists.
  await revokeApiKey(userId, keyId);
  return NextResponse.json({ ok: true });
}
