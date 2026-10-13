/**
 * Reader sign-in, and the door a private document opens through.
 *
 * ```
 * GET  /open/{docId}[/v{n}]   check the session and the list, then hand off to the document's origin
 * POST /signin/start/{provider}  begin Google or GitHub; the callback is /approve/callback/{provider}
 * POST /signin/email          mail a six-digit code
 * POST /signin/code           trade the code for a session
 * POST /signin/confirm        accept the Terms for a first-time account
 * POST /signin/out            clear the session ("Use another account")
 * ```
 *
 * All of it lives on the API host, which is the one place a reader session
 * exists. The session is a stateless signed cookie (`session.ts`), only these
 * routes read it, and `/api/v1` ignores it, so the cookie adds no cross-site
 * surface to the bearer API. The sign-in pages return only to an `/open/…`
 * path, so they cannot become an open redirect.
 *
 * A reader is an `accounts` row, the same principal a publisher is. Google and
 * GitHub reuse the device-code handshake and its callback; an emailed code is
 * refused for an address whose account already signs in with a provider, so the
 * recycled-mailbox refusal in docs/identity.md holds for every provider-backed
 * account.
 */
import { APPROVAL_PREFIX, READER_USER_CODE_PREFIX, readSmallForm } from "./approval/handler.js";
import {
  approvalIsConfigured,
  arcticOAuthClient,
  configuredProviders,
  normalizeEmail,
  type ProviderId,
} from "./approval/providers.js";
import type { Env } from "./config.js";
import {
  accountEmail,
  confirmDeviceApproval,
  findOrCreateAccount,
  findPrivateRead,
  sweepExpired,
} from "./db.js";
import { codeMessage, emailConfigured, sendEmail } from "./email.js";
import { sha256Hex } from "./hash.js";
import { newAccountId, newHandshakeToken } from "./ids.js";
import { isTopLevelRequest, withinClientLimit, withinLimit } from "./limits.js";
import { grantUrl } from "./private.js";
import { defaultPlan } from "./plans.js";
import {
  codePage,
  notAvailablePage,
  READER_NOT_FOUND,
  READER_UNAVAILABLE,
  readerPage,
  SIGNIN_FAILED,
  SIGNIN_PREFIX,
  signInPage,
  TOO_MANY,
} from "./reader-pages.js";
import { docPath, parseDocPath, servingRedirect, SERVING_PREFIX } from "./serve.js";
import {
  cookie,
  LOGIN_COOKIE,
  openPath,
  readerSecret,
  readSession,
  SESSION_COOKIE,
  sessionRedirect,
  signPayload,
} from "./session.js";

export const OPEN_PREFIX = "/open";

/** A provider handshake, and an emailed code, both live ten minutes. */
const SIGNIN_TTL_MS = 10 * 60 * 1000;

/** Wrong guesses one code survives. */
const MAX_CODE_ATTEMPTS = 5;

export async function handleReader(request: Request, url: URL, env: Env): Promise<Response> {
  const now = Date.now();
  if (url.pathname === OPEN_PREFIX || url.pathname.startsWith(`${OPEN_PREFIX}/`)) {
    return request.method === "GET" ? await open(request, url, env, now) : READER_NOT_FOUND();
  }

  const [section, provider, ...extra] = url.pathname
    .slice(SIGNIN_PREFIX.length)
    .split("/")
    .filter(Boolean);
  // Every sign-in route is a POST from one of our own pages. A cross-site form
  // cannot start a handshake or sign anyone out; absent header (curl, tests) is allowed.
  const site = request.headers.get("sec-fetch-site");
  if (request.method !== "POST" || (site !== null && site !== "same-origin" && site !== "none")) {
    return READER_NOT_FOUND();
  }
  if (readerSecret(env) === null) return READER_UNAVAILABLE();

  const form = await readSmallForm(request);
  if (form === null || extra.length > 0) return READER_NOT_FOUND();
  const next = openPath(form.get("next"));
  if (next === null) return READER_NOT_FOUND();

  if (section === "start" && provider !== undefined) return await start(request, url, env, provider, next, now);
  if (provider !== undefined) return READER_NOT_FOUND();
  if (section === "email") return await mailCode(request, env, form, next, now);
  if (section === "code") return await verifyCode(request, env, form, next, now);
  if (section === "confirm") return await confirm(env, form, next, now);
  if (section === "out") {
    return new Response(null, {
      status: 303,
      headers: {
        location: next,
        "set-cookie": cookie(SESSION_COOKIE, "", 0),
        "cache-control": "no-store",
      },
    });
  }
  return READER_NOT_FOUND();
}

function signIn(env: Env, next: string, note?: string): Response {
  const providers = approvalIsConfigured(env) ? configuredProviders(env) : [];
  const emailEnabled = emailConfigured(env);
  return providers.length === 0 && !emailEnabled
    ? READER_UNAVAILABLE()
    : signInPage(next, providers, emailEnabled, note);
}

