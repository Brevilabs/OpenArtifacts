import { handleAccount } from "./account.js";
import { analyticsSink, type AnalyticsSink } from "./analytics.js";
import { handleDocSection } from "./api/access.js";
import { deleteDoc, listDocs } from "./api/manage.js";
import { ADMIN_PREFIX, handleAdmin } from "./admin.js";
import { APPROVAL_PREFIX, handleApproval } from "./approval/handler.js";
import { createDoc, updateDoc } from "./api/push.js";
import {
  authenticateRequest,
  isPublishingRequest,
  INELIGIBLE_PLAN,
  mayPublish,
  publisherErrorResponse,
} from "./auth.js";
import type { Env } from "./config.js";
import { DEVICE_PREFIX, handleDevice } from "./device.js";
import { errorResponse } from "./errors.js";
import { listTokens, revokeToken } from "./api/tokens.js";
import { EMBED_PREFIX, HOME_PATH, OPEN_PREFIX, SERVING_PREFIX, SHARE_PREFIX, SIGNIN_PREFIX } from "./paths.js";
import { handlePublisherServing, isolate, legacyLabelResponse, LEGACY_LABEL } from "./private.js";
import { ORIGIN_CODE } from "./origin-code.js";
import { handleEmbed } from "./embed.js";
import { handleHome } from "./home.js";
import { handleReader } from "./reader.js";
import { readerSignInConfigured } from "./reader-config.js";
import { READER_NOT_FOUND, readerIsolate } from "./reader-pages.js";
import { handleShare } from "./share.js";
import { handleServing, servingError, servingRedirect } from "./serve.js";

// The comments Durable Object class must be exported from the Worker's entry
// module for the `durable_objects` binding in wrangler.jsonc to resolve.
export { DocComments } from "./comments/object.js";

/**
 * The surfaces. Public documents and the API are separate because user HTML has
 * to be served from a sacrificial host that never carries the API — a doc that
 * turns out to be phishing should cost us the serving domain, not the brand
 * domain. A third, `publisher-serving`, is one publisher's own origin
 * (`{code}.{SERVING_HOST}`), where that publisher's invited-only documents are
 * served and only that publisher's scripts run. `app`, when configured, carries
 * the pages for people, so the API host is for programs only.
 */
export type Surface =
  | "api"
  | "app"
  | "serving"
  | "publisher-serving"
  | "legacy-serving"
  | "retired-api"
  | "unknown";

export interface SurfaceConfig {
  /** Canonical host serving public docs. Empty/undefined locally. */
  servingHost?: string;
  /** Canonical host exposing /api/v1. Empty/undefined locally. */
  apiHost?: string;
  /** Previous docs host. It redirects GET and HEAD to servingHost. */
  legacyServingHost?: string;
  /** Previous API host. It returns 410 without entering the API path. */
  retiredApiHost?: string;
  /** Host serving the pages for people. Unset or equal to apiHost keeps them on the API host. */
  appHost?: string;
}

const API_PREFIX = "/api/v1";

/**
 * Lowercase and drop the trailing root dot, so `A.Com` and `a.com.` both match
 * `a.com`. The root dot matters: `new URL("https://openartifacts.site./x").hostname` is
 * `"openartifacts.site."`, so without this a request with a dotted Host header would
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

/**
 * The publisher a host belongs to, or null when it is none. That is
 * `{6-character code}.{servingHost}`, the code being the whole subdomain, so
 * `a.b.openartifacts.site` and a short or mixed-case code are the unknown hosts
 * they were before. The retired `{26-character label}` hosts are recognised too,
 * as `legacy`, so their old links can be sent on to `/open`. A publisher's
 * verified custom hostname resolves here later, by lookup.
 */
export function resolvePublisherHost(
  hostname: string,
  servingHost: string | undefined,
): { code: string } | { legacy: true } | null {
  if (!servingHost?.trim()) return null;
  const serving = normalizeHostname(servingHost);
  const host = normalizeHostname(hostname);
  if (!host.endsWith(`.${serving}`)) return null;
  const label = host.slice(0, -serving.length - 1);
  if (ORIGIN_CODE.test(label)) return { code: label };
  return LEGACY_LABEL.test(label) ? { legacy: true } : null;
}

function pathIsUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function hostsAreConfigured(config: SurfaceConfig): boolean {
  return [
    config.servingHost,
    config.apiHost,
    config.legacyServingHost,
    config.retiredApiHost,
    config.appHost,
  ].some((host) => host?.trim());
}

/**
 * The same path and query on `host`, over HTTPS: the old document host's
 * redirect, and the API host's for a page that moved to the app host.
 */
function sameUrlOn(url: URL, host: string): string {
  const target = new URL(url);
  target.protocol = "https:";
  target.hostname = normalizeHostname(host);
  target.port = "";
  return target.toString();
}

/** The pages for people: approval, reader sign-in, `/open`, the share page, Home and the frames. */
function isPagePath(pathname: string): boolean {
  return (
    pathIsUnder(pathname, APPROVAL_PREFIX) ||
    pathIsUnder(pathname, OPEN_PREFIX) ||
    pathIsUnder(pathname, SIGNIN_PREFIX) ||
    pathIsUnder(pathname, SHARE_PREFIX) ||
    pathname === HOME_PATH ||
    pathIsUnder(pathname, EMBED_PREFIX)
  );
}

/**
 * Host first, path second.
 *
 * Once any host is configured, the host alone decides the surface: a request
 * arriving on SERVING_HOST is the serving surface no matter what path it asks
 * for, which is what makes `/api/v1` unreachable there rather than merely
 * unadvertised. Unknown production hosts fail closed. Path-prefix fallback is
 * only for local development, when every host var is empty.
 */
export function resolveSurface(hostname: string, pathname: string, config: SurfaceConfig): Surface {
  if (hostMatches(hostname, config.servingHost)) return "serving";
  if (hostMatches(hostname, config.legacyServingHost)) return "legacy-serving";
  if (hostMatches(hostname, config.apiHost)) return "api";
  // After the API host, so an app host equal to it stays the API surface.
  if (hostMatches(hostname, config.appHost)) return "app";
  if (hostMatches(hostname, config.retiredApiHost)) return "retired-api";
  if (resolvePublisherHost(hostname, config.servingHost) !== null) return "publisher-serving";

  if (hostsAreConfigured(config)) return "unknown";

  if (pathIsUnder(pathname, API_PREFIX)) return "api";
  if (pathIsUnder(pathname, ADMIN_PREFIX)) return "api";
  // The pages for people and the device flow; locally they share the API
  // surface's path fallback, so `wrangler dev` can serve them too.
  if (pathIsUnder(pathname, DEVICE_PREFIX)) return "api";
  if (isPagePath(pathname)) return "api";
  if (pathIsUnder(pathname, SERVING_PREFIX)) return "serving";
  return "unknown";
}

/**
 * Every API request authenticates before any handler sees it, so a handler can
 * assume a publisher and never has to reason about the license key.
 *
 * `analytics` rides down to the handlers that change a document or who can read
 * it (create, update, delete, and the access section), for the reason given
 * where it is built.
 */
