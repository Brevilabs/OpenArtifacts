-- Delivery state is separate from the saved newsletter consent.
ALTER TABLE accounts ADD COLUMN newsletter_synced_at INTEGER;
