-- One custom domain per account: a subdomain the publisher owns, such as
-- `docs.acme.com`, that serves the account's pages as a second address for its
-- own origin (docs/private-sharing.md). Additive: the running Worker ignores
-- the table, so this can be applied before the Worker that uses it ships.
--
-- A row is pending while `active_at` is NULL and live once it is set. Only
-- **Check now** sets `active_at`, after it finds `token` in the domain's TXT
-- record and Cloudflare reports the hostname and its certificate active. The
-- daily sync only clears it. A pending claim blocks no one; the partial unique
-- index lets only one account be live on a hostname, and the newest proof
-- deletes the older live row.
--
-- `proved_at` says this row may own a Cloudflare custom hostname, so Remove
-- domain must delete it there. Not in the manifests: like `accounts` and
-- `owner_links` this is account configuration, and D1 Time Travel covers it.
CREATE TABLE publisher_hosts (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id),
  hostname    TEXT NOT NULL,
  token       TEXT NOT NULL,
  proved_at   INTEGER,
  active_at   INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX publisher_hosts_live ON publisher_hosts (hostname) WHERE active_at IS NOT NULL;