async function handleApi(
  request: Request,
  url: URL,
  env: Env,
  analytics: AnalyticsSink,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (!auth.ok) return publisherErrorResponse(auth);

  // `/api/v1/account`, `/api/v1/docs`, `/api/v1/private-docs`,
  // `/api/v1/docs/{docId}` with its `/access…`, `/html` and `/open` sections, and
  // `/api/v1/tokens/{tokenId}` are the whole surface. Anything the host matched into the API but that no route
  // claims is a 404, never a fall-through to the serving surface.
  const [collection, docId, ...extra] = url.pathname
    .slice(API_PREFIX.length)
    .split("/")
    .filter(Boolean);

  if (collection === "account" && extra.length === 0) {
    return await handleAccount(request, env, auth.publisher);
  }

  // `POST /api/v1/private-docs` is the create that is private from its first
  // insert. A server with no reader sign-in has no such route, as one that
  // predates private sharing has none: `404` after authentication and before the
  // publishing gate, so even an ineligible key sees what an old Worker shows.
  if (collection === "private-docs" && !readerSignInConfigured(env)) {
    return errorResponse("not_found", `No API route for ${url.pathname}`);
  }

  // Entitlement is per operation. Authentication above says *who* this is;
  // only publishing asks whether their plan may. Applying it to the whole
  // surface instead would refuse `GET` and `DELETE`, stranding a downgraded
  // publisher's already-public documents with no way to withdraw them — a
  // worse outcome than the gate exists to prevent.
  //
  // Scoped to the three routes that actually publish (`POST /docs`,
  // `POST /private-docs` and `PUT /docs/{docId}`), not to the method: a
  // `POST` at a path no route claims stays `404`, as the contract says.
  const publishing = isPublishingRequest(request);
  if (publishing && auth.publisher.authKind !== "account" && !mayPublish(auth.publisher.plan)) {
    return publisherErrorResponse(INELIGIBLE_PLAN);
  }

  // Every dispatch is `return await`, never a bare `return` of the handler's
  // promise, for the reason spelled out on the catch below.
  // `/docs/{docId}/access…`, `/html` and `/open`: who a document is shared
  // with and how its owner opens it. Null means no such route, which falls
  // through to the same `404` as every other unclaimed path.
  if (collection === "docs" && docId !== undefined && extra.length > 0) {
    const section = await handleDocSection(request, url, env, auth.publisher, docId, extra, analytics, ctx);
    if (section !== null) return section;
  }

  if (collection === "private-docs" && docId === undefined && extra.length === 0 && request.method === "POST") {
    return await createDoc(request, url, env, auth.publisher, analytics, "invited");
  }

  if (collection === "docs" && extra.length === 0) {
    if (docId === undefined && request.method === "POST") {
      return await createDoc(request, url, env, auth.publisher, analytics, "anyone");
    }
    if (docId === undefined && request.method === "GET") {
      return await listDocs(url, env, auth.publisher);
    }
    if (docId !== undefined && request.method === "PUT") {
      return await updateDoc(request, url, env, auth.publisher, docId, analytics);
    }
    if (docId !== undefined && request.method === "DELETE") {
      return await deleteDoc(env, auth.publisher, docId, analytics);
    }
  }

  // `docId` here is a token id: the same two path segments, named for the
  // collection they follow. Managing tokens is not gated on a plan — losing the
  // ability to publish must never cost someone the ability to revoke a machine.
  if (collection === "tokens" && extra.length === 0) {
    if (docId === undefined && request.method === "GET") {
      return await listTokens(env, auth.publisher);
    }
    if (docId !== undefined && request.method === "DELETE") {
      return await revokeToken(env, auth.publisher, docId);
    }
  }

  return errorResponse("not_found", `No API route for ${url.pathname}`);
}

/**
 * The pages for people (`isPagePath`), on the app host, or on the API host when
 * no app host is configured. Every dispatch is `return await`, for the reason
 * the router's catch gives.
 */
