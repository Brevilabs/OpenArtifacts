-- Inline comments. Additive: the running Worker ignores both columns, so this
-- can be applied before the Worker that uses them ships. The threads and
-- comments themselves are not here: they live in one SQLite Durable Object per
-- document (src/comments/object.ts), which keeps a hot, write-heavy,
-- per-document workload out of D1's write budget.
--
-- `comments_enabled` is the owner's switch. Off is the default for every
-- existing row, and turning it off deletes nothing.
ALTER TABLE docs ADD COLUMN comments_enabled INTEGER NOT NULL DEFAULT 0;

-- Asked once, the first time a person comments; 64 characters at most (checked
-- by the Worker). Free text and not unique. It is the only name a card shows.
ALTER TABLE accounts ADD COLUMN display_name TEXT;
