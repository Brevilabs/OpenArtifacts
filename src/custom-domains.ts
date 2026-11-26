/**
 * Custom domains: one subdomain an account owns, such as `docs.acme.com`, that
 * serves the account's pages as a second address for its own origin
 * (docs/private-sharing.md). Cloudflare for SaaS on the serving zone holds the
 * hostname and its certificate; our own TXT record proves control of the domain.
 *
 * **Only Check now makes a domain live**, and only when, at that moment, the TXT
 * record at `_openartifacts.{hostname}` holds this account's token and Cloudflare
 * reports the hostname and its certificate active. Cloudflare's status is one per
 * hostname and says nothing about which account controls the DNS, so nothing
 * that reads only Cloudflare may set a domain live: **the daily sync only
 * clears**. No Cloudflare call happens before the TXT proof, so a pending claim
 * creates nothing billed and a left-over CNAME activates nothing for the next
 * claimant.
 *
 * Every outside call has a timeout, and an error or a timeout is never read as
 * "not found".
 */
import type { Env } from "./config.js";
import { sha256Hex } from "./hash.js";
import { withinLimit } from "./limits.js";
import { customDomainsConfigured } from "./reader-config.js";
import { isOurHost, normalizeHostname, surfaceHosts } from "./urls.js";

const TIMEOUT_MS = 8_000;

/** The TXT record's name is `_openartifacts.{hostname}`, its value this prefix and a random token. */
export const TXT_PREFIX = "_openartifacts";
const TOKEN_PREFIX = "openartifacts-verify=";

export interface DomainRow {
  hostname: string;
  /** The whole TXT value, `openartifacts-verify=…`. */
  token: string;
  proved_at: number | null;
  active_at: number | null;
}

/** The account's domain, pending or live, or null. */
export async function domainRow(db: D1Database, accountId: string): Promise<DomainRow | null> {
  return await db
    .prepare("SELECT hostname, token, proved_at, active_at FROM publisher_hosts WHERE account_id = ?")
    .bind(accountId)
    .first<DomainRow>();
}

/** The CNAME target, derived as code hosts are: `domains.{SERVING_HOST}`. */
export function cnameTarget(env: Env): string {
  return `domains.${normalizeHostname(env.SERVING_HOST ?? "")}`;
}

/**
 * The hostname a person typed, as stored (ASCII, lowercase, no root dot), or null
 * when it is not a subdomain we accept: `new URL()` turns an international name
 * into punycode; then letters, digits and hyphens, labels of at most 63
 * characters, at least three labels, at most 253 characters, a top-level label
 * that is not all digits, and not equal to or under one of our domains.
 */
export function domainName(env: Env, input: string): string | null {
  let url: URL;
  try {
    url = new URL(`https://${input.trim()}`);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) return null;
  const host = normalizeHostname(url.hostname);
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 3 || !labels.every((label) => /^[a-z0-9-]{1,63}$/.test(label))) return null;
  if (/^[0-9]+$/.test(labels.at(-1)!)) return null;
  return isOurHost(host, surfaceHosts(env)) ? null : host;
}

/**
 * Add a pending domain with a fresh token. False when the hostname is not one we
 * accept or the account already has a domain. The caller has checked the plan.
 */
export async function addDomain(env: Env, accountId: string, input: string, now: number): Promise<boolean> {
  const hostname = domainName(env, input);
  if (hostname === null) return false;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = TOKEN_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const result = await env.DB.prepare(
    `INSERT INTO publisher_hosts (account_id, hostname, token, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id) DO NOTHING`,
  )
    .bind(accountId, hostname, token, now)
    .run();
  return result.meta.changes > 0;
}

/** What Check now found: the first thing still missing, or `live`. */
export type CheckOutcome =
  | "none"
  | "limited"
  | "unavailable"
  | "no_txt"
  | "no_cname"
  | "certificate"
  | "caa"
  | "blocked"
  | "live";

