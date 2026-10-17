/**
 * Serving a publisher's invited-only documents from the publisher's own origin.
 *
 * `openartifacts.site` runs every publisher's scripts on purpose, so it can never
 * hold a credential. An invited-only document therefore lives on
 * `{code}.openartifacts.site`, an origin that runs only its publisher's
 * scripts, and that is the only place its bytes are ever served. The rule that
 * replaces "the origin is cookieless" is: **no origin that runs more than one
 * publisher's scripts ever holds a credential.**
 *
 * One origin per publisher, not per document. The threat is another publisher's
 * script, and a publisher's own scripts can already read what that publisher
 * owns. It also makes a custom domain a one-for-one replacement later: the same
 * seat, a different name, resolved to a publisher by lookup instead of by hash.
 *
 * The code is 6 random characters, allocated once per publisher and stored in
 * `publisher_origins` (`src/origin-code.ts`), so the hostname, which appears in
 * DNS and in TLS SNI, reveals neither the owner nor the document. It is an
 * address, not a password. A host answers `404` for any document whose owner's
 * code is not its own, so a host never serves, or even confirms, another
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
import { threadsNotFound, threadsResource } from "./comments/resource.js";
import type { Env } from "./config.js";
import { findReadableDoc } from "./db.js";
import { writeManifestBestEffort } from "./manifest.js";
import { originCode } from "./origin-code.js";
import { SERVING_PREFIX, docPath, parseDocPath, parseThreadsPath, type DocRoute } from "./paths.js";
import { readerSecret, readerSignInConfigured } from "./reader-config.js";
import { serveAndCount, servingError, servingPageResponse, servingRedirect } from "./serve.js";
import {
  cookie,
  GRANT_COOKIE,
  readCookie,
  signPayload,
  verifyPayload,
} from "./session.js";

/** The retired hash-label host's name: 16 bytes of hash as base32, so always 26 characters. */
export const LEGACY_LABEL = /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

/** How long the URL grant lives. It is a hand-off between two redirects. */
const URL_GRANT_TTL_MS = 60 * 1000;

/** How long a publisher origin remembers a grant. Access is still checked per request. */
const COOKIE_GRANT_TTL_MS = 60 * 60 * 1000;

/**
 * The origin that serves a publisher's documents under `code`, or null when this
 * deployment has no serving host to hang a code on. No lookup: frames use this
 * with a code they already read.
 */
export function codeOrigin(env: Env, code: string): string | null {
  const servingHost = env.SERVING_HOST?.trim();
  return servingHost ? `https://${code}.${servingHost}` : null;
}

/**
 * The url that opens `route` on its publisher's origin for `principal`, good for
 * `URL_GRANT_TTL_MS`. Null when this deployment cannot do private sharing.
 *
 * `docOwner` is the document's `docs.owner`, never the caller's own
 * `Publisher.owner`: a publisher whose license key was later linked to an account
 * has documents under two owner ids and so two origins. `knownCode` is that
 * owner's code when the caller's read already has it. `principal` is either a reader's
 * account id or a publisher's owner id; the origin checks it with `canRead`
 * like any other.
 */
export async function grantUrl(
  env: Env,
  docOwner: string,
  route: DocRoute,
  principal: string,
  now: number,
  knownCode: string | null = null,
): Promise<{ url: string; expiresAt: number } | null> {
  const secret = readerSecret(env);
  if (secret === null || !env.SERVING_HOST?.trim()) return null;
  // The document was read with its owner's code, so only a first open lacks one.
  // That is the moment the code comes to exist, and R2 learns it now: nothing
  // else would snapshot a manifest before the next change to the doc.
  let code = knownCode;
  if (code === null) {
    code = await originCode(env.DB, docOwner);
    await writeManifestBestEffort(env, route.docId);
  }
  const publisher = { code, origin: codeOrigin(env, code)! };

  const expiresAt = now + URL_GRANT_TTL_MS;
  const grant = await signPayload(secret, "grant-url", { l: publisher.code, p: principal }, expiresAt);
  return { url: `${publisher.origin}${docPath(SERVING_PREFIX, route)}?grant=${grant}`, expiresAt };
}

/**
 * What a publisher's origin makes of a document it found, in the order it
 * decides: unknown, or another publisher's, is `missing`; then `deleted`; an
 * `anyone` document belongs to the apex (`public`); one the principal may not
 * read is `denied`; the rest are `ok`. The code comparison comes before
 * anything that reveals state, so a host never confirms that another
 * publisher's document exists, is deleted, or is public.
 *
 * Shared by the page and the threads resource, which differ only in how they
 * answer each outcome (a redirect or a page, against JSON): the read rule is one.
 */
