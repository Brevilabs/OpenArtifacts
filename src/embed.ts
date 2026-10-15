/**
 * The embed surface: `/embed/*` on the API host, what the top bar's **Share**
 * button is built from.
 *
 * ```
 * GET|HEAD /embed/page.js                         the script every served page loads
 * GET      /embed/share?doc=&origin=              the popover's frame
 * GET      /embed/sign-in?doc=&h=[&switch=1]      the popup that signs the frame in
 * POST     /embed/token  {doc, nonce}             the frame collects its token
 * GET|PUT|DELETE /embed/api/docs/{docId}/access…  the frame's JSON, behind the token
 * ```
 *
 * It lives on the API host and not on a document host for the reason the share
 * page does: the credential that changes who can read a document must never be
 * on an origin whose scripts the author writes. The script is the only part
 * that runs on the document's page, and it holds no credential. The controls
 * are a **frame** on this host, drawn under the button.
 *
 * **Which credential lives where.** The reader session is a cookie on this host
 * and a frame inside someone else's page cannot rely on it (browsers block or
 * partition third-party cookies), so the frame carries a per-document token
 * (`oas_…`, 24 hours, one account and one document) in its own storage and sends
 * it as a bearer header on same-origin `fetch`. A top-level popup, which does see
 * the session cookie, mints it. The token is accepted only by `/embed/api/…`
 * for its own document: `/api/v1` refuses its prefix, the share page, `/open`
 * and `/signin` read only the session cookie, and label hosts read only the
 * grant cookie.
 *
 * **Why the handoff is polled.** Every API-host page sends a cross-origin
 * opener policy, and Google's sign-in pages send one too (observed 2026-10-14:
 * `accounts.google.com/signin/oauth/error` enforces `same-origin`, and
 * `/o/oauth2/v2/auth` reports it). A navigation to such a page from a popup
 * whose opener is cross-origin switches browsing-context group and nulls
 * `window.opener` for good, so a plain `postMessage` to the frame may never
 * arrive. Instead the frame makes a nonce only it knows and puts its SHA-256 in
 * the popup's address; the popup stores the account under that hash for one
 * minute and one use; the frame collects it with the nonce. Seeing the popup's
 * address yields only the hash, which collects nothing. The popup also posts the
 * token when it still has an opener, and the frame accepts that message only
 * from the window it opened.
 *
 * Every route here is behind `readerSignInConfigured` in the router, so a server
 * with no reader sign-in has no `/embed/*` at all, and renders no tag that would
 * ask for it. Dispatch is by exact path; anything else under `/embed` is the
 * reader pages' not-found. No response here sets `X-Frame-Options`, any
 * `Access-Control-Allow-*` header, or any cookie but the popup's own binding.
 */
import type { AnalyticsSink } from "./analytics.js";
import {
  accessBody,
  addPerson,
  declineRequest,
  decodeAddress,
  getAccess,
  parseLinkAccess,
  refusalResponse,
  removePerson,
  setMode,
  type AccessResult,
  type AccessState,
} from "./api/access.js";
import type { Publisher } from "./auth.js";
import { stringField } from "./account.js";
import type { Env } from "./config.js";
import { accountEmail, findReadableDoc, putEmbedHandoff, sweepExpired, takeEmbedHandoff } from "./db.js";
import { COPILOT_HINT, FRAME_CSS, FRAME_SCRIPT, PAGE_SCRIPT } from "./embed-scripts.js";
import { accountPlan } from "./entitlement.js";
import { handleCommentsEmbed } from "./comments/embed-api.js";
import { docNotFound, errorResponse } from "./errors.js";
import { verifyFrameToken } from "./frame-token.js";
import { scriptHashSource, sha256Hex } from "./hash.js";
import { isDocId, SHARE_TOKEN_PREFIX } from "./ids.js";
import { sameOriginPost, withinClientLimit } from "./limits.js";
import { escapeHtml } from "./page.js";
import { publisherOrigin } from "./private.js";
import { readBodyWithin } from "./quota.js";
import { readerSecret } from "./reader-config.js";
import {
  EMBED_API_PREFIX,
  EMBED_SHARE_PATH,
  EMBED_SIGNIN_PATH,
  EMBED_TOKEN_PATH,
  PAGE_SCRIPT_PATH,
  popupDonePage,
  popupRefusedPage,
  READER_NOT_FOUND,
  TOO_MANY,
} from "./reader-pages.js";
import { signIn } from "./reader.js";
import {
  cookie,
  EMBED_HASH,
  EMBED_SIGNIN_TTL_MS,
  embedCookieName,
  readCookie,
  readSession,
  SHARE_TOKEN_TTL_MS,
  signPayload,
  verifyPayload,
} from "./session.js";
import { publicDocUrl } from "./urls.js";

