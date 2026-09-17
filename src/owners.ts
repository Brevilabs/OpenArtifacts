/**
 * Document ownership can join two proven identities without moving their rows.
 * Keep credential identity separate: these aliases never authorize token access.
 */
import { ACCOUNT_ID_PREFIX } from "./ids.js";

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
 * The canonical account for the authenticated owner, for a statement already
 * prefixed with `OWNER_SCOPE_SQL`.
 *
 * Authentication returns the external id for a license key and the local `oa_`
 * id for an account token, deliberately: a credential names a credential. Once
 * those two are linked they are nonetheless one publisher, and `owner_scope`
 * already spends a statement working out which. Returning it costs nothing
 * where it is already computed, so anything that has to name the human rather
 * than the credential — an analytics `distinct_id`, say — can have the same
 * answer the ownership check just used, from the same read.
 *
 * It is a `RETURNING` expression and not a query of its own on purpose. A
 * second lookup could disagree with the statement it accompanies, and would
 * have its own failure mode on a path where the write has already succeeded.
 */
export const CANONICAL_OWNER_SQL = "(SELECT id FROM canonical)";

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
    externalOwner.trim() !== externalOwner || externalOwner.length === 0 ||
    /[\u0000-\u0020\u007f]/.test(externalOwner) ||
    externalOwner.length > 256 || externalOwner.startsWith(ACCOUNT_ID_PREFIX) ||
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
