-- Nullable on existing accounts: no newsletter choice has been recorded.
ALTER TABLE accounts ADD COLUMN newsletter_opt_in INTEGER CHECK (newsletter_opt_in IN (0, 1));
ALTER TABLE accounts ADD COLUMN newsletter_choice_at INTEGER;
-- The choice travels through OAuth, but is committed only on device confirmation.
ALTER TABLE device_codes ADD COLUMN newsletter_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (newsletter_opt_in IN (0, 1));
