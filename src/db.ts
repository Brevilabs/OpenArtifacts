/**
 * Row types for the D1 pointer index, one per table in 0001_init.sql.
 *
 * D1 holds pointers only — ids, sizes, timestamps. The bytes live in R2, and
 * every row here is reconstructible from it, so a lost D1 is a rebuild rather
 * than a data loss. Queries land here as the phase that needs them arrives.
 */

/** Publisher row, which doubles as the license-validation cache (phase 2). */
export interface PublisherRow {
  /** SHA-256 of the license key. Raw keys are never stored. */
  key_hash: string;
  plan: string;
  /** Epoch ms of the last successful license-server validation. */
  validated_at: number;
}

export interface DocRow {
  id: string;
  /** `publishers.key_hash` of the owner. */
  publisher: string;
  title: string;
  /**
   * Highest version number *reserved*; 0 before the first push lands.
   *
   * Reserved, not stored: the number is minted before the R2 object is written,
   * so a push that dies in between leaves this one above the newest version
   * that actually has bytes. It is the counter, never the pointer — anything
   * resolving a doc to bytes must go through `versions`, whose rows are written
   * after their object and therefore always have one.
   */
  latest_version: number;
  created_at: number;
  updated_at: number;
  /** Epoch ms when soft-deleted, else null. Deleted docs serve 410, not 404. */
  deleted_at: number | null;
}

export interface VersionRow {
  doc_id: string;
  n: number;
  /** Byte length of the stored R2 object. */
  size: number;
  /** The title this push asked for, or null when it asked for none. */
  title: string | null;
  created_at: number;
}

export interface PushQuotaRow {
  publisher: string;
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  pushes: number;
}

/**
 * The publisher row as auth needs it: read the cached validation, write it back
 * after a fresh one. It is an interface rather than two loose functions so the
 * auth tests can run against an in-memory double instead of a database.
 */
export interface PublisherStore {
  read(keyHash: string): Promise<PublisherRow | null>;
  save(row: PublisherRow): Promise<void>;
}

/** Version numbers start at 1; a `docs` row at 0 has never been pushed to. */
export const FIRST_VERSION = 1;

export function d1PublisherStore(db: D1Database): PublisherStore {
  return {
    read(keyHash) {
      return db
        .prepare("SELECT key_hash, plan, validated_at FROM publishers WHERE key_hash = ?")
        .bind(keyHash)
        .first<PublisherRow>();
    },

    // `docs.publisher` is a foreign key onto this table, so this upsert is also
    // what guarantees a row exists before the first push inserts a doc.
    async save(row) {
      await db
        .prepare(
          `INSERT INTO publishers (key_hash, plan, validated_at) VALUES (?, ?, ?)
           ON CONFLICT(key_hash) DO UPDATE SET plan = excluded.plan,
                                               validated_at = excluded.validated_at`,
        )
        .bind(row.key_hash, row.plan, row.validated_at)
        .run();
    },
  };
}

/**
 * Create the `docs` row for a first push, already carrying version 1 — but only
 * while this publisher is under `maxDocs` live docs. Returns false at the
 * ceiling.
 *
 * A freshly minted id is private to this request, so nothing can race for its
 * first version and the insert *is* the reservation — the `UPDATE ... RETURNING`
 * dance below only earns its keep once a doc is reachable by id.
 *
 * The capacity count is a predicate on that same insert rather than a read
 * before it, for the reason `reserveNextVersion` exists: a publisher at the
 * ceiling firing concurrent creates would otherwise have every one of them read
 * the same count and every one of them insert. A quota documented as a hard
 * number has to behave like one under the concurrency an agent produces.
 * `docs_by_publisher_live` covers the subquery, so it is an index scan of only
 * this publisher's live rows.
 *
 * `publisher` is a foreign key onto `publishers`, so this fails unless auth has
 * already written that row. That is the intended coupling: no doc without a
 * publisher we validated.
 */
