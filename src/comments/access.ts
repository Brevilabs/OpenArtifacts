/**
 * Who may do what with a document's comments, decided in the Worker.
 *
 * The rule (docs/comments.md, "Access"):
 *
 *   canComment = canRead
 *                AND the owner turned comments on
 *                AND the document's owner still has a plan with comments
 *                AND the principal is the owner, an invited account whose role
 *                    is `comment`, or, on an `anyone` document, anyone signed in.
 *
 * `canRead` and `canManage` are the existing predicates (`CAN_READ_SQL`,
 * `CAN_MANAGE_SQL`), read in the same statement as the rest
 * (`findCommentableDoc`); this file only assembles them. Nothing is allowed
 * that those predicates did not allow, and everything refused is `404`, never
 * `403` — except the two answers that are only ever given to someone who manages
 * the document and so reveal nothing about it: `comments_off` and the plan's
 * `402`.
 *
 * **Entitlement belongs to the document's owner, not to the writer.** Readers
 * and commenters never pay; a lapsed owner keeps the threads readable and stops
 * accepting new ones. It is read from what is stored (`ownerPlans`), so a write
 * costs one more D1 read and no license-server call.
 */
import { mayPublish, type Publisher } from "../auth.js";
import type { Env } from "../config.js";
import { findCommentableDoc, ownerPlans, type CommentableDoc } from "../db.js";
import { docNotFound, errorResponse } from "../errors.js";
import { isDocId } from "../ids.js";
import { configuredPlans, effectivePlan, limitReached, planLimits } from "../plans.js";
import type { AuthorKind } from "./object.js";

export const NO_STORE = { "cache-control": "no-store" };

/** The credential behind a request: a publisher record and what sort of author it writes as. */
export interface Caller {
  /** `owner` is the principal; `plan` is what the credential's own account holds. */
  publisher: Publisher;
  /**
   * The request's execution context: mail is sent on `ctx.waitUntil` so a write
   * is answered without waiting for it.
   */
  ctx: ExecutionContext;
  /** `human` for the Share token; `agent` for an account token or a license key. */
  kind: AuthorKind;
}

/** A readable, live document and the caller's standing on it. */
export interface Standing {
  doc: CommentableDoc;
  /**
   * Every id this principal's own comments may be stored under: its whole owner
   * scope. Authorship is "the author is in here", so a license key's comments
   * stay its own after the key is linked to an account.
   */
  scope: string[];
  canManage: boolean;
  /** The role (owner, invited `comment`, or signed in on a public page) allows writing, switch and plan aside. */
  mayWrite: boolean;
}

/**
 * The standing of `caller` (null for an anonymous reader) on `docId`, or null
 * when the answer is `404`: an unusable id, no such document, a deleted one, or one the caller cannot read.
 * `pinned` names the version the reads are for.
 */
export async function standingOn(
  env: Env,
  docId: string,
  caller: Caller | null,
  pinned: number | null = null,
): Promise<Standing | null> {
  if (!isDocId(docId)) return null;
  const principal = caller?.publisher.owner ?? "";
  const doc = await findCommentableDoc(env.DB, docId, principal, pinned);
  if (doc === null || doc.deleted_at !== null || !doc.allowed) return null;
  const canManage = doc.can_manage;
  const mayWrite = canManage || doc.invited_comment || (doc.link_access === "anyone" && principal !== "");
  return { doc, scope: doc.scope_ids, canManage, mayWrite };
}

/**
 * Whether the plans an owner holds include comments. A stored account plan
 * counts through `PLAN_LIMITS` (after its expiry, which falls back to the
 * default plan); a license key through `PUBLISHING_PLANS`. Any one qualifies,
 * since a linked key and its account are one owner.
 */
export async function ownerHasComments(env: Env, owner: string, now: number): Promise<boolean> {
  const plans = await ownerPlans(env.DB, owner);
  if (plans.licenses.some(mayPublish)) return true;
  const known = configuredPlans(env);
  return plans.accounts.some((held) => {
    const plan = effectivePlan(env, held.plan, held.expiresAt, now);
    return Object.hasOwn(known, plan) && planLimits(env, plan).comments === true;
  });
}

/** `canComment` in full, including the owner's plan, for a viewer flag. */
export async function viewerCanComment(env: Env, standing: Standing, now: number): Promise<boolean> {
  return (
    standing.doc.comments_enabled &&
    standing.mayWrite &&
    (await ownerHasComments(env, standing.doc.owner, now))
  );
}

/**
 * The answer for a document whose comments are off: `409 comments_off` to a
 * caller who manages it (they can fix it), `404` to everyone else.
 */
export function commentsOff(standing: Standing, docId: string): Response {
  return standing.canManage
    ? errorResponse("comments_off", "Comments are off for this document. Turn them on in Share.", NO_STORE)
    : docNotFound(docId);
}

/**
 * The `402` for an owner whose plan has no comments, shaped like the private
 * sharing refusal: an account gets the upgrade link, a license key a Copilot
 * message with nothing to buy here.
 */
export function commentsPlanRefusal(env: Env, publisher: Publisher): Response {
  return publisher.authKind === "account"
    ? limitReached(env, publisher, "comments", "Comments need a paid plan.")
    : errorResponse(
      "limit_reached",
      "Your Copilot plan does not include comments.",
      undefined,
      { plan: publisher.plan, limit: "comments" },
    );
}

/** The document's comments object. Callers have established that `env.COMMENTS` exists. */
export function commentsStub(env: Env, docId: string) {
  const namespace = env.COMMENTS!;
  return namespace.get(namespace.idFromName(docId));
}
