/**
 * The approval page: the only place a human ever interacts with OpenArtifacts,
 * and the only way an account comes into existence.
 *
 * There is no sign-up form, no sign-in page and no session. A CLI prints a url
 * carrying the user code it is waiting on, the person opens it, proves
 * an email with Google or GitHub, and presses a button to approve. The first
 * approval an address makes is the registration; every one after it finds the
 * same account. When the page is done, nothing about the browser is remembered
 * — the token the CLI receives is the credential from then on, which is why
 * there is nothing here for a session to be for.
 *
 * **Proving who you are and approving a terminal are two steps, and the second
 * is a `POST` a person presses.** RFC 8628 §5.4 is the reason. A provider's
 * redirect back is a `GET` that a link can cause, and someone already signed in
 * to that provider is carried straight through it with no prompt — so if the
 * redirect completed the approval, sending a victim a link would be enough to
 * attach an attacker's terminal to their account. Nothing this page does on a
 * `GET` changes what a device code is worth.
 *
 * **It sets no cookie, on any surface.** The handshake's `state` and PKCE
 * verifier live in the device code's own row, because the browser is not the
 * thing being authorized and has nothing to remember between the three
 * requests. That keeps the serving origin's cookieless promise an absolute
 * rather than a host-by-host argument, which matters because publishers' own
 * scripts run there.
 *
 * Every outcome is an HTML page, including the failures. The caller here is a
 * browser with a person behind it, not a client matching on an error code, so
 * `docs/http-api.md`'s JSON envelope would be the wrong answer to give them.
 */
import { type Env } from "../config.js";
import {
  confirmDeviceApproval,
  denyDeviceApproval,
  deviceCodeIsPending,
  findPendingHandshake,
  holdProvenIdentity,
  resolveAccountForIdentity,
  startDeviceHandshake,
} from "../db.js";
import { newAccountId, newHandshakeToken } from "../ids.js";
import { isTopLevelRequest, withinClientLimit } from "../limits.js";
import { readBodyWithin } from "../quota.js";
import { ABOUT_LINK, brandPageHtml, escapeHtml, type BrandPage } from "../page.js";
import {
  approvalIsConfigured,
  arcticOAuthClient,
  configuredProviders,
  normalizeEmail,
  PROVIDER_LABELS,
  type OAuthClient,
  type ProviderId,
} from "./providers.js";

/** Path prefix of the approval surface, used by the router on the API host. */
export const APPROVAL_PREFIX = "/approve";

/** The query parameter carrying the device code the CLI is waiting on. */
export const USER_CODE_PARAM = "user_code";

/**
 * The hidden field on the confirm form.
 *
 * Deliberately not `state`. `state` is handed to whoever *starts* a handshake,
 * so an attacker who starts one on their own code knows it, and could then send
 * the provider's url to a signed-in victim and approve their own code as them.
 * This token is minted only once an identity is proved and appears only in the
 * page the returning browser receives.
 */
const CONFIRM_TOKEN_FIELD = "confirm_token";

/** The words the confirmation page uses when the terminal named itself nothing. */
const UNNAMED_DEVICE = "that terminal";

/**
 * A device code as it may appear in a url.
 *
 * Deliberately a shape rather than a format. `newUserCode` decides the length
 * and the grouping, and this only has to exclude what cannot be a code at all,
 * so changing the format there does not strand links already printed. Upper
 * case and dashes are what RFC 8628 codes look like when a person reads one off
 * a terminal onto a phone.
 */
const USER_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,63}$/;

/**
 * Ceiling on a submitted form.
 *
 * Both `POST` routes are unauthenticated, and `formData()` buffers whatever
 * arrives before this page can read the one short field it wants — so without a
 * bound, anyone who can reach the approval host can make the Worker hold an
 * arbitrary body. A device code and a confirm token are under a hundred bytes
 * together; a kilobyte is room for a form this page will never grow into.
 */
const MAX_FORM_BYTES = 1024;

/** The only encoding this page's own forms ever send. */
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

export interface ApprovalDeps {
  now?: () => number;
  /** Injected by tests, since arctic's handshake reaches the network. */
  oauth?: OAuthClient;
  /**
   * Injected by tests that need a limiter a deployment has not declared, or a
   * verdict they choose. Production reads `env.APPROVAL_LOOKUP_LIMITER`.
   */
  limiter?: RateLimit;
}

