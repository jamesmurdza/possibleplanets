/**
 * Daytona client singleton, ported from apps/gateway/app.py's
 * get_daytona_client(). Cached at module scope -- cheap to reuse across
 * invocations within the same warm server process, and harmless to
 * recreate on a cold start.
 */
import { Daytona } from "@daytona/sdk";

let _client: Daytona | null = null;

export function getDaytonaClient(): Daytona {
  if (!_client) {
    const apiKey = process.env.daytona_api_key || process.env.DAYTONA_API_KEY;
    if (!apiKey) {
      throw new Error("DAYTONA_API_KEY not set in environment");
    }
    _client = new Daytona({ apiKey });
  }
  return _client;
}
