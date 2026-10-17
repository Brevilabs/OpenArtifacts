/**
 * Comment notifications, by email, best effort.
 *
 * A new thread goes to the document's owner (unless they wrote it). A reply or
 * a resolve goes to everyone who wrote in the thread — an agent's comments to
 * the account it acts for — minus whoever just acted. Reopening mails nobody.
 * The message names people by display name only, never by address. Recipients
 * are filtered to accounts that can read the document **now**: access is
 * revocable, and someone who was removed (or whose invite lapsed when the page
 * went back to invited-only) must not keep receiving the title, the quote and
 * other people's words.
 *
 * It sends only when Email Service is configured, bounded per document by
 * `COMMENT_EMAIL_LIMITER`, and **never fails or changes the request**: the
 * comment is already stored when this runs, so a refused, failed or throwing
 * send costs the recipient an email and nothing else. An address is looked up
 * only for an id that is an account; an owner id with no account (an unlinked
 * license key) has no mailbox and is skipped.
 */
import type { AnalyticsSink } from "../analytics.js";
import type { Env } from "../config.js";
import { accountEmails, readableAccounts, type CommentableDoc } from "../db.js";
import { commentMessage, sendEmail, type CommentEvent } from "../email.js";
import { sha256Hex } from "../hash.js";
import { withinLimit } from "../limits.js";
import { publicDocUrl } from "../urls.js";
import type { AuthorKind, ThreadRecord } from "./object.js";
import { labeller } from "./present.js";

export interface Notification {
  event: CommentEvent;
  docId: string;
  doc: CommentableDoc;
  /** Who acted, as comments store them: `principal` is the canonical account id. */
  actor: { principal: string; kind: AuthorKind };
  /** The thread as it stands after the action, anchored for `version`. */
  thread: ThreadRecord;
  /** The new comment's body; null for a resolve. */
  text: string | null;
  version: number;
}

/** The accounts a notification goes to, before the actor is removed. */
function audience(n: Notification): string[] {
  if (n.event === "thread") return [n.doc.owner_account];
  return n.thread.comments.map((c) => (c.author.kind === "agent" ? (c.author.onBehalfOf ?? c.author.principal) : c.author.principal));
}

export async function notifyComment(env: Env, requestUrl: URL, n: Notification, analytics: AnalyticsSink): Promise<void> {
  try {
    const recipients = [...new Set(audience(n))].filter((id) => id !== n.actor.principal);
    if (recipients.length === 0) return;
    const readers = await readableAccounts(env.DB, n.docId, recipients);
    const emails = await accountEmails(env.DB, recipients.filter((id) => readers.has(id)));
    let prepared: Promise<ReturnType<typeof commentMessage>> | undefined;
    const message = () => prepared ??= (async () => {
      const label = await labeller(env, n.doc.owner_account, [n.thread], [n.actor.principal]);
      const actor = label({
        principal: n.actor.principal,
        kind: n.actor.kind,
        onBehalfOf: n.actor.kind === "agent" ? n.actor.principal : null,
      });
      return commentMessage({
        event: n.event,
        actor: actor.name,
        title: n.doc.title,
        quote: n.thread.matchedText ?? n.thread.anchor.exact,
        text: n.text,
        url: publicDocUrl(env, requestUrl, n.docId),
        version: n.version,
      });
    })();
    // An unlinked license owner has no account, so the reader query omits it.
    // Log its skipped notification too, unless the doc was deleted.
    if (recipients.includes(n.doc.owner_account) && !emails.has(n.doc.owner_account) && await env.DB.prepare(
      "SELECT 1 FROM docs WHERE id = ? AND deleted_at IS NULL",
    ).bind(n.docId).first() !== null) {
      await sendEmail(env, analytics, { type: `comment_${n.event}`, docId: n.docId, to: null }, message);
    }
    const key = await sha256Hex(`comment-email:${n.docId}`);
    for (const to of emails.values()) {
      await sendEmail(env, analytics, { type: `comment_${n.event}`, docId: n.docId, to }, message,
        () => withinLimit(env.COMMENT_EMAIL_LIMITER, key));
    }
  } catch (error) {
    console.error("comment notification failed", { error: error instanceof Error ? error.name : "unknown" });
  }
}
