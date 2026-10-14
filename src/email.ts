/**
 * The two emails private sharing sends: an invite, and a sign-in code.
 *
 * Both go through the Cloudflare Email Service binding from a dedicated
 * sending subdomain, so abuse cannot touch the brand domain's mail reputation.
 * The binding is optional like the OAuth secrets: without it nothing is sent,
 * the code form is not offered, and Google and GitHub sign-in still work.
 */
import type { Env } from "./config.js";
import { escapeHtml } from "./page.js";

export function emailConfigured(env: Env): boolean {
  return env.EMAIL !== undefined && Boolean(env.EMAIL_FROM?.trim());
}

/** True when the message was handed to Email Service. Never throws. */
export async function sendEmail(
  env: Env,
  to: string,
  message: { subject: string; text: string; html: string },
): Promise<boolean> {
  if (env.EMAIL === undefined || !env.EMAIL_FROM?.trim()) return false;
  try {
    await env.EMAIL.send({ from: { email: env.EMAIL_FROM.trim(), name: "OpenArtifacts" }, to, ...message });
    return true;
  } catch (error) {
    // Name only. The message can quote the recipient, and a log is read far more
    // casually than the table the address came from.
    console.error("email delivery failed", { error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
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
 * is how the requester learns the answer.
 */
export function inviteMessage(sharer: string | null, title: string, url: string, recipient: string) {
  const name = oneLine(title);
  const by = sharer === null ? [] : [`Shared by ${sharer}`];
  const signIn = `Sign in with this address, ${recipient}, to open it.`;
  const ignore = "If you were not expecting this, ignore this email.";
  return {
    subject: `\u201c${name}\u201d was shared with you`,
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
