/**
 * The per-document token the Share popover and the comments frame hold
 * (`oas_…`, a signed `{a: accountId, d: docId}`, 24 hours), checked once for
 * every `/embed/api/…` route that takes it.
 *
 * Its own file so the two families of routes (the Share popover's access
 * routes in `embed.ts` and the comments routes in `comments/embed-api.ts`) share
 * one check and neither imports the other.
 */
import { parseBearerToken } from "./auth.js";
import type { Env } from "./config.js";
import { accountEmail } from "./db.js";
import { SHARE_TOKEN_PREFIX } from "./ids.js";
import { readerSecret } from "./reader-config.js";
import { verifyPayload } from "./session.js";

/** The account a valid token stands for, and the address it signed in with. */
export interface FrameIdentity {
  accountId: string;
  email: string;
}

/**
 * The identity behind the request's bearer token, or null when there is none to
 * trust: no header, another credential's prefix, a bad or expired signature, a
 * token minted for a different document, or an account that no longer exists.
 * Every failure is the same null, so a caller answers one `401`.
 *
 * `docId` is the document the route is about. It must equal the token's own
 * `d`, which is what keeps a token minted for one document useless on another's
 * routes. `null` accepts a token for any document, and only the display-name
 * route asks for that: it is about the account, not a document.
 */
export async function verifyFrameToken(
  request: Request,
  env: Env,
  docId: string | null,
  now: number,
): Promise<FrameIdentity | null> {
  const secret = readerSecret(env);
  if (secret === null) return null;
  const bearer = parseBearerToken(request.headers.get("authorization"));
  if (bearer === null || !bearer.startsWith(SHARE_TOKEN_PREFIX)) return null;
  const claims = await verifyPayload(secret, "share-token", bearer.slice(SHARE_TOKEN_PREFIX.length), now);
  if (typeof claims?.a !== "string" || claims.a === "" || (docId !== null && claims.d !== docId)) return null;
  const email = await accountEmail(env.DB, claims.a);
  return email === null ? null : { accountId: claims.a, email };
}
