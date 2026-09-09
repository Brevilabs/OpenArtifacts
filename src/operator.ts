import type { Env } from "./config.js";
import { deleteDocObjects } from "./api/manage.js";
import { docNotFound, errorResponse } from "./errors.js";
import { isDocId } from "./ids.js";
import { OWNER_SCOPE_SQL } from "./owners.js";
import { readBodyWithin } from "./quota.js";

/** Caller must authenticate the service credential before dispatching here. */
export async function operatorAction(request: Request, env: Env, target: string, suspension: boolean): Promise<Response> {
  if (!suspension) return await removeDocument(env, target);
  if (!target || target.length > 256 || /[\u0000-\u0020\u007f]/.test(target) ||
    (target.startsWith("oa_") && !/^oa_[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(target))) {
    return errorResponse("bad_request", "Invalid publisher identity.");
  }
  const raw = await readBodyWithin(request, 1024);
  let body: unknown;
  try { body = raw && JSON.parse(new TextDecoder().decode(raw)); } catch { body = null; }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).length !== 1 || !("suspended" in body) || typeof body.suspended !== "boolean") {
    return errorResponse("bad_request", "Expected only suspended, a boolean.");
  }
  if (body.suspended) {
    await env.DB.prepare(`INSERT INTO publisher_suspensions (owner, suspended_at) VALUES (?, ?)
      ON CONFLICT(owner) DO NOTHING`).bind(target, Date.now()).run();
  } else {
    await env.DB.prepare(`${OWNER_SCOPE_SQL} DELETE FROM publisher_suspensions
      WHERE owner IN (SELECT owner FROM owner_scope)`).bind(target, target).run();
  }
  return Response.json({ owner: target, suspended: body.suspended }, { headers: { "cache-control": "no-store" } });
}

/** Tombstones are permanent; retries finish any interrupted prefix cleanup. */
export async function removeDocument(env: Env, docId: string, objectBatch?: number): Promise<Response> {
  if (!isDocId(docId)) return docNotFound(docId);
  const row = await env.DB.prepare(`UPDATE docs SET deleted_at = COALESCE(deleted_at, ?)
    WHERE id = ? RETURNING id`).bind(Date.now(), docId).first();
  if (!row) return docNotFound(docId);
  try { await deleteDocObjects(env, docId, objectBatch); } catch {
    return errorResponse("internal", "Document withdrawn; object cleanup failed. Retry this removal.");
  }
  return new Response(null, { status: 204 });
}
