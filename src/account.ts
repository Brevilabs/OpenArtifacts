import { parseBearerToken, type Publisher } from "./auth.js";
import type { Env } from "./config.js";
import { errorResponse } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { OWNER_SCOPE_SQL } from "./owners.js";
import { effectivePlan, planLimits } from "./plans.js";
import { readBodyWithin, utcDay } from "./quota.js";

const NO_STORE = { "cache-control": "no-store" };
const PURPOSES = new Set(["upgrade", "billing", "link"]);
const HANDOFF_MS = 10 * 60 * 1000;

/** Bounded, exact one-field JSON shared by the account and service APIs. */
export async function stringField(request: Request, field: string): Promise<string | null> {
  const raw = await readBodyWithin(request, 1024);
  if (!raw) return null;
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !(field in body)) return null;
    const value = (body as Record<string, unknown>)[field];
    return typeof value === "string" ? value : null;
  } catch { return null; }
}

function actionUrl(env: Env): URL | null {
  if (!env.ACCOUNT_ACTION_URL?.trim()) return null;
  const url = new URL(env.ACCOUNT_ACTION_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new Error("ACCOUNT_ACTION_URL must be HTTPS without credentials or fragment (local HTTP is allowed).");
  }
  return url;
}

export async function handleAccount(request: Request, env: Env, publisher: Publisher): Promise<Response> {
  if (publisher.authKind !== "account") return errorResponse("unauthorized", "Sign in with an account token.");
  const path = new URL(request.url).pathname;
  if (path === "/api/v1/account" && request.method === "GET") {
    const row = await env.DB.prepare(`${OWNER_SCOPE_SQL}
      SELECT a.id AS accountId, a.plan, a.plan_expires_at,
        (SELECT COUNT(*) FROM docs WHERE owner IN (SELECT owner FROM owner_scope) AND deleted_at IS NULL) AS documents,
        (SELECT COALESCE(SUM(pushes), 0) FROM push_quota WHERE owner IN (SELECT owner FROM owner_scope) AND day = ?) AS pushesToday,
        EXISTS(SELECT 1 FROM owner_links WHERE account_id = a.id) AS externalLinked
      FROM accounts a WHERE a.id = ?`)
      .bind(publisher.owner, publisher.owner, utcDay(Date.now()), publisher.owner)
      .first<{ accountId: string; plan: string; plan_expires_at: number | null; documents: number; pushesToday: number; externalLinked: number }>();
    if (!row) return errorResponse("unauthorized", "Sign in again.");
    const plan = effectivePlan(env, row.plan, row.plan_expires_at);
    return Response.json({ accountId: row.accountId, plan, limits: planLimits(env, plan),
      usage: { documents: row.documents, pushesToday: row.pushesToday }, externalLinked: !!row.externalLinked }, { headers: NO_STORE });
  }
  if (path !== "/api/v1/account/handoffs" || request.method !== "POST") return errorResponse("not_found", "No account route.");
  const url = actionUrl(env);
  if (!url) return errorResponse("not_found", "Account actions are not configured.");
  const purpose = await stringField(request, "purpose");
  if (!purpose || !PURPOSES.has(purpose)) return errorResponse("bad_request", "Expected purpose upgrade, billing, or link.");
  const tokenHash = await sha256Hex(parseBearerToken(request.headers.get("authorization"))!);
  const code = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const expiresAt = now + HANDOFF_MS;
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM account_handoffs WHERE account_id = ? AND expires_at <= ?").bind(publisher.owner, now),
    env.DB.prepare(`INSERT INTO account_handoffs (code_hash, account_id, token_id, purpose, expires_at)
      SELECT ?, a.id, t.id, ?, ? FROM tokens t JOIN accounts a ON a.id = t.account_id
      WHERE t.token_hash = ? AND a.id = ?
        AND (SELECT COUNT(*) FROM account_handoffs WHERE account_id = a.id) < 5
      RETURNING code_hash`).bind(await sha256Hex(code), purpose, expiresAt, tokenHash, publisher.owner),
  ]);
  if (results[1]!.results.length === 0) return errorResponse("quota_exceeded", "Too many pending account actions, or token revoked. Sign in again or wait ten minutes.");
  url.searchParams.set("code", code);
  return Response.json({ url: url.toString(), expiresAt }, { headers: NO_STORE });
}

/** The service credential is checked by handleAdmin before this one-use proof. */
export async function consumeHandoff(request: Request, env: Env): Promise<Response> {
  const code = await stringField(request, "code");
  if (!code || !/^[0-9a-f]{64}$/.test(code)) return errorResponse("bad_request", "Expected a handoff code.");
  const row = await env.DB.prepare(`DELETE FROM account_handoffs
    WHERE code_hash = ? AND expires_at > ?
      AND EXISTS(SELECT 1 FROM tokens t JOIN accounts a ON a.id = t.account_id
                 WHERE t.id = account_handoffs.token_id AND a.id = account_handoffs.account_id)
    RETURNING account_id AS accountId, purpose,
      (SELECT email FROM accounts WHERE id = account_handoffs.account_id) AS email,
      (SELECT external_owner FROM owner_links WHERE account_id = account_handoffs.account_id) AS externalOwner`)
    .bind(await sha256Hex(code), Date.now()).first();
  if (!row) return errorResponse("not_found", "No live handoff.");
  return Response.json(row, { headers: NO_STORE });
}
