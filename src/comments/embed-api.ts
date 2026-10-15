/**
 * The comments frame's JSON, behind the same per-document token as the Share
 * popover (`oas_…`, `src/frame-token.ts`). Human-facing and not part of the
 * frozen client contract.
 *
 * ```
 * GET    /embed/api/docs/{docId}/threads?state=&since=&v=     (the token is optional)
 * POST   /embed/api/docs/{docId}/threads
 * POST   /embed/api/docs/{docId}/threads/{threadId}/comments | resolve | reopen
 * DELETE /embed/api/docs/{docId}/comments/{commentId}
 * PUT    /embed/api/docs/{docId}/settings                      (the Share popover's switch)
 * PUT    /embed/api/account                                    (the display name)
 * ```
 *
 * They run the same functions as `/api/v1` (`routes.ts`, `service.ts`) with the
 * token's account as the principal and `kind: "human"`: the frame is a person,
 * where an account token or a license key is an agent. **The token must name the
 * route's document**, so one minted for A is `401` on B; the account route is
 * about the person and takes a token for any document.
 *
 * Listing works without a token too, as the anonymous reader: the same answer
 * the serving origin gives, and `404` for a document only an invited person can
 * read. A token that is present but wrong is `401`, never quietly anonymous,
 * so the frame clears it and signs in again.
 *
 * No CORS, ever (the frame's calls are same-origin), and no CSRF surface: the
 * credential is a header, never a cookie.
 */
import type { Publisher } from "../auth.js";
import type { Env } from "../config.js";
import { accountPlan } from "../entitlement.js";
import { errorResponse } from "../errors.js";
import { verifyFrameToken } from "../frame-token.js";
import { isDocId } from "../ids.js";
import { EMBED_API_PREFIX } from "../reader-pages.js";
import { readerSecret } from "../reader-config.js";
import { NO_STORE, type Caller } from "./access.js";
import { commentRoute } from "./routes.js";
import { listThreads, setName } from "./service.js";

/** The response for a route this family owns, or null when `url` is not one of them. */
export async function handleCommentsEmbed(
  request: Request,
  url: URL,
  env: Env,
  now: number,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const [first, docId, ...extra] = url.pathname.slice(EMBED_API_PREFIX.length + 1).split("/");
  const account = first === "account" && docId === undefined;
  const comments = first === "docs" && docId !== undefined && isDocId(docId) &&
    (extra[0] === "threads" || extra[0] === "comments" || extra[0] === "settings");
  if (!account && !comments) return null;
  if (readerSecret(env) === null || env.COMMENTS === undefined) return errorResponse("not_found", "No route.", NO_STORE);

  const anonymousList = comments && request.method === "GET" && extra[0] === "threads" && extra.length === 1 &&
    !request.headers.has("authorization");
  if (anonymousList) return await listThreads(env, url, null, docId!);

  const identity = await verifyFrameToken(request, env, account ? null : docId!, now);
  if (identity === null) return errorResponse("unauthorized", "Sign in again to comment.", NO_STORE);
  if (account) {
    return request.method === "PUT"
      ? await setName(request, env, identity.accountId)
      : errorResponse("not_found", "No route.", NO_STORE);
  }

  // The token's account as a publisher, as the Share popover builds it. The plan is read fresh only for
  // the owner's switch, the one write that spends it; reading and commenting never touch the license server.
  const publisher: Publisher = {
    owner: identity.accountId,
    plan: (await accountPlan(env, identity.accountId, { skipAccountRefresh: extra[0] !== "settings" })).plan,
    authKind: "account",
  };
  const caller: Caller = { publisher, kind: "human", ctx };
  return (await commentRoute(request, url, env, caller, docId!, extra)) ?? errorResponse("not_found", "No route.", NO_STORE);
}
