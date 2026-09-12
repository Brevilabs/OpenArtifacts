-- Hold a verified identity until the person accepts Terms and creates an account.
ALTER TABLE device_codes ADD COLUMN pending_subject TEXT;
ALTER TABLE device_codes ADD COLUMN pending_email TEXT;
