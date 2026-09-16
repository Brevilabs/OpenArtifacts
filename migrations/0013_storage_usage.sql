-- Reserve bytes before an upload starts, including writes with uncertain outcomes.
-- Seed known versions conservatively, including deleted documents: deletion may
-- have failed in R2. Reconcile against R2 before enabling a storage allowance;
-- see docs/storage-allowance.md. Never assume D1 describes all historical objects.
-- Quota includes tombstones, unlike the existing live-document partial index.
CREATE INDEX docs_by_owner ON docs(owner);
CREATE TABLE storage_usage (
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  PRIMARY KEY (doc_id, n)
);
INSERT INTO storage_usage (doc_id, n, size)
  SELECT doc_id, n, size FROM versions WHERE size > 0;
