/**
 * Document ownership can join two proven identities without moving their rows.
 * Keep credential identity separate: these aliases never authorize token access.
 */
import { ACCOUNT_ID_PREFIX, newAccountId } from "./ids.js";
import type { Env } from "./config.js";
import { errorResponse } from "./errors.js";
import { normalizeEmail } from "./approval/providers.js";
import { defaultPlan } from "./plans.js";
import { readBodyWithin } from "./quota.js";

function validExternalOwner(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u0020\u007f]/.test(value) &&
    !value.startsWith(ACCOUNT_ID_PREFIX)
  );
}

/**
 * Bind the authenticated owner twice, before the statement's other parameters.
 * Resolve inside each statement so a link committed during a request applies to
 * its next reservation or ownership check, including a request using an old key.
 */
export const OWNER_SCOPE_SQL = `WITH canonical AS (
  SELECT COALESCE((SELECT account_id FROM owner_links WHERE external_owner = ?), ?) AS id
), owner_scope AS (
  SELECT id AS owner FROM canonical
  UNION ALL
  SELECT external_owner FROM owner_links JOIN canonical ON account_id = id
)`;

/**
 * The publisher's app-sites `User.id` when one is known — the license-key owner
 * itself, or the one linked to an account — and otherwise the local `oa_`
 * account id. A `RETURNING` expression for a statement prefixed with
 * `OWNER_SCOPE_SQL`, so a linked key and token resolve to the same id from the
 * same read that authorized the write.
 */
export const PUBLISHER_USER_ID_SQL = `(SELECT COALESCE(
  (SELECT external_owner FROM owner_links WHERE account_id = canonical.id),
  canonical.id
) FROM canonical)`;

export type OwnerLinkResult = "linked" | "conflict" | "invalid" | "account_not_found";

/**
 * Trusted callers must prove both identities before invoking this primitive.
 * Email equality or an outage cache is not proof. Associations are permanent;
 * repeated confirmation of the same pair succeeds without changing anything.
 */
export async function linkExternalOwner(
  db: D1Database,
  externalOwner: string,
  accountId: string,
  atMs: number,
): Promise<OwnerLinkResult> {
  if (
    !validExternalOwner(externalOwner) ||
    !/^oa_[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(accountId) ||
    !Number.isSafeInteger(atMs) || atMs < 0
  ) return "invalid";

  const inserted = await db.prepare(
    `INSERT INTO owner_links (external_owner, account_id, created_at)
     SELECT ?, id, ? FROM accounts WHERE id = ?
     ON CONFLICT DO NOTHING RETURNING account_id`,
  ).bind(externalOwner, atMs, accountId).first<{ account_id: string }>();
  if (inserted !== null) return "linked";

  const existing = await db.prepare(
    "SELECT account_id FROM owner_links WHERE external_owner = ?",
  ).bind(externalOwner).first<{ account_id: string }>();
  if (existing?.account_id === accountId) return "linked";
  const account = await db.prepare("SELECT id FROM accounts WHERE id = ?")
    .bind(accountId).first();
  return account === null ? "account_not_found" : "conflict";
}

/** The admin caller has already proved control of this external identity. */
export async function lookupExternalOwner(env: Env, owner: string): Promise<Response> {
  if (!validExternalOwner(owner)) return errorResponse("bad_request", "Invalid owner identity.");
  const row = await env.DB.prepare(
    `SELECT a.id AS accountId, a.email AS email
    FROM owner_links l JOIN accounts a ON a.id = l.account_id WHERE l.external_owner = ?`,
  )
    .bind(owner)
    .first<{ accountId: string; email: string }>();
  return row
    ? Response.json(row, { headers: { "cache-control": "no-store" } })
    : errorResponse("not_found", "No account for this owner.", { "cache-control": "no-store" });
}

/** Create and permanently link only after the trusted caller obtains explicit consent. */
export async function createLinkedAccount(request: Request, env: Env): Promise<Response> {
  const raw = await readBodyWithin(request, 1024);
  let body: unknown;
  try {
    body = raw && JSON.parse(new TextDecoder().decode(raw));
  } catch {
    body = null;
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    !("email" in body) ||
    typeof body.email !== "string" ||
    !("externalOwner" in body) ||
    !validExternalOwner(body.externalOwner)
  )
    return errorResponse("bad_request", "Expected email and externalOwner.");
  const email = normalizeEmail(body.email);
  if (!email) return errorResponse("bad_request", "Invalid email address.");
  const id = newAccountId(),
    now = Date.now();
  const owner = body.externalOwner;
  const results = await env.DB.batch<{ accountId?: string; email?: string; id?: string }>([
    env.DB.prepare(
      `INSERT INTO accounts (id, email, created_at, plan, plan_checked_at)
      SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE email = ?)
        AND NOT EXISTS (SELECT 1 FROM owner_links WHERE external_owner = ?)
      ON CONFLICT(email) DO NOTHING`,
    ).bind(id, email, now, defaultPlan(env), now, email, owner),
    env.DB.prepare(
      `INSERT INTO owner_links (external_owner, account_id, created_at)
      SELECT ?, id, ? FROM accounts WHERE id = ? ON CONFLICT DO NOTHING`,
    ).bind(owner, now, id),
    env.DB.prepare(
      `SELECT account_id AS accountId,
      (SELECT email FROM accounts WHERE id = account_id) AS email
      FROM owner_links WHERE external_owner = ?`,
    ).bind(owner),
    env.DB.prepare("SELECT id FROM accounts WHERE email = ?").bind(email),
  ]);
  const linked = results[2]!.results[0];
  if (linked?.accountId === id)
    return Response.json(linked, { status: 201, headers: { "cache-control": "no-store" } });
  if (linked)
    return errorResponse("conflict", "This owner is already associated with another account.");
  if (results[3]!.results.length)
    return errorResponse(
      "email_taken",
      "An account already uses this address. Sign in to it, then link.",
    );
  return errorResponse("internal", "Could not create the linked account.");
}
