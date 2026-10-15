/**
 * Serving a publisher's invited-only documents from the publisher's own origin.
 *
 * `openartifacts.site` runs every publisher's scripts on purpose, so it can never
 * hold a credential. An invited-only document therefore lives on
 * `{label}.openartifacts.site`, an origin that runs only its publisher's
 * scripts, and that is the only place its bytes are ever served. The rule that
 * replaces "the origin is cookieless" is: **no origin that runs more than one
 * publisher's scripts ever holds a credential.**
 *
 * One origin per publisher, not per document. The threat is another publisher's
 * script, and a publisher's own scripts can already read what that publisher
 * owns. It also makes a custom domain a one-for-one replacement later: the same
 * seat, a different name, resolved to a publisher by lookup instead of by hash.
 *
 * The label is derived from `docs.owner` by a one-way hash and never stored, so
 * the hostname, which appears in DNS and in TLS SNI, reveals neither the owner
 * nor the document. A host answers `404` for any document whose owner does not
 * hash to its label, so a host never serves, or even confirms, another
 * publisher's document.
 *
 * How a reader gets here: `/open/{docId}` on the API host checks the session
 * and `canRead`, then redirects to this origin with a 60-second grant in the
 * URL. This origin answers that with a bodiless `303` that swaps the grant for
 * a one-hour cookie, so the credential never sits in the address bar. The grant
 * names an origin and a principal, not a document, and the cookie can only
 * read: **every request checks the document against `canRead` in D1 again**,
 * which is why removing a person takes effect on their next request.
 */
import type { AnalyticsSink } from "./analytics.js";
import type { Env } from "./config.js";
import { findReadableDoc } from "./db.js";
import { encodeBase32 } from "./ids.js";
import { SERVING_PREFIX, docPath, parseDocPath, type DocRoute } from "./paths.js";
import { readerSecret, readerSignInConfigured } from "./reader-config.js";
import { serveAndCount, servingError, servingPageResponse, servingRedirect } from "./serve.js";
import {
  cookie,
  GRANT_COOKIE,
  readCookie,
  signPayload,
  verifyPayload,
} from "./session.js";

/** A label host's name: 16 bytes of hash as base32, so always 26 characters. */
export const PRIVATE_LABEL = /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

/** How long the URL grant lives. It is a hand-off between two redirects. */
const URL_GRANT_TTL_MS = 60 * 1000;

/** How long a publisher origin remembers a grant. Access is still checked per request. */
const COOKIE_GRANT_TTL_MS = 60 * 60 * 1000;

/**
 * One publisher's origin label: the first 16 bytes of
 * `SHA-256("openartifacts-origin-v1:" + owner)` as lowercase Crockford base32.
 *
 * `owner` is always `docs.owner` of the document being opened, never the
 * caller's own `Publisher.owner`. A publisher whose license key was later linked
 * to an account has documents under two owner ids and so two origins; deriving
 * the label from the caller would send a reader to a host that then answers
 * `404` for the document. `docs.owner` never changes, so a document's origin is
 * stable for life.
 */
export async function originLabel(owner: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`openartifacts-origin-v1:${owner}`),
  );
  return encodeBase32(new Uint8Array(digest).slice(0, 16));
}

/**
 * Where a publisher's invited-only documents are served: today a label host
 * under `SERVING_HOST`. Null when this deployment has no serving host to hang a
 * label on.
 *
 * `/open` and the owner route reach a publisher origin only through here, so a
 * custom domain, a verified `publisher_hosts` lookup, changes this function and
 * no link anyone holds.
 */
export async function publisherOrigin(
  env: Env,
  owner: string,
): Promise<{ label: string; origin: string } | null> {
  const servingHost = env.SERVING_HOST?.trim();
  if (!servingHost) return null;
  const label = await originLabel(owner);
  return { label, origin: `https://${label}.${servingHost}` };
}

/**
 * The url that opens `route` on its publisher's origin for `principal`, good for
 * `URL_GRANT_TTL_MS`. Null when this deployment cannot do private sharing.
 *
 * `docOwner` is the document's `docs.owner`. `principal` is either a reader's
 * account id or a publisher's owner id; the origin checks it with `canRead`
 * like any other.
 */