/** The part of a Cloudflare custom hostname this reads. */
interface CustomHostname {
  id: string;
  hostname: string;
  status: string;
  verification_errors?: string[];
  ssl?: {
    status?: string;
    method?: string;
    type?: string;
    settings?: unknown;
    validation_errors?: Array<{ message?: string }>;
  };
}

/** Whether a TXT answer for `_openartifacts.{hostname}` contains `token`. Throws on any failure. */
async function txtHolds(hostname: string, token: string): Promise<boolean> {
  const name = encodeURIComponent(`${TXT_PREFIX}.${hostname}`);
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=TXT`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`DNS lookup answered ${response.status}`);
  const body = (await response.json()) as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
  // NXDOMAIN is an answer: there is no such record.
  if (body.Status === 3) return false;
  if (body.Status !== 0) throw new Error(`DNS lookup status ${body.Status}`);
  // By substring: Cloudflare quotes TXT data and Google does not.
  return (body.Answer ?? []).some((answer) => answer.type === 16 && typeof answer.data === "string" && answer.data.includes(token));
}

/** One call to the zone's custom hostnames. Throws on a failure, a timeout or `success: false`. */
async function cloudflare(env: Env, method: string, path: string, body?: unknown): Promise<unknown> {
  const zone = env.CF_SAAS_ZONE_ID?.trim();
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/custom_hostnames${path}`, {
    method,
    headers: { authorization: `Bearer ${env.CF_SAAS_API_TOKEN?.trim()}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const parsed = (await response.json().catch(() => null)) as { success?: boolean; result?: unknown } | null;
  if (!response.ok || parsed?.success !== true) throw new Error(`Cloudflare ${method} answered ${response.status}`);
  return parsed.result;
}

/** The zone's custom hostname for `hostname`, or null when Cloudflare has none. */
async function findHostname(env: Env, hostname: string): Promise<CustomHostname | null> {
  const result = await cloudflare(env, "GET", `?hostname=${encodeURIComponent(hostname)}`);
  if (!Array.isArray(result)) throw new Error("Cloudflare answered no list");
  return (result as CustomHostname[]).find((host) => host.hostname === hostname) ?? null;
}

/**
 * Ask Cloudflare to check the hostname again. The `PATCH` echoes the current
 * `ssl.method`, `ssl.type` and `ssl.settings`, as Cloudflare's certificate
 * troubleshooting page says; it also restarts an `expired` or timed-out
 * certificate, which nothing else would.
 */
async function recheck(env: Env, host: CustomHostname): Promise<void> {
  const ssl = host.ssl ?? {};
  await cloudflare(env, "PATCH", `/${host.id}`, {
    ssl: { method: ssl.method ?? "http", type: ssl.type ?? "dv", ...(ssl.settings === undefined ? {} : { settings: ssl.settings }) },
  });
}

/**
 * **Check now**, in the design's order. Six a minute per account. The TXT proof
 * comes first and stops everything else when it fails; a passing one marks the
 * row `proved_at`. Only when Cloudflare reports both the hostname and its
 * certificate `active` does one batch delete another account's live row for this
 * hostname (the newest proof wins) and set `active_at`.
 */
export async function checkDomain(env: Env, accountId: string, now: number): Promise<CheckOutcome> {
  if (!(await withinLimit(env.DOMAIN_CHECK_LIMITER, await sha256Hex(`domain-check:${accountId}`)))) return "limited";
  const row = await domainRow(env.DB, accountId);
  if (row === null) return "none";

  try {
    if (!(await txtHolds(row.hostname, row.token))) return "no_txt";
  } catch (error) {
    console.warn("custom domain TXT lookup failed", { hostname: row.hostname, error });
    return "unavailable";
  }
  await env.DB.prepare("UPDATE publisher_hosts SET proved_at = ? WHERE account_id = ? AND token = ? AND proved_at IS NULL")
    .bind(now, accountId, row.token)
    .run();

  try {
    const host = await findHostname(env, row.hostname);
    if (host === null) {
      await cloudflare(env, "POST", "", { hostname: row.hostname, ssl: { method: "http", type: "dv" } });
      return "certificate";
    }
    if (host.status === "blocked" || host.status === "pending_blocked") return "blocked";
    const sslStatus = host.ssl?.status ?? "";
    if (host.status === "pending" || host.status === "moved") {
      await recheck(env, host);
      return host.verification_errors?.length ? "no_cname" : "certificate";
    }
    // Any other status that is not active: the hostname is between two states.
    if (host.status !== "active") return "certificate";
    if (sslStatus !== "active") {
      if (sslStatus === "expired" || sslStatus.endsWith("_timed_out")) await recheck(env, host);
      return host.ssl?.validation_errors?.some((e) => e.message?.includes("CAA")) ? "caa" : "certificate";
    }
  } catch (error) {
    console.warn("custom domain Cloudflare call failed", { hostname: row.hostname, error });
    return "unavailable";
  }

  const [, set] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM publisher_hosts WHERE hostname = ? AND account_id <> ? AND active_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM publisher_hosts WHERE account_id = ? AND token = ?)`,
    ).bind(row.hostname, accountId, accountId, row.token),
    env.DB.prepare("UPDATE publisher_hosts SET active_at = ? WHERE account_id = ? AND token = ? RETURNING account_id")
      .bind(now, accountId, row.token),
  ]);
  return set!.results.length > 0 ? "live" : "none";
}

