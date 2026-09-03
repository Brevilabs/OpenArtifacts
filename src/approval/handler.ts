/**
 * The approval page: the only place a human ever interacts with OpenArtifacts,
 * and the only way an account comes into existence.
 *
 * There is no sign-up form, no sign-in page and no session. A CLI prints a url
 * carrying the device code it is waiting on (#57), the person opens it, proves
 * an email with Google or GitHub, and the approval binds that account to the
 * code. The first approval an address makes is the registration; every one
 * after it finds the same account. When the page is done, nothing about the
 * browser is remembered — the token the CLI receives is the credential from
 * then on, which is why there is nothing here for a session to be for.
 *
 * It lives on the API host rather than the serving host, and that is a security
 * boundary rather than a routing preference. The serving origin runs
 * publishers' own scripts and must stay cookieless for that to be acceptable
 * (see `serve.ts`), so the one cookie this Worker sets — the signed handshake
 * state — is confined to the brand domain, where no uploaded script runs.
 *
 * Every outcome is an HTML page, including the failures. The caller here is a
 * browser with a person behind it, not a client matching on an error code, so
 * `docs/http-api.md`'s JSON envelope would be the wrong answer to give them.
 */
import { type Env } from "../config.js";
import { approveDeviceCode, deviceCodeIsPending, findOrCreateAccount } from "../db.js";
import { newAccountId } from "../ids.js";
import { ABOUT_LINK, brandPageHtml, escapeHtml, type BrandPage } from "../page.js";
import { clearApprovalCookie, openApprovalCookie, sealApprovalCookie } from "./cookie.js";
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
 * A device code as it may appear in a url.
 *
 * Deliberately a shape rather than a format: **#57 mints these codes** and is
 * free to choose their length and grouping, so this only has to exclude what
 * cannot be one. Upper case and dashes are what RFC 8628 codes look like when
 * a person reads one off a terminal onto a phone.
 */
const USER_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,63}$/;

export interface ApprovalDeps {
  now?: () => number;
  /** Injected by tests, since arctic's handshake reaches the network. */
  oauth?: OAuthClient;
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
 * `GET /approve`, `GET /approve/start/{provider}` and
 * `GET /approve/callback/{provider}`. Anything else under the prefix is a 404
 * page.
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
  // Nothing here changes state on the way *in* — the state change is the
  // approval itself, and it happens on the provider's redirect back, which is a
  // GET. A form POST would need its own CSRF token to protect what the signed
  // cookie already protects.
  if (request.method !== "GET") return page(NOT_FOUND, 404);

  const [section, provider, ...extra] = url.pathname
    .slice(APPROVAL_PREFIX.length)
    .split("/")
    .filter(Boolean);

  try {
    if (section === undefined) return await chooser(url, env, deps);
    if (extra.length === 0 && provider !== undefined) {
      if (section === "start") return await begin(url, env, provider, deps);
      if (section === "callback") return await finish(request, url, env, provider, deps);
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

/** The page that offers the providers, once the code is known to be waiting. */
async function chooser(url: URL, env: Env, deps: ApprovalDeps): Promise<Response> {
  if (!approvalIsConfigured(env)) return page(NOT_CONFIGURED, 503);

  const userCode = normalizeUserCode(url.searchParams.get(USER_CODE_PARAM));
  if (userCode === null) return page(NO_CODE, 400);

  const now = (deps.now ?? Date.now)();
  // Checked before the providers are offered rather than after the handshake,
  // so a stale link costs a page rather than a trip through Google. Telling a
  // visitor that a code is or is not pending is not the leak the doc ids' 404
  // rule guards against: a user code is short and meant to be read aloud, and
  // RFC 8628 expects the page to say when one is wrong. What it protects is the
  // approval itself, which no amount of knowing a code performs.
  if (!(await deviceCodeIsPending(env.DB, userCode, now))) return page(CODE_GONE, 404);

  const buttons = configuredProviders(env)
    .map((provider) => {
      const href = `${APPROVAL_PREFIX}/start/${provider}?${USER_CODE_PARAM}=${encodeURIComponent(userCode)}`;
      return `<a href="${escapeHtml(href)}">Continue with ${PROVIDER_LABELS[provider]}</a>`;
    })
    .join("\n    ");

  return page(
    {
      ...CHOOSE,
      detail: codeDetail(userCode),
      actions: `<div class="actions">\n    ${buttons}\n  </div>`,
    },
    200,
  );
}

/** Start a handshake: mint the state and PKCE verifier, and hand them a cookie. */
async function begin(
  url: URL,
  env: Env,
  provider: string,
  deps: ApprovalDeps,
): Promise<Response> {
  if (!approvalIsConfigured(env)) return page(NOT_CONFIGURED, 503);

  const secret = env.APPROVAL_COOKIE_SECRET?.trim();
  const chosen = configuredProviders(env).find((id) => id === provider);
  if (chosen === undefined || secret === undefined) return page(NOT_FOUND, 404);

  const userCode = normalizeUserCode(url.searchParams.get(USER_CODE_PARAM));
  if (userCode === null) return page(NO_CODE, 400);

  const now = (deps.now ?? Date.now)();
  const state = randomToken();
  const verifier = randomToken();
  const oauth = deps.oauth ?? arcticOAuthClient(env);
  const target = oauth.authorizationUrl(chosen, redirectUri(url, chosen), state, verifier);

  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "set-cookie": await sealApprovalCookie(
        { provider: chosen, state, verifier, userCode },
        secret,
        now,
      ),
      "cache-control": "no-store",
    },
  });
}