/**
 * Fold a device code to the form the database stores, or null when the value
 * cannot be one.
 *
 * Case-folding is what lets someone read a code off one screen and type it into
 * another, which RFC 8628 expects of a user code and is the reason the flow
 * works from a phone.
 */
export function normalizeUserCode(raw: string | null): string | null {
  if (raw === null) return null;
  const code = raw.trim().toUpperCase();
  return USER_CODE_PATTERN.test(code) ? code : null;
}

/**
 * The four routes, and the one method each answers to:
 *
 * ```
 * GET  /approve                      the page that asks for a code
 * GET  /approve?user_code=…          the page that offers the providers
 * POST /approve/start/{provider}     redirects to the provider
 * GET  /approve/callback/{provider}  where the provider redirects back
 * POST /approve/confirm              the press that approves the code
 * POST /approve/deny                 the press that refuses it
 * ```
 *
 * The methods are the design rather than a convention. Only the three `POST`s
 * change what a device code is worth, and none can be caused by a link.
 *
 * @param url the request url, whose origin is also the redirect uri the
 *   providers are registered against — the router has already refused every
 *   host but the configured API one, so it is the deployment's own name rather
 *   than something a caller chose
 */
export async function handleApproval(
  request: Request,
  url: URL,
  env: Env,
  deps: ApprovalDeps = {},
): Promise<Response> {
  const [section, provider, ...extra] = url.pathname
    .slice(APPROVAL_PREFIX.length)
    .split("/")
    .filter(Boolean);

  try {
    if (section === undefined && request.method === "GET") {
      return await chooser(request, url, env, deps);
    }
    if (section === "confirm" && provider === undefined && request.method === "POST") {
      return await confirm(request, env, deps);
    }
    if (section === "deny" && provider === undefined && request.method === "POST") {
      return await deny(request, env, deps);
    }
    if (extra.length === 0 && provider !== undefined) {
      if (section === "start" && request.method === "POST") {
        return await begin(request, url, env, provider, deps);
      }
      if (section === "callback" && request.method === "GET") {
        return await prove(url, env, provider, deps);
      }
    }
    return page(NOT_FOUND, 404);
  } catch (error) {
    // The router's catch would answer this with the API's JSON envelope, which
    // is the wrong thing to hand a browser. Logged rather than shown: a failed
    // handshake's message can quote a provider response.
    console.error("approval failed", { path: url.pathname, error });
    return page(BROKEN, 500);
  }
}

/**
 * The page that offers the providers, once the code is known to be waiting —
 * and, with no code on the url, the page that asks for one.
 *
 * Arriving without a code is the ordinary manual path rather than a mistake.
 * The mint returns a bare `verification_uri` alongside the one with the code
 * already in it, precisely so a person can read a short address off a terminal
 * and type it into a phone; that address has to lead somewhere they can enter
 * the code they are looking at, or the manual half of RFC 8628 is advertised
 * and then unusable.
 *
 * The form is a `GET`, because submitting it only navigates to this same page
 * with the code on the url. The two `POST`s either side of it are the ones that
 * change what a code is worth, and they stay exactly as they are.
 */
