-- The display name a provider sent at sign-in, held with the proven identity until the
-- person accepts Terms and the account is created, then written to accounts.display_name
-- and cleared with the other pending_* columns. Additive.
ALTER TABLE device_codes ADD COLUMN pending_name TEXT;
