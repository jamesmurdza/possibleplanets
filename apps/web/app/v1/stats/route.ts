import { getDurationStats } from "../../../lib/db";
import { corsJson, corsOptions } from "../../../lib/cors";

export async function OPTIONS() {
  return corsOptions();
}

export async function GET() {
  try {
    const stats = await getDurationStats();
    return corsJson({ stats });
  } catch {
    return corsJson({ stats: [] });
  }
}
