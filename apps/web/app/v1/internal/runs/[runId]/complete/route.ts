import { completeRunFromWebhook } from "../../../../../../lib/runs";

/**
 * Receives the POST a sandbox's own wrapped command sends back when its
 * run command exits (see lib/runs.ts's buildWrappedCommand) -- the PRIMARY
 * way a run gets finalized now, not a fallback. No CORS wrapper here on
 * purpose: this is a server-to-server call from inside a Daytona sandbox,
 * never from a browser, so none of the cors.ts machinery (meant for public
 * pages fetching this app from arbitrary origins) applies.
 *
 * Auth: the run_id in the URL itself is treated as sufficient -- it's an
 * unguessable randomUUID, generated and stored server-side at submitRun()
 * time against one specific sandbox/session, never exposed anywhere a
 * third party could discover it ahead of time. No separate per-run secret
 * token is layered on top of it (confirmed as an explicit, deliberate
 * choice, not an oversight -- see the design discussion this route came
 * out of: "run_id itself is enough for now").
 */
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ detail: "invalid JSON body" }, { status: 400 });
    }

    const exitCode = Number(body?.exit_code);
    const stdout = typeof body?.stdout === "string" ? body.stdout : "";
    if (!Number.isInteger(exitCode)) {
      return Response.json({ detail: "exit_code must be an integer" }, { status: 400 });
    }

    const view = await completeRunFromWebhook(runId, exitCode, stdout);
    if (!view) {
      return Response.json({ detail: `unknown run_id '${runId}'` }, { status: 404 });
    }
    return Response.json(view);
  } catch (err) {
    // Deliberately still a well-formed response, not an uncaught throw --
    // the sandbox's own urllib/Downloads call wraps this in a try/except
    // and ignores the result either way (see buildWrappedCommand), but a
    // clean 502 here still makes this endpoint debuggable from logs.
    return Response.json({ detail: `gateway_error: ${String((err as Error)?.message ?? err)}` }, { status: 502 });
  }
}
