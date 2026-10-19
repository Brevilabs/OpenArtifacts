-- One permanent, random, 6-character subdomain per publisher: the origin that
-- publisher's invited-only pages are served from (`{code}.openartifacts.site`).
-- It replaces the 26-character label that was a hash of `docs.owner` and was
-- never stored. Additive: the running Worker ignores the table, so this can be
-- applied before the Worker that uses it ships (the deploy workflow refuses to
-- deploy over an unapplied migration).
--
-- `owner` is `docs.owner`, an app-sites `User.id`, never a caller's id. The code
-- is an address, not a password: it is random, so it reveals nothing about the
-- owner, and it grants nothing; every request still checks `canRead`.
--
-- Rows are allocated lazily, the first time a publisher origin URL is needed, so
-- a publisher with no invited-only page has none. They are NEVER updated and
-- NEVER deleted, not when the account or its documents go: a code is never
-- reassigned, so a link to a withdrawn publisher cannot start serving someone
-- else. UNIQUE makes a random collision fail the insert, and allocation retries.
--
-- Rebuildable: each document's manifest in R2 records its owner's code
-- (`originCode`), and `src/rebuild.ts` emits these rows back.
CREATE TABLE publisher_origins (
  owner      TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
