import { MAX_DOC_BYTES, type Env } from "./config.js";
import type { Publisher } from "./auth.js";
import { errorResponse } from "./errors.js";

export interface PlanLimits {
  documents: number;
  pushesPerDay: number;
  htmlBytes: number;
  storageBytes?: number;
  /** The plan may make documents invited-only and add people to them. */
  privateSharing?: boolean;
  /** The plan may turn comments on for a document, and its documents accept comments. */
  comments?: boolean;
}

const DEFAULT_PLANS: Record<string, PlanLimits> = {
  free: { documents: 3, pushesPerDay: 6, htmlBytes: 1024 * 1024 },
};

/** Finite positive ceilings only; the HTML memory safety bound is never configurable. */
export function configuredPlans(env: Env): Record<string, PlanLimits> {
  const raw: unknown = env.PLAN_LIMITS?.trim()
    ? JSON.parse(env.PLAN_LIMITS)
    : DEFAULT_PLANS;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new Error("Invalid PLAN_LIMITS.");
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid PLAN_LIMITS entry.");
    }
    const limits = value as Record<string, unknown>;
    if (Object.keys(limits).some((key) => !["documents", "pushesPerDay", "htmlBytes", "storageBytes", "privateSharing", "comments"].includes(key)) || ["documents", "pushesPerDay", "htmlBytes"].some(
      (field) => typeof limits[field] !== "number" || !Number.isSafeInteger(limits[field]) || (limits[field] as number) <= 0,
    ) || (limits.storageBytes !== undefined && (!Number.isSafeInteger(limits.storageBytes) || (limits.storageBytes as number) <= 0)) || (limits.privateSharing !== undefined && typeof limits.privateSharing !== "boolean") || (limits.comments !== undefined && typeof limits.comments !== "boolean") || (limits.htmlBytes as number) > MAX_DOC_BYTES) throw new Error("Invalid plan ceilings.");
  }
  return raw as Record<string, PlanLimits>;
}

export function planLimits(env: Env, plan: string): PlanLimits {
  const plans = configuredPlans(env);
  if (!Object.hasOwn(plans, plan)) throw new Error("Account plan is not configured.");
  return plans[plan]!;
}

export function defaultPlan(env: Env): string {
  const plan = env.DEFAULT_PLAN ?? "free";
  planLimits(env, plan);
  return plan;
}

/** Expiration changes access on the next request, never ownership or stored history. */
export function effectivePlan(env: Env, plan: string, expiresAt: number | null, now = Date.now()): string {
  return expiresAt !== null && expiresAt <= now ? defaultPlan(env) : plan;
}

/** The checkout link to offer, or undefined where the server has none. Routes checkout, never authenticates it. */
export function upgradeUrl(env: Env): string | undefined {
  if (!env.UPGRADE_URL?.trim()) return undefined;
  const url = new URL(env.UPGRADE_URL);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("UPGRADE_URL must be an absolute HTTP(S) URL without credentials.");
  }
  // Billing must prove account ownership.
  url.searchParams.delete("owner");
  return url.toString();
}

export function limitReached(env: Env, publisher: Publisher, limit: string, message: string): Response {
  const upgrade = upgradeUrl(env);
  return errorResponse("limit_reached", env.ACCOUNT_ACTION_URL?.trim()
    ? `${message} Run openartifacts account --open to manage your plan.`
    : message, undefined, {
    plan: publisher.plan, limit, ...(upgrade ? { upgrade_url: upgrade } : {}),
  });
}
