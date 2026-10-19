/**
 * Sharing, sign-in and comment emails, with one recorded outcome per recipient.
 *
 * All go through the Cloudflare Email Service binding from a dedicated
 * sending subdomain, so abuse cannot touch the brand domain's mail reputation.
 * The binding is optional like the OAuth secrets: without it nothing is sent,
 * the code form is not offered, and Google and GitHub sign-in still work.
 */
import type { AnalyticsSink } from "./analytics.js";
import { documentAnalyticsKey } from "./analytics.js";
import type { Env } from "./config.js";
import { macHex } from "./session.js";
import { escapeHtml } from "./page.js";
import { roleAtLeast, type InviteRole } from "./roles.js";

export function emailConfigured(env: Env): boolean {
  return env.EMAIL !== undefined && Boolean(env.EMAIL_FROM?.trim());
}

export type EmailType = "invite" | "access_request" | "signin_code" | "comment_thread" | "comment_reply" | "comment_resolved";
export type EmailOutcome = "sent" | "failed" | "skipped_limit" | "skipped_no_owner_email";
export type EmailReason = "accepted" | "no_owner_email" | "not_configured" | "preparation_failed" | "sending_limit" | "send_failed";
export type EmailMessage = { subject: string; text: string; html: string };

/** Same folding as accounts and invites; no provider-specific dot or plus folding. */
export async function emailRecipientHash(secret: string, address: string): Promise<string> {
  return `email_v1_${await macHex(secret, "email-recipient-v1", address.trim().toLowerCase())}`;
}

/**
 * One decision, one structured log and one analytics record per intended email.
 * Preparation and the limiter run here too, so a failure cannot disappear before
 * reaching the sender. No message, address, code or exception text enters telemetry.
 * `sent` means accepted by Email Service, not delivered to an inbox.
 */
export async function sendEmail(
  env: Env,
  analytics: AnalyticsSink,
  context: { type: EmailType; docId: string | null; to: string | null | (() => Promise<string | null>) },
  message: () => EmailMessage | Promise<EmailMessage>,
  allowed?: () => Promise<boolean>,
): Promise<EmailOutcome> {
  let outcome: EmailOutcome = "failed";
  let reason: EmailReason = "preparation_failed";
  let to: string | null = null;
  try {
    to = typeof context.to === "function" ? await context.to() : context.to;
    reason = "not_configured";
    if (to === null) {
      outcome = "skipped_no_owner_email";
      reason = "no_owner_email";
    } else if (emailConfigured(env)) {
      reason = "preparation_failed";
      if (allowed !== undefined && !(await allowed())) {
        outcome = "skipped_limit";
        reason = "sending_limit";
      } else {
        const prepared = await message();
        reason = "send_failed";
        await env.EMAIL!.send({ from: { email: env.EMAIL_FROM!.trim(), name: "OpenArtifacts" }, to, ...prepared });
        outcome = "sent";
        reason = "accepted";
      }
    }
  } catch {
    // Only the fixed reason above is safe: sender errors may quote addresses or content.
  }
  await recordEmailDelivery(env, analytics, { ...context, to }, outcome, reason);
  return outcome;
}

/** Also used when sign-in refuses a code before reaching the sender. */
export async function recordEmailDelivery(
  env: Env,
  analytics: AnalyticsSink,
  context: { type: EmailType; docId: string | null; to: string | null },
  outcome: EmailOutcome,
  reason: EmailReason,
): Promise<void> {
  const secret = env.READER_SESSION_SECRET?.trim();
  const recipientHash = context.to === null || !secret ? null : await emailRecipientHash(secret, context.to);
  const atMs = Date.now();
  console.info("email delivery", {
    email_type: context.type,
    document_key: context.docId === null ? "no_document" : await documentAnalyticsKey(context.docId),
    recipient_hash: recipientHash,
    outcome,
    reason,
    at_ms: atMs,
  });
  analytics.record({ name: "email_delivery", docId: context.docId, atMs, emailType: context.type, recipientHash, outcome, reason });
}

/** A title is publisher-supplied text headed for a mail header: one short line. */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 100);
}

export function codeMessage(code: string) {
  return {
    subject: `${code} is your OpenArtifacts sign-in code`,
    text: `Your OpenArtifacts sign-in code is ${code}.\n\nIt works for 10 minutes. If you did not ask for it, ignore this email.`,
    html: `<p>Your OpenArtifacts sign-in code is <b>${code}</b>.</p><p>It works for 10 minutes. If you did not ask for it, ignore this email.</p>`,
  };
}

