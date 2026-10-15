/**
 * The signed values private sharing hands out, and the cookies they travel in:
 * a reader session, a read-only grant for one publisher's origin, the binding of
 * an OAuth handshake to the browser that started it, and the Share popover's
 * per-document token and the cookie that binds its sign-in popup.
 *
 * All of them are an HMAC over a short JSON payload, keyed by
 * `READER_SESSION_SECRET`. Stateless on purpose: there is no session table to
 * read on a request, and signing out clears the cookie. What each one is worth
 * is decided by the code that checks it, not by anything in the value.
 *
 * **The purpose is part of the signed input.** A value minted for one purpose
 * fails the MAC check for every other, so a URL grant cannot be replayed as a
 * session and a session cannot be presented as a grant.
 */
import { isDocId } from "./ids.js";
import { EMBED_SIGNIN_PATH, SHARE_PREFIX } from "./reader-pages.js";
import { docPath, parseDocPath } from "./serve.js";

export const SESSION_COOKIE = "__Host-oa_session";
export const GRANT_COOKIE = "__Host-oa_grant";
export const LOGIN_COOKIE = "__Host-oa_login";

/**
 * `grant-url` and `grant-cookie` are the same read-only grant for one
 * publisher's origin, in the URL for a minute and in the cookie for an hour.
 * They are separate purposes so a leaked URL grant cannot be planted as a cookie.
 *
 * `signup` is the ten-minute token that carries a mailbox proved by an emailed
 * code from the code page to the Terms step, and `email-code` keys the hash an
 * emailed code is stored under, so neither can be replayed as any other value.
 *
 * `share-token` is the Share popover's credential, one account and one
 * document, and `embed-signin` is the ten-minute cookie that ties the popup's
 * return from a provider to the request that opened it. Neither is a session,
 * and no session, grant, login or signup value verifies as either.
 */
export type Purpose =
  | "session"
  | "grant-url"
  | "grant-cookie"
  | "login"
  | "signup"
  | "email-code"
  | "share-token"
  | "embed-signin";

/** How long a Share popover token is good for. One sign-in per document per day. */
export const SHARE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long the popup's binding cookie lives, and how long a frame keeps polling
 * for its sign-in: the time a person may take to sign in, not a credential's life.
 */
export const EMBED_SIGNIN_TTL_MS = 10 * 60 * 1000;

/**
 * The cookie that binds a popup's return from Google or GitHub to the request
 * that opened it (`embed.ts`). One cookie per handshake, named by the first 16
 * hex characters of the nonce's hash, so two popovers signing in at once keep
 * separate bindings. The value still verifies only for its own full `{d, h}`,
 * so the short name adds no trust.
 */
export const EMBED_COOKIE_PREFIX = "__Host-oa_embed_";
export const embedCookieName = (h: string): string => `${EMBED_COOKIE_PREFIX}${h.slice(0, 16)}`;

/** The nonce hash in a popup url: lowercase SHA-256 hex. */
export const EMBED_HASH = /^[0-9a-f]{64}$/;

/** How long a signed-in reader stays signed in on the API host. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}

/**
 * `text` keyed by the secret under `purpose`, as lowercase hex. For a value that
 * is stored rather than handed out: an emailed code is six digits, so an
 * unkeyed hash of it would be recovered instantly by anyone who read the table.
 */
export async function macHex(secret: string, purpose: Purpose, text: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(`${purpose}.${text}`));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `payload` plus an expiry, signed. The result is a cookie- and URL-safe string. */
export async function signPayload(
  secret: string,
  purpose: Purpose,
  payload: Record<string, string>,
  expiresAt: number,
): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify({ ...payload, exp: expiresAt })));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(`${purpose}.${body}`));
  return `${body}.${toBase64Url(new Uint8Array(mac))}`;
}

/** The payload of a value signed for `purpose` that has not expired, else null. */
export async function verifyPayload(
  secret: string,
  purpose: Purpose,
  token: string | null,
  now: number,
): Promise<Record<string, string> | null> {
  const [body, mac, ...extra] = token?.split(".") ?? [];
  if (!body || !mac || extra.length > 0) return null;
  const macBytes = fromBase64Url(mac);
  if (macBytes === null) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    macBytes,
    encoder.encode(`${purpose}.${body}`),
  );
  if (!valid) return null;

  try {
    const decoded = fromBase64Url(body);
    const payload = decoded && JSON.parse(new TextDecoder().decode(decoded));
    return payload && typeof payload.exp === "number" && payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

/** A `__Host-` cookie: `Secure`, `Path=/` and no `Domain`, which the prefix requires. */
export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

/** The account a request's session cookie names, or null when signed out. */
export async function readSession(request: Request, secret: string, now: number): Promise<string | null> {
  const session = await verifyPayload(secret, "session", readCookie(request, SESSION_COOKIE), now);
  return typeof session?.a === "string" ? session.a : null;
}

/**
 * A return path the sign-in pages may redirect to: `/open/{docId}[/v{n}]`,
 * `/share/{docId}` or the Share popover's popup, `/embed/sign-in?doc=…&h=…`, and
 * nothing else. Rebuilt from the parsed parts rather than echoed, so what a
 * form field or a cookie carried can never become a different location: no
 * absolute url, no `//host`, no fragment, no other query parameter (the popup's
 * `switch` is dropped), and not the `/open/{docId}/request` route, which answers
 * only a POST.
 */
export function returnPath(candidate: string | null): string | null {
  if (candidate === null) return null;
  if (candidate.startsWith(`${EMBED_SIGNIN_PATH}?`)) return popupPath(candidate);
  const open = parseDocPath(candidate, "/open");
  if (open !== null) return docPath("/open", open);
  const share = parseDocPath(candidate, SHARE_PREFIX);
  return share !== null && share.pinned === null ? docPath(SHARE_PREFIX, share) : null;
}

/** The popup's own address, `/embed/sign-in?doc={docId}&h={hash}`, or null if either parameter is not well formed. */
export function popupPath(candidate: string): string | null {
  const { pathname, searchParams, hash } = new URL(candidate, "https://x");
  const doc = searchParams.get("doc");
  const h = searchParams.get("h");
  if (pathname !== EMBED_SIGNIN_PATH || hash !== "" || doc === null || h === null) return null;
  return isDocId(doc) && EMBED_HASH.test(h) ? `${EMBED_SIGNIN_PATH}?doc=${doc}&h=${h}` : null;
}

/** Sign `accountId` in and send the browser on to `location`. */
export async function sessionRedirect(
  secret: string,
  accountId: string,
  location: string,
  now: number,
): Promise<Response> {
  const session = await signPayload(secret, "session", { a: accountId }, now + SESSION_TTL_MS);
  return new Response(null, {
    status: 303,
    headers: {
      location,
      "set-cookie": cookie(SESSION_COOKIE, session, SESSION_TTL_MS / 1000),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
