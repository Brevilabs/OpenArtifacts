import { deleteDoc, listDocs } from "./api/manage.js";
import { createDoc, updateDoc } from "./api/push.js";
import { capturePublish, captureUnshare, scheduleCapture } from "./analytics.js";
import {
  authenticateRequest,
  INELIGIBLE_PLAN,
  mayPublish,
  publisherErrorResponse,
} from "./auth.js";
import type { Env } from "./config.js";
import { errorResponse } from "./errors.js";
import { handleServing, servingError, SERVING_PREFIX } from "./serve.js";

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

/**
 * Lowercase and drop the trailing root dot, so `A.Com` and `a.com.` both match
 * `a.com`. The root dot matters: `new URL("https://symposium.page./x").hostname` is
 * `"symposium.page."`, so without this a request with a dotted Host header would
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

/**
 * Every API request authenticates before any handler sees it, so a handler can
 * assume a publisher and never has to reason about the license key.
 */
async function handleApi(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (!auth.ok) return publisherErrorResponse(auth);

  // `/api/v1/docs` and `/api/v1/docs/{docId}` are the whole surface. Anything
  // the host matched into the API but that no route claims is a 404, never a
  // fall-through to the serving surface.
  const [collection, docId, ...extra] = url.pathname
    .slice(API_PREFIX.length)
    .split("/")
    .filter(Boolean);

  // Entitlement is per operation. Authentication above says *who* this is;
  // only publishing asks whether their plan may. Applying it to the whole
  // surface instead would refuse `GET` and `DELETE`, stranding a downgraded
  // publisher's already-public documents with no way to withdraw them — a
  // worse outcome than the gate exists to prevent.
  //
  // Scoped to the two routes that actually publish, not to the method: a
  // `POST` at a path no route claims stays `404`, as the contract says.
  const publishing =
    collection === "docs" &&
    extra.length === 0 &&
    ((docId === undefined && request.method === "POST") ||
      (docId !== undefined && request.method === "PUT"));
  if (publishing && !mayPublish(auth.publisher.plan)) {
    return publisherErrorResponse(INELIGIBLE_PLAN);
  }

  // Every dispatch is `return await`, never a bare `return` of the handler's
  // promise, for the reason spelled out on the catch below.
  if (collection === "docs" && extra.length === 0) {
    if (docId === undefined && request.method === "POST") {
      const response = await createDoc(request, url, env, auth.publisher);
      if (response.status === 201) {
        scheduleCapture(ctx, capturePublish(env, auth.publisher.owner, "create"));
      }
      return response;
    }
    if (docId === undefined && request.method === "GET") {
      return await listDocs(url, env, auth.publisher);
    }
    if (docId !== undefined && request.method === "PUT") {
      const response = await updateDoc(request, url, env, auth.publisher, docId);
      if (response.status === 200) {
        scheduleCapture(ctx, capturePublish(env, auth.publisher.owner, "update"));
      }
      return response;
    }
    if (docId !== undefined && request.method === "DELETE") {
      const response = await deleteDoc(env, auth.publisher, docId);
      if (response.status === 204) {
        scheduleCapture(ctx, captureUnshare(env, auth.publisher.owner));
      }
      return response;
    }
  }

  return errorResponse("not_found", `No API route for ${url.pathname}`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    try {
      // `return await`, not `return` — here, and at every dispatch either
      // surface makes. A bare return hands somebody else's promise back
      // unawaited: the rejection sails straight past this catch, and workerd
      // reports it as an unhandled rejection even when a caller further up did
      // handle it, which fails the whole test run.
      switch (surface) {
        case "api":
          return await handleApi(request, url, env, ctx);
        case "serving":
          return await handleServing(request, url, env);
        default:
          return errorResponse("not_found", `No route for ${url.pathname}`);
      }
    } catch (error) {
      // R2 and D1 can fail mid-request. Left uncaught they become workerd's
      // plain-text 500. The API keeps its JSON contract, while the reader-facing
      // surface gets a proper status page. The cause is logged rather than
      // returned because it can quote a query or a key.
      console.error("unhandled error", { path: url.pathname, error });
      const message = "Something went wrong on our end. Please try again.";
      // The surface still decides the headers. A 500 on a doc url is a serving
      // response like any other, and has to carry the robots tag that proves it.
      return surface === "serving"
        ? servingError(request.method, "internal")
        : errorResponse("internal", message);
    }
  },
} satisfies ExportedHandler<Env>;
