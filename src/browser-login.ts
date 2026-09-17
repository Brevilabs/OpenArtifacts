import { actionUrl } from "./account.js";
import { APPROVAL_PREFIX, BROWSER_USER_CODE_PREFIX } from "./approval/handler.js";
import { confirmDeviceApproval, sweepExpired } from "./db.js";
import { errorResponse } from "./errors.js";
import type { Env } from "./config.js";
import { newAccountId, newHandshakeToken } from "./ids.js";
import { defaultPlan } from "./plans.js";
import { readBodyWithin } from "./quota.js";
import {
  approvalIsConfigured,
  arcticOAuthClient,
  configuredProviders,
  type OAuthClient,
  type ProviderId,
} from "./approval/providers.js";

const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const TTL_MS = 10 * 60 * 1000;
const HANDSHAKE_TOKEN = /^[0-9a-z]{1,128}$/;

export interface BrowserLoginDeps {
  now?: () => number;
  oauth?: OAuthClient;
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

export async function startBrowserLogin(
  request: Request,
  env: Env,
  deps: BrowserLoginDeps = {},
): Promise<Response> {
  const value = await body(request);
  if (
    !value ||
    Object.keys(value).length !== 2 ||
    value.termsAccepted !== true ||
    !configuredProviders(env).includes(value.provider as ProviderId)
  )
    return errorResponse("bad_request", "Invalid browser sign-in request.", HEADERS);

  let destination: URL | null;
  try {
    destination = actionUrl(env);
  } catch {
    destination = null;
  }
  if (!approvalIsConfigured(env) || destination === null) {
    return Response.json(
      { error: { code: "not_configured", message: "Browser sign-in is not configured." } },
      { status: 503, headers: HEADERS },
    );
  }

  const provider = value.provider as ProviderId;
  const state = newHandshakeToken();
  const verifier = newHandshakeToken();
  const now = (deps.now ?? Date.now)();
  await sweepExpired(env.DB, now);
  await env.DB.prepare(
    `INSERT INTO device_codes (user_code, provider, state, verifier, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(BROWSER_USER_CODE_PREFIX + state, provider, state, verifier, now + TTL_MS, now)
    .run();

  const oauth = deps.oauth ?? arcticOAuthClient(env);
  const redirect = `${new URL(request.url).origin}${APPROVAL_PREFIX}/callback/${provider}`;
  const url = oauth.authorizationUrl(provider, redirect, state, verifier);
  return Response.json({ url: url.toString(), state }, { headers: HEADERS });
}

export async function consumeBrowserLogin(
  request: Request,
  env: Env,
  deps: Pick<BrowserLoginDeps, "now"> = {},
): Promise<Response> {
  const value = await body(request);
  if (
    !value ||
    Object.keys(value).length !== 2 ||
    value.termsAccepted !== true ||
    typeof value.code !== "string" ||
    !HANDSHAKE_TOKEN.test(value.code)
  )
    return errorResponse("bad_request", "Sign-in expired or could not be verified.", HEADERS);

  const now = (deps.now ?? Date.now)();
  const row = await env.DB.prepare(
    `SELECT user_code, account_id, pending_subject FROM device_codes
     WHERE confirm_token = ? AND user_code LIKE 'browser#_%' ESCAPE '#'
       AND approved_at IS NULL AND denied_at IS NULL AND expires_at > ?`,
  )
    .bind(value.code, now)
    .first<{ user_code: string; account_id: string | null; pending_subject: string | null }>();
  if (!row)
    return errorResponse("bad_request", "Sign-in expired or could not be verified.", HEADERS);

  let accountId = row.account_id;
  let identity: { email: string; externalOwner: string | null } | null = null;
  if (accountId !== null) {
    identity = await readIdentity(env.DB, accountId);
    const spent = await env.DB.prepare(
      "DELETE FROM device_codes WHERE user_code = ? AND confirm_token = ? RETURNING user_code",
    )
      .bind(row.user_code, value.code)
      .first();
    if (!spent || !identity)
      return errorResponse("bad_request", "Sign-in expired or could not be verified.", HEADERS);
  } else {
    const userCode = await confirmDeviceApproval(
      env.DB,
      value.code,
      now,
      null,
      true,
      newAccountId(),
      defaultPlan(env),
    );
    if (userCode === null)
      return errorResponse("bad_request", "Sign-in expired or could not be verified.", HEADERS);
    const removed = await env.DB.prepare(
      "DELETE FROM device_codes WHERE user_code = ? RETURNING account_id",
    )
      .bind(userCode)
      .first<{ account_id: string | null }>();
    accountId = removed?.account_id ?? null;
    if (accountId !== null) identity = await readIdentity(env.DB, accountId);
    if (!identity || accountId === null)
      return errorResponse("bad_request", "Sign-in expired or could not be verified.", HEADERS);
  }

  return Response.json(
    { accountId, email: identity.email, externalOwner: identity.externalOwner },
    { headers: HEADERS },
  );
}

async function readIdentity(
  db: D1Database,
  accountId: string,
): Promise<{ email: string; externalOwner: string | null } | null> {
  return await db
    .prepare(
      `SELECT a.email,
        (SELECT external_owner FROM owner_links WHERE account_id = a.id) AS externalOwner
       FROM accounts a WHERE a.id = ?`,
    )
    .bind(accountId)
    .first<{ email: string; externalOwner: string | null }>();
}
