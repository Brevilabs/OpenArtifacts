/**
 * The one cookie this Worker sets, and the whole of its state store.
 *
 * An OAuth authorization-code flow has to remember two things across the trip
 * to the provider: the `state` it will compare on the way back, and the PKCE
 * verifier it will present. A session store is the usual home for them, and
 * this project deliberately has none — a session is a credential that outlives
 * the request, and the point of the approval page is that nothing outlives it.
 * So the two values ride in a signed, HttpOnly cookie that expires in minutes,
 * and the request that comes back is the last one that can use it.
 *
 * Signed, not encrypted. What has to be impossible is *forging* a handshake —
 * an attacker who could write this cookie could hand the browser their own
 * `state` and finish a flow the user never started. Reading it grants nothing:
 * a verifier is only useful with the authorization code it was issued against,
 * which is in the browser's url bar anyway, and the cookie is HttpOnly and
 * Secure and scoped to the approval path.
 *
 * The expiry is in the payload as well as in `Max-Age` because only one of them
 * is ours. `Max-Age` asks the browser to forget the cookie; the payload's
 * `expiresAt` is what this Worker checks, so a client that keeps a stale cookie
 * — or replays a captured one — gets nothing for it.
 */
import { APPROVAL_STATE_TTL_MS } from "../config.js";
import { PROVIDER_IDS, type ProviderId } from "./providers.js";

/**
 * Scoped to the approval path so it is not attached to any other request on the
 * API host, and `Lax` because the request that needs it is the provider's
 * top-level redirect back — a cross-site navigation, which `Strict` would strip
 * the cookie from, breaking every handshake.
 */
const COOKIE_NAME = "oa_approval";
const COOKIE_PATH = "/approve";
const COOKIE_ATTRIBUTES = `Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`;

/** What the callback has to know that the redirect back cannot tell it. */
export interface ApprovalState {
  /** Which provider the handshake was started with. */
  provider: ProviderId;
  /** The CSRF token echoed by the provider, compared on return. */
  state: string;
  /** The PKCE code verifier whose challenge went out with the authorization url. */
  verifier: string;
  /** The device code (#57) this approval is for, already normalized. */
  userCode: string;
  /** Epoch ms after which this handshake is refused. */
  expiresAt: number;
}

/** The wire shape, short-keyed because it travels in a header on every hop. */
interface SealedPayload {
  p: string;
  s: string;
  v: string;
  u: string;
  e: number;
}

/**
 * Build the `Set-Cookie` value that carries a handshake, with its expiry
 * already stamped.
 *
 * @param secret the deployment's `APPROVAL_COOKIE_SECRET`
 * @param nowMs when the handshake started, which fixes when it stops working
 */
export async function sealApprovalCookie(
  state: Omit<ApprovalState, "expiresAt">,
  secret: string,
  nowMs: number,
): Promise<string> {
  const payload: SealedPayload = {
    p: state.provider,
    s: state.state,
    v: state.verifier,
    u: state.userCode,
    e: nowMs + APPROVAL_STATE_TTL_MS,
  };

  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = toBase64Url(await sign(body, secret));
  const maxAgeSeconds = Math.ceil(APPROVAL_STATE_TTL_MS / 1000);

  return `${COOKIE_NAME}=${body}.${signature}; ${COOKIE_ATTRIBUTES}; Max-Age=${maxAgeSeconds}`;
}

/**
 * The `Set-Cookie` that ends a handshake, sent with every terminal approval
 * page.
 *
 * A handshake is single-use: once the callback has run, the cookie it needed is
 * a spare key to a door that no longer exists. Clearing it on failure matters
 * as much as on success, since that is the path where a user is about to start
 * over and must not carry the old `state` into the new attempt.
 */
export function clearApprovalCookie(): string {
  return `${COOKIE_NAME}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
}

/**
 * Recover a handshake from the request's cookies, or null when there is nothing
 * usable there.
 *
 * Every failure is one null: no cookie, a mangled one, a bad signature, an
 * expired payload, a provider this build does not know. The caller has one
 * honest thing to say to a human in all of those cases — start again — and
 * distinguishing them on screen would be telling an attacker which half of a
 * forgery attempt was wrong.
 */
export async function openApprovalCookie(
  cookieHeader: string | null,
  secret: string,
  nowMs: number,
): Promise<ApprovalState | null> {
  const raw = readCookie(cookieHeader, COOKIE_NAME);
  if (raw === null) return null;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;
  const body = raw.slice(0, separator);
  const signature = fromBase64Url(raw.slice(separator + 1));
  if (signature === null) return null;

  if (!(await verify(body, signature, secret))) return null;

  const decoded = fromBase64Url(body);
  if (decoded === null) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const { p, s, v, u, e } = payload as Partial<SealedPayload>;
  if (typeof p !== "string" || typeof s !== "string") return null;
  if (typeof v !== "string" || typeof u !== "string" || typeof e !== "number") return null;
  if (!isProviderId(p)) return null;
  if (e <= nowMs) return null;

  return { provider: p, state: s, verifier: v, userCode: u, expiresAt: e };
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * One cookie out of a `Cookie` header.
 *
 * Split on `;` and take the first `=`, which is all RFC 6265 permits: a value
 * may contain `=`, a name may not. Whitespace around the pair is normal — the
 * separator is defined as `"; "` — and unquoted values are left as they are,
 * since the value written above is base64url and never quoted.
 */
function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;

  for (const pair of header.split(";")) {
    const equals = pair.indexOf("=");
    if (equals < 0) continue;
    if (pair.slice(0, equals).trim() !== name) continue;
    const value = pair.slice(equals + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

async function sign(body: string, secret: string): Promise<Uint8Array> {
  const key = await hmacKey(secret, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return new Uint8Array(signature);
}

/**
 * `crypto.subtle.verify` rather than comparing two strings: it is the only
 * comparison here that does not leak how far a forged signature matched before
 * it failed, and it costs nothing to use instead.
 */
async function verify(body: string, signature: Uint8Array, secret: string): Promise<boolean> {
  const key = await hmacKey(secret, "verify");
  return await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(body),
  );
}

/** base64url, so the value needs no cookie quoting and no percent-encoding. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}