async function handlePage(
  request: Request,
  url: URL,
  env: Env,
  analytics: AnalyticsSink,
  ctx: ExecutionContext,
): Promise<Response> {
  if (pathIsUnder(url.pathname, APPROVAL_PREFIX)) {
    return await handleApproval(request, url, env);
  }
  // The top bar's page script and, with it, everything the Share popover is
  // made of. Served from the app host because the popover holds a credential
  // no document's origin may see. Gated like the pages below: a server with no
  // reader sign-in has no `/embed/*` and renders no tag that would ask for it.
  // Wrapped like them too, so every response carries one opener policy.
  if (pathIsUnder(url.pathname, EMBED_PREFIX)) {
    return readerIsolate(
      !readerSignInConfigured(env) ? READER_NOT_FOUND() : await handleEmbed(request, url, env, analytics, ctx),
    );
  }
  // Reader sign-in, the door a private document opens through, the share page
  // and Home. A server with no reader sign-in configured has none of these
  // pages, as one that predates private sharing has none. Every response here
  // carries the same opener policy, redirects included, so a popup is cut off
  // whatever /open decides.
  return readerIsolate(
    !readerSignInConfigured(env)
      ? READER_NOT_FOUND()
      : url.pathname === HOME_PATH
        ? await handleHome(request, url, env)
        : pathIsUnder(url.pathname, SHARE_PREFIX)
          ? await handleShare(request, url, env, analytics, ctx)
          : await handleReader(request, url, env, ctx, analytics),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const surfaceConfig = {
      servingHost: env.SERVING_HOST,
      apiHost: env.API_HOST,
      legacyServingHost: env.LEGACY_SERVING_HOST,
      retiredApiHost: env.RETIRED_API_HOST,
      appHost: env.APP_HOST,
    };
    const surface = resolveSurface(url.hostname, url.pathname, surfaceConfig);

    // The old API hostname stays attached because a limited-zone Cloudflare
    // token cannot reliably delete an omitted custom-domain route. Retire it in
    // the router instead: every method and path stops before authentication or
    // an API handler, including /health.
    if (surface === "retired-api") {
      return errorResponse(
        "gone",
        "This API host has been retired. Use https://api.openartifacts.ai.",
        { "cache-control": "no-store" },
      );
    }

    if (surface === "legacy-serving") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return servingError(request.method, "not_found");
      }
      const servingHost = env.SERVING_HOST?.trim();
      if (!servingHost) return servingError(request.method, "internal");

      return servingRedirect(sameUrlOn(url, servingHost));
    }

    // Local development has no configured hosts. In production, health answers
    // only on an explicit serving/API host; an unknown Host still fails closed.
    if (
      url.pathname === "/health" &&
      surface !== "publisher-serving" &&
      (surface !== "unknown" || !hostsAreConfigured(surfaceConfig))
    ) {
      return Response.json({ ok: true });
    }

    // Product analytics, built once per request and handed to the handlers that
    // own an outcome worth counting. It is a parameter rather than something
    // reachable from `env` on purpose: a handler that can record has to have
    // been given the ability, so the set of places an event can come from is
    // the set of places this value reaches, and that set is this file.
    //
    // `ctx` exists for this. Delivery is scheduled on `ctx.waitUntil` after the
    // response is decided, which is what keeps an analytics outage off the
    // publish and read paths; a sink built without it would have to either
    // block the response or drop the event.
    const analytics = analyticsSink(env, ctx);

    try {
      // `return await`, not `return` — here, and at every dispatch either
      // surface makes. A bare return hands somebody else's promise back
      // unawaited: the rejection sails straight past this catch, and workerd
      // reports it as an unhandled rejection even when a caller further up did
      // handle it, which fails the whole test run.
      switch (surface) {
        case "api":
          if (pathIsUnder(url.pathname, ADMIN_PREFIX)) {
            return await handleAdmin(request, url, env);
          }
          // The pages for people, before `handleApi`: a person reaches them with
          // a browser and no credential, and authenticating them would answer
          // a human with `401` JSON. None is under `/api/v1`, so nothing in the
          // frozen contract moves. With an app host they live there, and an old
          // link here is sent on with its exact path and query. A write is never
          // redirected.
          if (isPagePath(url.pathname)) {
            const appHost = env.APP_HOST?.trim();
            if (!appHost || hostMatches(url.hostname, appHost)) {
              return await handlePage(request, url, env, analytics, ctx);
            }
            if (request.method !== "GET" && request.method !== "HEAD") return readerIsolate(READER_NOT_FOUND());
            return readerIsolate(servingRedirect(sameUrlOn(url, appHost)));
          }
          // Likewise before `handleApi`: a terminal asking for a device code
          // has no credential yet, which is the entire reason it is asking.
          // Outside `/api/v1`, so the promise that every request under that
          // prefix authenticates stays exactly true.
          if (pathIsUnder(url.pathname, DEVICE_PREFIX)) {
            return await handleDevice(request, url, env);
          }
          return await handleApi(request, url, env, analytics, ctx);
        case "app":
          if (url.pathname === "/") return readerIsolate(servingRedirect(HOME_PATH, 302));
          if (isPagePath(url.pathname)) return await handlePage(request, url, env, analytics, ctx);
          return readerIsolate(READER_NOT_FOUND());
        case "serving":
          return await handleServing(request, url, env, analytics);
        case "publisher-serving": {
          const publisher = resolvePublisherHost(url.hostname, env.SERVING_HOST);
          if (publisher === null) return servingError(request.method, "not_found");
          if ("legacy" in publisher) {
            return legacyLabelResponse(request, url, env) ?? errorResponse("not_found", `No route for ${url.pathname}`);
          }
          return await handlePublisherServing(request, url, env, analytics, publisher);
        }
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
      // A publisher's origin keeps its isolation headers on a 500 too: the
      // handler that threw is the one that would have added them.
      if (surface === "publisher-serving") return isolate(servingError(request.method, "internal"));
      return surface === "serving"
        ? servingError(request.method, "internal")
        : errorResponse("internal", message);
    }
  },
} satisfies ExportedHandler<Env>;
