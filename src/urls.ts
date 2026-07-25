/**
 * The public url of a doc — the one thing a publisher actually pastes into a
 * chat, so it has to be right the first time and stable forever after (D4).
 */
import type { Env } from "./config.js";

/**
 * `https://{serving host}/d/{docId}`.
 *
 * The serving host is preferred when configured, because the url has to point
 * at the sacrificial domain even though the push arrived on the brand one. In
 * v0 nothing is configured and both surfaces share one workers.dev subdomain,
 * so the request's own origin is the answer — which also means a preview
 * deployment hands out its own urls rather than production's.
 */
export function publicDocUrl(env: Env, requestUrl: URL, docId: string): string {
  const servingHost = env.SERVING_HOST?.trim();
  const origin = servingHost ? `${requestUrl.protocol}//${servingHost}` : requestUrl.origin;
  return `${origin}/d/${docId}`;
}
