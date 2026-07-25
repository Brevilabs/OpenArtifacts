/**
 * The public serving surface: `GET /d/{docId}` and `GET /d/{docId}/v{n}`.
 *
 * Injection already happened at push time (D11), so this file reads an R2
 * object and streams it back untouched. It never parses, rewrites or even
 * decodes the bytes — a served page is byte-identical to the stored version,
 * which is what makes `immutable` an honest thing to say about `/v{n}`.
 *
 * What it does add is the header policy below. Since the bytes are somebody
 * else's HTML with somebody else's scripts in it (D6), those headers are the
 * part of the security boundary that lives in this service, and they are
 * attached here — on the response — rather than injected into the markup,
 * because the two directives that matter most (`frame-ancestors`, and
 * `form-action` against a document that may rewrite its own DOM) are only
 * honoured as a real header.
 */
import type { Env } from "./config.js";
import { findServableVersion } from "./db.js";
import { errorResponse } from "./errors.js";
import { isDocId } from "./ids.js";
import { STORED_CONTENT_TYPE, versionObjectKey } from "./storage.js";

/** Path prefix of the serving surface, used by the router's path fallback. */
export const SERVING_PREFIX = "/d";

/** Everything this surface serves lives under `/d/`. `/d` alone is not a doc. */
const DOC_PATH_PREFIX = `${SERVING_PREFIX}/`;

/**
 * `v` then a decimal with no leading zeros, so one version has exactly one url.
 * Bounded at nine digits: the number only ever reaches R2 as part of a key, and
 * a bound here means no unbounded digit string ever becomes a `Number`.
 */
const VERSION_SEGMENT = /^v([1-9][0-9]{0,8})$/;

