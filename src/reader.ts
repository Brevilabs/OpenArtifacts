/**
 * Reader sign-in, and the door a private document opens through.
 *
 * ```
 * GET  /open/{docId}[/v{n}]      check the session and `canRead`, then hand off to the publisher's origin
 * POST /open/{docId}/request     ask the owner to let this account in
 * POST /signin/start/{provider}  begin Google or GitHub; the callback is /approve/callback/{provider}
 * POST /signin/email             mail a six-digit code
 * POST /signin/code              trade the code for a session, or on to the Terms
 * POST /signin/confirm           accept the Terms for a first-time provider account
 * POST /signin/confirm-email     accept the Terms for a first-time emailed-code account
 * POST /signin/out               clear the session ("Use another account")
 * ```
 *
 * `GET`/`POST /share/{docId}` is the owner's side of the same session and lives
 * in `share.ts`.
 *
 * All of it lives on the API host, which is the one place a reader session
 * exists. The session is a stateless signed cookie (`session.ts`), only these
 * routes and the share page read it, and `/api/v1` ignores it, so the cookie
 * adds no cross-site surface to the bearer API. The sign-in pages return only
 * to an `/open/…` or `/share/{docId}` path, so they cannot become an open
 * redirect.
 *
 * A reader is an `accounts` row, the same principal a publisher is. Google and
 * GitHub reuse the device-code handshake and its callback. An emailed code
 * proves the mailbox, and only then is the account decided: an address whose
 * account already signs in with Google or GitHub is refused, so the
 * recycled-mailbox refusal in docs/identity.md holds for every provider-backed
 * account, and an address with no account goes through the Terms first.
 */
import { APPROVAL_PREFIX, READER_USER_CODE_PREFIX, readSmallForm } from "./approval/handler.js";
import {
  arcticOAuthClient,
  configuredProviders,
  normalizeEmail,
  type ProviderId,
} from "./approval/providers.js";
import { MAX_PENDING_REQUESTS_PER_DOC, type Env } from "./config.js";
import {
  accountEmail,
  confirmDeviceApproval,
  findOrCreateAccount,
  findReadableDoc,
  insertAccessRequest,
  ownerEmail,
  sweepExpired,
} from "./db.js";
import { codeMessage, emailConfigured, requestMessage, sendEmail } from "./email.js";
import { sha256Hex } from "./hash.js";
import { isDocId, newAccountId, newHandshakeToken } from "./ids.js";
import { sameOriginPost, withinClientLimit, withinLimit } from "./limits.js";
import { grantUrl } from "./private.js";
import { defaultPlan } from "./plans.js";
import { readerSecret } from "./reader-config.js";
import {
  codePage,
  notAvailablePage,
  OPEN_PREFIX,
  READER_NOT_FOUND,
  readerPage,
  requestSentPage,
  SHARE_PREFIX,
  SIGNIN_FAILED,
  SIGNIN_PREFIX,
  signInPage,
  termsPage,
  TOO_MANY,
} from "./reader-pages.js";
import { docPath, parseDocPath, servingRedirect, SERVING_PREFIX } from "./serve.js";
import {
  cookie,
  LOGIN_COOKIE,
  macHex,
  readSession,
  returnPath,
  SESSION_COOKIE,
  sessionRedirect,
  signPayload,
  verifyPayload,
} from "./session.js";

/** A provider handshake, an emailed code and the Terms token all live ten minutes. */
const SIGNIN_TTL_MS = 10 * 60 * 1000;

/** Wrong guesses one code survives. */
const MAX_CODE_ATTEMPTS = 5;

/**
 * `/open/{docId}/request`, or null for any other path. The version segment
 * `parseDocPath` accepts is not part of this route: a request is for a
 * document, never for one of its versions.
 */
function requestRoute(pathname: string): string | null {
  const [docId, action, ...extra] = pathname.slice(OPEN_PREFIX.length + 1).split("/");
  return docId !== undefined && isDocId(docId) && action === "request" && extra.length === 0 ? docId : null;
}

