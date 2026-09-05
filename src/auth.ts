/**
 * Publisher authentication.
 *
 * A publisher presents a Brevilabs license key, and the only identifier the
 * rest of the system ever sees is that key's SHA-256 (D2). The raw key exists
 * inside this module for exactly as long as it takes to hash it and hand it to
 * the license server — it is never stored, logged, or returned, not even a
 * prefix of it.
 *
 * The key identifies a *credential*; `Publisher.owner` identifies whose
 * documents it publishes, and every doc query keys off that. The license server
 * resolves one to the other, returning the app-sites `User.id` that owns the
 * key. Nothing downstream reads the value, so a different identity — a free
 * tier, a dashboard session — is a branch here and nothing else.
 *
 * This module answers *who*, never *may they*. The plan rides along on the
 * resolved publisher and the router decides what it entitles them to, because
 * entitlement differs per operation: publishing is gated, listing and unshare
 * are not. Refusing here instead would take a lapsed publisher's already-public
 * documents hostage — see `mayPublish`.
 *
 * Validation is cached for an hour in the `publishers` row. The cache is also the
 * outage story: if the license server is unreachable but this key has validated
 * before, the push is allowed. A key that has never validated cannot publish
 * during an outage, which is the accepted trade (see the plan's risks).
 *
 * The fallback covers outages only, never rejections. A key the server actively
 * refuses is denied even when it has a warm cache row — otherwise revoking a key
 * would never take effect, since the fallback would re-admit it on every request.
 *
 * **A second credential resolves here too.** An OpenArtifacts token, issued by
 * the device flow to an account this deployment owns, arrives in the same
 * header and answers the same question. The two are told apart by the token's
 * `oat_` prefix rather than by trying one path and falling back to the other,
 * and that is a security property, not a shortcut: without it a token would be
 * handed to the Brevilabs license server to be identified, which would leak our
 * own secret to a third party on every request. Neither path can reach the
 * other's store, so a token can never be validated as a license key and a
 * license key can never be looked up as a token.
 */
import { LICENSE_CACHE_TTL_MS, TOKEN_LAST_USED_RESOLUTION_MS, type Env } from "./config.js";
import { d1PublisherStore, findLiveToken, touchTokenUse, type PublisherStore } from "./db.js";
import { errorResponse, type ErrorCode } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { TOKEN_PREFIX } from "./ids.js";

/** tRPC endpoint on the license server, appended to `LICENSE_API_URL`. */
const VALIDATE_PATH = "/api/trpc/license.validateLicenseKey";

/**
 * The license server sits in the push path, so a hung connection must fail
 * rather than hold the request open until the worker's own limit kills it: a
 * timeout here lands on the cached-validation fallback, a worker timeout does not.
 */
const LICENSE_TIMEOUT_MS = 5_000;

/** Plan recorded when the license server validates a key but names no plan. */
const UNKNOWN_PLAN = "unknown";

/**
 * The paid Copilot plans entitled to publish.
 *
 * The license server currently has two paid plans: Plus subscriptions and the
 * lifetime Believer enum (sold as Supporter). Keep this explicit rather than
 * treating every plan other than `free` as paid: a new or malformed value must
 * fail closed until its entitlement is understood.
 *
 * Lowercase because `validateLicense` folds the license server's uppercase enum
 * before it gets here, and because `publishers.plan` stores the folded form.
 */
const PUBLISHING_PLANS: ReadonlySet<string> = new Set(["plus", "believer"]);

/**
 * Entitlement is per *operation*, not per identity, so this is deliberately not
 * consulted here. A valid key identifies a publisher and that is all
 * authentication decides; only `POST` and `PUT` ask whether the plan may
 * publish, and the router applies it (see `handleApi`).
 *
 * Gating authentication on it instead would refuse `GET` and `DELETE` too,
 * which strands a downgraded publisher's already-public documents with no way
 * to withdraw them.
 */
export function mayPublish(plan: string): boolean {
  return PUBLISHING_PLANS.has(plan);
}

/** The refusal a route gives a valid key whose plan may not publish. */
export const INELIGIBLE_PLAN: { reason: PublisherFailure; message: string } = {
  reason: "ineligible_plan",
  message: "Publishing requires a paid plan.",
};

export interface Publisher {
  /**
   * Whose documents these are. Every doc query keys off it, which is what makes
   * two keys on one account see one shelf.
   *
   * It holds an app-sites `User.id` for a license key and an `oa_`-prefixed
   * account id for a token, and nothing downstream can tell or cares — the two
   * id spaces cannot collide, so one column carries both safely
   * (`docs/identity.md`).
   *
   * The credential itself appears nowhere outside this module. It identifies a
   * credential, and nothing downstream has any business knowing which one was
   * used.
   */
  owner: string;
  plan: string;
  /** Present only for our own tokens; never infer identity type from a plan name. */
  authKind?: "account";
}