/**
 * The Content Security Policy. This is the security boundary of Symposium, so every
 * directive below is a deliberate choice rather than a copied default.
 *
 * The threat model is unusual and worth stating plainly: the page's own author
 * is the untrusted party. Publishers upload whole documents including scripts,
 * and we run them on purpose (D6) — interactive figures and embedded
 * simulations are the reason the client renders HTML at all. So this policy is
 * not trying to stop a doc from executing code. It is trying to stop a doc from
 * using our origin to harm *readers*, and to keep one doc's blast radius off
 * the rest of the internet.
 *
 * Three things make that a defensible trade, none of them in this string: the
 * origin is cookieless and holds nothing but already-public docs, so there is
 * no session or private data on it to steal; docs are served from a sacrificial
 * host, never the brand domain; and publishing is gated on a paid license key.
 *
 * Directive by directive:
 *
 * - `default-src` is the floor for every fetch type not named below (manifests,
 *   prefetch, and whatever a future browser adds). It admits the same sources
 *   the named directives do, so an unanticipated fetch type behaves like the
 *   ones we thought about instead of breaking a legitimate doc.
 * - `script-src` allows inline and https, because that is the feature. It also
 *   allows `'unsafe-eval'`: wasm and Pyodide-class simulations need it, and
 *   refusing eval defends a *trusted* page against injected code — it buys
 *   nothing when the author can simply write the code inline instead.
 * - `style-src`, `img-src`, `font-src`, `media-src` mirror that: inline, https,
 *   and data: urls, which is exactly what a self-contained exported document
 *   uses for embedded images and fonts.
 * - `connect-src` is open to https on purpose, and it is worth being honest
 *   about what that means: nothing here prevents a script from posting data it
 *   collected to another origin. Nothing could, while scripts run at all. The
 *   defence against a doc collecting something worth posting is `form-action`
 *   plus a cookieless origin, not a connect allowlist that would break every
 *   figure that loads a dataset.
 * - `frame-src` allows https so an embedded video or map keeps working, and
 *   blob: for viewers that frame a generated document. Those local-scheme
 *   frames inherit this policy from their creator, so they are not a way around
 *   the two 'none' directives below. An `https:` frame does not inherit it —
 *   the framed origin's own policy governs that document — which is one of the
 *   reasons `form-action` is not the phishing defence it looks like.
 * - `worker-src` allows blob:, which is how a bundled simulation spawns a
 *   worker without a second request.
 * - `object-src 'none'`: `<object>`/`<embed>` load plugin content, historically
 *   the one content type that could ignore the embedding page's CSP. Rendered
 *   notes use `<img>`, `<iframe>` and `<canvas>`, so this costs nothing.
 * - `base-uri 'none'`: a single `<base>` tag silently re-points every relative
 *   url in the document. Docs are self-contained single files that never need
 *   one, so forbidding it removes the primitive that makes a link resolve
 *   somewhere other than where it reads.
 * - `form-action 'none'` closes the cheapest phishing path: a page that renders
 *   a convincing login box has nowhere to POST it, from any markup, to any
 *   origin. It is worth stating what it is *not*, because the shape of the
 *   directive invites the wrong conclusion — it is not a phishing defence.
 *   `connect-src` hands the same page a `fetch()`, and `frame-src https:` lets
 *   it embed somebody else's login form governed by somebody else's policy.
 *   No CSP closes phishing on an origin that runs the author's scripts (D6);
 *   what bounds it is the sacrificial host, the paid-key gate, and an origin
 *   holding nothing but public docs.
 * - `frame-ancestors 'none'`: no page may frame a doc. That blocks clickjacking
 *   a doc's own content, and blocks borrowing a doc as the visible layer of
 *   somebody else's attack. It holds against a doc framing another doc too:
 *   `frame-src 'self'` permits the request, and this directive on the reply
 *   refuses it.
 *
 * Deliberately absent: `upgrade-insecure-requests`, which is moot when no
 * directive admits http: in the first place, and `sandbox` — the one omission
 * worth arguing about. `sandbox allow-scripts` *without* `allow-same-origin`
 * would put every doc in its own opaque origin, which is the only per-doc
 * isolation available while all docs share one host: no localStorage shared
 * between docs, no doc reading another by id. It is off because that isolation
 * has nothing to protect yet — the origin carries no session and no private
 * data — while its cost is immediate, since an opaque origin makes
 * `localStorage`, `document.cookie` and `history.pushState` throw, breaking the
 * stateful interactive docs D6 exists to allow. Revisit when free-tier
 * publishing lands and the paid-key gate stops carrying the argument.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self' https: data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'self' 'unsafe-inline' https: data:",
  "img-src 'self' https: data: blob:",
  "font-src 'self' https: data:",
  "media-src 'self' https: data: blob:",
  "connect-src 'self' https: data: blob:",
  "frame-src 'self' https: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** D9. The header, not the meta tag, is what applies to a 404 as well. */
const ROBOTS = "noindex, nofollow";

/** D12: the shared link is stable and serves latest directly, so it can age. */
const LATEST_CACHE_CONTROL = "public, max-age=60";

/** A version's bytes are written once and never rewritten. A year is the cap. */
const PINNED_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Every response this surface produces, including its errors, carries the whole
 * policy. Built fresh per response because `Headers` is mutable and one shared
 * instance would let a handler leak a header into the next request's reply.
 *
 * No `Set-Cookie` is ever added here or anywhere downstream. The origin being
 * cookieless is not an accident of having nothing to store — it is the property
 * that makes running strangers' scripts on a shared origin acceptable, so it
 * belongs in this file's contract next to the CSP.
 */
function servingHeaders(cacheControl: string): Headers {
  return new Headers({
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-robots-tag": ROBOTS,
    // The stored type is always `text/html`, so this blocks nothing today. It
    // is here for the day an object is stored with a type that disagrees.
    "x-content-type-options": "nosniff",
    // The doc id *is* the access control: whoever holds the url holds the doc.
    // Without this it would ride in `Referer` to every site the doc links to or
    // loads an image from, handing the capability to third parties.
    "referrer-policy": "no-referrer",
    "cache-control": cacheControl,
  });
}

