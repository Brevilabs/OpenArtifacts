/**
 * Publisher authentication.
 *
 * A publisher is a Copilot Plus license key, and the only identifier the rest of
 * the system ever sees is that key's SHA-256 (D2). The raw key exists inside this
 * module for exactly as long as it takes to hash it and hand it to the license
 * server — it is never stored, logged, or returned, not even a prefix of it.
 * Everything downstream depends on `Publisher.id`, so swapping in a free-tier
 * identity later means adding a branch here and touching nothing else.
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
 */
import { LICENSE_CACHE_TTL_MS, type Env } from "./config.js";
import { d1PublisherStore, type PublisherStore } from "./db.js";
import { errorResponse, type ErrorCode } from "./errors.js";

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
 * The plans entitled to publish. Phase 1 is Believers only.
 *
 * This is a product decision rather than a technical one: a lifetime tier is a
 * small and known population, which is the right blast radius for the first
 * public-hosting surface we operate. Widening it is adding a string here.
 *
 * Lowercase because `validateLicense` folds the license server's uppercase enum
 * before it gets here, and because `publishers.plan` stores the folded form.
 */
const PUBLISHING_PLANS: ReadonlySet<string> = new Set(["believer"]);

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
  // "lifetime", not "Believer": `BELIEVER` is the license server's database
  // enum, and the plan customers actually bought is sold as *Supporter*.
  // Naming the enum here would print a word the reader has never seen. This
  // mismatch is deliberate — do not "fix" it to match PUBLISHING_PLANS.
  message: "Publishing is currently limited to lifetime license holders.",
};

export interface Publisher {
  /** SHA-256 hex of the license key. The only publisher identity in the system. */
  id: string;
  plan: string;
}

export type PublisherFailure =
  /** No usable `Authorization: Bearer <key>` header on the request. */
  | "missing_credentials"
  /** The license server answered, and the answer was no. */
  | "invalid_license"
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
      message: "Expected an Authorization: Bearer <license key> header.",
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
  const now = deps.now ?? Date.now;
  const store = deps.store ?? d1PublisherStore(env.DB);

  const id = await sha256Hex(token);
  const cached = await store.read(id);
  const checkedAt = now();

  if (cached && checkedAt - cached.validated_at < LICENSE_CACHE_TTL_MS) {
    return { ok: true, publisher: { id, plan: cached.plan } };
  }

  const check = await validateLicense(token, env, deps);

  switch (check.status) {
    case "valid":
      await store.save({ key_hash: id, plan: check.plan, validated_at: checkedAt });
      return { ok: true, publisher: { id, plan: check.plan } };

    case "denied":
      // Deliberately no row write and no row delete: a previously valid key that
      // has since lapsed keeps its `publishers` row, because `docs.publisher`
      // still references it. It just stops resolving.
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
        return { ok: true, publisher: { id, plan: cached.plan } };
      }
      return {
        ok: false,
        reason: "license_unavailable",
        message: "License validation is temporarily unavailable. Please try again shortly.",
      };
  }
}

const FAILURE_STATUS: Record<PublisherFailure, ErrorCode> = {
  missing_credentials: "unauthorized",
  invalid_license: "unauthorized",
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
  | { status: "valid"; plan: string }
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

  // The server plan is an uppercase enum (`PLUS`, `BELIEVER`); store it folded
  // so nothing downstream has to guess the casing, as the reference does too.
  const plan = typeof payload.plan === "string" ? payload.plan.toLowerCase() : UNKNOWN_PLAN;
  // The plan is carried, never judged here. `UNKNOWN_PLAN` is not in
  // PUBLISHING_PLANS, so a response whose plan we cannot read authenticates but
  // cannot publish — the safe direction.
  return { status: "valid", plan };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
