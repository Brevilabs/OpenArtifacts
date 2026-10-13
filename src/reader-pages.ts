/**
 * The pages a reader sees on the API host while opening a private document.
 *
 * Kept apart from the routes (`reader.ts`) and from the OAuth callback
 * (`approval/handler.ts`), which both render them, so neither has to import the
 * other. Every value that came from a request is escaped here, at the one place
 * it enters markup.
 */
import { PROVIDER_ICONS, PROVIDER_LABELS, type ProviderId } from "./approval/providers.js";
import { ABOUT_LINK, brandPageHtml, escapeHtml, type BrandPage } from "./page.js";

export const SIGNIN_PREFIX = "/signin";

/**
 * These pages hold no script and load nothing, so the policy can be closed: no
 * framing (they carry buttons that sign someone in or out) and nothing fetched.
 */
const READER_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'";

export function readerPage(copy: BrandPage, status: number): Response {
  return new Response(brandPageHtml(copy), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": READER_CSP,
    },
  });
}

const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

const TERMS_CONSENT = `<label class="newsletter terms-consent"><input type="checkbox" name="terms" value="yes" required> <span>I agree to the <a href="https://openartifacts.ai/terms">Terms</a>. This creates your free account.</span></label>`;

/** An email input in the code-box style would uppercase an address on screen. */
const EMAIL_FIELD_STYLE = "text-transform:none;letter-spacing:normal";

export function signInPage(
  next: string,
  providers: ProviderId[],
  emailEnabled: boolean,
  note = "",
): Response {
  const buttons = providers
    .map(
      (provider) =>
        `<button type="submit" formaction="${SIGNIN_PREFIX}/start/${provider}">${PROVIDER_ICONS[provider]}<span>Sign in with ${PROVIDER_LABELS[provider]}</span></button>`,
    )
    .join("\n");
  const social = providers.length
    ? `<form class="signup" method="post" action="${SIGNIN_PREFIX}/start/${providers[0]}">${hidden("next", next)}<div class="actions">${buttons}</div></form>`
    : "";
  const email = emailEnabled
    ? `<form class="signup" method="post" action="${SIGNIN_PREFIX}/email">${hidden("next", next)}<div class="actions"><input type="email" name="email" placeholder="you@example.com" aria-label="Email address" autocomplete="email" style="${EMAIL_FIELD_STYLE}" required><button type="submit">Email me a code</button></div></form>`
    : "";
  return readerPage(
    {
      title: "Sign in to open this document",
      heading: "Sign in to open this document.",
      message: `${note ? `${escapeHtml(note)} ` : ""}Sign in with the address it was shared with.`,
      actions: social + email,
    },
    200,
  );
}

export function codePage(email: string, next: string, needsTerms: boolean, note = ""): Response {
  return readerPage(
    {
      title: "Check your email",
      heading: "Check your email.",
      message: `${note ? `${escapeHtml(note)} ` : ""}We sent a 6-digit code to <b><bdi>${escapeHtml(email)}</bdi></b>. It works for 10 minutes.`,
      actions: `<form class="signup" method="post" action="${SIGNIN_PREFIX}/code">${hidden("email", email)}${hidden("next", next)}${needsTerms ? TERMS_CONSENT : ""}<div class="actions"><input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="123456" aria-label="Sign-in code" required><button type="submit">Sign in</button></div></form>`,
    },
    200,
  );
}

/** A provider proved an address that has no account yet. */
export function termsPage(email: string, confirmToken: string, next: string): Response {
  return readerPage(
    {
      title: "Create your free account",
      heading: "Create your free account.",
      message: `Continue as <b><bdi>${escapeHtml(email)}</bdi></b> to open this document.`,
      actions: `<form class="signup" method="post" action="${SIGNIN_PREFIX}/confirm">${hidden("confirm_token", confirmToken)}${hidden("next", next)}${TERMS_CONSENT}<div class="actions"><button type="submit">Create account and open</button></div></form>`,
    },
    200,
  );
}

export function notAvailablePage(email: string, next: string): Response {
  return readerPage(
    {
      title: "Document unavailable",
      heading: "This document isn’t available.",
      message: `It isn’t shared with <b><bdi>${escapeHtml(email)}</bdi></b>, or it was removed. Sign in with another address to try again.`,
      actions: `<form method="post" action="${SIGNIN_PREFIX}/out">${hidden("next", next)}<div class="actions"><button type="submit">Use another account</button></div></form>`,
    },
    404,
  );
}

export const SIGNIN_FAILED = (): Response =>
  readerPage(
    {
      title: "Sign-in didn’t finish",
      heading: "That didn’t work.",
      message: "Open the link you were sent again to sign in.",
      actions: ABOUT_LINK,
    },
    400,
  );

export const TOO_MANY = (): Response =>
  readerPage(
    {
      title: "Too many tries",
      heading: "Wait a minute.",
      message: "Too many sign-in attempts. Wait a minute, then open the link again.",
      actions: ABOUT_LINK,
    },
    429,
  );

export const READER_UNAVAILABLE = (): Response =>
  readerPage(
    {
      title: "Private documents unavailable",
      heading: "Private documents aren’t set up here.",
      message: "This deployment cannot open private documents. Public documents are unaffected.",
      actions: ABOUT_LINK,
    },
    503,
  );

export const READER_NOT_FOUND = (): Response =>
  readerPage(
    {
      title: "Page unavailable",
      heading: "There’s nothing here.",
      message: "Check the address you were sent and open it again.",
      actions: ABOUT_LINK,
    },
    404,
  );
