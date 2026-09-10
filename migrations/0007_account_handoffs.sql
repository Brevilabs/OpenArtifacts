-- Short-lived account proof for a trusted integration; never store raw codes.
CREATE TABLE account_handoffs (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  token_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('upgrade', 'billing', 'link')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX account_handoffs_by_account ON account_handoffs(account_id, expires_at);
