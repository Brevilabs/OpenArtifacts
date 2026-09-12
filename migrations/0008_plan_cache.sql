-- Unshipped pull cache: freshness and paid validity are independent.
ALTER TABLE accounts ADD COLUMN plan_expires_at INTEGER CHECK (plan_expires_at >= 0);
ALTER TABLE accounts ADD COLUMN plan_checked_at INTEGER CHECK (plan_checked_at >= 0);
UPDATE accounts SET plan_checked_at = created_at;
CREATE TRIGGER owner_link_refresh AFTER INSERT ON owner_links
BEGIN UPDATE accounts SET plan_checked_at = NULL WHERE id = NEW.account_id; END;
