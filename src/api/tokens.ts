/**
 * Tokens: `GET /api/v1/tokens` lists the credentials an account has issued to
 * its machines, `DELETE /api/v1/tokens/{tokenId}` withdraws one.
 *
 * These two calls are the entire account-management surface, because there is
 * no dashboard and no session to hang one on. Someone who suspects a laptop is
 * gone asks their agent to list their tokens, reads the labels its machines
 * chose for themselves, and revokes the one that should not exist any more.
 *
 * **A value never appears here.** The list reports ids, labels and times; only
 * hashes are stored, so there is nothing else it could report even if it wanted
 * to. A token that has been lost is replaced by approving again.
 *
 * Both work with any live token on the account, and with a license key too —
 * ownership is per account, not per credential, exactly as it is for documents.
 * A license key's account can hold no tokens, so it sees an empty list, which
 * is the honest answer rather than a special case.
 */
import type { Publisher } from "../auth.js";
import type { Env } from "../config.js";
import { MAX_TOKENS_LISTED } from "../config.js";
import { countLiveTokens, listAccountTokens, revokeAccountToken } from "../db.js";
import { errorResponse } from "../errors.js";
import { isTokenId } from "../ids.js";

/** One token as the list reports it. Times are epoch ms, like everywhere here. */
interface ListedToken {
  tokenId: string;
  /** What the machine called itself when it asked for the code, or null. */
  label: string | null;
  createdAt: number;
  /**
   * Last request this token authenticated, to an hour's resolution, and null
   * for a token that has never been used. Coarse on purpose: refreshing it on
   * every request would put a write behind every read, and the question it
   * answers — which of my machines is still using this — does not need minutes.
   */
  lastUsedAt: number | null;
}

interface TokenListResponse {
  tokens: ListedToken[];
}

/** What a revoke tells the caller, which is mostly about what is left. */
interface RevokedToken {
  tokenId: string;
  /**
   * Live tokens the account still holds. Zero is allowed and is the point of
   * reporting it: revoking your last token is a legitimate thing to do, and the
   * client should be able to say that the next command will need a fresh
   * browser approval rather than discovering it as a `401`.
   */
  remaining: number;
}

/** `GET /api/v1/tokens` — the live tokens this account has issued, newest first. */
export async function listTokens(env: Env, publisher: Publisher): Promise<Response> {
  const rows = await listAccountTokens(env.DB, publisher.owner, MAX_TOKENS_LISTED);

  const body: TokenListResponse = {
    tokens: rows.map((row) => ({
      tokenId: row.id,
      label: row.label,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    })),
  };
  return Response.json(body);
}

/**
 * `DELETE /api/v1/tokens/{tokenId}` — withdraw one token.
 *
 * A body rather than the `204` a document delete gives, because the caller has
 * to know what it has left: the same call can leave an account with three
 * working machines or with none, and only one of those needs the person told.
 *
 * Revoking the token making the request is allowed and succeeds — this request
 * has already authenticated, and the next one will not.
 */
export async function revokeToken(
  env: Env,
  publisher: Publisher,
  tokenId: string,
): Promise<Response> {
  // An id that cannot exist is answered without touching D1.
  if (!isTokenId(tokenId)) return tokenNotFound(tokenId);

  if (!(await revokeAccountToken(env.DB, tokenId, publisher.owner, Date.now()))) {
    return tokenNotFound(tokenId);
  }

  const body: RevokedToken = {
    tokenId,
    remaining: await countLiveTokens(env.DB, publisher.owner),
  };
  return Response.json(body);
}

/**
 * The one answer for a token that does not exist, is not the caller's, or was
 * already revoked.
 *
 * The same rule the documents follow, for the same reason: a `403` on another
 * account's token would confirm that the id is real, and an id that can be
 * confirmed is an id worth probing. Identical wording across all three causes
 * is the property, so this exists once rather than at each call site.
 */
function tokenNotFound(tokenId: string): Response {
  return errorResponse("not_found", `No token with id ${tokenId}.`);
}
