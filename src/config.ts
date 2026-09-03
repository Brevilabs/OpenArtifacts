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
 * How long a device code is worth approving.
 *
 * Long enough to find a phone, open a browser and sign in with a provider;
 * short enough that a code left on a screen is worthless by the time anyone
 * else walks past it. RFC 8628 leaves the number to the deployment.
 */
export const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;

/** The polling interval the mint response tells the terminal to use. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

/**
 * The gap below which a poll is answered `slow_down` instead of being served.
 *
 * A second under the advertised interval rather than the interval itself: a
 * client that sleeps exactly five seconds still arrives a little early or late
 * depending on the network, and refusing a well-behaved client for jitter would
 * make the flow flaky for the one thing it exists to keep orderly.
 */
export const MIN_DEVICE_POLL_GAP_MS = (DEVICE_POLL_INTERVAL_SECONDS - 1) * 1000;

/** Window the device-code mint limit is counted over. */
export const DEVICE_MINT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Device codes one client address may mint per window.
 *
 * Minting is unauthenticated by necessity, so the address is the only thing to
 * count against. Twenty in ten minutes is far above one person signing in a
 * machine or two and leaves room for an office behind one address, while
 * capping what a script can produce to spam people with approval pages.
 */
export const MAX_DEVICE_MINTS_PER_WINDOW = 20;

/**
 * How stale a token's `last_used_at` may get before a request refreshes it.
 *
 * Writing it on every request would put a D1 write behind every read, which is
 * the wrong trade for a column whose only reader is a human deciding which
 * machine to revoke. An hour's resolution answers that question just as well,
 * and a token's first use still records itself immediately.
 */
export const TOKEN_LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

/**
 * Tokens `GET /api/v1/tokens` returns.
 *
 * There is no paging: a token is minted by a human approving a machine, so an
 * account holds a handful. The cap is what stops a pathological account turning
 * one request into an unbounded D1 scan.
 */
export const MAX_TOKENS_LISTED = 100;