export async function insertDocWithinQuota(
  db: D1Database,
  doc: Omit<DocRow, "deleted_at" | "latest_version">,
  maxDocs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO docs (id, publisher, title, latest_version, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM docs WHERE publisher = ? AND deleted_at IS NULL) < ?`,
    )
    .bind(
      doc.id,
      doc.publisher,
      doc.title,
      FIRST_VERSION,
      doc.created_at,
      doc.updated_at,
      doc.publisher,
      maxDocs,
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Hard-delete a `docs` row. Only for rolling back a create that failed after the
 * row existed: the id was minted this request and nothing else can have seen it,
 * so there are no versions, no objects, and no url to leave behind.
 *
 * Unsharing a *published* doc is a soft delete (`softDeleteDoc`) — that row has
 * to survive so its url keeps answering 410 rather than pretending it never was.
 */
export async function deleteDocRow(db: D1Database, docId: string): Promise<void> {
  await db.prepare("DELETE FROM docs WHERE id = ?").bind(docId).run();
}

/** Whether a doc has been soft-deleted since a push started writing to it. */
export async function docIsDeleted(db: D1Database, docId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM docs WHERE id = ? AND deleted_at IS NOT NULL")
    .bind(docId)
    .first();

  return row !== null;
}

/**
 * Drop one version row, for a version whose object has just been removed again
 * after losing a race with delete. The row only ever named those bytes.
 */
export async function deleteVersionRow(
  db: D1Database,
  docId: string,
  version: number,
): Promise<void> {
  await db.prepare("DELETE FROM versions WHERE doc_id = ? AND n = ?").bind(docId, version).run();
}

/**
 * Mint the next version number for a doc, or null if this publisher has no such
 * doc to push to.
 *
 * The whole coordination story of v0 is this one statement (D7). Incrementing
 * and reading back in a single write means two concurrent pushes to the same
 * doc get 2 and 3, never 2 and 2 — which matters because the number is an R2
 * key, and two pushes sharing a key would mean one overwriting the other's
 * immutable bytes.
 *
 * Ownership and liveness are predicates on that same statement rather than an
 * earlier read, so a doc deleted or transferred in between cannot slip through.
 * Null covers "no such doc", "not yours" and "deleted" alike: the caller must
 * answer all three with 404, because distinguishing them would confirm that
 * another publisher's doc exists.
 *
 * It mints the number and nothing else. Title and `updated_at` describe the
 * content a reader gets, so they are committed by `commitVersionMetadata` only
 * once the bytes are actually stored — writing them here would let a failed
 * push leave "my docs" describing a version the public url is not serving.
 */
export async function reserveNextVersion(
  db: D1Database,
  docId: string,
  publisher: string,
): Promise<number | null> {
  const reserved = await db
    .prepare(
      `UPDATE docs
          SET latest_version = latest_version + 1
        WHERE id = ? AND publisher = ? AND deleted_at IS NULL
        RETURNING latest_version`,
    )
    .bind(docId, publisher)
    .first<{ latest_version: number }>();

  return reserved?.latest_version ?? null;
}

/**
 * Point a doc's listing metadata at the version that just landed.
 *
 * Runs after the bytes are stored, so the pair a reader sees in "my docs" always
 * describes content the public url will actually serve. A push that dies before
 * this leaves a burned version number and the previous push's metadata — which
 * is the honest answer, because the previous push is still what is being served.
 *
 * Two things move, on two different rules, because they answer two different
 * questions.
 *
 * **Title** is whatever the highest-numbered stored version asked for. Deriving
 * it from the version rows rather than writing it here makes it independent of
 * the order commits happen to run in: overlapping pushes can reserve 2 and 3,
 * store in either order, and an explicit title on 2 is not lost because 3 —
 * which asked for no title — committed first. Versions that omitted a title are
 * skipped rather than treated as blanking it, which is what makes omission mean
 * "leave it alone" no matter how many pushes are in flight.
 *
 * **`updated_at`** moves only while this version is the newest stored one, since
 * it describes what the shared link resolves to. The comparison is against
 * `MAX(versions.n)` and not `docs.latest_version`, because the counter can be
 * ahead of what exists: a push that reserves a number and then fails burns it,
 * and a dead reservation must not veto a version that really landed.
 *
 * Batched, so a reader cannot catch the pair mid-update.
 */
export async function commitVersionMetadata(
  db: D1Database,
  docId: string,
  version: number,
  atMs: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE docs
            SET title = COALESCE(
              (SELECT v.title FROM versions v
                WHERE v.doc_id = ? AND v.title IS NOT NULL
                ORDER BY v.n DESC LIMIT 1),
              title)
          WHERE id = ?`,
      )
      .bind(docId, docId),
    db
      .prepare(
        `UPDATE docs SET updated_at = ?
          WHERE id = ?
            AND ? >= (SELECT COALESCE(MAX(n), 0) FROM versions WHERE doc_id = ?)`,
      )
      .bind(atMs, docId, version, docId),
  ]);
}

