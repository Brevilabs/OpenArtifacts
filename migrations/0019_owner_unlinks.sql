-- An operator may remove a mistaken owner link, but only together with a
-- permanent audit row for that exact link (owner, account, creation time).
CREATE TABLE owner_unlinks (
  external_owner TEXT NOT NULL,
  account_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,            -- the removed link's created_at
  unlinked_at INTEGER NOT NULL CHECK (unlinked_at >= 0),
  PRIMARY KEY (external_owner, linked_at)
);

-- The plan came through the link: end it and force a refresh (compare 0011).
CREATE TRIGGER owner_unlink_refresh AFTER DELETE ON owner_links
BEGIN
  UPDATE accounts SET plan_expires_at = 0, plan_checked_at = NULL, plan_retry_after = NULL
  WHERE id = OLD.account_id;
END;

-- Create the new guard before dropping the old one, so a delete guard exists
-- after every statement even if D1 applies the file one statement at a time.
CREATE TRIGGER owner_links_audited_delete BEFORE DELETE ON owner_links
WHEN NOT EXISTS (
  SELECT 1 FROM owner_unlinks
  WHERE external_owner = OLD.external_owner AND account_id = OLD.account_id
    AND linked_at = OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'owner associations are removed only by an audited unlink'); END;
DROP TRIGGER owner_links_no_delete;
