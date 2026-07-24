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
 * Create the `docs` row for a first push, already carrying version 1.
 *
 * A freshly minted id is private to this request, so nothing can race for its
 * first version and the insert *is* the reservation — the `UPDATE ... RETURNING`
 * dance below only earns its keep once a doc is reachable by id.
 *
 * `publisher` is a foreign key onto `publishers`, so this fails unless auth has
 * already written that row. That is the intended coupling: no doc without a
 * publisher we validated.
 */
export async function insertDoc(
  db: D1Database,
  doc: Omit<DocRow, "deleted_at" | "latest_version">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO docs (id, publisher, title, latest_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(doc.id, doc.publisher, doc.title, FIRST_VERSION, doc.created_at, doc.updated_at)
    .run();
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
 * `title` is null on a push that does not carry one, which keeps the existing
 * title rather than blanking it.
 */
export async function reserveNextVersion(
  db: D1Database,
  docId: string,
  publisher: string,
  title: string | null,
  atMs: number,
): Promise<number | null> {
  const reserved = await db
    .prepare(
      `UPDATE docs
          SET latest_version = latest_version + 1,
              title = COALESCE(?, title),
              updated_at = ?
        WHERE id = ? AND publisher = ? AND deleted_at IS NULL
        RETURNING latest_version`,
    )
    .bind(title, atMs, docId, publisher)
    .first<{ latest_version: number }>();

  return reserved?.latest_version ?? null;
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
    .prepare("INSERT INTO versions (doc_id, n, size, created_at) VALUES (?, ?, ?, ?)")
    .bind(version.doc_id, version.n, version.size, version.created_at)
    .run();
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