/**
 * Every failure this surface answers with, exported because the router's
 * catch-all needs one too: a binding that throws mid-read must still produce a
 * *serving* response, or an outage becomes the one doc url that invites a
 * crawler in. Routing a thrown error back through here is what makes the header
 * policy a property of the surface rather than of remembering to add it.
 *
 * All of them are `no-store` rather than cacheable. 410 in particular is
 * heuristically cacheable by default, and a delete is the one answer a publisher
 * may need to be able to correct. Uncached costs us nothing: none of these ever
 * reached R2.
 */
export function servingError(code: "not_found" | "gone" | "internal", message: string): Response {
  return errorResponse(code, message, servingHeaders("no-store"));
}

/**
 * One message for "no such id", "malformed id" and "no such version" alike. The
 * id space is not worth probing at 128 bits, but a reply that distinguished the
 * cases would still be telling a stranger which ids are real.
 */
function noDocAt(pathname: string): Response {
  return servingError("not_found", `No doc at ${pathname}`);
}

interface DocRoute {
  docId: string;
  /** The version from `/v{n}`, or null for the latest-version url. */
  pinned: number | null;
}

/**
 * Parse `/d/{docId}` and `/d/{docId}/v{n}`, or null for anything else.
 *
 * The prefix is matched rather than sliced off blind: on the serving host every
 * path lands here, so `/dx{docId}` reaches this function too and must not be
 * mistaken for a doc url.
 *
 * `isDocId` runs before anything else touches the database (phase 1), so junk
 * and crawler noise cost a regex rather than a D1 read.
 */
function parseDocPath(pathname: string): DocRoute | null {
  if (!pathname.startsWith(DOC_PATH_PREFIX)) return null;

  const segments = pathname.slice(DOC_PATH_PREFIX.length).split("/");
  // `/d/{docId}/` is the same page as `/d/{docId}`; a trailing slash is a
  // browser and copy-paste artifact, not a different resource.
  if (segments.length > 1 && segments.at(-1) === "") segments.pop();

  const [docId, versionSegment, ...extra] = segments;
  if (docId === undefined || extra.length > 0) return null;
  if (!isDocId(docId)) return null;
  if (versionSegment === undefined) return { docId, pinned: null };

  const digits = VERSION_SEGMENT.exec(versionSegment)?.[1];
  return digits === undefined ? null : { docId, pinned: Number(digits) };
}

/**
 * The conditional headers R2 may act on, and only those.
 *
 * A failed `onlyIf` comes back as an object with no body, and R2 answers a
 * failed `If-Match` the same way it answers a matched `If-None-Match` — but the
 * first is a 412 and the second a 304. Forwarding only the two preconditions
 * whose failure means "not modified" makes a bodyless result unambiguous
 * instead of a guess.
 */
function notModifiedConditions(from: Headers): Headers {
  const conditions = new Headers();
  for (const name of ["if-none-match", "if-modified-since"]) {
    const value = from.get(name);
    if (value !== null) conditions.set(name, value);
  }
  return conditions;
}

/**
 * The same question `onlyIf` answers, asked directly — because `R2.head()` has
 * no `onlyIf`, and fetching a body on a HEAD just to have R2 evaluate it would
 * pay for bytes the method promises not to send.
 *
 * Precedence follows RFC 9110: `If-None-Match` wins outright when present, and
 * `If-Modified-Since` is consulted only in its absence.
 */
