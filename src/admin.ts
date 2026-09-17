import { startBrowserLogin, consumeBrowserLogin } from "./browser-login.js";
import { consumeHandoff, stringField } from "./account.js";
import { linkExternalOwner, lookupExternalOwner, createLinkedAccount } from "./owners.js";
import { parseBearerToken } from "./auth.js";
import type { Env } from "./config.js";
import { errorResponse } from "./errors.js";
import { configuredPlans } from "./plans.js";
import { readBodyWithin } from "./quota.js";

export const ADMIN_PREFIX = "/admin/v1";

/** Trusted service API: account plans, ownership associations, and one-use account proofs. */
export async function handleAdmin(request: Request, url: URL, env: Env): Promise<Response> {
  const routes = [
    ["PUT", /^\/admin\/v1\/accounts\/([^/]+)\/(plan|external-owner)$/, "account"],
    ["POST", /^\/admin\/v1\/handoffs\/consume$/, "handoff"],
    ["POST", /^\/admin\/v1\/browser-logins$/, "browser-start"],
    ["POST", /^\/admin\/v1\/browser-logins\/consume$/, "browser-consume"],
    ["GET", /^\/admin\/v1\/external-owners\/([^/]+)$/, "owner-lookup"],
    ["POST", /^\/admin\/v1\/accounts$/, "account-create"],
  ] as const;
  const route = routes.find(
    ([method, path]) => request.method === method && path.test(url.pathname),
  );
  if (!env.ADMIN_API_KEY?.trim() || !route) return errorResponse("not_found", "No admin route.");
  const match = route[1].exec(url.pathname)!;
  const token = parseBearerToken(request.headers.get("authorization"));
  // The service secret is not a publisher token; never forward it to license authentication.
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  if (
    !token ||
    !crypto.subtle.timingSafeEqual(await digest(token), await digest(env.ADMIN_API_KEY))
  ) {
    return errorResponse("unauthorized", "Expected the admin bearer credential.", {
      "www-authenticate": "Bearer",
    });
  }
  if (route[2] === "browser-start") return await startBrowserLogin(request, env);
  if (route[2] === "browser-consume") return await consumeBrowserLogin(request, env);
  if (route[2] === "handoff") return await consumeHandoff(request, env);
  if (route[2] === "account-create") return await createLinkedAccount(request, env);
  if (route[2] === "owner-lookup") {
    let externalOwner: string;
    try {
      externalOwner = decodeURIComponent(match[1]!);
    } catch {
      return errorResponse("bad_request", "Invalid owner identity.");
    }
    return await lookupExternalOwner(env, externalOwner);
  }
  let owner: string;
  try { owner = decodeURIComponent(match![1]!); } catch {
    return errorResponse("not_found", "No account with that id.");
  }
  if (match![2] === "external-owner") {
    const externalOwner = await stringField(request, "externalOwner");
    if (externalOwner === null) return errorResponse("bad_request", "Expected only externalOwner.");
    const result = await linkExternalOwner(env.DB, externalOwner, owner, Date.now());
    if (result === "invalid") return errorResponse("bad_request", "Invalid owner identity.");
    if (result === "account_not_found") return errorResponse("not_found", "No account with that id.");
    if (result === "conflict") return errorResponse("conflict", "An owner is already associated with another account.");
    return Response.json({ accountId: owner, externalOwner }, { headers: { "cache-control": "no-store" } });
  }
  const raw = await readBodyWithin(request, 1024);
  if (!raw) return errorResponse("bad_request", "Admin body must be at most 1024 bytes.");
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch {
    return errorResponse("bad_request", "Body must be JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !("plan" in body) ||
    typeof body.plan !== "string") return errorResponse("bad_request", "Expected a plan name.");
  if (Object.keys(body).length !== 1) return errorResponse("bad_request", "Expected only a plan name.");
  // A malformed deployment is a 500, while a caller naming no configured plan is a 400.
  if (!Object.hasOwn(configuredPlans(env), body.plan)) {
    return errorResponse("bad_request", "Unknown plan.");
  }
  const updated = await env.DB.prepare("UPDATE accounts SET plan = ?, plan_expires_at = NULL, plan_checked_at = MAX(?, COALESCE(plan_checked_at, 0) + 1) WHERE id = ? RETURNING id, plan")
    .bind(body.plan, Date.now(), owner).first<{ id: string; plan: string }>();
  if (!updated) return errorResponse("not_found", "No account with that id.");
  return Response.json({ owner: updated.id, plan: updated.plan }, { headers: { "cache-control": "no-store" } });
}
