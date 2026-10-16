-- Whether a document has ever had a thread: the "a thread exists" half of "this
-- page has comments" (the other half is a person on the list at role `comment`
-- or above). Additive: the running Worker ignores the column, so this can be
-- applied before the Worker that uses it ships.
--
-- The service sets it to 1 after every successful thread create and never
-- clears it. It is rebuildable: a document has threads exactly when
-- `docs/{id}/threads.json` in R2 holds one. No existing row has threads (comments
-- were never on for any document), so 0 is right for every row.
ALTER TABLE docs ADD COLUMN has_threads INTEGER NOT NULL DEFAULT 0;
