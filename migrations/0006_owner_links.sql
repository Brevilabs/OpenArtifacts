-- Join document collections without rewriting ownership or in-flight counters.
-- The credential owner remains unchanged, particularly for token administration.
CREATE TABLE owner_links (
  external_owner TEXT NOT NULL PRIMARY KEY
    CHECK (length(external_owner) BETWEEN 1 AND 256
           AND trim(external_owner) = external_owner
           AND substr(external_owner, 1, 3) <> 'oa_'),
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id)
    CHECK (length(account_id) = 29 AND substr(account_id, 1, 3) = 'oa_'
           AND substr(account_id, 4) NOT GLOB '*[^0-9abcdefghjkmnpqrstvwxyz]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

-- There is no unlink/transfer operation: credentials already granted access to
-- the joined collection must never silently change which collection they name.
CREATE TRIGGER owner_links_no_update BEFORE UPDATE ON owner_links
BEGIN SELECT RAISE(ABORT, 'owner associations are immutable'); END;
CREATE TRIGGER owner_links_no_delete BEFORE DELETE ON owner_links
BEGIN SELECT RAISE(ABORT, 'owner associations are immutable'); END;
