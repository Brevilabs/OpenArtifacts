/**
 * The pages a reader sees on the API host while opening a private document.
 *
 * Kept apart from the routes (`reader.ts`) and from the OAuth callback
 * (`approval/handler.ts`), which both render them, so neither has to import the
 * other. Every value that came from a request is escaped here, at the one place
 * it enters markup.
 */
import { PROVIDER_ICONS, PROVIDER_LABELS, type ProviderId } from "./approval/providers.js";
import { POPUP_DONE_SCRIPT } from "./embed-scripts.js";
import { scriptHashSource } from "./hash.js";
import { ABOUT_LINK, brandPageHtml, escapeHtml, type BrandPage } from "./page.js";
import { EMBED_SIGNIN_PATH, HOME_PATH, OPEN_PREFIX, SHARE_PREFIX, SIGNIN_PREFIX } from "./paths.js";

/**
 * Whether a return path is one of the two ways an owner manages a document, the
 * share page and the popover's popup, which are signed in to for a different
 * reason than opening one.
 */
const isManagePath = (next: string): boolean =>
  next.startsWith(`${SHARE_PREFIX}/`) || next.startsWith(`${EMBED_SIGNIN_PATH}?`);

/**
 * These pages hold no script and load nothing, so the policy can be closed: no
 * framing (they carry buttons that sign someone in or out) and nothing fetched.
 */
export const READER_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'";

/**
 * A page on the API host. Its referrer policy is `same-origin`, not
 * `no-referrer`, on purpose: a form posted from a `no-referrer` page carries
 * `Origin: null`, and a browser without Fetch Metadata (Safari before 16.4) has
 * only `Origin` for `sameOriginPost` to fall back on. Same-origin keeps the real
 * `Origin` on these forms and still sends no `Referer` to any other origin.
 *
 * `csp` is for the one page that carries a script, the
 * share page's Copy button, which names that script's hash; every other page
 * keeps the closed policy.
 */
export function readerPage(copy: BrandPage, status: number, csp = READER_CSP): Response {
  return readerResponse(brandPageHtml(copy), status, csp);
}

/** `readerPage`'s headers around a page that is not the brand card, such as Home. */
export function readerResponse(html: string, status: number, csp = READER_CSP): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "content-security-policy": csp,
      "cross-origin-opener-policy": READER_OPENER_POLICY,
    },
  });
}

/** Every reader page and redirect on the API host: a popup loses its opener whatever /open decides, so `w.closed` tells an opener nothing. */
export const READER_OPENER_POLICY = "same-origin";
export function readerIsolate(response: Response): Response {
  const isolated = new Response(response.body, response);
  isolated.headers.set("cross-origin-opener-policy", READER_OPENER_POLICY);
  return isolated;
}

export const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

const TERMS_CONSENT = `<label class="newsletter terms-consent"><input type="checkbox" name="terms" value="yes" required> <span>I agree to the <a href="https://openartifacts.ai/terms">Terms</a>. This creates your free account.</span></label>`;

/** An email input in the code-box style would uppercase an address on screen. */
const EMAIL_FIELD_STYLE = "text-transform:none;letter-spacing:normal";

/**
 * The first screen for everyone who is not signed in. It names no address,
 * because nobody knows yet who holds the link, and it lists only the ways this
 * server can actually sign someone in. `next` decides which of the two it is:
 * a reader opening a document, or an owner managing one.
 */
export function signInPage(
  next: string,
  providers: ProviderId[],
  emailEnabled: boolean,
  note = "",
): Response {
  const manage = isManagePath(next);
  const home = next === HOME_PATH;
  const buttons = providers
    .map(
      (provider) =>
        `<button type="submit" formaction="${SIGNIN_PREFIX}/start/${provider}">${PROVIDER_ICONS[provider]}<span>Sign in with ${PROVIDER_LABELS[provider]}</span></button>`,
    )
    .join("\n");
  const social = providers.length
    ? `<form class="signup" method="post" action="${SIGNIN_PREFIX}/start/${providers[0]}">${hidden("next", next)}<div class="actions">${buttons}</div></form>`
    : "";
  const divider =
    providers.length > 0 && emailEnabled
      ? '<p class="terms divider">or</p>'
      : "";
  const email = emailEnabled
    ? `<form class="signup" method="post" action="${SIGNIN_PREFIX}/email">${hidden("next", next)}<div class="actions"><input type="email" name="email" placeholder="Email address" aria-label="Email address" autocomplete="email" style="${EMAIL_FIELD_STYLE}" required><button type="submit">Email me a code</button></div></form>`
    : "";
  const message = home
    ? "Sign in with the account that published your pages. New here? Signing in creates a free account."
    : manage
    ? "Sign in with the account that published it. New here? Signing in creates a free account."
    : "The owner shared it with specific people. Sign in with the address they invited. New here? Signing in creates a free account.";
  return readerPage(
    {
      title: home ? "Sign in to see your pages" : manage ? "Sign in to manage this document" : "Sign in or create an account",
      heading: home
        ? "Sign in to see your pages"
        : manage
        ? "Sign in to manage this document"
        : "Sign in or create an account to open this document",
      message: `${note ? `${escapeHtml(note)} ` : ""}${message}`,
      actions: social + divider + email,
    },
    200,
  );
}