/**
 * The provider's redirect back, which is where an account is created and a
 * device code is bound.
 *
 * Everything the request carries about the handshake is checked against the
 * cookie, never trusted on its own: the provider in the path, the `state`, and
 * the device code, which comes from the cookie rather than the query string
 * precisely so the code approved is the one the page was opened for.
 */
async function finish(
  request: Request,
  url: URL,
  env: Env,
  provider: string,
  deps: ApprovalDeps,
): Promise<Response> {
  if (!approvalIsConfigured(env)) return page(NOT_CONFIGURED, 503);

  const secret = env.APPROVAL_COOKIE_SECRET?.trim();
  if (secret === undefined) return page(NOT_CONFIGURED, 503);

  const now = (deps.now ?? Date.now)();
  const handshake = await openApprovalCookie(request.headers.get("cookie"), secret, now);
  // One page for a missing, forged, expired or mismatched handshake. They are
  // the same thing to the person in front of it — start again — and separating
  // them on screen would tell whoever forged one which half was wrong.
  if (handshake === null || handshake.provider !== provider) {
    return spent(EXPIRED, 400);
  }

  const state = url.searchParams.get("state");
  if (state === null || state !== handshake.state) return spent(EXPIRED, 400);

  // A provider that sends `error` instead of `code` is almost always someone
  // pressing Cancel, and that deserves its own words rather than a failure.
  const code = url.searchParams.get("code");
  if (code === null) {
    return spent(url.searchParams.has("error") ? DECLINED : EXPIRED, 400);
  }

  const oauth = deps.oauth ?? arcticOAuthClient(env);
  const asserted = await oauth.verifiedEmail(
    handshake.provider,
    redirectUri(url, handshake.provider),
    code,
    handshake.verifier,
  );
  // Null covers a refused exchange and an address the provider will not vouch
  // for alike, and the second is the one that matters: `accounts.email` is
  // unique, so accepting an unverified address would let anyone who can assert
  // one claim the documents of whoever owns it.
  //
  // The folding happens here rather than per provider so there is exactly one
  // rule deciding when two approvals are the same person. Two rules would
  // eventually disagree, and disagreeing means one person with two shelves of
  // documents and no way to reunite them.
  const email = asserted === null ? null : normalizeEmail(asserted);
  if (email === null) return spent(UNVERIFIED, 400);

  const account = await findOrCreateAccount(env.DB, newAccountId(), email, now);

  // The binding is the last thing that happens, and it is a single conditional
  // write. An account created a moment ago whose code has since expired is left
  // behind on purpose: it costs one row, it is the same account the person's
  // next approval will find, and undoing it would mean deleting an account that
  // may already own documents.
  if (!(await approveDeviceCode(env.DB, handshake.userCode, account.id, now))) {
    return spent(CODE_GONE, 404);
  }

  return spent({ ...APPROVED, detail: codeDetail(handshake.userCode) }, 200);
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

/** 256 bits, base64url, for both the CSRF `state` and the PKCE verifier. */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function codeDetail(userCode: string): string {
  return `  <div class="code">${escapeHtml(userCode)}</div>`;
}

/** Every page is `no-store`: none of them is the same twice. */
function page(copy: BrandPage, status: number, extra?: HeadersInit): Response {
  return new Response(brandPageHtml(copy), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

/**
 * A page that also ends the handshake. Every outcome of the callback clears the
 * cookie, failures included — that is the path where someone is about to start
 * over, and carrying the old `state` into the new attempt would fail it.
 */
function spent(copy: BrandPage, status: number): Response {
  return page(copy, status, { "set-cookie": clearApprovalCookie() });
}

const CHOOSE: BrandPage = {
  title: "Approve a device",
  heading: "Approve this device.",
  message:
    "Your terminal is waiting on the code below. Sign in to approve it. OpenArtifacts keeps only the verified email address your provider returns, and creates your account the first time you do this.",
};

const APPROVED: BrandPage = {
  title: "Device approved",
  heading: "You’re signed in.",
  message:
    "Your terminal is finishing up now, and you can close this page. It keeps the token from here on, so you will not be asked again on this machine.",
  actions: ABOUT_LINK,
};

const NO_CODE: BrandPage = {
  title: "Approval link incomplete",
  heading: "This link is incomplete.",
  message:
    "Open the whole address your terminal printed, code and all. If you typed it by hand, check the code against the one still on screen.",
  actions: ABOUT_LINK,
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
    "This approval has to finish within a few minutes of starting. Open the link from your terminal again and sign in.",
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
