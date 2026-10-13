-- Private sharing: who may read a document, and the sign-in codes readers use.
-- Additive: the running Worker ignores the new column and tables, so this can be
-- applied before the Worker that uses them ships. See docs/private-sharing.md.
--
-- `anyone` is exactly today's public document and stays the default for every
-- existing row. `invited` means sign in, then be on the list or own the document.
ALTER TABLE docs ADD COLUMN link_access TEXT NOT NULL DEFAULT 'anyone'
  CHECK (link_access IN ('anyone', 'invited'));

-- The invite list is independent of the mode: switching to `anyone` keeps it.
-- `email` is `normalizeEmail()`, the folding `accounts.email` uses.
CREATE TABLE doc_invites (
  doc_id     TEXT    NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  email      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, email)
);

-- One live emailed sign-in code per address; a new request replaces the old row.
-- Only the hash is stored.
CREATE TABLE email_codes (
  email      TEXT    PRIMARY KEY,
  code_hash  TEXT    NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