async function chooser(
  request: Request,
  url: URL,
  env: Env,
  deps: ApprovalDeps,
): Promise<Response> {
  if (!approvalIsConfigured(env)) return page(NOT_CONFIGURED, 503);

  const submitted = url.searchParams.get(USER_CODE_PARAM);
  if (submitted === null || submitted.trim() === "") return codeEntry(200);

  const userCode = normalizeUserCode(submitted);
  if (userCode === null) return codeEntry(400, "That does not look like a code.");

  // Gated before the limiter, not after. This route is a plain `GET`, so a
  // hostile page can make a visitor's browser send it from their address with
  // an `<img>` — and if that were counted, twenty of them would spend the
  // visitor's allowance and their own approval would come back as `CODE_GONE`.
  // Refusing a subresource first means only requests the visitor made are
  // charged to them.
  if (!isTopLevelRequest(request)) return page(CODE_GONE, 404);

  // Counted before the row is read, so a client working through the code space
  // is stopped by the limit rather than by how many rows it can afford to
  // read. `CODE_GONE` on refusal, because a throttle and a miss have to look
  // the same: telling them apart would turn the limit into an oracle for which
  // codes are real (https://github.com/Brevilabs/OpenArtifacts/pull/62#discussion_r3928334751).
  const limiter = deps.limiter ?? env.APPROVAL_LOOKUP_LIMITER;
  if (!(await withinClientLimit(limiter, request))) return page(CODE_GONE, 404);

  const now = (deps.now ?? Date.now)();
  // Checked before the providers are offered rather than after the handshake,
  // so a stale link costs a page rather than a trip through Google. Telling a
  // visitor that a code is or is not pending is not the leak the doc ids' 404
  // rule guards against: a user code is short and meant to be read aloud, and
  // RFC 8628 expects the page to say when one is wrong. What it protects is the
  // approval itself, which no amount of knowing a code performs.
  if (!(await deviceCodeIsPending(env.DB, userCode, now))) return page(CODE_GONE, 404);

  // Forms rather than links, so no url can start a handshake. Starting one
  // approves nothing by itself, but a link that carries a signed-in visitor
  // through their provider and lands them on a confirmation they never asked
  // for is the first half of the attack the confirm step exists to stop, and
  // there is no reason to leave it lying around.
  const buttons = configuredProviders(env)
    .map((provider) =>
      form(
        `${APPROVAL_PREFIX}/start/${provider}`,
        { [USER_CODE_PARAM]: userCode },
        `Continue with ${PROVIDER_LABELS[provider]}`,
      ),
    )
    .join("\n    ");

  return page({ ...CHOOSE, detail: codeDetail(userCode), actions: actions(buttons) }, 200);
}

/** Start a handshake: mint its state and verifier, and record them on the code. */
async function begin(
  request: Request,
  url: URL,
  env: Env,
  provider: string,
  deps: ApprovalDeps,
): Promise<Response> {
  if (!approvalIsConfigured(env)) return page(NOT_CONFIGURED, 503);

  const chosen = configuredProviders(env).find((id) => id === provider);
  if (chosen === undefined) return page(NOT_FOUND, 404);

  const submitted = await readSmallForm(request);
  if (submitted === null) return page(NOT_FOUND, 404);

  const userCode = normalizeUserCode(submitted.get(USER_CODE_PARAM));
  if (userCode === null) return codeEntry(400, "That does not look like a code.");

  // Gated and counted with the chooser's lookups, for the same two reasons:
  // this route also says whether a code is live, and it writes when it is.
  if (!isTopLevelRequest(request)) return page(CODE_GONE, 404);

  const limiter = deps.limiter ?? env.APPROVAL_LOOKUP_LIMITER;
  if (!(await withinClientLimit(limiter, request))) return page(CODE_GONE, 404);

  const now = (deps.now ?? Date.now)();
  const state = newHandshakeToken();
  const verifier = newHandshakeToken();
  if (!(await startDeviceHandshake(env.DB, userCode, chosen, state, verifier, now))) {
    return page(CODE_GONE, 404);
  }

  const oauth = deps.oauth ?? arcticOAuthClient(env);
  const target = oauth.authorizationUrl(chosen, redirectUri(url, chosen), state, verifier);

  // 303, so the browser follows with a `GET`. After a `POST`, a 302 leaves the
  // method to the browser, and the provider has no use for a re-posted body.
  return new Response(null, {
    status: 303,
    headers: { location: target.toString(), "cache-control": "no-store" },
  });
}

/**
 * The provider's redirect back, where the email is proved and the account is
 * created — and where nothing is approved.
 *
 * The `state` is the only thing this request carries that this page put there,
 * so it is what the handshake is looked up by. The device code and the provider
 * come out of that row rather than off the url, so neither can be swapped by
 * whoever follows the link.
 */
