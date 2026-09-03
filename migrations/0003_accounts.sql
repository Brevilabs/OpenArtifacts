-- Accounts OpenArtifacts owns, created by the first approval.
--
-- Until now the only identity in this repo was a Brevilabs license key, and
-- `docs.owner` was always an app-sites `User.id` resolved through the license
-- server. That made an open source project depend on a private service, and it
-- left anyone without a Copilot license with nothing to publish as. An account
-- here is the other way in: a verified email, an id of our own, and nothing
-- else.
--
-- The two id spaces are deliberately disjoint rather than merged. A license
-- key keeps resolving to its app-sites uuid, an account minted here carries the
-- `oa_` prefix `newAccountId` gives it, and no equality test can ever confuse
-- one for the other. Merging them would mean trusting an email to name an
-- app-sites account, which is exactly the claim OAuth cannot make.

CREATE TABLE accounts (
  id         TEXT    PRIMARY KEY,
  -- The address a provider asserted *and* said it had verified. Unique, because
  -- it is the only thing that makes approving with Google and then with GitHub
  -- land on one account rather than two. Stored lowercased and trimmed
  -- (`normalizeEmail`), since the uniqueness is only as good as the folding.
  email      TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- The pending device codes an approval binds an account to.
--
-- **Minimal on purpose: #57 owns the device flow and extends this table.** The
-- approval page needs exactly one write — bind this account to the code the CLI
-- is polling — so only the columns that write touches exist here. The device
-- code the CLI holds, its token, the machine label and the polling bookkeeping
-- all belong to #57, which should add columns to this table rather than create
-- a second one.
--
-- `user_code` is the primary key because it is what the human sees and what the
-- approval url carries. It is stored uppercase; `normalizeUserCode` folds the
-- request's copy so a code typed by hand still matches.
CREATE TABLE device_codes (
  user_code   TEXT    PRIMARY KEY,
  -- The account that approved, and null while the code is still pending. Not a
  -- foreign key onto `accounts`: D1 leaves `PRAGMA foreign_keys` off, so the
  -- constraint would be documentation that does not run, and the only writer is
  -- `approveDeviceCode`, which has the account row in hand.
  account_id  TEXT,
  -- Epoch ms of the approval, and null while pending. Paired with `account_id`
  -- by the single `UPDATE` that sets them, so one is never present alone.
  approved_at INTEGER,
  -- Epoch ms. An approval past it is refused, so a code left on a screen
  -- overnight cannot be approved by whoever walks past next.
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