/**
 * The script's validator: the first 32 hex characters of its SHA-256, computed
 * once per isolate. The script is a constant, so the hash never changes within
 * one deploy and always changes with one that edits it.
 */
let pageScriptEtag: Promise<string> | undefined;

function pageScriptValidator(): Promise<string> {
  pageScriptEtag ??= sha256Hex(PAGE_SCRIPT).then((hex) => `"${hex.slice(0, 32)}"`);
  return pageScriptEtag;
}

/** `W/"x"` and `"x"` name the same bytes here, so the comparison is weak. */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const bare = (tag: string) => tag.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  return ifNoneMatch
    .split(",")
    .some((tag) => tag.trim() === "*" || (bare(tag).length > 0 && bare(tag) === bare(etag)));
}

/**
 * `GET|HEAD /embed/page.js`.
 *
 * A Worker route and not a Workers Static Asset, though a page view should cost
 * no Worker request. Static assets are matched ahead of the Worker on **every**
 * hostname it is attached to (the retired API host that must answer `410` to
 * every path, the legacy host that must redirect, the document host, every label
 * host), which would break the router's fail-closed host allowlist, and would
 * need a `_headers` file as a second place for response policy. An hour of
 * browser cache gives the same property for as long as the copy is fresh: no
 * Worker request, then at most one background revalidation per browser per hour.
 *
 * **The URL is permanent.** Pinned `/v{n}` pages are served `immutable` for a
 * year and carry this tag, so the address can never move or change meaning. A
 * fix to the script reaches every page through this route's cache lifetime.
 *
 * The body is a constant and the response never reads a cookie: it is fetched
 * cross-site from every document, and the serving pages' `no-referrer` means
 * the API host cannot tell which document loaded it.
 */
async function pageScript(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return READER_NOT_FOUND();

  const etag = await pageScriptValidator();
  const headers = new Headers({
    "content-type": "text/javascript; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "cross-origin",
    "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
    etag,
  });

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch !== null && etagMatches(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : PAGE_SCRIPT, { status: 200, headers });
}

/** The frame's JSON and the claim are never cached, and never read a cookie. */
const NO_STORE = { "cache-control": "no-store" };

let frameScriptSource: Promise<string> | undefined;

/** The frame's `script-src` source: its one inline script, by hash, memoised like the share page's. */
function frameScriptHash(): Promise<string> {
  frameScriptSource ??= scriptHashSource(FRAME_SCRIPT);
  return frameScriptSource;
}

/**
 * `GET /embed/share?doc={docId}&origin={embedder's origin}`: the popover's
 * frame, as the same shell for every document id.
 *
 * **The frame reveals nothing to a non-reader.** Anyone can load this with any
 * id, and until a token proves the viewer can read the document the body is the
 * same bytes for a public, an invited-only, an unknown and a deleted document:
 * `Share`, **Copy link** for the canonical address (built from the id, no
 * lookup) and **Sign in to manage**. No title, no mode, no list. Only the
 * document's title, from `/embed/api/…` after a token, ever follows.
 *
 * The one thing that varies is `frame-ancestors`, and with it `data-origin`
 * (the target of the frame's `postMessage`). The lookup here decides only that:
 * the document's serving origin is `https://{SERVING_HOST}` when it is live and
 * public, its publisher's `https://{label}.{SERVING_HOST}` when it is live and
 * invited-only, and none otherwise. The frame may be embedded only by that
 * origin, and the policy echoes the caller's own `origin` parameter only when it
 * equals it, so the header tells a caller nothing it did not already name. (The
 * parameter is why: the request is anonymous and serving pages send
 * `no-referrer`, so the server cannot see the embedder, and a header derived
 * from the row alone would publish an invited-only document's label origin to
 * anyone holding the link.) The browser checks the policy against the real
 * ancestor, so a forged parameter frames nothing. A private document's controls
 * can therefore be embedded only by its own publisher's pages, never by another
 * publisher's. Residual, accepted: someone who already knows a label and holds a
 * link can confirm the pairing.
 */
