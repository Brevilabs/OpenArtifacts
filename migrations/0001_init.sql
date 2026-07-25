-- Symposium v0 pointer index.
--
-- R2 is the system of record; every row here is rebuildable by scanning R2.
-- Timestamps are epoch milliseconds (INTEGER), so no date parsing at read time.

-- Publishers, keyed by the SHA-256 of their license key. Raw keys are never
-- stored. This table doubles as the license-validation cache: `validated_at`
-- is the last successful check, and a row younger than the TTL skips the
-- license-server round trip.
CREATE TABLE publishers (
  key_hash     TEXT    PRIMARY KEY,
  plan         TEXT    NOT NULL,
  validated_at INTEGER NOT NULL
);

-- One row per shared doc. `latest_version` is the version counter; it is
-- incremented with a single `UPDATE ... RETURNING`, which is the only
-- atomicity this design needs.
CREATE TABLE docs (
  id             TEXT    PRIMARY KEY,
  publisher      TEXT    NOT NULL REFERENCES publishers(key_hash),
  title          TEXT    NOT NULL,
  latest_version INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);

-- Serves both the cursor-paged "list my docs" scan and the live-doc count the
-- per-key doc quota checks. Partial, so soft-deleted docs cost nothing.
CREATE INDEX docs_by_publisher_live
  ON docs (publisher, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Immutable version log. One row per push; the R2 object for (doc_id, n) is
-- written before the row, so a row always has bytes behind it.
-- `title` is what this push asked the doc to be called, and null when it asked
-- for nothing. It lives here rather than only on `docs` because a title belongs
-- to the push that set it: two overlapping pushes can store out of order, and
-- the doc's title has to resolve by version number, not by which commit ran last.
CREATE TABLE versions (
  doc_id     TEXT    NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  n          INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  title      TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, n)
);

-- Daily push counter per publisher. `day` is a UTC `YYYY-MM-DD` string, so the
-- window rolls without a scheduled reset. Read and written by one upsert on
-- (publisher, day), which the primary key already covers.
CREATE TABLE push_quota (
  publisher TEXT    NOT NULL,
  day       TEXT    NOT NULL,
  pushes    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (publisher, day)
);
