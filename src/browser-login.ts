import { errorResponse } from "./errors.js";
import type { Env } from "./config.js";
import { resolveAccountForIdentity } from "./db.js";
import { sha256Hex } from "./hash.js";
import { newAccountId, newHandshakeToken } from "./ids.js";
import { defaultPlan } from "./plans.js";
import { readBodyWithin } from "./quota.js";
import {
  arcticOAuthClient,
  configuredProviders,
  normalizeEmail,
  type OAuthClient,
  type ProviderId,
} from "./approval/providers.js";

const HEX = /^[0-9a-f]{64}$/;
const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const TTL_MS = 10 * 60 * 1000;
export const BROWSER_STATE_PREFIX = "browser_";
export interface BrowserLoginDeps {
  now?: () => number;
  oauth?: OAuthClient;
}
interface LoginRow {
  provider: ProviderId;
  verifier: string;
  subject: string;
  email: string;
}
const fail = (status = 400) =>
  new Response("Sign-in expired or could not be verified. Start again from your account page.", {
    status,
    headers: HEADERS,
  });
const randomCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const hex = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

function callbackUrl(env: Env): URL {
  const url = new URL(env.ACCOUNT_ACTION_URL ?? "");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  )
    throw new Error("Invalid ACCOUNT_ACTION_URL");
  return new URL("/account/login/callback", url.origin);
}
function redirectUri(url: URL, provider: ProviderId) {
  return `${url.origin}/approve/callback/${provider}`;
}
async function body(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await readBodyWithin(request, 1024);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(raw));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Called only after the existing admin bearer authentication. No browser token is minted. */
export async function startBrowserLogin(
  request: Request,
  env: Env,
  deps: BrowserLoginDeps = {},
): Promise<Response> {
  const value = await body(request);
  if (
    !value ||
    Object.keys(value).length !== 4 ||
    !hex(value.state) ||
    !hex(value.challenge) ||
    value.termsAccepted !== true ||
    !configuredProviders(env).includes(value.provider as ProviderId)
  )
    return errorResponse("bad_request", "Invalid browser sign-in request.", HEADERS);
  callbackUrl(env); // Reject a missing/malformed destination before persisting a handshake.
  const provider = value.provider as ProviderId;
  const now = (deps.now ?? Date.now)();
  const verifier = newHandshakeToken();
  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM browser_logins WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      `INSERT INTO browser_logins (state_hash, challenge, provider, verifier, expires_at, terms_accepted_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM browser_logins) < 1000
      ON CONFLICT DO NOTHING RETURNING state_hash`,
    ).bind(await sha256Hex(value.state), value.challenge, provider, verifier, now + TTL_MS, now),
  ]);
  if (!result[1]!.results.length)
    return errorResponse(
      "quota_exceeded",
      "Too many pending sign-ins or duplicate state.",
      HEADERS,
    );
  const oauth = deps.oauth ?? arcticOAuthClient(env);
  const url = oauth.authorizationUrl(
    provider,
    redirectUri(new URL(request.url), provider),
    BROWSER_STATE_PREFIX + value.state,
    verifier,
  );
  return Response.json({ url: url.toString() }, { headers: HEADERS });
}

/** Existing provider callback URL, dispatched separately from device approval. */
export async function proveBrowserLogin(
  url: URL,
  env: Env,
  provider: string,
  deps: BrowserLoginDeps = {},
): Promise<Response> {
  const state = url.searchParams.get("state")?.slice(BROWSER_STATE_PREFIX.length);
  if (!hex(state)) return fail();
  const now = (deps.now ?? Date.now)();
  // The verifier is claimed before exchange, so concurrent callbacks cannot reuse it.
  const stateHash = await sha256Hex(state);
  const row = await env.DB.prepare(
    `UPDATE browser_logins SET claimed = 1
    WHERE state_hash = ? AND provider = ? AND claimed = 0 AND expires_at > ?
    RETURNING provider, verifier`,
  )
    .bind(stateHash, provider, now)
    .first<LoginRow>();
  if (!row) return fail();
  const target = callbackUrl(env);
  target.searchParams.set("state", state);
  const decline = () => {
    target.searchParams.set("error", "sign_in_failed");
    return new Response(null, {
      status: 303,
      headers: { ...HEADERS, location: target.toString() },
    });
  };
  const code = url.searchParams.get("code");
  if (!code) return decline();
  const oauth = deps.oauth ?? arcticOAuthClient(env);
  const identity = await oauth
    .verifiedIdentity(row.provider, redirectUri(url, row.provider), code, row.verifier)
    .catch(() => null);
  const email = identity && normalizeEmail(identity.email);
  if (!identity || !email) return decline();
  const proof = randomCode();
  const updated = await env.DB.prepare(
    `UPDATE browser_logins SET verifier = NULL, subject = ?, email = ?, code_hash = ?
    WHERE state_hash = ? AND expires_at > ? RETURNING state_hash`,
  )
    .bind(identity.subject, email, await sha256Hex(proof), stateHash, (deps.now ?? Date.now)())
    .first();
  if (!updated) return decline();
  target.searchParams.set("code", proof);
  return new Response(null, { status: 303, headers: { ...HEADERS, location: target.toString() } });
}

/** Consuming requires the secret held in the initiating app's signed browser cookie. */
export async function consumeBrowserLogin(
  request: Request,
  env: Env,
  deps: BrowserLoginDeps = {},
): Promise<Response> {
  const value = await body(request);
  if (
    !value ||
    Object.keys(value).length !== 3 ||
    !hex(value.state) ||
    !hex(value.code) ||
    !hex(value.secret)
  )
    return errorResponse("bad_request", "Sign-in expired or could not be verified.", HEADERS);
  const now = (deps.now ?? Date.now)();
  const row = await env.DB.prepare(
    `DELETE FROM browser_logins
    WHERE state_hash = ? AND code_hash = ? AND challenge = ? AND expires_at > ?
      AND subject IS NOT NULL AND email IS NOT NULL AND terms_accepted_at IS NOT NULL
      AND provider IN ('google', 'github')
    RETURNING provider, subject, email`,
  )
    .bind(
      await sha256Hex(value.state),
      await sha256Hex(value.code),
      await sha256Hex(value.secret),
      now,
    )
    .first<LoginRow>();
  if (!row)
    return errorResponse("bad_request", "Sign-in expired or could not be verified.", HEADERS);
  const account = await resolveAccountForIdentity(
    env.DB,
    row.provider,
    row.subject,
    row.email,
    newAccountId(),
    now,
    defaultPlan(env),
  );
  if (!account)
    return errorResponse(
      "conflict",
      "This address already belongs to another sign-in with this provider.",
      HEADERS,
    );
  const link = await env.DB.prepare("SELECT external_owner FROM owner_links WHERE account_id = ?")
    .bind(account.id)
    .first<{ external_owner: string }>();
  return Response.json(
    { accountId: account.id, email: account.email, externalOwner: link?.external_owner ?? null },
    { headers: HEADERS },
  );
}
