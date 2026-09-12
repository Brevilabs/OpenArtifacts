import { syncNewsletter } from "./newsletter.js";
import { LICENSE_CACHE_TTL_MS, type Env } from "./config.js";
import { configuredPlans, defaultPlan, effectivePlan } from "./plans.js";

export type RefreshStatus = "cached" | "refreshed" | "unavailable";
type Snapshot = { plan: string; expiresAt: number | null; checkedAt: number | null; externalOwner: string | null; retryAfter: number | null };

/** Credentials stay in D1. Only the Worker-proven account/link and service secret cross the network. */
export async function accountPlan(env: Env, owner: string, deps: {
  now?: () => number; fetch?: typeof fetch; forceAccountRefresh?: boolean; skipAccountRefresh?: boolean;
} = {}): Promise<{ plan: string; status: RefreshStatus }> {
  const read = () => env.DB.prepare(`SELECT plan, plan_expires_at AS expiresAt, plan_checked_at AS checkedAt, plan_retry_after AS retryAfter,
    (SELECT external_owner FROM owner_links WHERE account_id = accounts.id) AS externalOwner
    FROM accounts WHERE id = ?`).bind(owner).first<Snapshot>();
  let cached = await read();
  if (!cached) return { plan: defaultPlan(env), status: "unavailable" };
  const now = deps.now ?? Date.now;
  const at = now();
  let status: RefreshStatus = "cached";
  if (!deps.skipAccountRefresh && (deps.forceAccountRefresh ||
      ((cached.retryAfter === null || cached.retryAfter <= at) &&
       (cached.checkedAt === null || cached.checkedAt <= at - LICENSE_CACHE_TTL_MS ||
        (cached.expiresAt !== null && cached.expiresAt <= at))))) {
    const original = cached;
    await syncNewsletter(env, owner, deps.fetch);
    status = "unavailable";
    if (env.LICENSE_API_URL && env.LICENSE_API_KEY) {
      // Distinguish same-millisecond refreshes from the stored snapshot without a revision counter.
      const started = Math.max(at, (cached.checkedAt ?? 0) + 1);
      try {
        const response = await (deps.fetch ?? fetch)(`${env.LICENSE_API_URL.replace(/\/+$/, "")}/api/trpc/license.openArtifactsEntitlement`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.LICENSE_API_KEY}` },
          body: JSON.stringify({ json: { accountId: owner, ...(cached.externalOwner ? { externalOwner: cached.externalOwner } : {}) } }),
          signal: AbortSignal.timeout(8000),
        });
        const body = await response.json() as { result?: { data?: { json?: { plan?: unknown; expiresAt?: unknown } } } };
        const value = body.result?.data?.json;
        if (!response.ok || !value || (value.plan !== "default" && value.plan !== "plus") ||
            (value.expiresAt !== null && (typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0))) {
          throw new Error("Invalid entitlement response");
        }
        const plan = value.plan === "plus" ? "pro" : defaultPlan(env);
        if (!Object.hasOwn(configuredPlans(env), plan)) throw new Error("Unconfigured paid plan");
        const written = await env.DB.prepare(`UPDATE accounts SET plan = ?, plan_expires_at = ?, plan_checked_at = ?, plan_retry_after = NULL
          WHERE id = ? AND (plan_checked_at IS NULL OR plan_checked_at < ?)
            AND (SELECT external_owner FROM owner_links WHERE account_id = accounts.id) IS ?`)
          .bind(plan, value.expiresAt, started, owner, started, cached.externalOwner).run();
        status = written.meta.changes ? "refreshed" : "cached";
      } catch {
        // Backoff is independent of paid validity and successful-verification time.
        // Do not delay a concurrent successful refresh or a newly linked account.
        await env.DB.prepare(`UPDATE accounts SET plan_retry_after = ?
          WHERE id = ? AND plan_checked_at IS ?
            AND (SELECT external_owner FROM owner_links WHERE account_id = accounts.id) IS ?`)
          .bind(now() + 60_000, owner, original.checkedAt, original.externalOwner).run();
      }
    }
    // A concurrent manual assignment, link, or newer refresh wins even when our fetch fails.
    cached = await read();
    if (!cached) return { plan: defaultPlan(env), status: "unavailable" };
    if (status === "unavailable" && cached.checkedAt !== null &&
        cached.checkedAt !== original.checkedAt) status = "cached";
  }
  return { plan: deps.skipAccountRefresh ? cached.plan : effectivePlan(env, cached.plan, cached.expiresAt, now()), status };
}
