/**
 * The signed values private sharing hands out, and the cookies they travel in:
 * a reader session, a read-only grant for one publisher's origin, and the
 * binding of an OAuth handshake to the browser that started it.
 *
 * All three are an HMAC over a short JSON payload, keyed by
 * `READER_SESSION_SECRET`. Stateless on purpose: there is no session table to
 * read on a request, and signing out clears the cookie. What each one is worth
 * is decided by the code that checks it, not by anything in the value.
 *
 * **The purpose is part of the signed input.** A value minted for one purpose
 * fails the MAC check for every other, so a URL grant cannot be replayed as a
 * session and a session cannot be presented as a grant.
 */
import { docPath, parseDocPath } from "./serve.js";

export const SESSION_COOKIE = "__Host-oa_session";
export const GRANT_COOKIE = "__Host-oa_grant";
export const LOGIN_COOKIE = "__Host-oa_login";

/**
 * `grant-url` and `grant-cookie` are the same read-only grant for one
 * publisher's origin, in the URL for a minute and in the cookie for an hour.
 * They are separate purposes so a leaked URL grant cannot be planted as a cookie.
 */
export type Purpose = "session" | "grant-url" | "grant-cookie" | "login";

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
 * A return path the sign-in pages may redirect to: `/open/{docId}[/v{n}]` and
 * nothing else. Rebuilt from the parsed parts rather than echoed, so what a
 * form field or a cookie carried can never become a different location.
 */
export function openPath(candidate: string | null): string | null {
  const route = candidate === null ? null : parseDocPath(candidate, "/open");
  return route === null ? null : docPath("/open", route);
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