async function shareFrame(request: Request, url: URL, env: Env): Promise<Response> {
  const doc = url.searchParams.get("doc");
  if (request.method !== "GET" || doc === null || !isDocId(doc)) return READER_NOT_FOUND();

  const row = await findReadableDoc(env.DB, doc, null, "");
  const live = row !== null && row.deleted_at === null;
  const serving = !live
    ? null
    : row.link_access === "anyone"
      ? env.SERVING_HOST?.trim()
        ? `https://${env.SERVING_HOST.trim()}`
        : null
      : ((await publisherOrigin(env, row.owner))?.origin ?? null);
  const servingOrigin = serving?.toLowerCase() ?? null;
  const matched = servingOrigin !== null && (url.searchParams.get("origin") ?? "").toLowerCase() === servingOrigin;
  const ancestors = matched ? servingOrigin : "'none'";

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Share · OpenArtifacts</title>
<style>${FRAME_CSS}</style>
</head>
<body>
<main data-doc="${escapeHtml(doc)}" data-link="${escapeHtml(publicDocUrl(env, url, doc))}" data-origin="${matched ? escapeHtml(servingOrigin) : ""}" data-hint="${escapeHtml(COPILOT_HINT)}">
<header><h1 id="oa-title">Share</h1><button type="button" aria-label="Close">×</button></header>
<p class="muted">Only the owner can change who can open this.</p>
<div class="foot"><button type="button" class="primary">Copy link</button></div>
<p class="muted" id="oa-account">Is this your page? <button type="button" class="link" disabled>Sign in to manage</button></p>
<p id="oa-msg" class="err" role="alert"></p>
</main>
<script>${FRAME_SCRIPT}</script>
</body>
</html>`;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // Not `no-referrer`: a Safari from before WebKit bug 256472 was fixed
      // derived `Sec-Fetch-Site` from the referrer, and would send `none` on the
      // popup navigation, which the popup refuses. It also keeps a real `Origin`
      // on the frame's writes.
      "referrer-policy": "same-origin",
      "content-security-policy":
        `default-src 'none'; script-src ${await frameScriptHash()}; style-src 'unsafe-inline'; img-src data:; ` +
        `connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors}`,
    },
  });
}

/**
 * `GET /embed/sign-in?doc={docId}&h={sha256 hex}[&switch=1]`: the popup the
 * frame opens to sign in. Top-level and first-party, so it sees the session
 * cookie the frame cannot.
 *
 * **It must have been opened by our frame.** `Sec-Fetch-Site: same-origin` is
 * true only when an API-host document initiated the navigation, which is the
 * frame's `window.open`. An attacker's page that opens this address with its own
 * `h` produces `cross-site` (or `none`, typed or opened from an old Safari with
 * no referrer) and is refused even when the owner has a session; otherwise it
 * could collect a token for the owner against a hash it chose. The return from
 * Google or GitHub is itself `cross-site`, so the first, bound request also sets
 * a cookie (one per handshake, `__Host-oa_embed_{16 hex}`) and a later request
 * is bound if it carries that cookie for its own `doc` and `h`. A cookie can be
 * set only in the browser that made the bound request, which a stored row could
 * not promise: curl can send `Sec-Fetch-Site: same-origin` and create a row for
 * its own `h`.
 *
 * **One rule holds this together: no page or redirect on the API host may carry
 * an `/embed/sign-in` address whose `h` did not come from a bound request.**
 * Today the producers are the frame's `window.open`, the sign-in page rendered
 * below (its `next`), and the login cookie that carries that `next`. Every
 * `/signin/*` route is a same-origin `POST`, so no cross-site page can plant a
 * `next`, and a query-supplied `next` is never echoed into a `GET` page or a
 * redirect.
 *
 * With no session, or with `switch=1` (**Use another account**), the popup shows
 * the manage-purpose sign-in and returns here; a completed sign-in replaces the
 * session. With a session it stores the handoff and says so. It mints whatever
 * the session's account may do with the document and the routes decide
 * (`frameApi`): the outcome never depends on the document, so it is no oracle.
 */