/**
 * "We sent a code", the same page for every address that is a well-formed
 * email. Whether the address has an account, and whether a provider backs it,
 * is decided only after the code is entered and the mailbox is proved, so this
 * page tells whoever typed the address nothing about it.
 */
export function codePage(email: string, next: string, note = ""): Response {
  return readerPage(
    {
      title: "Check your email",
      heading: "Check your email.",
      message: `${note ? `${escapeHtml(note)} ` : ""}We sent a 6-digit code to <b><bdi>${escapeHtml(email)}</bdi></b>. It works for 10 minutes.`,
      actions: `<form class="signup" method="post" action="${SIGNIN_PREFIX}/code">${hidden("email", email)}${hidden("next", next)}<div class="actions"><input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="123456" aria-label="Sign-in code" required><button type="submit">Sign in</button></div></form>`,
    },
    200,
  );
}

/**
 * Where a proven address with no account accepts the Terms. `submit` names the
 * route and the one field that carries what proves the address: a provider
 * handshake's confirm token, or the signed token an emailed code earned. There
 * is no newsletter choice here; a reader is not asked to subscribe.
 */
export function termsPage(
  email: string,
  next: string,
  submit: { action: string; field: string; token: string },
): Response {
  const home = next === HOME_PATH;
  const purpose = isManagePath(next) ? "manage" : "open";
  return readerPage(
    {
      title: "Create your free account",
      heading: "Create your free account.",
      message: `Continue as <b><bdi>${escapeHtml(email)}</bdi></b> to ${home ? "see your pages" : `${purpose} this document`}.`,
      actions: `<form class="signup" method="post" action="${submit.action}">${hidden(submit.field, submit.token)}${hidden("next", next)}<p class="terms">See our <a href="https://openartifacts.ai/privacy">Privacy Policy</a>.</p>${TERMS_CONSENT}<div class="actions"><button type="submit">Create account and ${home ? "continue" : purpose}</button></div></form>`,
    },
    200,
  );
}

/**
 * "Use another account": sign out, then come back to `next` and sign in again.
 * Exported for the share page's reader view, which offers it beside the same
 * Copilot hint the popover shows.
 */
export const useAnotherAccount = (next: string) =>
  `<form method="post" action="${SIGNIN_PREFIX}/out">${hidden("next", next)}<button type="submit">Use another account</button></form>`;

/**
 * The page a signed-in reader gets for a document they cannot open. It is the
 * same page for a document they were never invited to, one they were removed
 * from, one that was deleted and one that never existed, so it cannot tell a
 * private document from no document. It carries no title and no content.
 *
 * **Request access** is a plain form post to `/open/{docId}/request`: the
 * address comes from the session, never from a field, and the route answers
 * every case alike. The share page shows this same page to a signed-in account
 * that neither manages the document nor may read it.
 */
export function notAvailablePage(email: string, docId: string, next: string): Response {
  return readerPage(
    {
      title: "Document unavailable",
      heading: `This document isn't available to <b><bdi>${escapeHtml(email)}</bdi></b>`,
      message:
        "If you were invited with another address, sign in with that address. Otherwise you can ask the owner.",
      actions: `<div class="actions"><form method="post" action="${OPEN_PREFIX}/${escapeHtml(docId)}/request"><button type="submit">Request access</button></form>${useAnotherAccount(next)}</div>`,
    },
    404,
  );
}

/**
 * What every request to open a document answers within the account's
 * allowance: stored, repeated, unknown id, deleted, public, already allowed,
 * over the cap. One status and one set of words, so the route reveals nothing
 * the not-available page does not. Only an account over its allowance, which
 * no document decides, is told the request was not sent. Without email on the
 * server the approval cannot be announced, so the page says what will happen
 * instead.
 */
