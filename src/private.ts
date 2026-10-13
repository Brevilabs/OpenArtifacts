/**
 * Serving an invited-only document from its own origin.
 *
 * `openartifacts.site` runs every author's scripts on purpose, so it can never
 * hold a credential. A private document therefore lives on
 * `{label}.openartifacts.site`, an origin that runs only that author's scripts,
 * and that is the only place its bytes are ever served. The rule that replaces
 * "the origin is cookieless" is: **no origin that runs more than one author's
 * scripts ever holds a credential.**
 *
 * The label is derived from the doc id by a one-way hash and never stored, so
 * the hostname — which appears in DNS and in TLS SNI — does not reveal the id.
 * The id stays in the encrypted path, where it was always secret.
 *
 * How a reader gets here: `/open/{docId}` on the API host checks the session and
 * the invite list, then redirects to this origin with a 60-second grant in the
 * URL. This origin answers that with a bodiless `303` that swaps the grant for
 * a one-hour cookie, so the credential never sits in the address bar. The cookie
 * names a principal, not a permission: **every request checks the access list in
 * D1 again**, which is why removing a person takes effect on their next request.
 */
import type { AnalyticsSink } from "./analytics.js";
import type { Env } from "./config.js";
import { findPrivateRead } from "./db.js";
import { encodeBase32 } from "./ids.js";
import {
  docPath,
  parseDocPath,
  serveAndCount,
  servingError,
  servingPageResponse,
  servingRedirect,
  SERVING_PREFIX,
  type DocRoute,
} from "./serve.js";
import {
  cookie,
  GRANT_COOKIE,
  readCookie,
  readerSecret,
  signPayload,
  verifyPayload,
} from "./session.js";

/** A label host's name: 16 bytes of hash as base32, so always 26 characters. */
export const PRIVATE_LABEL = /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

/** How long the URL grant lives. It is a hand-off between two redirects. */
const URL_GRANT_TTL_MS = 60 * 1000;

/** How long a document origin remembers a grant. Access is still checked per request. */
const COOKIE_GRANT_TTL_MS = 60 * 60 * 1000;

/** The first 16 bytes of `SHA-256("openartifacts-origin-v1:" + docId)`, as base32. */
export async function originLabel(docId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`openartifacts-origin-v1:${docId}`),
  );
  return encodeBase32(new Uint8Array(digest).slice(0, 16));
}

/**
 * The url that opens `route` on its own origin for `principal`, good for
 * `URL_GRANT_TTL_MS`. Null when this deployment cannot do private sharing: no
 * secret, or no serving host to hang a label on.
 */
export async function grantUrl(
  env: Env,
  route: DocRoute,
  principal: string,
  now: number,
): Promise<{ url: string; expiresAt: number } | null> {
  const secret = readerSecret(env);
  const servingHost = env.SERVING_HOST?.trim();
  if (secret === null || !servingHost) return null;

  const expiresAt = now + URL_GRANT_TTL_MS;
  const grant = await signPayload(secret, "grant-url", { d: route.docId, p: principal }, expiresAt);
  const host = `${await originLabel(route.docId)}.${servingHost}`;
  return { url: `https://${host}${docPath(SERVING_PREFIX, route)}?grant=${grant}`, expiresAt };
}

/** Whether this deployment can make a document invited-only and open it afterwards. */
export function privateSharingConfigured(env: Env): boolean {
  return readerSecret(env) !== null && Boolean(env.SERVING_HOST?.trim()) && Boolean(env.API_HOST?.trim());
}

/**
 * `GET /d/{docId}[/v{n}]` on a label host.
 *
 * The isolation headers are set on every response from here, errors and
 * redirects included, by copying into a response whose headers are mutable.
 * `same-origin-allow-popups` cuts the window reference a hostile opener would
 * keep to a popup that lands here; `same-origin` keeps other origins from
 * embedding what this one returns.
 */
export async function handlePrivateServing(
  request: Request,
  url: URL,
  env: Env,
  analytics: AnalyticsSink,
): Promise<Response> {
  const response = await privateResponse(request, url, env, analytics);
  const isolated = new Response(response.body, response);
  isolated.headers.set("cross-origin-opener-policy", "same-origin-allow-popups");
  isolated.headers.set("cross-origin-resource-policy", "same-origin");
  return isolated;
}

async function privateResponse(
  request: Request,
  url: URL,
  env: Env,
  analytics: AnalyticsSink,
): Promise<Response> {
  const atMs = Date.now();
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") return servingError(method, "not_found");

  // A host serves exactly one document. Any other id, whatever grant came with
  // it, is a miss before the database or the grant is even looked at.
  const route = parseDocPath(url.pathname);
  if (route === null || url.hostname.split(".")[0] !== (await originLabel(route.docId))) {
    return servingError(method, "not_found");
  }
  const secret = readerSecret(env);
  const apiHost = env.API_HOST?.trim();
  if (secret === null || !apiHost) return servingError(method, "not_found");

  // Absolute: this host has no sign-in page, and a relative path would resolve here.
  const signIn = servingRedirect(`https://${apiHost}${docPath("/open", route)}`, 302);

  const urlGrant = url.searchParams.get("grant");
  if (urlGrant !== null) {
    const granted = await verifyPayload(secret, "grant-url", urlGrant, atMs);
    if (granted?.d !== route.docId || typeof granted.p !== "string") return signIn;
    const held = await signPayload(
      secret,
      "grant-cookie",
      { d: route.docId, p: granted.p },
      atMs + COOKIE_GRANT_TTL_MS,
    );
    return servingRedirect(
      docPath(SERVING_PREFIX, route),
      303,
      cookie(GRANT_COOKIE, held, COOKIE_GRANT_TTL_MS / 1000),
    );
  }

  const held = await verifyPayload(secret, "grant-cookie", readCookie(request, GRANT_COOKIE), atMs);
  if (held?.d !== route.docId || typeof held.p !== "string") return signIn;

  const found = await findPrivateRead(env.DB, route.docId, route.pinned, held.p);
  if (found === null) return servingError(method, "not_found");
  if (found.deleted_at !== null) return servingPageResponse(method, "deleted");
  if (found.link_access === "anyone") {
    return servingRedirect(`https://${env.SERVING_HOST?.trim()}${docPath(SERVING_PREFIX, route)}`, 302);
  }
  if (!found.allowed || found.version === null) return servingError(method, "not_found");

  return await serveAndCount(request, env, route, found.version, analytics, atMs, true);
}
