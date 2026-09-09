import { consumeHandoff, stringField } from "./account.js";
import { linkExternalOwner } from "./owners.js";
import { parseBearerToken } from "./auth.js";
import type { Env } from "./config.js";
import { errorResponse } from "./errors.js";
import { configuredPlans } from "./plans.js";
import { readBodyWithin } from "./quota.js";

export const ADMIN_PREFIX = "/admin/v1";

/** Trusted service API: account plans, ownership associations, and one-use account proofs. */
export async function handleAdmin(request: Request, url: URL, env: Env): Promise<Response> {
  const match = /^\/admin\/v1\/accounts\/([^/]+)\/(plan|external-owner)$/.exec(url.pathname);
  const consume = request.method === "POST" && url.pathname === "/admin/v1/handoffs/consume";
  if (!env.ADMIN_API_KEY?.trim() || (!consume && (request.method !== "PUT" || !match))) {
    return errorResponse("not_found", "No admin route.");
  }
  const token = parseBearerToken(request.headers.get("authorization"));
  // The service secret is not a publisher token; never forward it to license authentication.
  const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  if (!token || !crypto.subtle.timingSafeEqual(await digest(token), await digest(env.ADMIN_API_KEY))) {
    return errorResponse("unauthorized", "Expected the admin bearer credential.", { "www-authenticate": "Bearer" });
  }
  if (consume) return await consumeHandoff(request, env);
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
    typeof body.plan !== "string" || Object.keys(body).length !== 1) {
    return errorResponse("bad_request", "Expected only a plan name.");
  }
  // A malformed deployment is a 500, while a caller naming no configured plan is a 400.
  if (!Object.hasOwn(configuredPlans(env), body.plan)) {
    return errorResponse("bad_request", "Unknown plan.");
  }
  const updated = await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ? RETURNING id, plan")
    .bind(body.plan, owner).first<{ id: string; plan: string }>();
  if (!updated) return errorResponse("not_found", "No account with that id.");
  return Response.json({ owner: updated.id, plan: updated.plan }, { headers: { "cache-control": "no-store" } });
}
