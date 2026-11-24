-- One row per removed owner link, written in the same batch as the delete.
-- `by_owner` = 1 for the account holder's own unlink from the account page,
-- 0 for the admin unlink. The self-serve cooldown counts only `by_owner` rows.
CREATE TABLE owner_unlinks (
  external_owner TEXT NOT NULL,
  account_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  unlinked_at INTEGER NOT NULL CHECK (unlinked_at >= 0),
  by_owner INTEGER NOT NULL CHECK (by_owner IN (0, 1))
);
CREATE INDEX owner_unlinks_by_external_owner ON owner_unlinks (external_owner, unlinked_at);
CREATE INDEX owner_unlinks_by_account ON owner_unlinks (account_id, unlinked_at);
