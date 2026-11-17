import { advanceRun } from "../../../../lib/runs";
import { corsJson, corsOptions } from "../../../../lib/cors";

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    const view = await advanceRun(runId);
    if (!view) {
      return corsJson({ detail: `unknown run_id '${runId}'` }, { status: 404 });
    }
    return corsJson(view);
  } catch (err) {
    return corsJson({ detail: `gateway_error: ${String((err as Error)?.message ?? err)}` }, { status: 502 });
  }
}