/**
 * Record that a version exists.
 *
 * Written *after* its R2 object, never before, so every row here has bytes
 * behind it. The reverse failure — an object with no row — is the one this
 * ordering chooses to allow: it costs storage, where a row with no object would
 * be a doc that 500s.
 */
export async function insertVersion(db: D1Database, version: VersionRow): Promise<void> {
  await db
    .prepare("INSERT INTO versions (doc_id, n, size, title, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(version.doc_id, version.n, version.size, version.title, version.created_at)
    .run();
}

/** What the serving path needs to know about a doc, in one read. */
export interface ServableVersion {
  /** Epoch ms when the doc was soft-deleted, else null. Deleted serves 410. */
  deleted_at: number | null;
  /** The version that has bytes, or null when the request names none. */
  version: number | null;
}

/**
 * Resolve a public url to the version whose bytes should be served, or null if
 * no doc has that id at all.
 *
 * `pinned` is the version from `/d/{docId}/v{n}`, or null for `/d/{docId}`.
 *
 * The version comes from `versions`, never from `docs.latest_version`, because
 * that counter is a *reservation*: a push that dies between minting the number
 * and writing the object leaves it one above the newest version that actually
 * has bytes, and serving that number would 404 a doc that is perfectly fine.
 * Taking the highest row instead also steps over the gap such a push leaves
 * behind. The same subquery answers the pinned case, where matching the exact
 * `n` is what proves the version exists rather than merely being below the
 * counter.
 *
 * Liveness is *not* a predicate here: a deleted doc must still be found, so the
 * caller can tell 410 from 404. That distinction is the one thing this query
 * exists to preserve, and it is safe to expose because a doc id is 80 random
 * bits — knowing one already means having been given the link.
 */
export async function findServableVersion(
  db: D1Database,
  docId: string,
  pinned: number | null,
): Promise<ServableVersion | null> {
  // `return await`: see the note on the router's catch in index.ts.
  return await db
    .prepare(
      `SELECT d.deleted_at AS deleted_at,
              (SELECT MAX(v.n)
                 FROM versions v
                WHERE v.doc_id = d.id
                  AND (? IS NULL OR v.n = ?)) AS version
         FROM docs d
        WHERE d.id = ?`,
    )
    .bind(pinned, pinned, docId)
    .first<ServableVersion>();
}

/**
 * Whether this publisher owns a live doc with that id — the same conflation of
 * "missing", "someone else's" and "deleted" that `reserveNextVersion` makes,
 * for the same reason, and answered identically for all three so the shape of
 * the reply cannot confirm another publisher's doc exists.
 */
export async function ownsLiveDoc(
  db: D1Database,
  docId: string,
  publisher: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM docs WHERE id = ? AND publisher = ? AND deleted_at IS NULL")
    .bind(docId, publisher)
    .first();

  return row !== null;
}

/**
 * Soft-delete a doc, returning false when this publisher has no live doc with
 * that id — missing, someone else's, or already deleted, conflated for the same
 * reason as everywhere else on the write path.
 *
 * Soft, not hard: the row is what lets the serving path answer 410 rather than
 * 404, so a reader who bookmarked the link learns it was withdrawn instead of
 * wondering whether they mistyped it. The bytes are a separate matter and the
 * caller drops them; this row outlives them on purpose.
 *
 * Ownership and liveness are predicates on the write itself rather than an
 * earlier read, so two concurrent deletes of the same doc produce exactly one
 * true — which is what makes "delete the objects" safe to run only on that one.
 */
export async function softDeleteDoc(
  db: D1Database,
  docId: string,
  publisher: string,
  atMs: number,
): Promise<boolean> {
  const deleted = await db
    .prepare(
      `UPDATE docs
          SET deleted_at = ?
        WHERE id = ? AND publisher = ? AND deleted_at IS NULL
        RETURNING id`,
    )
    .bind(atMs, docId, publisher)
    .first<{ id: string }>();

  return deleted !== null;
}

/** One row of the publisher's doc list, as the index scan yields it. */
export interface DocListRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  /**
   * Newest version that has bytes, from `versions` rather than the
   * `latest_version` counter — the counter can sit one above it after a push
   * that died mid-write, and a list that reported it would name a version the
   * doc's url does not serve. Null for a doc whose first push never landed.
   */
  version: number | null;
}

