import { parseBearerToken } from "./auth.js";
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
    (value.provider !== "copilot" &&
      !configuredProviders(env).includes(value.provider as ProviderId))
  )
    return fail();
  callbackUrl(env); // Reject a missing/malformed destination before persisting a handshake.
  const provider = value.provider as ProviderId | "copilot";
  if (provider === "copilot" && !env.COPILOT_SSO_SECRET?.trim()) return fail(503);
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
  if (!result[1]!.results.length) return fail(429);
  if (provider === "copilot") {
    const url = new URL("https://obsidiancopilot.com/openartifacts/authorize");
    url.searchParams.set("state", value.state);
    return Response.json({ url: url.toString() }, { headers: HEADERS });
  }
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
  if (!hex(state) || !configuredProviders(env).includes(provider as ProviderId)) return fail();
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

const PROOF_WHERE = `state_hash = ? AND code_hash = ? AND challenge = ? AND expires_at > ?
  AND subject IS NOT NULL AND email IS NOT NULL AND terms_accepted_at IS NOT NULL`;
const COPILOT_WHERE = `${PROOF_WHERE} AND provider = 'copilot'`;
const COPILOT_RESULT = `
  (SELECT account_id FROM owner_links WHERE external_owner = browser_logins.subject) AS accountId,
  (SELECT a.email FROM accounts a JOIN owner_links l ON a.id = l.account_id
    WHERE l.external_owner = browser_logins.subject) AS email, subject AS externalOwner`;
async function proofBindings(value: Record<string, unknown>, now: number) {
  return hex(value.state) && hex(value.code) && hex(value.secret)
    ? [
        await sha256Hex(value.state),
        await sha256Hex(value.code),
        await sha256Hex(value.secret),
        now,
      ]
    : null;
}

/** Consuming requires the secret held in the initiating app's signed browser cookie. */
export async function consumeBrowserLogin(
  request: Request,
  env: Env,
  deps: BrowserLoginDeps = {},
): Promise<Response> {
  const value = await body(request);
  const now = (deps.now ?? Date.now)();
  const bindings = value && Object.keys(value).length === 3 && (await proofBindings(value, now));
  if (!bindings) return fail();
  const [consumed, remaining] = await env.DB.batch<{ email: string }>([
    env.DB.prepare(
      `DELETE FROM browser_logins WHERE ${COPILOT_WHERE}
      AND EXISTS(SELECT 1 FROM owner_links WHERE external_owner = browser_logins.subject)
      RETURNING ${COPILOT_RESULT}`,
    ).bind(...bindings),
    env.DB.prepare(`SELECT email FROM browser_logins WHERE ${COPILOT_WHERE}`).bind(...bindings),
  ]);
  const proof = consumed!.results[0];
  if (proof) return Response.json(proof, { headers: HEADERS });
  const pending = remaining!.results[0];
  if (pending)
    return Response.json({ needsLink: true, email: pending.email }, { headers: HEADERS });
  const row = await env.DB.prepare(
    `DELETE FROM browser_logins WHERE ${PROOF_WHERE}
    AND provider IN ('google', 'github') RETURNING provider, subject, email`,
  )
    .bind(...bindings)
    .first<LoginRow>();
  if (!row) return fail();
  const account = await resolveAccountForIdentity(
    env.DB,
    row.provider,
    row.subject,
    row.email,
    newAccountId(),
    now,
    defaultPlan(env),
  );
  if (!account) return fail(409);
  const link = await env.DB.prepare("SELECT external_owner FROM owner_links WHERE account_id = ?")
    .bind(account.id)
    .first<{ external_owner: string }>();
  return Response.json(
    { accountId: account.id, email: account.email, externalOwner: link?.external_owner ?? null },
    { headers: HEADERS },
  );
}

