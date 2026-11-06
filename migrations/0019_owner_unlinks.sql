-- One row per removed owner link; the row is what lets that one link be deleted.
CREATE TABLE owner_unlinks (
  external_owner TEXT NOT NULL,
  account_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,   -- the removed link's created_at
  unlinked_at INTEGER NOT NULL,
  PRIMARY KEY (external_owner, linked_at)
);
DROP TRIGGER owner_links_no_delete;
CREATE TRIGGER owner_links_no_delete BEFORE DELETE ON owner_links
WHEN NOT EXISTS (SELECT 1 FROM owner_unlinks u WHERE u.external_owner = OLD.external_owner
  AND u.account_id = OLD.account_id AND u.linked_at = OLD.created_at)
BEGIN SELECT RAISE(ABORT, 'owner associations are immutable'); END;
