-- Browser account access is separate from device/publishing credentials.
CREATE TABLE browser_logins (
  state_hash TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  verifier TEXT,
  claimed INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  terms_accepted_at INTEGER NOT NULL,
  subject TEXT,
  email TEXT,
  code_hash TEXT
);
CREATE INDEX browser_logins_expiry ON browser_logins(expires_at);
