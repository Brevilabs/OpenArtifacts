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
  /** Highest version number minted; 0 before the first push lands. */
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
