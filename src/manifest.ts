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
 * A snapshot, never a read-modify-write of the old JSON. Awaited by the caller.
 *
 * Two writers can interleave, and the dangerous direction is D1 `invited` with
 * a manifest saying `anyone`. So the snapshot is re-read after each put and
 * the put repeated until it matches D1; this throws if it never settles.
 * Does nothing for a doc with no row.
 *
 * One residual: a writer that read an older snapshot can put it after a newer
 * one, or after a delete's tombstone. Its re-read sees the change and repairs
 * it, unless that corrective put fails or its isolate dies first (an update's
 * best-effort write swallows the failure). Accepted: closing it would mean
 * serializing every manifest write.
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

/**
 * For create and update, whose page is already live when this runs: failing the
 * request would invite a retry that mints a duplicate doc or another version.
 * Safe because a create with no manifest rebuilds closed (private, no owner) and
 * an update never changes access or people; the next doc-state write rewrites it.
 */
export async function writeManifestBestEffort(env: Env, docId: string): Promise<void> {
  try {
    await writeManifest(env, docId);
  } catch (error) {
    console.error("manifest write failed", { docId, error });
  }
}
