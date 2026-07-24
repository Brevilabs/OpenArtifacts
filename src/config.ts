/**
 * Worker bindings and the quota ceilings from the plan (D10).
 *
 * `SERVING_HOST` / `API_HOST` are declared in wrangler.jsonc but left empty in
 * v0, where everything runs on one workers.dev subdomain and the router falls
 * back to path prefixes. Setting them later splits the surfaces across the
 * brand and sacrificial domains without a code change (D3).
 */
export interface Env {
  /** R2 bucket holding the served bytes. System of record. */
  DOCS: R2Bucket;
  /** D1 pointer index. Rebuildable from R2; never holds content. */
  DB: D1Database;

  /** Host that serves public docs. Empty in v0. */
  SERVING_HOST?: string;
  /** Host that exposes /api/v1. Empty in v0. */
  API_HOST?: string;

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
