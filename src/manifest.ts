/**
 * The per-document manifest: a snapshot of what D1 knows about a doc that R2
 * does not, left in R2 beside its versions as `docs/{docId}/manifest.json`.
 *
 * D1 is the only record of who owns a doc, what it is called, whether it was
 * withdrawn and whether it is private. Without this object a rebuild from the
 * version files alone would turn every private page public and every withdrawn
 * url into a 404. See `src/rebuild.ts` for the way back.
 *
 * It holds document state and nothing else: no access requests (transient),
 * no comments (the comments object snapshots its own `threads.json`), no
 * accounts or sessions.
 */
import type { Env } from "./config.js";
import type { InviteRole, LinkAccess } from "./db.js";
import { manifestObjectKey } from "./storage.js";

/** The stored shape. `schema` is bumped only by a change an old reader cannot ignore. */
export interface DocManifest {
  schema: 1;
  docId: string;
  /** An app-sites `User.id`, as `docs.owner` holds it. */
  owner: string;
  title: string;
  linkAccess: LinkAccess;
  commentsEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms, or null while the doc is live. */
  deletedAt: number | null;
  /** The version counter. A lower bound for a rebuild, which also reads the objects. */
  latestVersion: number;
  people: Array<{ email: string; role: InviteRole; createdAt: number }>;
}

interface DocSnapshotRow {
  owner: string;
  title: string;
  link_access: LinkAccess;
  comments_enabled: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  latest_version: number;
}

/** Re-reads allowed after a put that a concurrent write may have outdated. */
const MAX_PASSES = 4;

/** The manifest D1 implies for `docId` right now, or null for a doc with no row. */
async function readManifest(env: Env, docId: string): Promise<string | null> {
  const [doc, invites] = await env.DB.batch([
    env.DB.prepare(
      `SELECT owner, title, link_access, comments_enabled, created_at, updated_at, deleted_at, latest_version
         FROM docs WHERE id = ?`,
    ).bind(docId),
    env.DB.prepare(
      "SELECT email, role, created_at FROM doc_invites WHERE doc_id = ? ORDER BY created_at, email",
    ).bind(docId),
  ]);
  const row = doc!.results[0] as DocSnapshotRow | undefined;
  if (row === undefined) return null;

  const manifest: DocManifest = {
    schema: 1,
    docId,
    owner: row.owner,
    title: row.title,
    linkAccess: row.link_access,
    commentsEnabled: row.comments_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    latestVersion: row.latest_version,
    people: (invites!.results as Array<{ email: string; role: InviteRole; created_at: number }>).map(
      (person) => ({ email: person.email, role: person.role, createdAt: person.created_at }),
    ),
  };
  return JSON.stringify(manifest);
}

/**
 * Snapshot `docId` from D1 into its manifest, replacing whatever was there.
 *
 * It is a snapshot and never a read-modify-write of the old JSON: the new object
 * is a pure function of the rows, so a lost or stale previous write heals on the
 * next one. D1 is read in one batch, so the row and its people agree.
 *
 * Call it right after the D1 write it records and **await it**. It is also
 * written unconditionally, even when the write that brought us here changed
 * nothing: that is what makes a retry repair a manifest whose first put failed,
 * since the retried D1 write is a no-op by then. (Delete is the exception: a
 * retry of a delete answers 404 before getting here, so it retries the put itself.)
 *
 * **Two writers can interleave.** Nothing orders a read of D1 against the put
 * that follows it, so a writer holding an older snapshot can land its put after
 * a newer one. After each put the snapshot is therefore read again, and the put
 * is repeated until the two agree. That converges: any D1 change after a
 * writer's last read is followed by that change's own writer's put, so the last
 * put always matches D1. If it never settles, this throws and the request fails
 * loudly rather than leaving a stale manifest behind.
 *
 * The staleness that matters is one direction: D1 says `invited` and the
 * manifest says `anyone`, which a rebuild would turn into a public page. A failed
 * put and the interleaving above are the two ways to it; both end in a retry or a
 * repeated put instead of a silent gap. The other directions fail closed in a
 * rebuild or cost an owner a re-invite.
 *
 * The same re-read covers a push whose snapshot predates a concurrent delete:
 * its put can land after the tombstone, but the re-read sees the deletion and
 * puts the tombstone back.
 *
 * Does nothing for a doc with no row (a create rolled back).
 */
export async function writeManifest(env: Env, docId: string): Promise<void> {
  let body = await readManifest(env, docId);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (body === null) return;
    await env.DOCS.put(manifestObjectKey(docId), body, {
      httpMetadata: { contentType: "application/json" },
    });
    const current = await readManifest(env, docId);
    if (current === body) return;
    body = current;
  }
  throw new Error(`manifest for ${docId} did not settle after ${MAX_PASSES} passes`);
}
