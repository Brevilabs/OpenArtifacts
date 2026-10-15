/**
 * The embed surface: `/embed/*` on the API host, what the top bar's **Share**
 * button is built from.
 *
 * ```
 * GET|HEAD /embed/page.js   the script every served page loads
 * ```
 *
 * It lives on the API host and not on a document host for the reason the share
 * page does: the credential that changes who can read a document must never be
 * on an origin whose scripts the author writes. The script is the only part
 * that runs on the document's page, and it holds no credential.
 *
 * Every route here is behind `readerSignInConfigured` in the router, so a server
 * with no reader sign-in has no `/embed/*` at all, and renders no tag that would
 * ask for it. Dispatch is by exact path; anything else under `/embed` is the
 * reader pages' not-found.
 */
import { PAGE_SCRIPT } from "./embed-scripts.js";
import { sha256Hex } from "./hash.js";
import { PAGE_SCRIPT_PATH, READER_NOT_FOUND } from "./reader-pages.js";

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

export async function handleEmbed(request: Request, url: URL): Promise<Response> {
  if (url.pathname === PAGE_SCRIPT_PATH) return await pageScript(request);
  return READER_NOT_FOUND();
}
