/**
 * CORS for the /v1/* gateway routes only (never the dashboard page itself).
 * Unlike the old Python gateway -- which kept CORS opt-in and off by default
 * because it normally ran behind the Daytona sandbox proxy, which already
 * injects its own Access-Control-Allow-Origin -- this gateway is meant to be
 * usable directly by anyone, from any other project/origin, same as a public
 * API. So these headers are always on for /v1/* responses, not gated behind
 * an env var.
 */
import { NextResponse } from "next/server";

export function withCors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

export function corsJson(body: unknown, init?: { status?: number }): NextResponse {
  return withCors(NextResponse.json(body, init));
}

export function corsOptions(): NextResponse {
  return withCors(new NextResponse(null, { status: 204 }));
}