export function judgeForPublisher(
  found: { origin_code: string | null; deleted_at: number | null; link_access: string; allowed: boolean } | null,
  publisher: { code: string },
): "missing" | "deleted" | "public" | "denied" | "ok" {
  if (found === null) return "missing";
  if (found.origin_code !== publisher.code) return "missing";
  if (found.deleted_at !== null) return "deleted";
  if (found.link_access === "anyone") return "public";
  return found.allowed ? "ok" : "denied";
}

/**
 * A request to a retired 26-character label host (`resolvePublisherHost`). A
 * top-level GET or HEAD of a document url goes to the API's `/open`, which mints
 * the code host; anything else is null, and the router answers it as it answers
 * an unknown host. Kept only while old links are in the wild; a later cleanup
 * removes this and `LEGACY_LABEL`.
 */
export function legacyLabelResponse(request: Request, url: URL, env: Env): Response | null {
  const apiHost = env.API_HOST?.trim();
  if ((request.method !== "GET" && request.method !== "HEAD") || !apiHost) return null;
  const route = parseDocPath(url.pathname);
  if (route === null) return null;
  return isolate(servingRedirect(`https://${apiHost}${docPath("/open", route)}`, 302));
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
 * `GET /d/{docId}[/v{n}]` on a publisher's origin. `publisher` is the code the
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
  publisher: { code: string },
): Promise<Response> {
  return isolate(await publisherResponse(request, url, env, analytics, publisher));
}

async function publisherResponse(
  request: Request,
  url: URL,
  env: Env,
  analytics: AnalyticsSink,
  publisher: { code: string },
): Promise<Response> {
  const atMs = Date.now();
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") return servingError(method, "not_found");

  const threadsDoc = parseThreadsPath(url.pathname);
  const route = threadsDoc === null ? parseDocPath(url.pathname) : null;
  const secret = readerSecret(env);
  const apiHost = env.API_HOST?.trim();
  if ((route === null && threadsDoc === null) || secret === null || !apiHost || !readerSignInConfigured(env)) {
    return servingError(method, "not_found");
  }

  // A grant names this origin and a principal. Another publisher's grant carries
  // another code and is refused here, before the database is read.
  const readGrant = (held: Record<string, string> | null) =>
    held !== null && held.l === publisher.code && typeof held.p === "string" && held.p !== ""
      ? held.p
      : null;

  // The comments resource: the grant cookie and nothing else. Never the `?grant=`
  // swap (which would answer JSON with a redirect), and no cookie, a public
  // document, or a document the cookie may not read is a `404`, not the sign-in
  // redirect the page gets: a script cannot follow one.
  if (threadsDoc !== null) {
    const principal = readGrant(await verifyPayload(secret, "grant-cookie", readCookie(request, GRANT_COOKIE), atMs));
    if (principal === null) return threadsNotFound(method);
    return await threadsResource(env, method, threadsDoc, url.searchParams.get("v"), principal, async (doc) => {
      const verdict = judgeForPublisher(doc, publisher);
      return verdict === "ok" || verdict === "deleted" ? verdict : "missing";
    });
  }
  if (route === null) return servingError(method, "not_found");

  // Absolute: this host has no sign-in page, and a relative path would resolve here.
  const signIn = servingRedirect(`https://${apiHost}${docPath("/open", route)}`, 302);

  const urlGrant = url.searchParams.get("grant");
  if (urlGrant !== null) {
    const principal = readGrant(await verifyPayload(secret, "grant-url", urlGrant, atMs));
    if (principal === null) return signIn;
    const held = await signPayload(
      secret,
      "grant-cookie",
      { l: publisher.code, p: principal },
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
  const verdict = judgeForPublisher(found, publisher);
  if (found === null || verdict === "missing") return servingError(method, "not_found");
  if (verdict === "deleted") return servingPageResponse(method, "deleted");
  if (verdict === "public") {
    return servingRedirect(`https://${env.SERVING_HOST?.trim()}${docPath(SERVING_PREFIX, route)}`, 302);
  }
  // Not allowed goes to the one not-available page, on the API host. This host
  // never renders it: the Request access form must post with the session cookie,
  // so there is exactly one copy. No loop is possible, because `/open` redirects
  // here only when `canRead` says allowed, the same predicate as above.
  if (verdict === "denied") return signIn;
  if (found.version === null) return servingError(method, "not_found");

  return await serveAndCount(request, env, route, found.version, analytics, atMs, true, found.has_comments === 1);
}
