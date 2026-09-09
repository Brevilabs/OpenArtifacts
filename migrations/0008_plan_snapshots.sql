-- A service may deliver ordered plan snapshots with a bounded validity period.
-- Existing manual assignments remain unlimited and start behind every revision.
ALTER TABLE accounts ADD COLUMN plan_expires_at INTEGER CHECK (plan_expires_at >= 0);
ALTER TABLE accounts ADD COLUMN plan_revision INTEGER NOT NULL DEFAULT 0 CHECK (plan_revision >= 0);