export type PublisherFailure =
  /** No usable `Authorization: Bearer <key>` header on the request. */
  | "missing_credentials"
  /** The license server answered, and the answer was no. */
  | "invalid_license"
  /** The credential looked like one of our tokens, and no live token matches. */
  | "invalid_token"
  /**
   * The key is real and current, but its plan may not publish. Raised by the
   * router on `POST`/`PUT` only — never by authentication, which would take
   * `GET` and `DELETE` with it.
   */
  | "ineligible_plan"
  /** The license server could not answer and this key has no cached validation. */
  | "license_unavailable";

export type PublisherResolution =
  | { ok: true; publisher: Publisher }
  | { ok: false; reason: PublisherFailure; message: string };

export interface AuthDeps {
  /** Injected by tests so they never touch the network. */
  fetch?: typeof fetch;
  now?: () => number;
  store?: PublisherStore;
}

/**
 * `Bearer <token>`, scheme-insensitive per RFC 7235. Anything else — no header,
 * another scheme, an empty token — is no credential at all.
 */
export function parseBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function authenticateRequest(
  request: Request,
  env: Env,
  deps: AuthDeps = {},
): Promise<PublisherResolution> {
  const token = parseBearerToken(request.headers.get("authorization"));
  if (token === null) {
    return {
      ok: false,
      reason: "missing_credentials",
      message: "Expected an Authorization: Bearer <token> header.",
    };
  }
  // `return await`: see the note on the router's catch in index.ts.
  return await resolvePublisher(token, env, deps);
}

export async function resolvePublisher(
  token: string,
  env: Env,
  deps: AuthDeps = {},
): Promise<PublisherResolution> {
  // Prefix first, and never a fallback between the two paths: a value that
  // announces itself as one of our tokens is only ever checked against our own
  // table, so it cannot be sent to the license server by accident.
  if (token.startsWith(TOKEN_PREFIX)) {
    // `return await`: see the note on the router's catch in index.ts.
    return await resolveAccountToken(token, env, deps);
  }

  const now = deps.now ?? Date.now;
  const store = deps.store ?? d1PublisherStore(env.DB);

  const id = await sha256Hex(token);
  const cached = await store.read(id);
  const checkedAt = now();

  if (cached && checkedAt - cached.validated_at < LICENSE_CACHE_TTL_MS) {
    return { ok: true, publisher: { owner: cached.owner, plan: cached.plan } };
  }

  const check = await validateLicense(token, env, deps);

  switch (check.status) {
    case "valid":
      await store.save({
        key_hash: id,
        plan: check.plan,
        validated_at: checkedAt,
        owner: check.owner,
      });
      return { ok: true, publisher: { owner: check.owner, plan: check.plan } };

    case "denied":
      // Deliberately no row write and no row delete. A previously valid key that
      // has since lapsed keeps its `publishers` row — that row is what an
      // outage falls back to, and throwing it away would turn a revoked key
      // into a lost account. It simply stops resolving.
      return {
        ok: false,
        reason: "invalid_license",
        message: "That license key is not valid for publishing.",
      };

    case "unreachable":
      if (cached) {
        // Stale but real. An outage must not lock out a publisher who has
        // published before. The plan rides along, so a publisher downgraded
        // since their last successful validation loses publishing here too
        // while keeping list and delete.
        return { ok: true, publisher: { owner: cached.owner, plan: cached.plan } };
      }
      return {
        ok: false,
        reason: "license_unavailable",
        message: "License validation is temporarily unavailable. Please try again shortly.",
      };
  }
}

/**
 * Resolve one of this deployment's own tokens to the account it publishes as.
 *
 * There is no cache and no outage story, because there is nothing to be out:
 * the token's owner is a row in this database rather than an answer from
 * another service. That is also why a revoked token stops working on its very
 * next request, where a revoked license key keeps working until its cached
 * validation ages out.
 */
async function resolveAccountToken(
  token: string,
  env: Env,
  deps: AuthDeps,
): Promise<PublisherResolution> {
  const now = deps.now ?? Date.now;
  const live = await findLiveToken(env.DB, await sha256Hex(token));

  if (live === null) {
    // The same answer for an unknown token, a revoked one and a typo. Which of
    // the three it was is not the caller's business, and telling them would
    // turn a refusal into a probe.
    return {
      ok: false,
      reason: "invalid_token",
      message: "That token is not valid. Sign in again to get a new one.",
    };
  }

  const at = now();
  if (live.last_used_at === null || live.last_used_at < at - TOKEN_LAST_USED_RESOLUTION_MS) {
    await touchTokenUse(env.DB, live.id, at, at - TOKEN_LAST_USED_RESOLUTION_MS);
  }

  return { ok: true, publisher: { owner: live.account_id, plan: live.plan, authKind: "account" } };
}

const FAILURE_STATUS: Record<PublisherFailure, ErrorCode> = {
  missing_credentials: "unauthorized",
  invalid_license: "unauthorized",
  invalid_token: "unauthorized",
  // `unauthorized`, not a new code: the contract in docs/http-api.md is frozen,
  // and `message` is the part of it that is free to change. A client matching
  // on `code` keeps working; a human reads why. Only `POST` and `PUT` can
  // produce this.
  ineligible_plan: "unauthorized",
  // Not the caller's fault and not a credential problem: telling Copilot 401
  // here would make it prompt for a key that is perfectly good.
  license_unavailable: "internal",
};