/**
 * Where a page of the list stopped, in the order the scan runs. Both columns
 * are needed: `created_at` is milliseconds and two docs pushed in the same
 * millisecond are entirely possible, so the id is what breaks the tie and keeps
 * the order total.
 */
export interface DocListCursor {
  created_at: number;
  id: string;
}

/**
 * A page of one publisher's live docs, newest first.
 *
 * Keyset, not OFFSET. The `docs_by_publisher_live` partial index is
 * `(publisher, created_at DESC, id DESC)`, and it supplies both the filter and
 * the ordering, so no page is ever sorted in a temp b-tree. It is also the only
 * paging that stays correct while the publisher keeps pushing: OFFSET renumbers
 * the moment a newer doc appears, so a doc would shift onto a page the caller
 * has already read and be missed.
 *
 * Ordering by `created_at` rather than `updated_at` is what makes that hold — a
 * doc's created_at never moves, so a doc cannot jump backwards past a cursor
 * because it was re-pushed mid-walk.
 *
 * The resume predicate is a row-value comparison rather than the expanded
 * `a < ? OR (a = ? AND b < ?)`. The two mean the same thing, but only the row
 * value becomes an index range constraint — `EXPLAIN QUERY PLAN` shows
 * `(publisher=? AND (created_at,id)<(?,?))` against the expanded form's
 * `(publisher=?)`, which walks from the newest doc and discards rows until it
 * passes the cursor. Both are correct; one seeks.
 *
 * The two statements differ only in that predicate. Written out rather than
 * folded into one with `(? IS NULL OR ...)`, which SQLite cannot use the index
 * for at all.
 */
export async function listPublisherDocs(
  db: D1Database,
  publisher: string,
  after: DocListCursor | null,
  limit: number,
): Promise<DocListRow[]> {
  const columns = `d.id AS id, d.title AS title, d.created_at AS created_at,
                   d.updated_at AS updated_at,
                   (SELECT MAX(v.n) FROM versions v WHERE v.doc_id = d.id) AS version`;
  const order = "ORDER BY d.created_at DESC, d.id DESC LIMIT ?";

  const statement =
    after === null
      ? db
          .prepare(
            `SELECT ${columns} FROM docs d
              WHERE d.publisher = ? AND d.deleted_at IS NULL
              ${order}`,
          )
          .bind(publisher, limit)
      : db
          .prepare(
            `SELECT ${columns} FROM docs d
              WHERE d.publisher = ? AND d.deleted_at IS NULL
                AND (d.created_at, d.id) < (?, ?)
              ${order}`,
          )
          .bind(publisher, after.created_at, after.id, limit);

  return (await statement.all<DocListRow>()).results;
}