/**
 * `GET /open/{docId}[/v{n}]`: the one door a private document opens through.
 *
 * No session shows the sign-in page, and says nothing about the document, so a
 * link preview learns nothing. With a session, an invited-only document the
 * reader may read redirects to its own origin with a 60-second grant; a document
 * that has since become public redirects to its public url; everything else —
 * not invited, deleted, never existed — is one page.
 */
async function open(request: Request, url: URL, env: Env, now: number): Promise<Response> {
  const secret = readerSecret(env);
  const servingHost = env.SERVING_HOST?.trim();
  if (secret === null || !servingHost) return READER_UNAVAILABLE();
  const route = parseDocPath(url.pathname, OPEN_PREFIX);
  if (route === null) return READER_NOT_FOUND();
  const next = docPath(OPEN_PREFIX, route);

  const accountId = await readSession(request, secret, now);
  if (accountId === null) return signIn(env, next);

  const found = await findPrivateRead(env.DB, route.docId, route.pinned, accountId);
  if (found !== null && found.deleted_at === null) {
    if (found.link_access === "anyone") {
      return servingRedirect(`https://${servingHost}${docPath(SERVING_PREFIX, route)}`, 302);
    }
    if (found.allowed) {
      const grant = await grantUrl(env, route, accountId, now);
      if (grant !== null) return servingRedirect(grant.url, 302);
    }
  }

  const email = await accountEmail(env.DB, accountId);
  return email === null ? signIn(env, next) : notAvailablePage(email, next);
}

/**
 * Begin Google or GitHub. The handshake is a `reader_` row on the same table the
 * device flow uses, and the cookie set here ties its `state` to this browser.
 */
