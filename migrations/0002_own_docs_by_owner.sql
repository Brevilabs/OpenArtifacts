-- Documents belong to an account, not to a license key.
--
-- `docs.publisher` held the SHA-256 of a Copilot license key, which made the
-- key the identity: rotate keys and you lose sight of your documents, and
-- someone who signs in to symposium.md having never held a key has nothing to
-- look documents up by. It becomes `docs.owner`, holding the app-sites
-- `User.id` — the account that `LicenseKeyConfig.authUserId` attaches a key to,
-- and that a symposium.md session already carries.
--
-- **This replaces the v0 tables rather than migrating them.** Nothing is live:
-- every row is development test data and the R2 objects behind it are
-- disposable. Carrying rows across would mean keeping documents filed under key
-- hashes, which under the new rule are owned by an account id that does not
-- exist — rows no dashboard could ever show and no publisher could ever delete.
-- Dropping them is not a shortcut around a migration; it is the migration.
--
-- Orphaned R2 objects under `docs/` are the one loose end, and they are
-- development bytes with no row pointing at them. Empty the bucket alongside
-- this if you want it tidy.
--
-- `publishers` is a validation cache, so it is dropped for free: every row
-- rebuilds on its key's next request.

DROP TABLE versions;
DROP TABLE push_quota;
DROP TABLE docs;
DROP TABLE publishers;

-- Publishers, keyed by the SHA-256 of their license key. Raw keys are never
-- stored. This table doubles as the license-validation cache: `validated_at` is
-- the last successful check, and a row younger than the TTL skips the license
-- server round trip.
CREATE TABLE publishers (
  key_hash     TEXT    PRIMARY KEY,
  -- The app-sites `User.id` this key belongs to, from the license server's
  -- `accountId`. Not null on purpose: a key we cannot attribute to an account
  -- cannot publish, because there would be nobody to file the document under.
  -- Auth refuses such a response rather than inventing an owner for it.
  owner        TEXT    NOT NULL,
  plan         TEXT    NOT NULL,
  validated_at INTEGER NOT NULL
);

-- One row per shared doc. `latest_version` is the version counter; it is
-- incremented with a single `UPDATE ... RETURNING`, which is the only atomicity
-- this design needs.
CREATE TABLE docs (
  id             TEXT    PRIMARY KEY,
  -- An app-sites `User.id`. Deliberately not a foreign key onto `publishers`:
  -- that table is keyed by license key, and an account is not one. The
  -- invariant it used to carry — no doc without a publisher we validated — is
  -- the auth path's, since only a resolved publisher reaches a write.
  owner          TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  latest_version INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);

-- Serves both the cursor-paged "list my docs" scan and the live-doc count the
-- per-account doc quota checks. Partial, so soft-deleted docs cost nothing.
CREATE INDEX docs_by_owner_live
  ON docs (owner, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Immutable version log. One row per push; the R2 object for (doc_id, n) is
-- written before the row, so a row always has bytes behind it.
CREATE TABLE versions (
  doc_id     TEXT    NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  n          INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  title      TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, n)
);

-- Daily push counter per account. `day` is a UTC `YYYY-MM-DD` string, so the
-- window rolls without a scheduled reset. Per account rather than per key: two
-- keys on one account share one allowance, which is what the limit means.
CREATE TABLE push_quota (
  owner  TEXT    NOT NULL,
  day    TEXT    NOT NULL,
  pushes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, day)
);
