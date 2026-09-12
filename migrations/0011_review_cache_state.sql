-- A rejection must survive overlapping successful license checks.
ALTER TABLE publishers ADD COLUMN rejected_at INTEGER CHECK (rejected_at >= 0);

-- Bound entitlement retries during an outage independently of paid validity.
ALTER TABLE accounts ADD COLUMN plan_retry_after INTEGER;
DROP TRIGGER owner_link_refresh;
CREATE TRIGGER owner_link_refresh AFTER INSERT ON owner_links
BEGIN
  UPDATE accounts SET plan_checked_at = NULL, plan_retry_after = NULL WHERE id = NEW.account_id;
END;