async function popup(request: Request, url: URL, env: Env, now: number): Promise<Response> {
  const doc = url.searchParams.get("doc");
  const h = url.searchParams.get("h");
  const secret = readerSecret(env);
  if (request.method !== "GET" || secret === null || doc === null || !isDocId(doc) || h === null || !EMBED_HASH.test(h)) {
    return READER_NOT_FOUND();
  }

  const binding = await verifyPayload(secret, "embed-signin", readCookie(request, embedCookieName(h)), now);
  const bound = request.headers.get("sec-fetch-site") === "same-origin" || (binding?.d === doc && binding?.h === h);
  if (!bound) return popupRefusedPage(doc);

  const accountId = await readSession(request, secret, now);
  const signedIn = accountId !== null && (await accountEmail(env.DB, accountId)) !== null;
  if (!signedIn || url.searchParams.get("switch") === "1") {
    const response = signIn(env, `${EMBED_SIGNIN_PATH}?doc=${doc}&h=${h}`);
    const proof = await signPayload(secret, "embed-signin", { d: doc, h }, now + EMBED_SIGNIN_TTL_MS);
    response.headers.append("set-cookie", cookie(embedCookieName(h), proof, EMBED_SIGNIN_TTL_MS / 1000));
    return response;
  }

  if (!(await withinClientLimit(env.APPROVAL_LOOKUP_LIMITER, request))) return TOO_MANY();
  await sweepExpired(env.DB, now);
  await putEmbedHandoff(env.DB, doc, h, accountId, now);

  const expiresAt = now + SHARE_TOKEN_TTL_MS;
  const token = await shareToken(secret, accountId, doc, expiresAt);
  const response = await popupDonePage(doc, token, expiresAt);
  response.headers.append("set-cookie", cookie(embedCookieName(h), "", 0));
  return response;
}

/** The per-document token: `oas_` and a signature over `{a, d}`, stateless and good until `expiresAt`. */
async function shareToken(secret: string, accountId: string, docId: string, expiresAt: number): Promise<string> {
  return SHARE_TOKEN_PREFIX + (await signPayload(secret, "share-token", { a: accountId, d: docId }, expiresAt));
}

/**
 * `POST /embed/token {doc, nonce}`: the frame collects the token its popup left
 * a handoff for. The row is found by the hash of the nonce, so only the frame
 * that made the nonce can take it, once. Pending, unknown, used and expired all
 * answer `404`. The token is minted here from the stored account id, which is
 * equivalent to storing it: it is a stateless signature over `{a, d}`, and no
 * bearer value is ever written to D1.
 *
 * Polled every two seconds by a waiting frame, so it costs one D1 read per poll
 * and is limited per client address (`EMBED_TOKEN_LIMITER`).
 */
async function claimToken(request: Request, url: URL, env: Env, now: number): Promise<Response> {
  const secret = readerSecret(env);
  if (request.method !== "POST" || secret === null) return errorResponse("not_found", "No route.", NO_STORE);
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return errorResponse("bad_request", "Expected a JSON body.", NO_STORE);
  }
  if (!sameOriginPost(request, url, false)) return errorResponse("not_found", "No route.", NO_STORE);

  const raw = await readBodyWithin(request, 1024);
  let fields: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(new TextDecoder().decode(raw));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
  } catch {
    fields = null;
  }
  const { doc, nonce } = fields ?? {};
  if (
    fields === null ||
    Object.keys(fields).length !== 2 ||
    typeof doc !== "string" ||
    typeof nonce !== "string" ||
    !isDocId(doc) ||
    !/^[A-Za-z0-9_-]{43}$/.test(nonce)
  ) {
    return errorResponse("bad_request", 'Expected {"doc": …, "nonce": …}.', NO_STORE);
  }

  if (!(await withinClientLimit(env.EMBED_TOKEN_LIMITER, request))) {
    return errorResponse("slow_down", "Wait a few seconds before asking again.", NO_STORE);
  }
  const accountId = await takeEmbedHandoff(env.DB, doc, await sha256Hex(nonce), now);
  if (accountId === null) return errorResponse("not_found", "Nothing to collect.", NO_STORE);

  const expiresAt = now + SHARE_TOKEN_TTL_MS;
  return Response.json({ token: await shareToken(secret, accountId, doc, expiresAt), expiresAt }, { headers: NO_STORE });
}

const noStore = (response: Response): Response => {
  response.headers.set("cache-control", "no-store");
  return response;
};

/**
 * `/embed/api/docs/{docId}/access…`: the frame's own JSON, human-facing and not
 * part of the frozen client contract. The same five operations as
 * `/api/v1/docs/{docId}/access…` under the bearer token the popup minted.
 *
 * ```
 * GET    …/access                     → 200 owner | 200 reader | 404
 * PUT    …/access  {linkAccess}       → 200 owner
 * PUT    …/access/people/{email}      → 200 owner   (approving a request is an add)
 * DELETE …/access/people/{email}      → 200 owner
 * DELETE …/access/requests/{email}    → 200 owner   (decline)
 * ```
 *
 * The token is checked before the path's document is read: it must be this
 * deployment's `oas_` prefix on a `share-token` for exactly this document, and
 * its account must exist. Writes call the **same operation layer** as `/api/v1`
 * and the share page, with the account as the principal, so the plan gate, both
 * invite caps, the invite email, idempotency and `document_access_changed` are
 * identical on all three. A non-manager gets `404` from those functions, never
 * `403`. A reader (someone who can read the document but does not manage it)
 * gets the title and nothing about mode, people or requests.
 *
 * **No CORS, ever**: the frame's calls are same-origin. **No CSRF surface**: the
 * credential is a header a cross-site page cannot attach without a preflight
 * that fails, never a cookie.
 */
