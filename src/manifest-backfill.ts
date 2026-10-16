/**
 * TEMPORARY. The one-time backfill that gives every document that existed
 * before manifests a manifest: `POST /admin/v1/manifests/backfill?cursor=`.
 * Delete this file, its route in `src/admin.ts` and its tests in the PR after
 * the backfill has been run; from then on every change writes its own.
 *
 * Pages over every `docs` row, deleted ones included (a tombstone is the point),
 * in id order, and snapshots each with `writeManifest`. Safe to run while live
 * and to repeat: a manifest is a pure function of D1, so a second pass writes
 * the same bytes. Call it again with the returned `cursor` until none is returned.
 */
import type { Env } from "./config.js";
import { writeManifest } from "./manifest.js";

/**
 * Three subrequests per doc (a D1 batch, the put and the batch that checks it)
 * plus the one that lists the page: 15 docs is 46, under the 50 a Workers Free
 * invocation allows.
 */
const PAGE = 15;

export async function backfillManifests(url: URL, env: Env): Promise<Response> {
  const cursor = url.searchParams.get("cursor") ?? "";

  const { results } = await env.DB.prepare("SELECT id FROM docs WHERE id > ? ORDER BY id LIMIT ?")
    .bind(cursor, PAGE)
    .all<{ id: string }>();
  for (const { id } of results) await writeManifest(env, id);

  const next = results.length === PAGE ? results[PAGE - 1]!.id : undefined;
  return Response.json(
    { written: results.length, ...(next === undefined ? {} : { cursor: next }) },
    { headers: { "cache-control": "no-store" } },
  );
}
