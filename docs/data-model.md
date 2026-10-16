# Data model

Every place this Worker keeps state, on one page: D1 tables, R2 keys, Durable
Object storage, and the small rest. Current as of migration `0015_comments.sql`.

> **Update this file in the same PR as any migration or storage-key change.**

[← README](../README.md) · [Hosting](hosting.md) · [Identity](identity.md) · [Storage allowance](storage-allowance.md) · [Comments](comments.md)

Conventions: timestamps are epoch milliseconds (`INTEGER`) unless stated. D1
enforces foreign keys: an orphan child insert fails and `ON DELETE CASCADE` fires.
The only `DELETE FROM docs` is `rollbackCreate` (`src/db.ts`), which cascades into
`versions`, `storage_usage`, `doc_invites` and `doc_access_requests`. Enforced
references: those four to `docs(id)`, and `owner_links.account_id` and
`account_handoffs.account_id` to `accounts(id)`. Every other `*_id` or `owner`
column is a plain column. Raw secrets are never stored; a column called `*_hash`
is a SHA-256. Account ids are `oa_` plus 26 base32 characters; any other owner id
is an app-sites `User.id` from the license server.

## D1

Binding `DB`, database `symposium`, migrations in `migrations/`. Sixteen tables.

### Documents

#### `docs`

One row per shared document. Never deleted once a push has landed: a withdrawn
doc keeps its row so its url answers 410.

| Column | Type | Null / default | Meaning |
| --- | --- | --- | --- |
| `id` | TEXT | PK | Doc id, 16 base32 characters; the public url capability |
| `owner` | TEXT | NOT NULL | Owner id, always derived from the credential, never from input |
| `title` | TEXT | NOT NULL | Latest non-null version title |
| `latest_version` | INTEGER | NOT NULL, 0 | Version counter, bumped by `UPDATE ... RETURNING` |
| `created_at` | INTEGER | NOT NULL | |
| `updated_at` | INTEGER | NOT NULL | Last landed push |
| `deleted_at` | INTEGER | NULL | Set on withdrawal; tombstone, serves 410 |
| `link_access` | TEXT | NOT NULL, `'anyone'` | CHECK in (`anyone`, `invited`); `invited` means sign in and be on `doc_invites` or own it |
| `comments_enabled` | INTEGER | NOT NULL, 0 | Owner's switch for inline comments |

- Indexes: `docs_by_owner_live (owner, created_at DESC, id DESC) WHERE deleted_at IS NULL` (list and live-doc quota), `docs_by_owner (owner)` (storage quota counts tombstones).
- Written by: push (insert, version bump, title, `updated_at`), withdrawal (`deleted_at`), the Share and comments toggles. The only `DELETE` is the rollback of an empty create.

#### `versions`

Immutable log, one row per push. PK `(doc_id, n)`.

| Column | Type | Null / default | Meaning |
| --- | --- | --- | --- |
| `doc_id` | TEXT | NOT NULL | Owning doc |
| `n` | INTEGER | NOT NULL | Version number, from 1 |
| `size` | INTEGER | NOT NULL | Bytes of the publisher's stored HTML, before injection |
| `title` | TEXT | NULL | Title this push asked for; null if none |
| `created_at` | INTEGER | NOT NULL | |

- Written by: push, after the R2 put. Removed only when a push loses a race with a delete.

#### `storage_usage`

Byte ledger for the storage allowance. PK `(doc_id, n)`. Columns: `doc_id`, `n`,
`size` (`CHECK size > 0`). Reserved before the R2 write, credited back only when R2
confirms the exact key is gone, so it can exceed `versions`. Seeded from `versions`
by `0013`. See [storage-allowance.md](storage-allowance.md). Written by: push,
withdrawal.

#### `push_quota`

Daily push counter. PK `(owner, day)`. Columns: `owner`, `day` (UTC `YYYY-MM-DD`
text), `pushes` (NOT NULL, 0). Summed across the owner scope (a license owner and
its linked account share one allowance). Written by: one upsert per push, refunded
when a push is rejected after counting.

### Private sharing

#### `doc_invites`

Invite list, kept when the doc goes back to `anyone`. PK `(doc_id, email)`.