export function publisherErrorResponse(failure: {
  reason: PublisherFailure;
  message: string;
}): Response {
  const code = FAILURE_STATUS[failure.reason];
  const headers = code === "unauthorized" ? { "www-authenticate": "Bearer" } : undefined;
  return errorResponse(code, failure.message, headers);
}

type LicenseCheck =
  | {
      status: "valid";
      plan: string;
      /**
       * The app-sites `User.id` behind the key, which the license server returns
       * as `accountId`. Never null: a response that names no account does not
       * reach here — see `validateLicense`.
       */
      owner: string;
    }
  | { status: "denied" }
  | { status: "unreachable" };

/** Only an explicit verdict from the license server can deny a key. */
const UNREACHABLE: LicenseCheck = { status: "unreachable" };

/**
 * The tRPC error code that is a verdict on the publisher's key rather than a
 * fault on our side.
 *
 * `license.validateLicenseKey` throws `TRPCError NOT_FOUND` when the key is
 * absent or deleted, and that is the *only* way it reports a bad key: every
 * success path returns `isValid: true`, so `isValid: false` never arrives from
 * this server. Its own route handler logs exactly this code as a warning rather
 * than an error, which is what marks it a routine verdict instead of a fault.
 * brevilabs-api's `license_service.py` reaches the same conclusion, answering
 * 403 on any error envelope.
 *
 * Every other code stays `unreachable` on purpose, which is where we diverge
 * from that reference: `UNAUTHORIZED` means *our* `LICENSE_API_KEY` is wrong,
 * and a misconfigured worker must not tell every paying publisher that their
 * key is bad.
 */
const KEY_REJECTED_CODE = "NOT_FOUND";

async function validateLicense(token: string, env: Env, deps: AuthDeps): Promise<LicenseCheck> {
  const { LICENSE_API_URL, LICENSE_API_KEY } = env;
  // An unconfigured worker is handled exactly like an outage: cached publishers
  // keep working, and nothing unvalidated ever gets through.
  if (!LICENSE_API_URL || !LICENSE_API_KEY) return UNREACHABLE;

  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const url = `${LICENSE_API_URL.replace(/\/+$/, "")}${VALIDATE_PATH}`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Our server-side credential, not the publisher's key.
        authorization: `Bearer ${LICENSE_API_KEY}`,
      },
      body: JSON.stringify({ json: { licenseKey: token } }),
      signal: AbortSignal.timeout(LICENSE_TIMEOUT_MS),
    });
  } catch {
    return UNREACHABLE;
  }

  // Deliberately no `response.ok` check. tRPC delivers a genuine verdict with a
  // 4xx status — a rejected key is HTTP 404 carrying a NOT_FOUND envelope — so
  // the body is the only thing that separates a rejection from an outage. A
  // status with no tRPC envelope behind it (an HTML 502 from the edge, say)
  // fails the parse below and lands on `unreachable` anyway.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return UNREACHABLE;
  }

  const root = asRecord(body);
  if (!root) return UNREACHABLE;

  if ("error" in root) {
    // superjson error envelope: `{error: {json: {data: {code}}}}`.
    const code = asRecord(asRecord(asRecord(root.error)?.json)?.data)?.code;
    return code === KEY_REJECTED_CODE ? { status: "denied" } : UNREACHABLE;
  }

  const payload = asRecord(asRecord(asRecord(root.result)?.data)?.json);
  if (!payload || typeof payload.isValid !== "boolean") return UNREACHABLE;

  const isValid = payload.isValid;
  // Older license-server responses omit `backendAccess`; absent means "same as
  // isValid", so a valid key is not silently denied by a missing field.
  const backendAccess =
    typeof payload.backendAccess === "boolean" ? payload.backendAccess : isValid;
  if (!isValid || !backendAccess) return { status: "denied" };

  // The server plan is an uppercase enum (`FREE`, `PLUS`, `BELIEVER`); store it
  // folded so nothing downstream has to guess the casing, as the reference
  // does too.
  // The account that owns the key, which the license server sends as
  // `accountId`. Unlike the plan, this cannot degrade to a placeholder: it is
  // the identity every document is filed under, so a response we cannot read it
  // from is a response we cannot act on. Blank counts as unreadable — an empty
  // string would be one shared owner that every such key falls into, which is
  // one publisher reading another's documents.
  //
  // `unreachable`, not `denied`: the key may be perfectly good and the fault
  // ours, so this lands on the cached-validation path and answers 500 rather
  // than telling a paying customer their key is bad.
  const owner = payload.accountId;
  if (typeof owner !== "string" || owner.trim() === "") return UNREACHABLE;

  const plan = typeof payload.plan === "string" ? payload.plan.toLowerCase() : UNKNOWN_PLAN;
  // The plan is carried, never judged here. `UNKNOWN_PLAN` is not in
  // PUBLISHING_PLANS, so a response whose plan we cannot read authenticates but
  // cannot publish — the safe direction.
  return { status: "valid", plan, owner };
}


function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
