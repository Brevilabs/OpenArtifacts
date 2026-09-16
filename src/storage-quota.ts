import { OWNER_SCOPE_SQL } from "./owners.js";

/** Includes retained versions, pending writes and unsuccessful withdrawals. */
export async function storedBytes(db: D1Database, owner: string): Promise<number> {
  const row = await db.prepare(`${OWNER_SCOPE_SQL}
    SELECT COALESCE(SUM(s.size), 0) AS bytes FROM storage_usage s JOIN docs d ON d.id = s.doc_id
    WHERE d.owner IN (SELECT owner FROM owner_scope)`)
    .bind(owner, owner).first<{ bytes: number }>();
  return row!.bytes;
}

/** One statement serializes all documents and linked credentials at the ceiling. */
export async function reserveStorage(db: D1Database, owner: string, docId: string, version: number, size: number, limit?: number): Promise<boolean> {
  const result = await db.prepare(`${OWNER_SCOPE_SQL}
    INSERT INTO storage_usage (doc_id, n, size)
    SELECT ?, ?, ? WHERE ? IS NULL OR (
      SELECT COALESCE(SUM(s.size), 0) FROM storage_usage s JOIN docs d ON d.id = s.doc_id
      WHERE d.owner IN (SELECT owner FROM owner_scope)
    ) + ? <= ?`)
    .bind(owner, owner, docId, version, size, limit ?? null, size, limit ?? null).run();
  return result.meta.changes > 0;
}

/** Call only after R2 confirms removal. Exact keys make repeated cleanup harmless. */
export async function releaseStorage(db: D1Database, docId: string, versions: number[]): Promise<void> {
  if (versions.length === 0) return;
  await db.prepare("DELETE FROM storage_usage WHERE doc_id = ? AND n IN (SELECT value FROM json_each(?))")
    .bind(docId, JSON.stringify(versions)).run();
}
