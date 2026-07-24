import type { Env } from "./config.js";
import { errorResponse } from "./errors.js";

/**
 * The two surfaces. They are separate because user HTML has to be served from a
 * sacrificial host that never carries the API — a doc that turns out to be
 * phishing should cost us the serving domain, not the brand domain.
 */
export type Surface = "api" | "serving" | "unknown";

export interface SurfaceConfig {
  /** Host serving public docs. Empty/undefined in v0. */
  servingHost?: string;
  /** Host exposing /api/v1. Empty/undefined in v0. */
  apiHost?: string;
}

const API_PREFIX = "/api/v1";
const SERVING_PREFIX = "/d";

/**
 * Lowercase and drop the trailing root dot, so `A.Com` and `a.com.` both match
 * `a.com`. The root dot matters: `new URL("https://updoc.page./x").hostname` is
 * `"updoc.page."`, so without this a request with a dotted Host header would
 * miss the serving-host match and fall through to the path prefix — which is
 * exactly how `/api/v1` would become reachable on the serving domain.
 */
function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function hostMatches(hostname: string, configured: string | undefined): boolean {
  if (!configured) return false;
  return normalizeHostname(hostname) === normalizeHostname(configured);
}

function pathIsUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Host first, path second.
 *
 * Once the hosts are configured, the host alone decides the surface: a request
 * arriving on SERVING_HOST is the serving surface no matter what path it asks
 * for, which is what makes `/api/v1` unreachable there rather than merely
 * unadvertised. When the host matches nothing configured — the v0 workers.dev
 * case, and the migration window before DNS moves — the path prefix decides.
 */
export function resolveSurface(hostname: string, pathname: string, config: SurfaceConfig): Surface {
  if (hostMatches(hostname, config.servingHost)) return "serving";
  if (hostMatches(hostname, config.apiHost)) return "api";

  if (pathIsUnder(pathname, API_PREFIX)) return "api";
  if (pathIsUnder(pathname, SERVING_PREFIX)) return "serving";
  return "unknown";
}

/** Nothing on the serving host is ever indexable, including its errors. */
const SERVING_HEADERS: HeadersInit = {
  "x-robots-tag": "noindex, nofollow",
};

// Phase 3 (push) and phase 5 (manage) mount their handlers here.
function handleApi(_request: Request, url: URL, _env: Env): Response {
  return errorResponse("not_found", `No API route for ${url.pathname}`);
}

// Phase 4 mounts the /d/{docId} and /d/{docId}/v{n} handlers here.
function handleServing(_request: Request, url: URL, _env: Env): Response {
  return errorResponse("not_found", `No doc at ${url.pathname}`, SERVING_HEADERS);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Deliberately outside the surface split: the deploy smoke check has to
    // reach it on whichever host it lands on, and it discloses nothing.
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    const surface = resolveSurface(url.hostname, url.pathname, {
      servingHost: env.SERVING_HOST,
      apiHost: env.API_HOST,
    });

    switch (surface) {
      case "api":
        return handleApi(request, url, env);
      case "serving":
        return handleServing(request, url, env);
      default:
        return errorResponse("not_found", `No route for ${url.pathname}`);
    }
  },
} satisfies ExportedHandler<Env>;