async function frameApi(
  request: Request,
  url: URL,
  env: Env,
  analytics: AnalyticsSink,
  now: number,
): Promise<Response> {
  const [docs, docId, access, kind, person, ...rest] = url.pathname.slice(EMBED_API_PREFIX.length + 1).split("/");
  const method = request.method;
  const people = kind === "people" && person !== undefined && (method === "PUT" || method === "DELETE");
  const requests = kind === "requests" && person !== undefined && method === "DELETE";
  const route =
    docs === "docs" &&
    docId !== undefined &&
    isDocId(docId) &&
    access === "access" &&
    rest.length === 0 &&
    ((kind === undefined && (method === "GET" || method === "PUT")) || people || requests);
  if (!route || readerSecret(env) === null) return errorResponse("not_found", "No route.", NO_STORE);

  const identity = await verifyFrameToken(request, env, docId, now);
  if (identity === null) return errorResponse("unauthorized", "Sign in again to manage this document.", NO_STORE);
  const claims = { a: identity.accountId };
  const email = identity.email;

  // The session account as a publisher, as the share page builds it: its
  // documents are everything in its owner scope, and the plan gate reads its
  // current plan. Reading needs no plan, so a GET makes no license-server call.
  const principal: Publisher = {
    owner: claims.a,
    plan: (await accountPlan(env, claims.a, { skipAccountRefresh: method === "GET" })).plan,
    authKind: "account",
  };
  // `changed` says whether a write changed anything. The frame needs it to tell
  // its own switch to private from a repeat on a stale view.
  const owner = (state: AccessState, changed = false) =>
    Response.json({ viewer: "owner", account: email, title: state.title, changed, ...accessBody(env, url, docId, state) }, { headers: NO_STORE });
  const answer = (result: AccessResult) =>
    result.ok ? owner(result.state, result.changed) : noStore(refusalResponse(env, principal, docId, result.refusal));

  if (method === "GET") {
    const managed = await getAccess(env, principal, docId);
    if (managed.ok) return owner(managed.state);
    const readable = await findReadableDoc(env.DB, docId, null, claims.a);
    if (readable === null || readable.deleted_at !== null || !readable.allowed) return noStore(docNotFound(docId));
    return Response.json(
      { viewer: "reader", account: email, docId, url: publicDocUrl(env, url, docId), title: readable.title },
      { headers: NO_STORE },
    );
  }
  if (people && method === "PUT") return answer(await addPerson(env, url, principal, docId, decodeAddress(person), undefined, analytics));
  if (people) return answer(await removePerson(env, principal, docId, decodeAddress(person), analytics));
  if (requests) return answer(await declineRequest(env, principal, docId, decodeAddress(person)));

  const mode = parseLinkAccess(await stringField(request, "linkAccess"));
  if (mode === null) return errorResponse("bad_request", 'Expected {"linkAccess": "anyone" | "invited"}.', NO_STORE);
  return answer(await setMode(env, principal, docId, mode, analytics));
}

export async function handleEmbed(
  request: Request,
  url: URL,
  env: Env,
  analytics: AnalyticsSink,
): Promise<Response> {
  const now = Date.now();
  if (url.pathname === PAGE_SCRIPT_PATH) return await pageScript(request);
  if (url.pathname === EMBED_SHARE_PATH) return await shareFrame(request, url, env);
  if (url.pathname === EMBED_SIGNIN_PATH) return await popup(request, url, env, now);
  if (url.pathname === EMBED_TOKEN_PATH) return await claimToken(request, url, env, now);
  if (url.pathname.startsWith(`${EMBED_API_PREFIX}/`)) {
    // The comments family first; null means the path is not one of its routes.
    const comments = await handleCommentsEmbed(request, url, env, now);
    if (comments !== null) return comments;
    return await frameApi(request, url, env, analytics, now);
  }
  return READER_NOT_FOUND();
}