/**
 * The invite: the title, who shared it when the Worker knows, the canonical
 * link and the address to sign in with. `sharer` is the owner's account address,
 * or null for an owner the Worker has no address for, in which case the line is
 * left out rather than naming "someone". The link is always the sacrificial
 * domain's, never a grant. An approved request sends this same message, which
 * is how the requester learns the answer. The wording follows the role, not the
 * page's mode: at `comment` or above it invites the person to comment, at `view`
 * it says the document was shared.
 */
export function inviteMessage(
  sharer: string | null,
  title: string,
  url: string,
  recipient: string,
  role: InviteRole,
) {
  const name = oneLine(title);
  const comments = roleAtLeast(role, "comment");
  const by = sharer === null ? [] : [`Shared by ${sharer}`];
  const signIn = `Sign in with this address, ${recipient}, to ${comments ? "comment" : "open it"}.`;
  const ignore = "If you were not expecting this, ignore this email.";
  return {
    subject: comments
      ? `${sharer === null ? "You were invited" : `${oneLine(sharer)} invited you`} to comment on \u201c${name}\u201d`
      : `\u201c${name}\u201d was shared with you`,
    text: [name, ...by, `Open document: ${url}`, signIn, ignore].join("\n\n"),
    html: [
      `<p><b>${escapeHtml(name)}</b></p>`,
      ...by.map((line) => `<p>${escapeHtml(line)}</p>`),
      `<p><a href="${escapeHtml(url)}">Open document</a></p>`,
      `<p>${escapeHtml(signIn)}</p>`,
      `<p>${ignore}</p>`,
    ].join(""),
  };
}

/**
 * Tells an owner that `requesterAddress` asked to open `title`: the requester's
 * address, the title, that nothing has been shared yet, and one link to the
 * share page, where the owner approves or declines behind their own session.
 *
 * The link carries no token and no grant, so forwarding this email approves
 * nothing, and it is the only link in the message: never a requester-chosen url.
 * `shareUrl` is built by the caller from the API host and the document id. The
 * requester's address is the signed-in account's own, never typed text, and it
 * is the only thing about the requester the owner learns.
 */
export function requestMessage(requesterAddress: string, title: string, shareUrl: string) {
  const name = oneLine(title);
  const requester = oneLine(requesterAddress);
  const nothing = "Nothing has been shared yet.";
  const copilot = "Or open the note in Copilot and run Publish file to OpenArtifacts.";
  return {
    subject: `${requester} asked to open "${name}"`,
    text: [
      `${requester} asked to open "${name}".`,
      nothing,
      `Review request: ${shareUrl}`,
      copilot,
    ].join("\n\n"),
    html: [
      `<p><b>${escapeHtml(requester)}</b> asked to open <b>${escapeHtml(name)}</b>.</p>`,
      `<p>${nothing}</p>`,
      `<p><a href="${escapeHtml(shareUrl)}">Review request</a></p>`,
      `<p>${copilot}</p>`,
    ].join(""),
  };
}

/** What a comment notification is about. */
export type CommentEvent = "thread" | "reply" | "resolved";

/**
 * The note a comment sends: a new thread to the document's owner, a reply or a
 * resolve to everyone who wrote in the thread. `actor` is a display name, the
 * only thing the recipient learns about who wrote it: never anyone's address.
 * `quote` is the passage the thread sits on and `text` the comment (null for a
 * resolve, which says so instead). Both are other people's words, so they reach
 * the text part as plain text and the HTML part escaped, trimmed to a length an
 * inbox can hold; the one link is the document's canonical page.
 */
export function commentMessage(args: {
  event: CommentEvent;
  actor: string;
  title: string;
  quote: string;
  text: string | null;
  url: string;
  version: number;
}) {
  const title = oneLine(args.title);
  const actor = oneLine(args.actor);
  const quote = args.quote.length > 300 ? `${args.quote.slice(0, 300)}…` : args.quote;
  const text = args.text === null ? null : args.text.length > 2000 ? `${args.text.slice(0, 2000)}…` : args.text;
  const headline =
    args.event === "thread"
      ? `${actor} commented on "${title}"`
      : args.event === "reply"
        ? `${actor} replied on "${title}"`
        : `${actor} resolved a comment on "${title}" in version ${args.version}`;
  const ignore = "You are receiving this because you wrote on this thread or own the document.";
  return {
    subject: headline,
    text: [
      headline,
      `On: “${quote}”`,
      ...(text === null ? [] : [text]),
      `Open document: ${args.url}`,
      ignore,
    ].join("\n\n"),
    html: [
      `<p><b>${escapeHtml(headline)}</b></p>`,
      `<blockquote>${escapeHtml(quote)}</blockquote>`,
      ...(text === null ? [] : [`<p style="white-space:pre-wrap">${escapeHtml(text)}</p>`]),
      `<p><a href="${escapeHtml(args.url)}">Open document</a></p>`,
      `<p>${ignore}</p>`,
    ].join(""),
  };
}
