-- Documents belong to an owner, not to a license key.
--
-- `docs.publisher` held the SHA-256 of a Copilot license key, which made the key
-- itself the identity: rotate keys and you lose sight of your documents, and
-- someone who signs in to symposium.md having never held a key has nothing to
-- look documents up by. It becomes `docs.owner`, holding the app-sites
-- `User.id` — the account UUID that Copilot and symposium.md already share.
--
-- Reusing that id is what keeps this small. Accounts live in the Brevilabs
-- Postgres, not here; this schema stores no email, no account row and no link
-- table. `LicenseKeyConfig.authUserId` already maps a key to the id, and a
-- symposium.md session already carries it, so nothing is derived on either side
-- and the two cannot disagree.
--
-- Nothing reads the column's value — it is only ever compared for equality — so
-- `owner` staying opaque is what lets the identity behind it change without the
-- query layer noticing.
--
-- The foreign key from `docs.publisher` onto `publishers(key_hash)` has to go:
-- a `User.id` has no `publishers` row to point at. SQLite cannot drop a
-- constraint in place, hence the table rebuild below, done now while `docs` is
-- small — the rebuild copies every row, so its cost only grows.
--
-- What that foreign key used to guarantee, no doc without a publisher row we had
-- validated, is now the auth path's job alone. No version of this design keeps
-- it as a database constraint.

-- The resolved account id, cached beside the plan on the row that already caches
-- license validation. Null while the license server does not return one — which
-- is every row on the day this ships, since that field does not exist yet.
-- `Publisher.owner` falls back to the key hash for those, which is exactly the
-- behaviour they have now, so nothing observable changes on deploy and this can
-- land before the license server catches up.
ALTER TABLE publishers ADD COLUMN owner TEXT;

-- `versions.doc_id` cascades on delete from `docs`, so the version log is moved
-- aside before `docs` is dropped — dropping the parent with that child still
-- attached would take every version row with it. Rebuilding `versions` at the
-- end is also what re-points its foreign key at the new table.
CREATE TABLE versions_carry (
  doc_id     TEXT    NOT NULL,
  n          INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  title      TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO versions_carry (doc_id, n, size, title, created_at)
  SELECT doc_id, n, size, title, created_at FROM versions;
DROP TABLE versions;

CREATE TABLE docs_new (
  id             TEXT    PRIMARY KEY,
  -- An app-sites `User.id`, or the SHA-256 of a license key for a doc published
  -- before account ids were available. Opaque either way: no query interprets
  -- it, and none should start.
  owner          TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  latest_version INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
INSERT INTO docs_new (id, owner, title, latest_version, created_at, updated_at, deleted_at)
  SELECT id, publisher, title, latest_version, created_at, updated_at, deleted_at FROM docs;
DROP TABLE docs;
ALTER TABLE docs_new RENAME TO docs;

-- Unchanged in shape from `docs_by_publisher_live`, which went with the old
-- table: it still supplies both the filter and the ordering for the keyset walk
-- in `listPublisherDocs`, and is still partial so soft-deleted docs cost nothing.
CREATE INDEX docs_by_owner_live
  ON docs (owner, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE versions (
  doc_id     TEXT    NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  n          INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  title      TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, n)
);
INSERT INTO versions (doc_id, n, size, title, created_at)
  SELECT doc_id, n, size, title, created_at FROM versions_carry;
DROP TABLE versions_carry;

-- The daily push counter is keyed on the same id, so it follows the same rename.
-- A plain rename rather than a rebuild: nothing references this table.
ALTER TABLE push_quota RENAME COLUMN publisher TO owner;
