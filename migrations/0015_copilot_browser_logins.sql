-- Preserve pending browser flows while adding the independently proven Copilot identity.
CREATE TABLE browser_logins_with_copilot (
  state_hash TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'copilot')),
  verifier TEXT,
  claimed INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  terms_accepted_at INTEGER NOT NULL,
  subject TEXT,
  email TEXT,
  code_hash TEXT
);
INSERT INTO browser_logins_with_copilot SELECT * FROM browser_logins;
DROP TABLE browser_logins;
ALTER TABLE browser_logins_with_copilot RENAME TO browser_logins;
CREATE INDEX browser_logins_expiry ON browser_logins(expires_at);