async function prove(
  url: URL,
  env: Env,
  provider: string,
  deps: ApprovalDeps,
): Promise<Response> {
  if (!approvalIsConfigured(env)) return page(NOT_CONFIGURED, 503);

  const now = (deps.now ?? Date.now)();
  const state = url.searchParams.get("state");
  const handshake = state === null ? null : await findPendingHandshake(env.DB, state, now);
  // One page for a missing, unknown, expired or mismatched handshake. They are
  // the same thing to the person in front of it — start again — and separating
  // them on screen would tell whoever guessed at one which half was wrong.
  if (state === null || handshake === null || handshake.provider !== provider) {
    return page(EXPIRED, 400);
  }

  // A provider that sends `error` instead of `code` is almost always someone
  // pressing Cancel, and that deserves its own words rather than a failure.
  const code = url.searchParams.get("code");
  if (code === null) return page(url.searchParams.has("error") ? DECLINED : EXPIRED, 400);
  // Null once the handshake has been through here already, since the verifier is
  // cleared when it is spent. Reloading a callback cannot repeat an exchange.
  if (handshake.verifier === null) return page(EXPIRED, 400);

  const oauth = deps.oauth ?? arcticOAuthClient(env);
  const asserted = await oauth.verifiedIdentity(
    handshake.provider as ProviderId,
    redirectUri(url, handshake.provider as ProviderId),
    code,
    handshake.verifier,
  );
  // Null covers a refused exchange and an address the provider will not vouch
  // for alike, and the second is the one that matters: `accounts.email` is
  // unique, so accepting an unverified address would let anyone who can assert
  // one claim the documents of whoever owns it.
  //
  // The folding happens here rather than per provider so there is exactly one
  // rule deciding when two sign-ins are the same person. Two rules would
  // eventually disagree, and disagreeing means one person with two shelves of
  // documents and no way to reunite them.
  const email = asserted === null ? null : normalizeEmail(asserted.email);
  if (asserted === null || email === null) return page(UNVERIFIED, 400);

  // The subject, not the email, is what brings someone back to an account. An
  // address can be reassigned to a new person; a provider's subject cannot,
  // which is why this can refuse rather than merge.
  const account = await resolveAccountForIdentity(
    env.DB,
    handshake.provider,
    asserted.subject,
    email,
    newAccountId(),
    now,
  );
  if (account === null) return page(EMAIL_CLAIMED, 409);

  // An account created a moment ago whose code has since expired is left behind
  // on purpose: it costs one row, it is the same account the person's next
  // approval will find, and undoing it would mean deleting an account that may
  // already own documents.
  // Also the point at which one handshake is settled on one identity: two
  // people completing the same authorization url race here, and the loser is
  // told to start again rather than overwriting a confirmation page that has
  // already been rendered for somebody else.
  const confirmToken = newHandshakeToken();
  if (!(await holdProvenIdentity(env.DB, state, account.id, confirmToken, now))) {
    return page(EXPIRED, 400);
  }

  // The machine's own name for itself, which is the only thing on this page
  // that tells someone whether the terminal waiting on this code is theirs. It
  // is client-supplied text, so it is escaped like the address beside it.
  const device =
    handshake.label === null ? UNNAMED_DEVICE : `<b>${escapeHtml(handshake.label)}</b>`;

  return page(
    {
      ...CONFIRM,
      message: `You are signed in as ${escapeHtml(email)}. Approving lets ${device} publish as you until you revoke it. If you did not start this, choose Deny: nothing is approved and the code stops working immediately.`,
      detail: codeDetail(handshake.user_code),
      actions: actions(
        [
          form(
            `${APPROVAL_PREFIX}/confirm`,
            { [CONFIRM_TOKEN_FIELD]: confirmToken },
            "Approve this device",
          ),
          form(`${APPROVAL_PREFIX}/deny`, { [CONFIRM_TOKEN_FIELD]: confirmToken }, "Deny"),
        ].join(""),
      ),
    },
    200,
  );
}

/**
 * The press that approves the code.
 *
 * The hidden confirm token is what makes this safe without a credential of its
 * own: 256 random bits that appear only on the page rendered to the browser
 * that completed the handshake. Neither a cross-site form nor whoever started
 * the handshake has ever seen it, and the write clears it, so a press cannot be
 * replayed.
 */
async function confirm(request: Request, env: Env, deps: ApprovalDeps): Promise<Response> {
  if (!approvalIsConfigured(env)) return page(NOT_CONFIGURED, 503);

  const submitted = await readSmallForm(request);
  if (submitted === null) return page(NOT_FOUND, 404);

  const token = submitted.get(CONFIRM_TOKEN_FIELD);
  const now = (deps.now ?? Date.now)();

  const userCode = token === null ? null : await confirmDeviceApproval(env.DB, token, now);
  if (userCode === null) return page(EXPIRED, 400);

  return page({ ...APPROVED, detail: codeDetail(userCode) }, 200);
}

