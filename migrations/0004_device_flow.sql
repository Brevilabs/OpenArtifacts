-- The device flow, and the tokens an approval earns.
--
-- `0003_accounts.sql` left `device_codes` deliberately minimal: it held only
-- what the approval page reads and writes, and said the device flow would
-- extend this table rather than create a second one. This is that extension.
--
-- Two secrets are involved and they are not interchangeable. The `user_code`
-- is short, spoken aloud, and typed into a phone; it identifies which approval
-- page belongs to which terminal. The `device_code` is long, never displayed,
-- and is what the terminal polls with — it is the only thing that can collect
-- the token, so knowing a user code buys nothing.

-- SHA-256 of the device code the terminal polls with. The raw value exists in
-- the mint response and in the terminal's memory, and nowhere else — never in a
-- row and never in a log, exactly like a license key.
--
-- Nullable because `ALTER TABLE ... ADD COLUMN` cannot be NOT NULL without a
-- default, and because a row can predate a mint: the local development recipe
-- in docs/development.md inserts a code by hand to exercise the approval page.
ALTER TABLE device_codes ADD COLUMN device_code_hash TEXT;

-- What the terminal said it was when it asked for the code, so the approval
-- page can name the thing being approved and the token can carry that name
-- afterwards. Client-supplied text, trimmed and capped by `readDeviceLabel`,
-- escaped where it is rendered. Null when the client sent none.
ALTER TABLE device_codes ADD COLUMN label TEXT;

-- Epoch ms of a refusal on the approval page, and null until one is given.
--
-- Separate from simply letting the code expire, because the two are different
-- news for the person at the terminal: a refusal is final and immediate, an
-- expiry is "nobody got to it in time". It is also the only way to kill a code
-- that someone else started — the RFC 8628 §5.4 phishing case, where a victim
-- lands on a confirmation for a terminal that is not theirs.
ALTER TABLE device_codes ADD COLUMN denied_at INTEGER;

-- Epoch ms of the terminal's last poll, which is what `slow_down` is measured
-- against. RFC 8628 §3.5 lets the server tell a client polling faster than the
-- interval it was given to back off, and that needs the previous poll's time.
ALTER TABLE device_codes ADD COLUMN last_polled_at INTEGER;

-- The poll arrives knowing only the device code, so its hash has to name one
-- row exactly. Partial, so hand-inserted rows and rows from before this
-- migration do not collide on null.
CREATE UNIQUE INDEX device_codes_by_device_code
  ON device_codes (device_code_hash)
  WHERE device_code_hash IS NOT NULL;

-- The sweep on the mint path deletes by expiry, and `user_code` is the primary
-- key: without this index that delete is a full scan, and without the delete a
-- user code could never be reused.
CREATE INDEX device_codes_by_expiry ON device_codes (expires_at);

-- The credential an agent holds after an approval.
--
-- It is the *only* thing an agent ever presents, which is what keeps a secret
-- out of the agent's own transcript: nobody types it, it is written to the
-- user's config directory by the CLI and read back from there.
--
-- Only the hash is stored. The raw token is returned exactly once, in the
-- response to the poll that collected it, and there is no path that can show it
-- again — a lost token is replaced by approving again, never recovered.
CREATE TABLE tokens (
  -- The public name of the token: what `GET /api/v1/tokens` lists and what
  -- revoke takes. Deliberately not derived from the secret, so listing tokens
  -- reveals nothing that helps forge one.
  id           TEXT    PRIMARY KEY,
  token_hash   TEXT    NOT NULL UNIQUE,
  -- The account the token publishes as. Holds an `oa_`-prefixed id from
  -- `newAccountId`; an app-sites uuid can never appear here, because a license
  -- key is a different credential with a different path through `src/auth.ts`.
  --
  -- No foreign key onto `accounts`, for the reason `identities` has none: D1
  -- leaves `PRAGMA foreign_keys` off, so it would be documentation that does
  -- not run, and the only writer already holds the account row.
  account_id   TEXT    NOT NULL,
  -- Copied from the device code at issue time, so the label survives the row
  -- that carried it.
  label        TEXT,
  created_at   INTEGER NOT NULL,
  -- Epoch ms, refreshed at most once an hour rather than on every request —
  -- see `touchTokenUse`. Null until the token's first use.
  last_used_at INTEGER,
  -- Epoch ms of revocation, and null while the token is live. The row is kept
  -- rather than deleted so its hash stays taken: a revoked token must go on
  -- failing, and a deleted row would leave nothing to fail against.
  revoked_at   INTEGER
);

-- Listing a token's account, newest first, is the only query this table serves
-- besides the hash lookup the unique constraint already covers.
CREATE INDEX tokens_by_account
  ON tokens (account_id, created_at DESC)
  WHERE revoked_at IS NULL;

-- Fixed-window counter for the device-code mint endpoint.
--
-- Minting is unauthenticated by necessity — the whole point is that the caller
-- has no credential yet — so without a limit anyone could mint codes in bulk
-- and use the verification urls they produce to spam people with approval
-- pages that look like ours because they are ours. The counter is per client
-- address per window, and the address is stored hashed: it is a bucket to
-- count against, not a record of who visited.
CREATE TABLE device_code_requests (
  -- SHA-256 of the client address, or of a fixed placeholder where the platform
  -- reports none.
  client       TEXT    NOT NULL,
  -- Epoch ms of the start of the window this count belongs to.
  window_start INTEGER NOT NULL,
  requests     INTEGER NOT NULL,
  PRIMARY KEY (client, window_start)
);