function matchesConditions(conditions: Headers, object: R2Object): boolean {
  const ifNoneMatch = conditions.get("if-none-match");
  if (ifNoneMatch !== null) {
    if (ifNoneMatch.trim() === "*") return true;
    // Weak comparison: `W/"x"` and `"x"` are the same entity for this purpose,
    // which is the only comparison If-None-Match is allowed to use.
    const wanted = ifNoneMatch
      .split(",")
      .map((tag) => tag.trim().replace(/^W\//, ""))
      .filter((tag) => tag.length > 0);
    return wanted.includes(object.httpEtag.replace(/^W\//, ""));
  }

  const ifModifiedSince = conditions.get("if-modified-since");
  if (ifModifiedSince !== null) {
    const since = Date.parse(ifModifiedSince);
    // An unparseable date is not a condition, so it cannot make this a 304.
    // Second precision, because that is all an HTTP-date carries.
    if (!Number.isNaN(since)) {
      return Math.floor(object.uploaded.getTime() / 1000) <= Math.floor(since / 1000);
    }
  }

  return false;
}

/**
 * Stream one version's stored bytes back, unmodified.
 *
 * `version` is the one that resolved to bytes; `route.pinned` is only whether
 * the reader asked for a version by number, which is what the TTL follows. A
 * `/v{n}` url will never mean anything else, while the shared link changes what
 * it serves on the author's next push.
 *
 * The content type is this service's constant rather than the object's own
 * metadata: we wrote these bytes and we know what they are, and reading it back
 * off the object would let a stored value decide how a page is interpreted.
 */
async function serveObject(
  request: Request,
  env: Env,
  route: DocRoute,
  version: number,
  pathname: string,
): Promise<Response> {
  const key = versionObjectKey(route.docId, version);
  const headers = servingHeaders(
    route.pinned === null ? LATEST_CACHE_CONTROL : PINNED_CACHE_CONTROL,
  );

  const conditions = notModifiedConditions(request.headers);

  // A `versions` row without an object should not exist — the row is written
  // after the object it names — but R2 is the system of record, so its answer
  // wins over D1's rather than becoming a 500.
  if (request.method === "HEAD") {
    const object = await env.DOCS.head(key);
    if (object === null) return noDocAt(pathname);

    headers.set("etag", object.httpEtag);
    // A validator has to mean the same thing whichever method asks. HEAD is
    // defined as GET without the body, so a cache revalidating with HEAD must
    // get the 304 that GET would give it, not a 200 that says the doc changed.
    if (matchesConditions(conditions, object)) {
      return new Response(null, { status: 304, headers });
    }

    headers.set("content-type", STORED_CONTENT_TYPE);
    // Set only here. On a GET the runtime frames the body itself, and a length
    // we computed would be a second opinion that content-encoding can falsify.
    headers.set("content-length", String(object.size));
    return new Response(null, { status: 200, headers });
  }

  const object = await env.DOCS.get(key, { onlyIf: conditions });
  if (object === null) return noDocAt(pathname);

  headers.set("etag", object.httpEtag);
  if (!("body" in object)) return new Response(null, { status: 304, headers });

  headers.set("content-type", STORED_CONTENT_TYPE);
  // The stream, never the bytes: a 10MB doc passes through the worker without
  // ever being a 10MB string in it.
  return new Response(object.body, { status: 200, headers });
}

/**
 * The whole public surface.
 *
 * Order matters at the end: a deleted doc is 410 before its version is even
 * looked at, so `GET /d/{id}/v1` on a deleted doc does not leak that v1 once
 * existed by answering differently from `/v99`.
 */
export async function handleServing(request: Request, url: URL, env: Env): Promise<Response> {
  // Two verbs, no third. A 405 would need an error code the frozen contract
  // does not have, and nothing that legitimately reads a doc sends anything
  // else — a POST to a doc url is a probe, and it gets what a probe gets.
  if (request.method !== "GET" && request.method !== "HEAD") {
    return noDocAt(url.pathname);
  }

  const route = parseDocPath(url.pathname);
  if (route === null) return noDocAt(url.pathname);

  const found = await findServableVersion(env.DB, route.docId, route.pinned);
  if (found === null) return noDocAt(url.pathname);
  if (found.deleted_at !== null) {
    return servingError("gone", "This doc was deleted by its author.");
  }
  if (found.version === null) return noDocAt(url.pathname);

  // `return await`, not `return`, for the reason spelled out in index.ts: an
  // async function that hands back somebody else's promise unawaited drops
  // itself out of the rejection's stack and, in workerd, gets the rejection
  // reported as unhandled even though the router catches it.
  return await serveObject(request, env, route, found.version, url.pathname);
}
