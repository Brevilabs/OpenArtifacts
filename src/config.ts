/**
 * Worker bindings and the quota ceilings from the plan (D10).
 *
 * The canonical, legacy, and retired host vars are declared in wrangler.jsonc.
 * Local development leaves all four empty, where the router falls back to path
 * prefixes. Production configures them together so unknown hosts fail closed.
 */
export interface Env {
  /** R2 bucket holding the served bytes. System of record. */
  DOCS: R2Bucket;
  /** D1 pointer index. Rebuildable from R2; never holds content. */
  DB: D1Database;

  /** Canonical host that serves public docs. Empty in local development. */
  SERVING_HOST?: string;
  /** Canonical host that exposes /api/v1. Empty in local development. */
  API_HOST?: string;
  /** Previous docs host. Redirects GET/HEAD path and query to SERVING_HOST. */
  LEGACY_SERVING_HOST?: string;
  /** Previous API host. Every request receives 410 without authentication. */
  RETIRED_API_HOST?: string;

  /**
   * Base url of the Brevilabs license server, e.g. `https://api.brevilabs.com`.
   * Optional at the type level because it is supplied per environment (.dev.vars
   * locally, a var/secret once the worker is provisioned) rather than committed;
   * auth treats it as an outage when unset rather than trusting an unvalidated key.
   */
  LICENSE_API_URL?: string;
  /**
   * Server-side credential for the license server. This is *ours*, never a
   * publisher's license key, and the two must never be confused.
   */
  LICENSE_API_KEY?: string;

  /**
   * OAuth client credentials for the approval page, one pair per provider.
   *
   * Every one is optional, and a deployment that sets none still starts and
   * still serves documents — the approval page is the only thing that notices,
   * and it says so rather than failing. A provider counts as configured only
   * when both halves of its pair are present, so a half-filled secret store
   * cannot advertise a button that leads to a broken handshake.
   *
   * The redirect uri to register with each provider is the approval callback on
   * the API host: `https://{API_HOST}/approve/callback/{provider}`.
   */
  OAUTH_GOOGLE_CLIENT_ID?: string;
  OAUTH_GOOGLE_CLIENT_SECRET?: string;
  OAUTH_GITHUB_CLIENT_ID?: string;
  OAUTH_GITHUB_CLIENT_SECRET?: string;

  /**
   * Signing key for the short-lived approval cookie, which is the only cookie
   * this Worker ever sets and never on the serving origin.
   *
   * The cookie carries the OAuth `state` and the PKCE verifier, so a forged one
   * would let an attacker complete a handshake they started. Signing is what
   * makes the cookie safe to hold that without a session store behind it.
   * Approval is unavailable while this is unset, for the same reason a missing
   * client secret makes a provider unavailable.
   */
  APPROVAL_COOKIE_SECRET?: string;
}

/**
 * How long a successful license validation is trusted before the license server
 * is asked again. One hour means steady-state load of one call per publisher per
 * hour, and it bounds how long a revoked key keeps working.
 */
export const LICENSE_CACHE_TTL_MS = 60 * 60 * 1000;

/** Largest HTML body a single push may carry, before injection. */
export const MAX_DOC_BYTES = 10 * 1024 * 1024;

/** Pushes a single publisher key may make in one UTC day. */
export const MAX_PUSHES_PER_DAY = 100;

/** Live (non-deleted) docs a single publisher key may hold. */
export const MAX_DOCS_PER_PUBLISHER = 500;

/**
 * How long an approval handshake may stay open, cookie and all.
 *
 * It bounds a window in which a signed `state` and PKCE verifier are accepted
 * back, not a login session — there is no session. Five minutes is longer than
 * any provider consent screen takes and short enough that a cookie left on a
 * shared machine is worthless by the time anyone finds it.
 */
export const APPROVAL_STATE_TTL_MS = 5 * 60 * 1000;
