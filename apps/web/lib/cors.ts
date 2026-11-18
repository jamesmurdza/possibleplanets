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
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

export function corsJson(body: unknown, init?: { status?: number; headers?: Record<string, string> }): NextResponse {
  return withCors(NextResponse.json(body, init));
}

export function corsOptions(): NextResponse {
  return withCors(new NextResponse(null, { status: 204 }));
}

/**
 * The standard "something unexpected blew up" response every /v1/* route's
 * catch block returns -- e.g. a Daytona/Postgres call throwing. Previously
 * each route just folded `err.message` into the response body and moved on
 * -- nothing was ever logged server-side, so the ONLY record of a failure
 * was whatever reached the caller's browser. That's exactly how GCAM's
 * sandbox-build failure (missing gitignored input -- see lib/models.ts's
 * prebuilt_image comment) went unnoticed for a while: it 502'd for every
 * single request, with zero visibility on Netlify's own side, until
 * someone happened to check devtools. `console.error` here lands in
 * Netlify's function logs regardless of whether anyone's looking at the
 * response body -- the first place to check for a 502 going forward.
 */
export function corsGatewayError(err: unknown, context: string): NextResponse {
  console.error(`[${context}]`, err);
  return corsJson({ detail: `gateway_error: ${String((err as Error)?.message ?? err)}` }, { status: 502 });
}