export async function grantUrl(
  env: Env,
  docOwner: string,
  route: DocRoute,
  principal: string,
  now: number,
): Promise<{ url: string; expiresAt: number } | null> {
  const secret = readerSecret(env);
  const publisher = await publisherOrigin(env, docOwner);
  if (secret === null || publisher === null) return null;

  const expiresAt = now + URL_GRANT_TTL_MS;
  const grant = await signPayload(secret, "grant-url", { l: publisher.label, p: principal }, expiresAt);
  return { url: `${publisher.origin}${docPath(SERVING_PREFIX, route)}?grant=${grant}`, expiresAt };
}

/**
 * Copy `response` into one whose headers are mutable and add the isolation
 * headers. `same-origin-allow-popups` cuts the window reference a hostile opener
 * would keep to a popup that lands here; `same-origin` keeps other origins from
 * embedding what this one returns. Also used by the router's catch, so even a
 * `500` from this surface carries them.
 */
export function isolate(response: Response): Response {
  const isolated = new Response(response.body, response);
  isolated.headers.set("cross-origin-opener-policy", "same-origin-allow-popups");
  isolated.headers.set("cross-origin-resource-policy", "same-origin");
  return isolated;
}

/**
 * `GET /d/{docId}[/v{n}]` on a publisher's origin. `publisher` is the label the
 * router resolved from the hostname; this never parses the hostname again.
 *
 * The isolation headers are set on every response from here, errors and
 * redirects included.
 */
export async function handlePublisherServing(
  request: Request,
  url: URL,
  env: Env,
  analytics: AnalyticsSink,
  publisher: { label: string },
): Promise<Response> {
  return isolate(await publisherResponse(request, url, env, analytics, publisher));
}

async function publisherResponse(
  request: Request,
  url: URL,
  env: Env,
  analytics: AnalyticsSink,
  publisher: { label: string },
): Promise<Response> {
  const atMs = Date.now();
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") return servingError(method, "not_found");

  const route = parseDocPath(url.pathname);
  const secret = readerSecret(env);
  const apiHost = env.API_HOST?.trim();
  if (route === null || secret === null || !apiHost || !readerSignInConfigured(env)) {
    return servingError(method, "not_found");
  }

  // Absolute: this host has no sign-in page, and a relative path would resolve here.
  const signIn = servingRedirect(`https://${apiHost}${docPath("/open", route)}`, 302);

  // A grant names this origin and a principal. Another publisher's grant carries
  // another label and is refused here, before the database is read.
  const readGrant = (held: Record<string, string> | null) =>
    held !== null && held.l === publisher.label && typeof held.p === "string" && held.p !== ""
      ? held.p
      : null;

  const urlGrant = url.searchParams.get("grant");
  if (urlGrant !== null) {
    const principal = readGrant(await verifyPayload(secret, "grant-url", urlGrant, atMs));
    if (principal === null) return signIn;
    const held = await signPayload(
      secret,
      "grant-cookie",
      { l: publisher.label, p: principal },
      atMs + COOKIE_GRANT_TTL_MS,
    );
    return servingRedirect(
      docPath(SERVING_PREFIX, route),
      303,
      cookie(GRANT_COOKIE, held, COOKIE_GRANT_TTL_MS / 1000),
    );
  }

  const principal = readGrant(
    await verifyPayload(secret, "grant-cookie", readCookie(request, GRANT_COOKIE), atMs),
  );
  if (principal === null) return signIn;

  // One read decides everything. The owner comparison comes before any branch
  // that reveals the document's state, so a host never confirms that another
  // publisher's document exists, is deleted, or is public.
  const found = await findReadableDoc(env.DB, route.docId, route.pinned, principal);
  if (found === null) return servingError(method, "not_found");
  if ((await originLabel(found.owner)) !== publisher.label) return servingError(method, "not_found");
  if (found.deleted_at !== null) return servingPageResponse(method, "deleted");
  if (found.link_access === "anyone") {
    return servingRedirect(`https://${env.SERVING_HOST?.trim()}${docPath(SERVING_PREFIX, route)}`, 302);
  }
  // Not allowed goes to the one not-available page, on the API host. This host
  // never renders it: the Request access form must post with the session cookie,
  // so there is exactly one copy. No loop is possible, because `/open` redirects
  // here only when `canRead` says allowed, the same predicate as above.
  if (!found.allowed) return signIn;
  if (found.version === null) return servingError(method, "not_found");

  return await serveAndCount(request, env, route, found.version, analytics, atMs, true);
}