/**
 * The press that refuses the code.
 *
 * The other half of the defence the confirm token exists for. Closing the tab
 * already refuses an approval, but it leaves the code live for the rest of its
 * lifetime — so someone who lands here for a terminal that is not theirs, which
 * is exactly the RFC 8628 §5.4 case, has no way to end it. This ends it now,
 * and the terminal polling that code is told it was refused instead of waiting
 * out the expiry to learn nothing.
 *
 * The token is cleared by whichever press lands first, so a code can be
 * approved or refused but never both, and neither can be replayed.
 */
async function deny(request: Request, env: Env, deps: ApprovalDeps): Promise<Response> {
  if (!approvalIsConfigured(env)) return page(NOT_CONFIGURED, 503);

  const submitted = await readSmallForm(request);
  if (submitted === null) return page(NOT_FOUND, 404);

  const token = submitted.get(CONFIRM_TOKEN_FIELD);
  const now = (deps.now ?? Date.now)();

  const userCode = token === null ? null : await denyDeviceApproval(env.DB, token, now);
  if (userCode === null) return page(EXPIRED, 400);

  return page({ ...DENIED, detail: codeDetail(userCode) }, 200);
}

/**
 * Where the provider sends the browser back. Built from the request's own
 * origin so a deployment needs no extra host configuration: the router has
 * already refused every host but the configured API one, so this is the
 * deployment's own name. Register it with each provider verbatim.
 */
function redirectUri(url: URL, provider: ProviderId): string {
  return `${url.origin}${APPROVAL_PREFIX}/callback/${provider}`;
}

/**
 * Parse a submitted form, or null when the request is not one this page's own
 * buttons could have sent.
 *
 * `readBodyWithin` rather than `formData()`, and the cap is on bytes actually
 * read rather than on `Content-Length`. The header is the client's own
 * assertion — a body can under-declare its size, or announce none at all when
 * it is chunked — so believing it would leave the case it was supposed to close
 * wide open. Giving up mid-stream is the only bound that holds against a body
 * that lies, and it is the same reader the push path already uses for the same
 * reason.
 *
 * Parsed as a query string because the content type says it is one. That also
 * means no field can arrive as a file part, which `formData()` would have
 * allowed and every caller would have had to guard against.
 *
 * One neutral answer for every reason, and the caller gives it the same page a
 * path that matches nothing gets. The status is not load-bearing — no browser
 * that submitted one of our forms can land here, so the reader is a probe, and
 * a distinct status per check would only tell it which one it failed.
 */
async function readSmallForm(request: Request): Promise<URLSearchParams | null> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== FORM_CONTENT_TYPE) return null;

  const body = await readBodyWithin(request, MAX_FORM_BYTES);
  if (body === null) return null;

  return new URLSearchParams(new TextDecoder().decode(body));
}