export function requestSentPage(email: string, docId: string, emailEnabled: boolean, withinAllowance: boolean): Response {
  if (!withinAllowance) return readerPage({
    title: "Request not sent",
    heading: "Request not sent",
    message: "We couldn’t record your request. Wait a minute and try again, or ask the owner for the link.",
    actions: `<div class="actions"><a href="${OPEN_PREFIX}/${escapeHtml(docId)}">Try again</a></div>`,
  }, 200);
  const address = `<b><bdi>${escapeHtml(email)}</bdi></b>`;
  return readerPage(
    {
      title: "Request sent",
      heading: "Request sent",
      message: emailEnabled
        ? `The owner will decide. If they approve, you'll get an email at ${address} with the link.`
        : `The owner will decide. If they approve, the link will open for ${address}.`,
      actions: `<div class="actions">${useAnotherAccount(`${OPEN_PREFIX}/${docId}`)}</div>`,
    },
    200,
  );
}

/**
 * The popup refused: it was not opened by the Share frame. A person who got
 * here from a link or a page that is not ours is sent to the share page, which
 * does the same job at the top level. Browsers that send no Fetch Metadata land
 * here too, and keep the share page.
 */
export function popupRefusedPage(docId: string): Response {
  return readerPage(
    {
      title: "Sign-in didn’t start",
      heading: "Start from the page.",
      message: "Open this from Share on the document, or manage it on the share page.",
      actions: `<div class="actions"><a href="${SHARE_PREFIX}/${escapeHtml(docId)}">Open the share page</a></div>`,
    },
    400,
  );
}

/**
 * The popup's last page. The handoff row is already stored, which is what the
 * frame collects; this page also carries the token so a popup that still has its
 * opener can post it straight to the frame (`POPUP_DONE_SCRIPT`), then closes.
 *
 * The token sits in `data-` attributes of one element, escaped, and the one
 * inline script is a constant named by its hash, so the page's policy admits
 * that script and nothing else. The page is top-level and first-party, `no-store`
 * like every reader page, and nothing about the document decides what it says.
 */
export async function popupDonePage(docId: string, token: string, expiresAt: number): Promise<Response> {
  const hash = await scriptHashSource(POPUP_DONE_SCRIPT);
  return readerPage(
    {
      title: "Signed in",
      heading: "Signed in.",
      message: "You can close this window and go back to the document.",
      detail: `<div id="oa-done" hidden data-doc="${escapeHtml(docId)}" data-token="${escapeHtml(token)}" data-expires="${expiresAt}"></div>\n<script>${POPUP_DONE_SCRIPT}</script>`,
    },
    200,
    `${READER_CSP}; script-src ${hash}`,
  );
}

/**
 * Where "Try again" leads after a sign-in that did not finish. The share page
 * with no session shows a public document's visitor view, with no way to sign in,
 * so a retry that returned to it would look as though nothing happened; `?signin`
 * asks for the sign-in page. Other return paths are kept as they are.
 */
function retryHref(next: string): string {
  return next.startsWith(`${SHARE_PREFIX}/`) && !next.includes("?") ? `${next}?signin` : next;
}

/**
 * A reader's provider sign-in ended on an address that already belongs to
 * another sign-in with the same provider: the recycled-mailbox refusal. In the
 * reader's words, with a way back to the sign-in page.
 */
export function addressClaimedPage(provider: string, next: string): Response {
  const label = PROVIDER_LABELS[provider as ProviderId] ?? provider;
  return readerPage(
    {
      title: "Sign-in didn’t finish",
      heading: "That didn’t work.",
      message: `That address already belongs to another ${escapeHtml(label)} sign-in. Try your other provider.`,
      actions: `<div class="actions"><a href="${escapeHtml(retryHref(next))}">Try again</a></div>`,
    },
    409,
  );
}

/** A sign-in that did not finish. With `next` it offers to try again from there. */
export const SIGNIN_FAILED = (next?: string): Response =>
  readerPage(
    {
      title: "Sign-in didn’t finish",
      heading: "That didn’t work.",
      message: "Open the link you were sent again to sign in.",
      actions: next === undefined ? ABOUT_LINK : `<div class="actions"><a href="${escapeHtml(retryHref(next))}">Try again</a></div>`,
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