/**
 * **Remove domain.** One batch reads whether another account is live on the
 * hostname and deletes the row. The Cloudflare hostname is deleted only when the
 * row had passed the TXT check (it may own one) and no other account is live on
 * it. A failed delete is logged; the row is gone either way.
 */
export async function removeDomain(env: Env, accountId: string): Promise<void> {
  const [other, deleted] = await env.DB.batch([
    env.DB.prepare(
      `SELECT EXISTS (SELECT 1 FROM publisher_hosts o
                       WHERE o.hostname = (SELECT hostname FROM publisher_hosts WHERE account_id = ?)
                         AND o.account_id <> ? AND o.active_at IS NOT NULL) AS live`,
    ).bind(accountId, accountId),
    env.DB.prepare("DELETE FROM publisher_hosts WHERE account_id = ? RETURNING hostname, proved_at").bind(accountId),
  ]);
  const row = deleted!.results[0] as { hostname: string; proved_at: number | null } | undefined;
  if (row === undefined || row.proved_at === null || (other!.results[0] as { live: number }).live === 1) return;
  try {
    const host = await findHostname(env, row.hostname);
    if (host !== null) await cloudflare(env, "DELETE", `/${host.id}`);
  } catch (error) {
    console.error("custom hostname delete failed", { hostname: row.hostname, error });
  }
}

/** Hostname statuses after which a domain is not ours to serve. */
const GONE = new Set(["moved", "deleted", "blocked"]);

/**
 * The daily sync, best effort. For each live row it reads the Cloudflare
 * hostname and clears the row when the hostname is gone, `moved`, `deleted` or
 * `blocked`, or its certificate is `expired`. It ignores every other certificate
 * status (a renewal passes through `pending_*`), changes nothing on an error,
 * deletes nothing at Cloudflare, and never sets `active_at`. It clears with
 * `WHERE active_at = {the value read}`, so an old read cannot undo a newer
 * **Check now**. Nothing while the feature is off.
 */
export async function syncAll(env: Env): Promise<void> {
  if (!customDomainsConfigured(env)) return;
  const rows = await env.DB.prepare("SELECT account_id, hostname, active_at FROM publisher_hosts WHERE active_at IS NOT NULL")
    .all<{ account_id: string; hostname: string; active_at: number }>();
  for (const row of rows.results) {
    let host: CustomHostname | null;
    try {
      host = await findHostname(env, row.hostname);
    } catch (error) {
      console.warn("custom domain sync read failed", { hostname: row.hostname, error });
      continue;
    }
    if (host !== null && !GONE.has(host.status) && host.ssl?.status !== "expired") continue;
    await env.DB.prepare("UPDATE publisher_hosts SET active_at = NULL WHERE account_id = ? AND active_at = ?")
      .bind(row.account_id, row.active_at)
      .run();
  }
}