/** A one-button form. Every value is escaped, and none of them is markup. */
function form(action: string, fields: Record<string, string>, label: string): string {
  const hidden = Object.entries(fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");
  return `<form method="post" action="${escapeHtml(action)}">${hidden}<button type="submit">${label}</button></form>`;
}

function actions(inner: string): string {
  return `<div class="actions">\n    ${inner}\n  </div>`;
}

function codeDetail(userCode: string): string {
  return `  <div class="code">${escapeHtml(userCode)}</div>`;
}

/**
 * The page that asks for a code, with an optional line saying why it is being
 * asked again.
 *
 * What was submitted is deliberately not put back in the field. Nothing a
 * visitor types reaches this page's markup, which makes "the code cannot carry
 * anything" a property of the page rather than of the escaping being right, and
 * a ten-letter code is not worth weakening that to save retyping.
 */
function codeEntry(status: number, note?: string): Response {
  const message = note === undefined ? ENTER_CODE.message : `${note} ${ENTER_CODE.message}`;
  return page({ ...ENTER_CODE, message, actions: actions(codeForm()) }, status);
}

/**
 * The one field, and nothing else.
 *
 * `autocapitalize` and the uppercasing in the stylesheet are for the phone this
 * is most often typed into; neither is what makes a lowercase code work, since
 * `normalizeUserCode` folds case and trims whitespace on the way in. `required`
 * is what stops an empty submission bouncing off the same page with nothing to
 * say, and it is markup rather than script — this page has no JavaScript and
 * gains none here.
 */
function codeForm(): string {
  return (
    `<form method="get" action="${APPROVAL_PREFIX}">` +
    `<input type="text" name="${USER_CODE_PARAM}" placeholder="WDJBM-JHTQR" aria-label="Device code"` +
    ` autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"` +
    ` autofocus required>` +
    `<button type="submit">Continue</button></form>`
  );
}

/** Every page is `no-store`: none of them is the same twice. */
function page(copy: BrandPage, status: number): Response {
  return new Response(brandPageHtml(copy), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const CHOOSE: BrandPage = {
  title: "Approve a device",
  heading: "Approve this device.",
  message:
    "Your terminal is waiting on the code below. Sign in to continue. The first time creates your account, which stores your verified email address and the id your provider uses for you. Nothing else.",
};

const CONFIRM: BrandPage = {
  title: "Confirm approval",
  heading: "Approve this code?",
  /** Always replaced with the address that was proved; never rendered as it is. */
  message: "",
};

const APPROVED: BrandPage = {
  title: "Device approved",
  heading: "Approved.",
  message:
    "Your terminal is finishing up now, and you can close this page. It keeps the token from here on, so you will not be asked again on this machine.",
  actions: ABOUT_LINK,
};

const DENIED: BrandPage = {
  title: "Device denied",
  heading: "Denied.",
  message:
    "That code is now dead and the terminal waiting on it has been told so. Nothing was approved and no token was issued. If the request was not yours, there is nothing else to do.",
  actions: ABOUT_LINK,
};

const ENTER_CODE: BrandPage = {
  title: "Approve a device",
  heading: "Enter your code.",
  /** Always rendered with the form as its actions, and sometimes with a note. */
  message:
    "Your terminal is waiting on a short code. Type it in exactly as it appears there. Signing in on the next page creates your account the first time, which stores your verified email address and the id your provider uses for you. Nothing else.",
};

const CODE_GONE: BrandPage = {
  title: "Code expired",
  heading: "That code is no longer waiting.",
  message:
    "It expired, or it has already been approved. Run the command again in your terminal to get a fresh one.",
  actions: ABOUT_LINK,
};

const EXPIRED: BrandPage = {
  title: "Approval expired",
  heading: "That took too long.",
  message:
    "This approval has to finish before the code your terminal printed expires. Open the link from your terminal again and sign in.",
  actions: ABOUT_LINK,
};

const DECLINED: BrandPage = {
  title: "Sign-in declined",
  heading: "Nothing was approved.",
  message:
    "You cancelled at your provider, so no account was created and your terminal is still waiting. Open the link again if you meant to approve it.",
  actions: ABOUT_LINK,
};

const UNVERIFIED: BrandPage = {
  title: "Email not verified",
  heading: "We can’t use that address.",
  message:
    "Your provider did not confirm that it verified an email address for you. Verify your address with them and try again, or approve with the other provider.",
  actions: ABOUT_LINK,
};

const EMAIL_CLAIMED: BrandPage = {
  title: "Address already claimed",
  heading: "That address is already in use.",
  message:
    "Another sign-in on this provider already uses this email address, so it cannot be moved to a new one here. If the address was recently reassigned to you, the account behind it belongs to someone else. Approve with your other provider, or ask the operator.",
  actions: ABOUT_LINK,
};

const NOT_CONFIGURED: BrandPage = {
  title: "Approval unavailable",
  heading: "Approval isn’t set up here.",
  message:
    "This deployment has no sign-in provider configured, so it cannot create accounts. Documents it already serves are unaffected. Its operator can configure one.",
  actions: ABOUT_LINK,
};

const NOT_FOUND: BrandPage = {
  title: "Page unavailable",
  heading: "There’s nothing here.",
  message: "Check the address your terminal printed and open it again.",
  actions: ABOUT_LINK,
};

const BROKEN: BrandPage = {
  title: "Approval temporarily unavailable",
  heading: "We can’t finish that right now.",
  message:
    "Something went wrong on our end and nothing was approved. Open the link from your terminal again in a moment.",
  actions: ABOUT_LINK,
};