/** The dedicated Copilot credential can only prove its own signed-in user, never act as admin. */
export async function proveCopilotLogin(
  request: Request,
  env: Env,
  deps: BrowserLoginDeps = {},
): Promise<Response> {
  if (request.method !== "POST" || !env.COPILOT_SSO_SECRET?.trim()) return fail(404);
  const token = parseBearerToken(request.headers.get("authorization"));
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  if (
    !token ||
    !crypto.subtle.timingSafeEqual(await digest(token), await digest(env.COPILOT_SSO_SECRET))
  )
    return fail(401);
  const value = await body(request);
  const email = typeof value?.email === "string" ? normalizeEmail(value.email) : null;
  if (
    !value ||
    Object.keys(value).length !== 3 ||
    !hex(value.state) ||
    !email ||
    typeof value.subject !== "string" ||
    value.subject.length > 256 ||
    !value.subject ||
    value.subject.startsWith("oa_") ||
    /[\u0000-\u0020\u007f]/.test(value.subject)
  )
    return fail();
  const target = callbackUrl(env);
  const code = randomCode();
  const row = await env.DB.prepare(
    `UPDATE browser_logins
    SET claimed = 1, verifier = NULL, subject = ?, email = ?, code_hash = ?
    WHERE state_hash = ? AND provider = 'copilot' AND claimed = 0 AND expires_at > ? RETURNING state_hash`,
  )
    .bind(
      value.subject,
      email,
      await sha256Hex(code),
      await sha256Hex(value.state),
      (deps.now ?? Date.now)(),
    )
    .first();
  if (!row) return fail();
  target.searchParams.set("state", value.state);
  target.searchParams.set("code", code);
  return Response.json({ url: target.toString() }, { headers: HEADERS });
}

/** The website supplies accountId only from an independently verified OpenArtifacts session. */
export async function confirmCopilotLogin(
  request: Request,
  env: Env,
  deps: BrowserLoginDeps = {},
): Promise<Response> {
  const value = await body(request);
  const now = (deps.now ?? Date.now)();
  const bindings = value && (await proofBindings(value, now));
  const suppliedTarget = value?.accountId;
  if (
    !value ||
    !bindings ||
    value.confirmPermanent !== true ||
    Object.keys(value).length !== (suppliedTarget === undefined ? 4 : 5) ||
    (suppliedTarget !== undefined &&
      (typeof suppliedTarget !== "string" ||
        !/^oa_[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(suppliedTarget)))
  )
    return fail();
  const target = typeof suppliedTarget === "string" ? suppliedTarget : newAccountId();
  const statements: D1PreparedStatement[] = [];
  if (suppliedTarget === undefined)
    statements.push(
      env.DB.prepare(
        `
    INSERT INTO accounts (id, email, created_at, plan, plan_checked_at)
    SELECT ?, email, ?, ?, ? FROM browser_logins WHERE ${COPILOT_WHERE}
      AND NOT EXISTS(SELECT 1 FROM accounts WHERE accounts.email = browser_logins.email)
      AND NOT EXISTS(SELECT 1 FROM owner_links WHERE external_owner = browser_logins.subject)
    ON CONFLICT(email) DO NOTHING`,
      ).bind(target, now, defaultPlan(env), now, ...bindings),
    );
  statements.push(
    env.DB.prepare(
      `INSERT INTO owner_links (external_owner, account_id, created_at)
    SELECT subject, ?, ? FROM browser_logins WHERE ${COPILOT_WHERE}
      AND EXISTS(SELECT 1 FROM accounts WHERE id = ?)
    ON CONFLICT DO NOTHING`,
    ).bind(target, now, ...bindings, target),
  );
  // D1 executes the batch transactionally: no new account can be orphaned by a racing link.
  statements.push(
    env.DB.prepare(
      `DELETE FROM browser_logins WHERE ${COPILOT_WHERE}
    AND EXISTS(SELECT 1 FROM owner_links WHERE external_owner = browser_logins.subject
      ${suppliedTarget === undefined ? "" : "AND account_id = ?"}) RETURNING ${COPILOT_RESULT}`,
    ).bind(...bindings, ...(suppliedTarget === undefined ? [] : [target])),
  );
  statements.push(
    env.DB.prepare(`SELECT email FROM browser_logins WHERE ${COPILOT_WHERE}`).bind(...bindings),
  );
  const results = await env.DB.batch<{ email: string }>(statements);
  const proof = results[results.length - 2]!.results[0];
  if (proof) return Response.json(proof, { headers: HEADERS });
  const pending = results[results.length - 1]!.results[0];
  if (!pending) return fail();
  if (suppliedTarget === undefined)
    return Response.json({ needsAccountSignIn: true, email: pending.email }, { headers: HEADERS });
  return fail(409);
}
