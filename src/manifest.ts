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

/**
 * Snapshot `docId` from D1 into its manifest, replacing whatever was there.
 *
 * It is a snapshot and never a read-modify-write of the old JSON: the new object
 * is a pure function of the rows, so a lost or stale previous write heals on the
 * next one. D1 is read in one batch, so the row and its people agree.
 *
 * Call it right after the D1 write it records, before any other side effect, and
 * **await it**. It is also written unconditionally, even when the write that
 * brought us here changed nothing: that is what makes a retry repair a manifest
 * whose first put failed, since the retried D1 write is a no-op by then.
 *
 * The staleness that matters is one direction: D1 says `invited` and the
 * manifest says `anyone`, which a rebuild would turn into a public page. That
 * happens only if the put for a public-to-private flip fails. Awaiting makes it a
 * 500 the client retries (and the retry rewrites the manifest) instead of a
 * silent gap. The other directions fail closed in a rebuild or cost an owner a
 * re-invite.
 *
 * One race is accepted. A push's snapshot can read the row before a concurrent
 * delete commits and put after the delete's tombstone, leaving a live-looking
 * manifest over an emptied prefix. A rebuild would then answer 404 for that one
 * doc where it promised 410. The window is milliseconds and no lock is worth it.
 *
 * Does nothing for a doc with no row (a create rolled back).
 */
export async function writeManifest(env: Env, docId: string): Promise<void> {
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
  if (row === undefined) return;

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
  await env.DOCS.put(manifestObjectKey(docId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
  });
}