export async function handleReader(
  request: Request,
  url: URL,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const now = Date.now();
  if (url.pathname === OPEN_PREFIX || url.pathname.startsWith(`${OPEN_PREFIX}/`)) {
    const requested = requestRoute(url.pathname);
    if (requested !== null) {
      return request.method === "POST"
        ? await requestAccess(request, url, env, ctx, requested, now)
        : READER_NOT_FOUND();
    }
    return request.method === "GET" ? await open(request, url, env, now) : READER_NOT_FOUND();
  }

  const [section, provider, ...extra] = url.pathname
    .slice(SIGNIN_PREFIX.length)
    .split("/")
    .filter(Boolean);
  // Every sign-in route is a POST from one of our own pages. A cross-site form
  // cannot start a handshake, sign anyone in as somebody else or sign anyone
  // out. A browser that sends no Fetch Metadata is held to `Origin`; only a
  // request carrying neither (curl, the tests) passes on its absence.
  if (request.method !== "POST" || !sameOriginPost(request, url, false)) return READER_NOT_FOUND();

  const form = await readSmallForm(request);
  if (form === null || extra.length > 0) return READER_NOT_FOUND();
  const next = returnPath(form.get("next"));
  if (next === null) return READER_NOT_FOUND();

  if (section === "start" && provider !== undefined) return await start(request, url, env, provider, next, now);
  if (provider !== undefined) return READER_NOT_FOUND();
  if (section === "email") return await mailCode(request, env, form, next, now);
  if (section === "code") return await verifyCode(request, env, form, next, now);
  if (section === "confirm") return await confirm(env, form, next, now);
  if (section === "confirm-email") return await confirmEmail(env, form, next, now);
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

/** The sign-in page for the methods this server has, returning to `next`. */
export function signIn(env: Env, next: string, note?: string): Response {
  const providers = configuredProviders(env);
  return signInPage(next, providers, emailConfigured(env), note);
}

/**
 * `GET /open/{docId}[/v{n}]`: the one door a private document opens through.
 *
 * No session shows the sign-in page, and says nothing about the document, so a
 * link preview learns nothing. With a session, `canRead` decides: an invited-only
 * document the reader may read redirects to its publisher's origin with a
 * 60-second grant; a document that has since become public redirects to its
 * public url; everything else — not invited, deleted, never existed — is one page.
 *
 * The grant is minted for the label of the document's own owner, read from its
 * row. It is never derived from the reader's account or from the doc id: a
 * publisher whose key was later linked to an account has documents under two
 * owner ids, and a label from the wrong one would land the reader on a host that
 * answers `404`.
 */
async function open(request: Request, url: URL, env: Env, now: number): Promise<Response> {
  const secret = readerSecret(env);
  const servingHost = env.SERVING_HOST?.trim();
  if (secret === null || !servingHost) return READER_NOT_FOUND();
  const route = parseDocPath(url.pathname, OPEN_PREFIX);
  if (route === null) return READER_NOT_FOUND();
  const next = docPath(OPEN_PREFIX, route);

  const accountId = await readSession(request, secret, now);
  if (accountId === null) return signIn(env, next);

  const found = await findReadableDoc(env.DB, route.docId, route.pinned, accountId);
  if (found !== null && found.deleted_at === null) {
    if (found.link_access === "anyone") {
      return servingRedirect(`https://${servingHost}${docPath(SERVING_PREFIX, route)}`, 302);
    }
    if (found.allowed) {
      const grant = await grantUrl(env, found.owner, route, accountId, now);
      if (grant !== null) return servingRedirect(grant.url, 302);
    }
  }

  const email = await accountEmail(env.DB, accountId);
  return email === null ? signIn(env, next) : notAvailablePage(email, route.docId, next);
}

/**
 * `POST /open/{docId}/request`: the signed-in account asks the owner to let it
 * in. The only place a reader acts on a document they cannot open, so it is
 * built to say nothing.
 *
 * The page is the same bytes with the same status for every outcome: a stored
 * request, a repeat, an unknown or deleted id, a public document, an account
 * that is already allowed, a full list, and a rate limit. Nothing in the
 * response depends on the document, and the owner's email, the one slow step,
 * runs after the response is decided, so timing does not either. The address
 * that goes on the list is the session account's own `accounts.email`, never a
 * field, and the form that posts here carries none.
 */
async function requestAccess(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext | undefined,
  docId: string,
  now: number,
): Promise<Response> {
  const secret = readerSecret(env);
  if (secret === null || !sameOriginPost(request, url, true)) return READER_NOT_FOUND();

  const next = docPath(OPEN_PREFIX, { docId, pinned: null });
  const accountId = await readSession(request, secret, now);
  if (accountId === null) return signIn(env, next);
  const email = await accountEmail(env.DB, accountId);
  if (email === null) return signIn(env, next);

  if (await withinLimit(env.REQUEST_ACCESS_LIMITER, await sha256Hex(`request:${accountId}`))) {
    const added = await insertAccessRequest(env.DB, docId, accountId, now, MAX_PENDING_REQUESTS_PER_DOC);
    if (added !== null) {
      const notified = notifyOwner(env, url, docId, added);
      if (ctx === undefined) await notified;
      else ctx.waitUntil(notified);
    }
  }
  return requestSentPage(email, docId, emailConfigured(env));
}

/**
 * Tell the owner about a new request, when the Worker has an address for them: an
 * account owner's own, a license owner's linked account, nothing for an unlinked
 * license owner. Best effort and never throws, so it can ride `waitUntil`; the
 * request is on the list whether or not the email goes.
 */
async function notifyOwner(
  env: Env,
  requestUrl: URL,
  docId: string,
  added: { email: string; title: string; owner: string },
): Promise<void> {
  try {
    if (!emailConfigured(env)) return;
    const to = await ownerEmail(env.DB, added.owner);
    if (to === null) return;
    const apiHost = env.API_HOST?.trim();
    const origin = apiHost ? `https://${apiHost}` : requestUrl.origin;
    await sendEmail(env, to, requestMessage(added.email, added.title, `${origin}${SHARE_PREFIX}/${docId}`));
  } catch (error) {
    console.error("request email failed", { error: error instanceof Error ? error.name : "unknown" });
  }
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

/**
 * What is stored for a code: a keyed hash, not a plain one. There are only a
 * million codes, so anyone who could read `email_codes` (an export, a Time
 * Travel restore) would recover a live one from an unkeyed hash at once.
 */
const codeHash = (secret: string, email: string, code: string) =>
  macHex(secret, "email-code", `${email}:${code}`);

const PROVIDER_BACKED_NOTE = "That address signs in with Google or GitHub. Use that instead.";

/**
 * `POST /signin/email`: mail a code.
 *
 * Any well-formed address gets one, and the page that follows is the same for
 * all of them. Whether the address has an account, and whether Google or GitHub
 * backs it, is decided only after the code comes back (`verifyCode`), because
 * until then nothing has proved the person typing it holds the mailbox, and
 * answering earlier would tell anyone which addresses have accounts.
 */
async function mailCode(
  request: Request,
  env: Env,
  form: URLSearchParams,
  next: string,
  now: number,
): Promise<Response> {
  const secret = readerSecret(env);
  if (secret === null || !emailConfigured(env)) return READER_NOT_FOUND();
  const email = normalizeEmail(form.get("email") ?? "");
  if (email === null) return signIn(env, next, "That doesn’t look like an email address.");

  if (
    !(await withinLimit(env.SIGNIN_EMAIL_LIMITER, await sha256Hex(`signin:${email}`))) ||
    !(await withinClientLimit(env.SIGNIN_EMAIL_CLIENT_LIMITER, request))
  ) {
    return TOO_MANY();
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
    .bind(email, await codeHash(secret, email, code), now + SIGNIN_TTL_MS, now, now, MAX_CODE_ATTEMPTS)
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
  return codePage(email, next);
}

/**
 * `POST /signin/code`: trade the code for a session.
 *
 * The code is checked first. Only a matching code, which proves the mailbox,
 * reaches the decision about the account: one that signs in with Google or
 * GitHub keeps its provider and is refused (the code is spent either way), one
 * with no provider is signed in, and an address with no account goes to the
 * Terms, carrying a signed token for the proved address.
 */
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

  const retry = (note: string) => codePage(email, next, note);

  // The count goes up before the comparison, in the same statement that checks
  // it is still under the limit, so concurrent guesses cannot share an attempt.
  const live = await env.DB.prepare(
    `UPDATE email_codes SET attempts = attempts + 1
      WHERE email = ? AND expires_at > ? AND attempts < ? RETURNING code_hash`,
  )
    .bind(email, now, MAX_CODE_ATTEMPTS)
    .first<{ code_hash: string }>();
  if (live === null) return retry("That code has expired or been used up. Go back and ask for a new one.");
  if (live.code_hash !== (await codeHash(secret, email, code))) return retry("That code didn’t match.");

  const spent = await env.DB.prepare("DELETE FROM email_codes WHERE email = ? AND code_hash = ? RETURNING email")
    .bind(email, live.code_hash)
    .first();
  if (spent === null) return SIGNIN_FAILED();

  // The mailbox is proved. Now, and only now, what the address is.
  const account = await accountOf(env, email);
  if (account?.providerBacked) return signIn(env, next, PROVIDER_BACKED_NOTE);
  if (account !== null) return await sessionRedirect(secret, account.id, next, now);

  const signup = await signPayload(secret, "signup", { e: email }, now + SIGNIN_TTL_MS);
  return termsPage(email, next, { action: `${SIGNIN_PREFIX}/confirm-email`, field: "signup_token", token: signup });
}

/**
 * `POST /signin/confirm-email`: a proved address with no account accepts the
 * Terms, which creates the free account and signs it in.
 *
 * The token is what proves the address, signed for this purpose with ten
 * minutes to live. The account is read again after it is created: a Google or
 * GitHub sign-in for the same address can land between the code and this press,
 * and an account a provider now backs must not be handed a session by a code.
 */
async function confirmEmail(env: Env, form: URLSearchParams, next: string, now: number): Promise<Response> {
  const secret = readerSecret(env);
  if (secret === null) return SIGNIN_FAILED();
  const signup = await verifyPayload(secret, "signup", form.get("signup_token"), now);
  const email = typeof signup?.e === "string" ? normalizeEmail(signup.e) : null;
  if (email === null) return SIGNIN_FAILED(next);
  if (form.get("terms") !== "yes") {
    return termsPage(email, next, {
      action: `${SIGNIN_PREFIX}/confirm-email`,
      field: "signup_token",
      token: form.get("signup_token") ?? "",
    });
  }

  const created = await findOrCreateAccount(env.DB, newAccountId(), email, now, defaultPlan(env));
  if ((await accountOf(env, email))?.providerBacked) return signIn(env, next, PROVIDER_BACKED_NOTE);
  return await sessionRedirect(secret, created.id, next, now);
}
