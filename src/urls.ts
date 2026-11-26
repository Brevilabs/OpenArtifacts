/**
 * The public url of a doc — the one thing a publisher actually pastes into a
 * chat, so it has to be right the first time and stable forever after (D4).
 */
import type { Env } from "./config.js";
import { customDomainsConfigured } from "./reader-config.js";

/**
 * `https://{serving host}/d/{docId}`.
 *
 * The serving host is preferred when configured, because the url has to point
 * at the sacrificial domain even though the push arrived on the brand one. In
 * v0 nothing is configured and both surfaces share one workers.dev subdomain,
 * so the request's own origin is the answer — which also means a preview
 * deployment hands out its own urls rather than production's.
 */
export function publicDocUrl(env: Env, requestUrl: URL, docId: string): string {
  const servingHost = env.SERVING_HOST?.trim();
  const origin = servingHost ? `https://${servingHost}` : requestUrl.origin;
  return `${origin}/d/${docId}`;
}

/**
 * `https://{app host}`: where every page for people lives, and so the origin
 * of every link to one (Home, the share page, `/open`, approval, the page
 * script). The app host when one is configured, the API host otherwise, and
 * null when neither is, which is local development.
 */
export function appOrigin(env: Env): string | null {
  const host = (env.APP_HOST?.trim() || env.API_HOST?.trim())?.toLowerCase();
  return host ? `https://${host}` : null;
}

/**
 * `https://{host}` for a page's live custom domain (`custom_host`), or null
 * when there is none or the feature is off. Every use of a custom host goes
 * through this, so deleting `CF_SAAS_API_TOKEN` stops every link, pass and
 * redirect to one at once.
 */
export function customOrigin(env: Env, host: string | null): string | null {
  return host !== null && customDomainsConfigured(env) ? `https://${host}` : null;
}

/** `{custom origin}/d/{docId}`, or null when `customOrigin` is. The optional `customUrl`. */
export function customDocUrl(env: Env, host: string | null, docId: string): string | null {
  const origin = customOrigin(env, host);
  return origin === null ? null : `${origin}/d/${docId}`;
}

/** `{customUrl}` while the page's domain is live, else nothing: spread into a receipt or an `Access`. */
export function customUrlField(env: Env, host: string | null, docId: string): { customUrl?: string } {
  const customUrl = customDocUrl(env, host, docId);
  return customUrl === null ? {} : { customUrl };
}

/** Lowercase, no root dot: `A.Com.` is `a.com`. */
export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

/** `api.openartifacts.ai` → `openartifacts.ai`. A host of two labels or fewer is its own. */
function parentDomain(host: string): string {
  return host.split(".").length >= 3 ? host.slice(host.indexOf(".") + 1) : host;
}

/**
 * Whether `host` is, or is under, one of our domains: the serving host, the
 * legacy serving host, or the parent domain of the API, app and retired API
 * hosts (so all of `openartifacts.ai`). Such a host is never a custom domain,
 * in **Add domain** or in the router, so user content cannot reach the brand
 * domain this way, and the router spends no D1 read on it.
 */
export function isOurHost(
  host: string,
  hosts: { servingHost?: string; legacyServingHost?: string; apiHost?: string; appHost?: string; retiredApiHost?: string },
): boolean {
  const name = normalizeHostname(host);
  const domains = [
    hosts.servingHost,
    hosts.legacyServingHost,
    ...[hosts.apiHost, hosts.appHost, hosts.retiredApiHost].map((h) => (h?.trim() ? parentDomain(normalizeHostname(h)) : "")),
  ]
    .map((h) => normalizeHostname(h ?? ""))
    .filter(Boolean);
  return domains.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/** The router's host configuration, from `env`. */
export function surfaceHosts(env: Env) {
  return {
    servingHost: env.SERVING_HOST,
    apiHost: env.API_HOST,
    legacyServingHost: env.LEGACY_SERVING_HOST,
    retiredApiHost: env.RETIRED_API_HOST,
    appHost: env.APP_HOST,
  };
}
