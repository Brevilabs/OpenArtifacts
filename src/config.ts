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

  /**
   * Rate limiter on `POST /device/code`, declared in wrangler.jsonc.
   *
   * **Optional, and its absence is a supported deployment rather than a
   * misconfiguration.** A self-hoster who declares no limiter gets no limit on
   * that endpoint, which is the right default for a private deployment nobody
   * else can reach and a deliberate choice for a public one. The alternative —
   * failing closed when it is undefined — would mean a Worker that refuses to
   * sign anybody in until an operator has read a configuration reference.
   *
   * The hosted deployment declares it, and should carry a WAF rate limiting
   * rule on the same path as a second layer, since the binding runs inside the
   * Worker and a request that reaches it has already been paid for.
   */
  DEVICE_CODE_LIMITER?: RateLimit;

  /**
   * Rate limiter on the two approval routes that take a user code: the page
   * that looks one up, and the button that starts a handshake against it.
   *
   * A separate namespace from the mint's, and a much larger allowance, because
   * the two limits are protecting different things. A mint writes a row, so its
   * limit is about the write budget. These two read a row and conditionally
   * update one, and their limit is only defence in depth behind the user code's
   * own entropy. Sharing one bucket would also mean one ordinary sign-in spent
   * three of it — mint, look up, start — and a person who reloaded the approval
   * page twice would be told their code had expired.
   *
   * Optional for the same reason as the mint's, and absent means no limit.
   */
  APPROVAL_LOOKUP_LIMITER?: RateLimit;

  /**
   * Rate limiter on `POST /device/token`, keyed by the device-code hash.
   *
   * Keeping the poll interval here makes a pending poll read-only in D1. A
   * timestamp in the device row would turn every well-behaved poll into a write
   * and exhaust the hosted database allowance under ordinary sustained use.
   * Optional like the other two limiters; absent means the interval is advisory.
   */
  DEVICE_POLL_LIMITER?: RateLimit;

  /**
   * Aggregate limiter on `POST /device/token`, keyed by client address.
   *
   * The per-code limiter above enforces the advertised interval, but an
   * attacker can otherwise invent a fresh code for every request and force a
   * D1 miss each time. This second bucket bounds those misses without making
   * ordinary device codes behind one address share the one-per-interval rule.
   * Optional like the other limiters; absent means no aggregate ceiling.
   */
  DEVICE_POLL_CLIENT_LIMITER?: RateLimit;

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

/**
 * The polling interval the mint response tells the terminal to use.
 *
 * It matches `DEVICE_POLL_LIMITER`'s period. Workers rate limiter bindings only
 * accept periods of 10 or 60 seconds.
 */
export const DEVICE_POLL_INTERVAL_SECONDS = 10;

/**
 * The window the device-code limiter counts over, in seconds.
 *
 * The limit itself lives in wrangler.jsonc, where the binding is declared, and
 * is not readable from here — a rate limiter binding reports no numbers, only a
 * verdict. This copy exists solely so a refusal can carry a `Retry-After` the
 * caller can act on, and **it has to match the `period` on the binding**. The
 * binding accepts 10 or 60 and nothing else.
 */
export const DEVICE_MINT_PERIOD_SECONDS = 60;

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
 * Live tokens one account holds at once, which is also every token the list
 * returns.
 *
 * One number, not two, and that is the whole design. `GET /api/v1/tokens` has
 * no cursor, because a token exists only when a human approves a machine and an
 * account has a handful. A list capped below what an account can hold would
 * eventually hide a live token behind the cap — and since revoking is the only
 * way to manage one, a token nobody can see is a token nobody can withdraw.
 * Holding the count at this number instead makes the list complete by
 * construction.
 *
 * It is a rolling window rather than a ceiling that refuses: the hundred and
 * first collection evicts the account's least recently used token. Refusing
 * would strand an owner who no longer holds any of the hundred values, because
 * revoking needs one of them — see `collectDeviceToken`.
 */
export const MAX_TOKENS_PER_ACCOUNT = 100;