| Column | Type | Null / default | Meaning |
| --- | --- | --- | --- |
| `doc_id` | TEXT | NOT NULL | |
| `email` | TEXT | NOT NULL | `normalizeEmail()` form |
| `role` | TEXT | NOT NULL, `'comment'` | CHECK in (`view`, `comment`) |
| `created_at` | INTEGER | NOT NULL | |

- Written by: the owner's invite endpoints; role changes; emptied on withdrawal.

#### `doc_access_requests`

Pending "Request access" clicks. PK `(doc_id, email)`. Columns: `doc_id`, `email`
(the signed-in account's email, never typed), `created_at`. Rows leave on approve,
decline or withdrawal.

#### `invite_sends`

Ledger for the daily cap on new invites, no key. Columns: `owner`, `created_at`.
Index `invite_sends_by_owner (owner, created_at)`. Outlives its document by design
(no foreign key). `owner` is the doc's owner, not the caller.

- Written: one row only when `insertInvite` actually inserts a `doc_invites` row (same batch, guarded by `changes()`). A refused add, a full list or a repeat address writes nothing.
- Deleted: only by pruning. Every `insertInvite` call, refused or not, deletes the owner scope's rows older than 24 hours (`INVITE_WINDOW_MS`). Removing an invite, role changes and withdrawal never touch it.

#### `email_codes`

One live emailed sign-in code per address. PK `email`. Columns: `email`,
`code_hash`, `attempts` (NOT NULL, 0), `expires_at`.

- Expired rows are swept on every code request.
- A new request replaces a live code but keeps its `attempts`. An exhausted code cannot be replaced until it expires.
- Each guess increments `attempts` before the comparison. A correct code deletes the row.

#### `embed_handoffs`

Share popover sign-in handoff, one minute and one use. PK `h` (hash of a nonce
only the frame knows). Columns: `h`, `doc_id`, `account_id`, `expires_at`. Swept
by the next popup that writes one.

### Identity and credentials

#### `accounts`

Accounts this deployment owns. PK `id`. Also holds the cached plan.

| Column | Type | Null / default | Meaning |
| --- | --- | --- | --- |
| `id` | TEXT | PK | `oa_` id |
| `email` | TEXT | NOT NULL, UNIQUE | Provider-verified, lowercased; what merges providers |
| `created_at` | INTEGER | NOT NULL | |
| `plan` | TEXT | NOT NULL, `'free'` | Plan name; maps into `PLAN_LIMITS` |
| `plan_expires_at` | INTEGER | NULL | CHECK >= 0; end of paid validity |
| `plan_checked_at` | INTEGER | NULL | CHECK >= 0; last entitlement refresh; null forces a refresh |
| `plan_retry_after` | INTEGER | NULL | Entitlement outage backoff |
| `newsletter_opt_in` | INTEGER | NULL | CHECK in (0, 1); null means no choice recorded |
| `newsletter_choice_at` | INTEGER | NULL | When the choice was saved |
| `newsletter_synced_at` | INTEGER | NULL | When the opt-in reached the mailing list |
| `display_name` | TEXT | NULL | Comment author name, at most 64 characters (Worker-checked) |

- Written by: first approval (insert), entitlement refresh and admin plan changes (`plan*`), newsletter sync, the display-name prompt. Trigger `owner_link_refresh` clears `plan_checked_at` and `plan_retry_after` when an owner link is inserted.

#### `identities`

Provider identities that return someone to an account. PK `(provider, subject)`;
`UNIQUE (provider, account_id)`. Columns: `provider` (`google` or `github`),
`subject` (permanent provider id, never email), `account_id`, `created_at`. Written
by: account creation and later provider linking.

#### `tokens`

Agent credentials earned by a device approval. PK `id`.

| Column | Type | Null / default | Meaning |
| --- | --- | --- | --- |
| `id` | TEXT | PK | Public name, shown by list and revoke |
| `token_hash` | TEXT | NOT NULL, UNIQUE | SHA-256 of the secret; the raw token is shown once |
| `account_id` | TEXT | NOT NULL | `oa_` account it publishes as |
| `label` | TEXT | NULL | Copied from the device code |
| `created_at` | INTEGER | NOT NULL | |
| `last_used_at` | INTEGER | NULL | Refreshed at most hourly |

- Index `tokens_by_account (account_id, created_at DESC)`. Revoking deletes the row.
- Written by: poll that collects an approved device code; revoke; use touch.

#### `device_codes`

Transient: a device code, or a browser or reader OAuth handshake. PK `user_code`.
Expired rows are swept on every mint (device, browser sign-in, reader sign-in).
A row is deleted when its handshake completes: the poll that collects a token, a
browser or reader sign-in finishing, or the approval callback ending a handshake.

| Column | Type | Null / default | Meaning |
| --- | --- | --- | --- |
| `user_code` | TEXT | PK | Uppercase code; browser and reader handshakes use `browser_` and `reader_` plus the state |
| `provider` | TEXT | NULL | Provider of the handshake in flight |
| `state` | TEXT | NULL | OAuth `state`; identifies, never authorizes |
| `confirm_token` | TEXT | NULL | Carried by the confirm form; set once an identity is proved |
| `verifier` | TEXT | NULL | PKCE verifier; cleared when spent |
| `account_id` | TEXT | NULL | Account the handshake proved, before approval |
| `approved_at` | INTEGER | NULL | Human's approval; what the poll waits on |
| `expires_at` | INTEGER | NOT NULL | Every step refuses past it |
| `created_at` | INTEGER | NOT NULL | |
| `device_code_hash` | TEXT | NULL | SHA-256 of the polled device code |
| `label` | TEXT | NULL | Client-supplied machine name |
| `denied_at` | INTEGER | NULL | Final refusal |
| `newsletter_opt_in` | INTEGER | NOT NULL, 0 | CHECK in (0, 1); committed only on confirm |
| `pending_subject` | TEXT | NULL | Verified identity held until Terms are accepted |
| `pending_email` | TEXT | NULL | Same |

- Unique partial indexes on `state`, `confirm_token` and `device_code_hash` (each `WHERE ... IS NOT NULL`); `device_codes_by_expiry (expires_at)`.
- Written by: device mint, approval page, browser sign-in, reader sign-in.

#### `account_handoffs`

Short-lived proof that sends a signed-in agent to the account page. PK `code_hash`.
Columns: `code_hash`, `account_id`, `token_id`, `expires_at`. Index
`account_handoffs_by_account (account_id, expires_at)`.

- Single use: `POST /admin/v1/handoffs/consume` deletes the row.
- Life is 10 minutes.
- Each create first sweeps that account's expired rows.
- At most five live per account, counting only handoffs whose token still exists.
- Written by: `POST /api/v1/account/handoffs` (insert), consume (delete).

#### `owner_links`

Joins a license owner's documents to an account without rewriting ownership. PK
`external_owner` (CHECK: 1 to 256 characters, trimmed, not `oa_`-prefixed).
`account_id` is UNIQUE and CHECKed to be a well-formed `oa_` id; `created_at` CHECK
>= 0. **Immutable**: triggers `owner_links_no_update` and `owner_links_no_delete`
abort. This pair defines the owner scope that quotas and `docs` queries read.
Written by: the admin link endpoint, once.

#### `publishers`

License-key validation cache. PK `key_hash` (SHA-256 of the key). Columns: `owner`
(NOT NULL, the app-sites `User.id`), `plan` (NOT NULL), `validated_at` (NOT NULL),
`rejected_at` (NULL, CHECK >= 0; keeps a rejection ordered against in-flight
successes). Rebuilds on the key's next request. Written by: license auth.

## R2

Binding `DOCS`, bucket `symposium-docs`. Key layout is in `src/storage.ts`; the
only keys are under one prefix per doc.

| Key | Content | Written | Deleted | Content type |
| --- | --- | --- | --- | --- |
| `docs/{docId}/v{n}.html` | The publisher's own bytes for version `n`, no injections | Once per push, before the `versions` row | Withdrawal (prefix scan) or a push that lost a race with it | `text/html; charset=utf-8` |
| `docs/{docId}/manifest.json` | Snapshot of the doc's D1 state: `{ schema: 1, docId, owner, title, linkAccess, commentsEnabled, createdAt, updatedAt, deletedAt, latestVersion, people: [{ email, role, createdAt }] }` (`src/manifest.ts`) | Rewritten from D1 and awaited after access, invite and comments writes, whose request fails if the put does; best effort (logged) on create and update; the tombstone on delete | Withdrawal leaves it as the tombstone, and removes it only if the tombstone put fails | `application/json` |
| `docs/{docId}/threads.json` | Snapshot of the comment threads: `{ docId, schema: 1, threads }`, each thread with its comments and per-version anchors | Overwritten by `DocComments` after every mutation, best effort | Withdrawal (same prefix scan) | `application/json` |

- Version objects are immutable: never rewritten, `n` is reserved atomically in D1 first. The robots meta, favicon, social card and bylines are injected on the way out by `renderServedHtml`, never stored.
- `threads.json` is not read at runtime; it exists to rebuild the Durable Object from.
- No custom metadata on any object.
- Withdrawal lists and deletes the whole `docs/{docId}/` prefix, not just `versions` rows, except for the manifest tombstone.

## Durable Objects

One class, `DocComments`, bound as `COMMENTS`, SQLite-backed (migration tag `v1`).
Keyed by `idFromName(docId)`, so one object per document. It keeps threads, so D1
carries only `docs.comments_enabled`. Source: `src/comments/object.ts`.

| Table | Key | Columns |
| --- | --- | --- |
| `threads` | `id` (`th_...`) | `created_version`, `created_by`, `created_at`, `updated_at`, `section`, `anchor_exact`, `anchor_prefix`, `anchor_suffix`, `state` (CHECK `open`/`resolved`), `resolved_by`, `resolved_kind`, `resolved_on_behalf_of`, `resolved_at`, `resolved_at_version` |
| `comments` | `id` (`cm_...`) | `thread_id`, `author`, `author_kind` (CHECK `human`/`agent`), `on_behalf_of`, `body`, `created_at`, `at_version`; index `comments_by_thread (thread_id, created_at)` |
| `anchors` | `(thread_id, version)` | `status` (CHECK `anchored`/`orphaned`), `matched_text`; memo of where a thread sits in each version |

- Tables are created lazily on first use. Caps: 500 threads, 2000 comments, 4000 characters per body.
- Key-value storage: one key, `purged` (`true`), left as a tombstone after withdrawal. Withdrawal calls `purge()`, which deletes all storage and sets it.
- Authors are stored as owner or account ids; display names are joined from D1 `accounts.display_name` on read.

## Other state

| What | Where | Notes |
| --- | --- | --- |
| KV | none | No KV namespace is bound |
| Email | `send_email` binding `EMAIL` | Sends invite, request and sign-in code mail; stores nothing. Optional, absent means no email and no code sign-in |
| Rate limiters | `ratelimits` bindings in `wrangler.jsonc` | Counters live in Cloudflare, no stored data and nothing in D1; absent means no limit |
| Secrets | `LICENSE_API_KEY`, `ADMIN_API_KEY`, `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `READER_SESSION_SECRET`, `POSTHOG_PROJECT_API_KEY` | Names only. `READER_SESSION_SECRET` signs reader sessions and grants, so rotating it signs every reader out |
| Cookies | reader session and publisher-origin grant | Signed and stateless, nothing stored server side; the serving apex is cookieless |
| Cache API | none | The Worker never calls `caches` |
| Edge cache | `cache-control` on served pages | Latest `public, max-age=60`; pinned `/v{n}` `public, max-age=31536000, immutable`; private docs `private, no-store`. A Cache Rule and purge-on-delete are still owed (CLAUDE.md) |
| Plan limits | `PLAN_LIMITS` var | Config, not data; `accounts.plan` names an entry |

## What is the system of record

- **Document state is rebuildable from R2**: `manifest.json` carries owner, title, timestamps, deletion, access and the invite list, and the version objects carry the version log. `src/rebuild.ts` turns them back into `docs`, `doc_invites`, `versions` and `storage_usage` rows, and fails closed (`docs/deploying.md`).
- **D1 is still the only record** of accounts, sessions, owner links, the publishers cache and pending access requests; D1 Time Travel (30 days) covers them. Only `publishers` (and the plan columns on `accounts`) cache something held elsewhere.
- **The Durable Object is the only live record of comments**; `threads.json` is its backup.
