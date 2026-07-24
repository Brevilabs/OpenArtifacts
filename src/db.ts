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
