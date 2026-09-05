import { MAX_DOC_BYTES, type Env } from "./config.js";
import type { Publisher } from "./auth.js";
import { errorResponse } from "./errors.js";

export interface PlanLimits {
  documents: number;
  pushesPerDay: number;
  htmlBytes: number;
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
    if (Object.keys(limits).length !== 3 || ["documents", "pushesPerDay", "htmlBytes"].some(
      (field) => typeof limits[field] !== "number" || !Number.isSafeInteger(limits[field]) || (limits[field] as number) <= 0,
    ) || (limits.htmlBytes as number) > MAX_DOC_BYTES) throw new Error("Invalid plan ceilings.");
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

export function limitReached(env: Env, publisher: Publisher, limit: string, message: string): Response {
  let upgradeUrl: string | undefined;
  if (env.UPGRADE_URL?.trim()) {
    const url = new URL(env.UPGRADE_URL);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("UPGRADE_URL must be an absolute HTTP(S) URL without credentials.");
    }
    // This routes checkout, never authenticates it. Billing must prove account ownership.
    url.searchParams.set("owner", publisher.owner);
    upgradeUrl = url.toString();
  }
  return errorResponse("limit_reached", message, undefined, {
    plan: publisher.plan, limit, ...(upgradeUrl ? { upgrade_url: upgradeUrl } : {}),
  });
}