async function start(
  request: Request,
  url: URL,
  env: Env,
  provider: string,
  next: string,
  now: number,
): Promise<Response> {
  const secret = readerSecret(env);
  const chosen = configuredProviders(env).find((id): id is ProviderId => id === provider);
  if (secret === null || chosen === undefined) return READER_NOT_FOUND();
  if (!(await withinClientLimit(env.APPROVAL_LOOKUP_LIMITER, request))) return TOO_MANY();

  const state = newHandshakeToken();
  const verifier = newHandshakeToken();
  await sweepExpired(env.DB, now);
  await env.DB.prepare(
    `INSERT INTO device_codes (user_code, provider, state, verifier, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(READER_USER_CODE_PREFIX + state, chosen, state, verifier, now + SIGNIN_TTL_MS, now)
    .run();

  const login = await signPayload(secret, "login", { s: state, n: next }, now + SIGNIN_TTL_MS);
  const target = arcticOAuthClient(env).authorizationUrl(
    chosen,
    `${url.origin}${APPROVAL_PREFIX}/callback/${chosen}`,
    state,
    verifier,
  );
  return new Response(null, {
    status: 303,
    headers: {
      location: target.toString(),
      "set-cookie": cookie(LOGIN_COOKIE, login, SIGNIN_TTL_MS / 1000),
      "cache-control": "no-store",
    },
  });
}

/** A new account's Terms, accepted in the page the callback rendered. */
async function confirm(env: Env, form: URLSearchParams, next: string, now: number): Promise<Response> {
  const secret = readerSecret(env);
  const token = form.get("confirm_token");
  // Only a reader handshake's token: a device approval's token must never end
  // here as a session.
  const mine =
    token !== null &&
    (await env.DB.prepare(
      `SELECT 1 FROM device_codes WHERE confirm_token = ? AND user_code LIKE 'reader#_%' ESCAPE '#'`,
    )
      .bind(token)
      .first());
  if (secret === null || !mine) return SIGNIN_FAILED();

  const userCode = await confirmDeviceApproval(
    env.DB,
    token,
    now,
    null,
    form.get("terms") === "yes",
    newAccountId(),
    defaultPlan(env),
  );
  if (userCode === null) return SIGNIN_FAILED();
  const spent = await env.DB.prepare("DELETE FROM device_codes WHERE user_code = ? RETURNING account_id")
    .bind(userCode)
    .first<{ account_id: string | null }>();
  return spent?.account_id
    ? await sessionRedirect(secret, spent.account_id, next, now)
    : SIGNIN_FAILED();
}

/** Whether the address already has an account, and whether a provider backs it. */
async function accountOf(
  env: Env,
  email: string,
): Promise<{ id: string; providerBacked: boolean } | null> {
  const row = await env.DB.prepare(
    `SELECT a.id AS id,
            EXISTS (SELECT 1 FROM identities i WHERE i.account_id = a.id) AS providerBacked
       FROM accounts a WHERE a.email = ?`,
  )
    .bind(email)
    .first<{ id: string; providerBacked: number }>();
  return row === null ? null : { id: row.id, providerBacked: row.providerBacked === 1 };
}

/** Six digits, uniform: rejection sampling, as `newUserCode` does for its letters. */
function newEmailCode(): string {
  const draw = new Uint32Array(1);
  const ceiling = Math.floor(2 ** 32 / 1_000_000) * 1_000_000;
  do crypto.getRandomValues(draw);
  while (draw[0]! >= ceiling);
  return String(draw[0]! % 1_000_000).padStart(6, "0");
}

const codeHash = (email: string, code: string) => sha256Hex(`${email}:${code}`);

/**
 * `POST /signin/email`: mail a code.
 *
 * A code signs in to any address except one whose account already signs in with
 * Google or GitHub; those keep their provider, which is what keeps the
 * recycled-mailbox refusal true for every provider-backed account. Accounts
 * Copilot linking created have no provider and may use codes, since Copilot's
 * own magic link already treats the mailbox as proof of the account.
 */
async function mailCode(
  request: Request,
  env: Env,
  form: URLSearchParams,
  next: string,
  now: number,
): Promise<Response> {
  if (!emailConfigured(env)) return READER_NOT_FOUND();
  const email = normalizeEmail(form.get("email") ?? "");
  if (email === null) return signIn(env, next, "That doesn’t look like an email address.");

  if (
    !(await withinLimit(env.SIGNIN_EMAIL_LIMITER, await sha256Hex(`signin:${email}`))) ||
    !(await withinClientLimit(env.SIGNIN_EMAIL_LIMITER, request))
  ) {
    return TOO_MANY();
  }
  const account = await accountOf(env, email);
  if (account?.providerBacked) {
    return signIn(env, next, "That address signs in with Google or GitHub. Use that instead.");
  }

  const code = newEmailCode();
  await env.DB.prepare("DELETE FROM email_codes WHERE expires_at <= ?").bind(now).run();
  // A new request replaces a live code but keeps its count of wrong guesses, and
  // a code that has used them all cannot be replaced until it expires. Without
  // that, asking again would reset the allowance and the guess limit would be
  // worth a few minutes of an attacker's time.
  const stored = await env.DB.prepare(
    `INSERT INTO email_codes (email, code_hash, attempts, expires_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash,
       attempts = CASE WHEN email_codes.expires_at > ? THEN email_codes.attempts ELSE 0 END,
       expires_at = excluded.expires_at
     WHERE email_codes.expires_at <= ? OR email_codes.attempts < ?
     RETURNING email`,
  )
    .bind(email, await codeHash(email, code), now + SIGNIN_TTL_MS, now, now, MAX_CODE_ATTEMPTS)
    .first();
  if (stored === null) return TOO_MANY();

  if (!(await sendEmail(env, email, codeMessage(code)))) {
    return readerPage(
      {
        title: "Couldn’t send the code",
        heading: "We couldn’t send that.",
        message: "Something went wrong sending the email. Try again in a moment.",
      },
      502,
    );
  }
  return codePage(email, next, account === null);
}

/** `POST /signin/code`: trade the code for a session, creating the account on first use. */
async function verifyCode(
  request: Request,
  env: Env,
  form: URLSearchParams,
  next: string,
  now: number,
): Promise<Response> {
  const secret = readerSecret(env);
  const email = normalizeEmail(form.get("email") ?? "");
  const code = form.get("code")?.trim() ?? "";
  if (secret === null || email === null || !/^[0-9]{6}$/.test(code)) return SIGNIN_FAILED();
  if (!(await withinClientLimit(env.APPROVAL_LOOKUP_LIMITER, request))) return TOO_MANY();

  const account = await accountOf(env, email);
  const retry = (note: string) => codePage(email, next, account === null, note);

  // The count goes up before the comparison, in the same statement that checks
  // it is still under the limit, so concurrent guesses cannot share an attempt.
  const live = await env.DB.prepare(
    `UPDATE email_codes SET attempts = attempts + 1
      WHERE email = ? AND expires_at > ? AND attempts < ? RETURNING code_hash`,
  )
    .bind(email, now, MAX_CODE_ATTEMPTS)
    .first<{ code_hash: string }>();
  if (live === null) return retry("That code has expired or been used up. Go back and ask for a new one.");
  if (live.code_hash !== (await codeHash(email, code))) return retry("That code didn’t match.");
  if (account?.providerBacked) return SIGNIN_FAILED();
  if (account === null && form.get("terms") !== "yes") return retry("Accept the Terms to continue.");

  const spent = await env.DB.prepare("DELETE FROM email_codes WHERE email = ? AND code_hash = ? RETURNING email")
    .bind(email, live.code_hash)
    .first();
  if (spent === null) return SIGNIN_FAILED();

  const id =
    account?.id ?? (await findOrCreateAccount(env.DB, newAccountId(), email, now, defaultPlan(env))).id;
  return await sessionRedirect(secret, id, next, now);
}
