/**
 * Row types for the D1 pointer index, one per table in `migrations/`.
 *
 * D1 holds pointers only — ids, sizes, timestamps. The bytes live in R2, and
 * every row here is reconstructible from it, so a lost D1 is a rebuild rather
 * than a data loss. Queries land here as the phase that needs them arrives.
 */

/** Publisher row, which doubles as the license-validation cache (phase 2). */
export interface PublisherRow {
  /** SHA-256 of the license key. Raw keys are never stored. */
  key_hash: string;
  plan: string;
  /** Epoch ms of the last successful license-server validation. */
  validated_at: number;
  /** The app-sites `User.id` this key belongs to. */
  owner: string;
}

export interface DocRow {
  id: string;
  /** The app-sites `User.id` that owns the doc. */
  owner: string;
  title: string;
  /**
   * Highest version number *reserved*; 0 before the first push lands.
   *
   * Reserved, not stored: the number is minted before the R2 object is written,
   * so a push that dies in between leaves this one above the newest version
   * that actually has bytes. It is the counter, never the pointer — anything
   * resolving a doc to bytes must go through `versions`, whose rows are written
   * after their object and therefore always have one.
   */
  latest_version: number;
  created_at: number;
  updated_at: number;
  /** Epoch ms when soft-deleted, else null. Deleted docs serve 410, not 404. */
  deleted_at: number | null;
}

export interface VersionRow {
  doc_id: string;
  n: number;
  /** Byte length of the stored R2 object. */
  size: number;
  /** The title this push asked for, or null when it asked for none. */
  title: string | null;
  created_at: number;
}

export interface PushQuotaRow {
  /** The owner id from `docs.owner`, so the ceiling follows the documents. */
  owner: string;
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  pushes: number;
}

/**
 * An account this deployment owns, created by its holder's first approval.
 *
 * Distinct from `publishers`, which caches what the license server says about a
 * credential. This row *is* the identity: nothing outside is asked about it.
 */
export interface AccountRow {
  /** Carries `ACCOUNT_ID_PREFIX`, so it can never collide with a license owner. */
  id: string;
  /** Lowercased, provider-verified. Unique, which is what merges the providers. */
  email: string;
  created_at: number;
}

/**
 * A provider identity that resolves to an account on a later sign-in.
 *
 * The email creates an account; this returns someone to one. The two are
 * different questions because an address can be reassigned to another person
 * and a provider's subject cannot.
 */
export interface IdentityRow {
  /** `google` or `github`. */
  provider: string;
  /** Google's `sub`, or GitHub's numeric user id as a string. */
  subject: string;
  account_id: string;
  created_at: number;
}

/**
 * A device code a terminal is polling, and the OAuth handshake proving who is
 * approving it.
 *
 * One row carries three lifetimes that overlap: the code itself, which lives
 * until it is collected or expires; a handshake, which lives from a provider
 * button to the confirmation page; and the outcome, which is an approval, a
 * refusal, or neither. Every column that is null between handshakes is null
 * because the handshake that set it is over.
 */
export interface DeviceCodeRow {
  /** Uppercase, as `normalizeUserCode` folds it. */
  user_code: string;
  /** The provider of the handshake in flight, and null between handshakes. */
  provider: string | null;
  /**
   * The OAuth `state` of the handshake in flight; cleared once confirmed. It
   * identifies a handshake and authorizes nothing — whoever started it was
   * handed it in their redirect.
   */
  state: string | null;
  /** The token the confirm form carries. Only the returning browser sees it. */
  confirm_token: string | null;
  /** The PKCE verifier of the handshake in flight; cleared once spent. */
  verifier: string | null;
  /** The account a completed handshake proved, before anyone approved it. */
  account_id: string | null;
  /** Epoch ms of the human's approval, and null until it is given. */
  approved_at: number | null;
  /** SHA-256 of the device code the terminal polls with. Never the raw value. */
  device_code_hash: string | null;
  /** What the terminal called itself when it asked for the code. */
  label: string | null;
  /** Epoch ms of a refusal on the approval page, and null until one is given. */
  denied_at: number | null;
  /** Epoch ms of the terminal's last poll, which `slow_down` is measured from. */
  last_polled_at: number | null;
  expires_at: number;
  created_at: number;
}

/**
 * The half of a pending handshake the callback needs to finish it. The label
 * rides along so the confirmation page can name the machine being approved
 * instead of calling it "that terminal".
 */
export type PendingHandshake = Pick<
  DeviceCodeRow,
  "user_code" | "provider" | "verifier" | "label"
>;

/**
 * A token an approval issued.
 *
 * The value itself is not here and cannot be: only `token_hash` is stored, and
 * the raw token exists once, in the response to the poll that collected it.
 */
export interface TokenRow {
  id: string;
  token_hash: string;
  account_id: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** A live token as `GET /api/v1/tokens` reports it. The hash never leaves D1. */
export type ListedTokenRow = Pick<TokenRow, "id" | "label" | "created_at" | "last_used_at">;

/**
 * The publisher row as auth needs it: read the cached validation, write it back
 * after a fresh one. It is an interface rather than two loose functions so the
 * auth tests can run against an in-memory double instead of a database.
 */
export interface PublisherStore {
  read(keyHash: string): Promise<PublisherRow | null>;
  save(row: PublisherRow): Promise<void>;
}

/** Version numbers start at 1; a `docs` row at 0 has never been pushed to. */
export const FIRST_VERSION = 1;

export function d1PublisherStore(db: D1Database): PublisherStore {
  return {
    read(keyHash) {
      return db
        .prepare("SELECT key_hash, plan, validated_at, owner FROM publishers WHERE key_hash = ?")
        .bind(keyHash)
        .first<PublisherRow>();
    },

    // `owner` is written on every validation, like `plan` is. That is a refresh,
    // not a transfer: a license key's `authUserId` is set when the key is
    // created and never updated in app-sites, so the value cannot change under
    // us. If key transfer is ever added there, this cache becomes a hole — see
    // the note in `docs/identity.md`.
    async save(row) {
      await db
        .prepare(
          `INSERT INTO publishers (key_hash, plan, validated_at, owner) VALUES (?, ?, ?, ?)
           ON CONFLICT(key_hash) DO UPDATE SET plan = excluded.plan,
                                               validated_at = excluded.validated_at,
                                               owner = excluded.owner`,
        )
        .bind(row.key_hash, row.plan, row.validated_at, row.owner)
        .run();
    },
  };
}

/**
 * Create the `docs` row for a first push, already carrying version 1 — but only
 * while this publisher is under `maxDocs` live docs. Returns false at the
 * ceiling.
 *
 * A freshly minted id is private to this request, so nothing can race for its
 * first version and the insert *is* the reservation — the `UPDATE ... RETURNING`
 * dance below only earns its keep once a doc is reachable by id.
 *
 * The capacity count is a predicate on that same insert rather than a read
 * before it, for the reason `reserveNextVersion` exists: a publisher at the
 * ceiling firing concurrent creates would otherwise have every one of them read
 * the same count and every one of them insert. A quota documented as a hard
 * number has to behave like one under the concurrency an agent produces.
 * `docs_by_owner_live` covers the subquery, so it is an index scan of only this
 * owner's live rows.
 *
 * `owner` is not a foreign key onto `publishers`: that table is keyed by license
 * key, and an account is not one. "No doc without a publisher we validated" is
 * therefore the auth path's invariant rather than the database's — only a
 * resolved publisher reaches this.
 */
export async function insertDocWithinQuota(
  db: D1Database,
  doc: Omit<DocRow, "deleted_at" | "latest_version">,
  maxDocs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO docs (id, owner, title, latest_version, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM docs WHERE owner = ? AND deleted_at IS NULL) < ?`,
    )
    .bind(
      doc.id,
      doc.owner,
      doc.title,
      FIRST_VERSION,
      doc.created_at,
      doc.updated_at,
      doc.owner,
      maxDocs,
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Hard-delete a `docs` row. Only for rolling back a create that failed after the
 * row existed: the id was minted this request and nothing else can have seen it,
 * so there are no versions, no objects, and no url to leave behind.
 *
 * Unsharing a *published* doc is a soft delete (`softDeleteDoc`) — that row has
 * to survive so its url keeps answering 410 rather than pretending it never was.
 */
export async function deleteDocRow(db: D1Database, docId: string): Promise<void> {
  await db.prepare("DELETE FROM docs WHERE id = ?").bind(docId).run();
}

/** Whether a doc has been soft-deleted since a push started writing to it. */
export async function docIsDeleted(db: D1Database, docId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM docs WHERE id = ? AND deleted_at IS NOT NULL")
    .bind(docId)
    .first();

  return row !== null;
}

/**
 * Drop one version row, for a version whose object has just been removed again
 * after losing a race with delete. The row only ever named those bytes.
 */
export async function deleteVersionRow(
  db: D1Database,
  docId: string,
  version: number,
): Promise<void> {
  await db.prepare("DELETE FROM versions WHERE doc_id = ? AND n = ?").bind(docId, version).run();
}

/**
 * Mint the next version number for a doc, or null if this publisher has no such
 * doc to push to.
 *
 * The whole coordination story of v0 is this one statement (D7). Incrementing
 * and reading back in a single write means two concurrent pushes to the same
 * doc get 2 and 3, never 2 and 2 — which matters because the number is an R2
 * key, and two pushes sharing a key would mean one overwriting the other's
 * immutable bytes.
 *
 * Ownership and liveness are predicates on that same statement rather than an
 * earlier read, so a doc deleted or transferred in between cannot slip through.
 * Null covers "no such doc", "not yours" and "deleted" alike: the caller must
 * answer all three with 404, because distinguishing them would confirm that
 * another publisher's doc exists.
 *
 * It mints the number and nothing else. Title and `updated_at` describe the
 * content a reader gets, so they are committed by `commitVersionMetadata` only
 * once the bytes are actually stored — writing them here would let a failed
 * push leave "my docs" describing a version the public url is not serving.
 */
export async function reserveNextVersion(
  db: D1Database,
  docId: string,
  owner: string,
): Promise<number | null> {
  const reserved = await db
    .prepare(
      `UPDATE docs
          SET latest_version = latest_version + 1
        WHERE id = ? AND owner = ? AND deleted_at IS NULL
        RETURNING latest_version`,
    )
    .bind(docId, owner)
    .first<{ latest_version: number }>();

  return reserved?.latest_version ?? null;
}

/**
 * Point a doc's listing metadata at the version that just landed.
 *
 * Runs after the bytes are stored, so the pair a reader sees in "my docs" always
 * describes content the public url will actually serve. A push that dies before
 * this leaves a burned version number and the previous push's metadata — which
 * is the honest answer, because the previous push is still what is being served.
 *
 * Two things move, on two different rules, because they answer two different
 * questions.
 *
 * **Title** is whatever the highest-numbered stored version asked for. Deriving
 * it from the version rows rather than writing it here makes it independent of
 * the order commits happen to run in: overlapping pushes can reserve 2 and 3,
 * store in either order, and an explicit title on 2 is not lost because 3 —
 * which asked for no title — committed first. Versions that omitted a title are
 * skipped rather than treated as blanking it, which is what makes omission mean
 * "leave it alone" no matter how many pushes are in flight.
 *
 * **`updated_at`** moves only while this version is the newest stored one, since
 * it describes what the shared link resolves to. The comparison is against
 * `MAX(versions.n)` and not `docs.latest_version`, because the counter can be
 * ahead of what exists: a push that reserves a number and then fails burns it,
 * and a dead reservation must not veto a version that really landed.
 *
 * Batched, so a reader cannot catch the pair mid-update.
 */
export async function commitVersionMetadata(
  db: D1Database,
  docId: string,
  version: number,
  atMs: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE docs
            SET title = COALESCE(
              (SELECT v.title FROM versions v
                WHERE v.doc_id = ? AND v.title IS NOT NULL
                ORDER BY v.n DESC LIMIT 1),
              title)
          WHERE id = ?`,
      )
      .bind(docId, docId),
    db
      .prepare(
        `UPDATE docs SET updated_at = ?
          WHERE id = ?
            AND ? >= (SELECT COALESCE(MAX(n), 0) FROM versions WHERE doc_id = ?)`,
      )
      .bind(atMs, docId, version, docId),
  ]);
}

/**
 * Record that a version exists.
 *
 * Written *after* its R2 object, never before, so every row here has bytes
 * behind it. The reverse failure — an object with no row — is the one this
 * ordering chooses to allow: it costs storage, where a row with no object would
 * be a doc that 500s.
 */
export async function insertVersion(db: D1Database, version: VersionRow): Promise<void> {
  await db
    .prepare("INSERT INTO versions (doc_id, n, size, title, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(version.doc_id, version.n, version.size, version.title, version.created_at)
    .run();
}

/** What the serving path needs to know about a doc, in one read. */
export interface ServableVersion {
  /** Epoch ms when the doc was soft-deleted, else null. Deleted serves 410. */
  deleted_at: number | null;
  /** The version that has bytes, or null when the request names none. */
  version: number | null;
}

/**
 * Resolve a public url to the version whose bytes should be served, or null if
 * no doc has that id at all.
 *
 * `pinned` is the version from `/d/{docId}/v{n}`, or null for `/d/{docId}`.
 *
 * The version comes from `versions`, never from `docs.latest_version`, because
 * that counter is a *reservation*: a push that dies between minting the number
 * and writing the object leaves it one above the newest version that actually
 * has bytes, and serving that number would 404 a doc that is perfectly fine.
 * Taking the highest row instead also steps over the gap such a push leaves
 * behind. The same subquery answers the pinned case, where matching the exact
 * `n` is what proves the version exists rather than merely being below the
 * counter.
 *
 * Liveness is *not* a predicate here: a deleted doc must still be found, so the
 * caller can tell 410 from 404. That distinction is the one thing this query
 * exists to preserve, and it is safe to expose because a doc id is 80 random
 * bits — knowing one already means having been given the link.
 */
export async function findServableVersion(
  db: D1Database,
  docId: string,
  pinned: number | null,
): Promise<ServableVersion | null> {
  // `return await`: see the note on the router's catch in index.ts.
  return await db
    .prepare(
      `SELECT d.deleted_at AS deleted_at,
              (SELECT MAX(v.n)
                 FROM versions v
                WHERE v.doc_id = d.id
                  AND (? IS NULL OR v.n = ?)) AS version
         FROM docs d
        WHERE d.id = ?`,
    )
    .bind(pinned, pinned, docId)
    .first<ServableVersion>();
}

/**
 * Whether this owner has a live doc with that id — the same conflation of
 * "missing", "someone else's" and "deleted" that `reserveNextVersion` makes,
 * for the same reason, and answered identically for all three so the shape of
 * the reply cannot confirm another publisher's doc exists.
 */
export async function ownsLiveDoc(
  db: D1Database,
  docId: string,
  owner: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM docs WHERE id = ? AND owner = ? AND deleted_at IS NULL")
    .bind(docId, owner)
    .first();

  return row !== null;
}

/**
 * Soft-delete a doc, returning false when this publisher has no live doc with
 * that id — missing, someone else's, or already deleted, conflated for the same
 * reason as everywhere else on the write path.
 *
 * Soft, not hard: the row is what lets the serving path answer 410 rather than
 * 404, so a reader who bookmarked the link learns it was withdrawn instead of
 * wondering whether they mistyped it. The bytes are a separate matter and the
 * caller drops them; this row outlives them on purpose.
 *
 * Ownership and liveness are predicates on the write itself rather than an
 * earlier read, so two concurrent deletes of the same doc produce exactly one
 * true — which is what makes "delete the objects" safe to run only on that one.
 */
export async function softDeleteDoc(
  db: D1Database,
  docId: string,
  owner: string,
  atMs: number,
): Promise<boolean> {
  const deleted = await db
    .prepare(
      `UPDATE docs
          SET deleted_at = ?
        WHERE id = ? AND owner = ? AND deleted_at IS NULL
        RETURNING id`,
    )
    .bind(atMs, docId, owner)
    .first<{ id: string }>();

  return deleted !== null;
}

/** One row of the publisher's doc list, as the index scan yields it. */
export interface DocListRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  /**
   * Newest version that has bytes, from `versions` rather than the
   * `latest_version` counter — the counter can sit one above it after a push
   * that died mid-write, and a list that reported it would name a version the
   * doc's url does not serve. Null for a doc whose first push never landed.
   */
  version: number | null;
}

/**
 * Where a page of the list stopped, in the order the scan runs. Both columns
 * are needed: `created_at` is milliseconds and two docs pushed in the same
 * millisecond are entirely possible, so the id is what breaks the tie and keeps
 * the order total.
 */
export interface DocListCursor {
  created_at: number;
  id: string;
}

/**
 * A page of one owner's live docs, newest first.
 *
 * Keyset, not OFFSET. The `docs_by_owner_live` partial index is
 * `(owner, created_at DESC, id DESC)`, and it supplies both the filter and
 * the ordering, so no page is ever sorted in a temp b-tree. It is also the only
 * paging that stays correct while the publisher keeps pushing: OFFSET renumbers
 * the moment a newer doc appears, so a doc would shift onto a page the caller
 * has already read and be missed.
 *
 * Ordering by `created_at` rather than `updated_at` is what makes that hold — a
 * doc's created_at never moves, so a doc cannot jump backwards past a cursor
 * because it was re-pushed mid-walk.
 *
 * The resume predicate is a row-value comparison rather than the expanded
 * `a < ? OR (a = ? AND b < ?)`. The two mean the same thing, but only the row
 * value becomes an index range constraint — `EXPLAIN QUERY PLAN` shows
 * `(owner=? AND (created_at,id)<(?,?))` against the expanded form's
 * `(owner=?)`, which walks from the newest doc and discards rows until it
 * passes the cursor. Both are correct; one seeks.
 *
 * The two statements differ only in that predicate. Written out rather than
 * folded into one with `(? IS NULL OR ...)`, which SQLite cannot use the index
 * for at all.
 */
export async function listPublisherDocs(
  db: D1Database,
  owner: string,
  after: DocListCursor | null,
  limit: number,
): Promise<DocListRow[]> {
  const columns = `d.id AS id, d.title AS title, d.created_at AS created_at,
                   d.updated_at AS updated_at,
                   (SELECT MAX(v.n) FROM versions v WHERE v.doc_id = d.id) AS version`;
  const order = "ORDER BY d.created_at DESC, d.id DESC LIMIT ?";

  const statement =
    after === null
      ? db
          .prepare(
            `SELECT ${columns} FROM docs d
              WHERE d.owner = ? AND d.deleted_at IS NULL
              ${order}`,
          )
          .bind(owner, limit)
      : db
          .prepare(
            `SELECT ${columns} FROM docs d
              WHERE d.owner = ? AND d.deleted_at IS NULL
                AND (d.created_at, d.id) < (?, ?)
              ${order}`,
          )
          .bind(owner, after.created_at, after.id, limit);

  return (await statement.all<DocListRow>()).results;
}

/**
 * Resolve a verified email to its account, creating one on first sight.
 *
 * This is the whole of "sign up": there is no form, and the first approval is
 * the registration. `id` is minted by the caller so the row can be inserted and
 * read back in one statement.
 *
 * The insert is the lookup. Reading first and inserting after would let two
 * approvals racing on one address — the same person clicking Google in one tab
 * and GitHub in another — both find nothing and both insert, and the unique
 * index would turn the loser into a 500 in front of a user who did nothing
 * wrong. `ON CONFLICT DO NOTHING` makes the loser's insert a no-op it can
 * simply read the winner's row after.
 *
 * @param email already normalized; the uniqueness that joins two providers into
 *   one account is only as good as the folding done before this is called
 */
export async function findOrCreateAccount(
  db: D1Database,
  id: string,
  email: string,
  atMs: number,
): Promise<AccountRow> {
  const inserted = await db
    .prepare(
      `INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)
       ON CONFLICT(email) DO NOTHING
       RETURNING id, email, created_at`,
    )
    .bind(id, email, atMs)
    .first<AccountRow>();
  if (inserted !== null) return inserted;

  const existing = await db
    .prepare("SELECT id, email, created_at FROM accounts WHERE email = ?")
    .bind(email)
    .first<AccountRow>();
  // Only reachable if the row that won the conflict vanished between the two
  // statements, which nothing deletes. Throwing beats returning a null account
  // the approval path would have to invent an owner for.
  if (existing === null) throw new Error("account row disappeared after a conflicting insert");
  return existing;
}

/**
 * Resolve a provider identity to its account, or null when the address it
 * presents is already claimed by a different identity on the same provider.
 *
 * Three outcomes, in this order:
 *
 * 1. **This subject has signed in before.** Its account, whatever email the
 *    provider reports now — a person who changes their address keeps their
 *    documents, and the `accounts` row is deliberately left alone.
 * 2. **A new subject, and the address is free or belongs to an account this
 *    provider has never signed in to.** The account by email, created if it is
 *    new, and the identity is linked to it. This is what makes approving with
 *    Google and then with GitHub land on one account with no linking step.
 * 3. **A new subject, and the address belongs to an account another subject on
 *    *this* provider already signs in to.** Null. That is the reassigned
 *    mailbox: the previous holder's Google account still exists, someone else
 *    now verifies the same address with Google, and merging them would hand
 *    over their documents. Refusing is the only safe answer this page can give
 *    without a way to ask the original owner.
 *
 * The third case is decided by `identities`' own `UNIQUE (provider,
 * account_id)` rather than by a read before the write. Two unseen subjects can
 * verify one address at the same moment, and a check-then-insert would let both
 * through — which is worse than not refusing at all, since the account would
 * then be permanently shared and no later sign-in would notice.
 *
 * @param newId an account id to use if one has to be minted, so this stays
 *   deterministic under test
 */
export async function resolveAccountForIdentity(
  db: D1Database,
  provider: string,
  subject: string,
  email: string,
  newId: string,
  nowMs: number,
): Promise<AccountRow | null> {
  const linked = await db
    .prepare(
      `SELECT a.id AS id, a.email AS email, a.created_at AS created_at
         FROM identities i JOIN accounts a ON a.id = i.account_id
        WHERE i.provider = ? AND i.subject = ?`,
    )
    .bind(provider, subject)
    .first<AccountRow>();
  if (linked !== null) return linked;

  const byEmail = await db
    .prepare("SELECT id, email, created_at FROM accounts WHERE email = ?")
    .bind(email)
    .first<AccountRow>();

  const account = byEmail ?? (await findOrCreateAccount(db, newId, email, nowMs));

  // No conflict target, so *either* constraint refuses the insert quietly. The
  // two mean opposite things, and the read below is what tells them apart.
  const inserted = await db
    .prepare(
      `INSERT INTO identities (provider, subject, account_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING account_id`,
    )
    .bind(provider, subject, account.id, nowMs)
    .first<{ account_id: string }>();
  if (inserted !== null) return account;

  // A row for this subject means the primary key refused: two first sign-ins
  // for one subject overlapped. That is not a conflict of people, so the winner
  // is returned — including when the two reported different addresses, as a
  // mid-flight email change can. Returning the loser's own choice instead would
  // approve a device code onto an account no later sign-in ever resolves to,
  // and its owner could never reach the documents under it again.
  //
  // No row means `UNIQUE (provider, account_id)` refused: another subject on
  // this provider holds the account this address named. That is the reassigned
  // mailbox, and it is the one case that must not be merged.
  //
  // An account a refused sign-in happened to create is left behind. It costs
  // one row, it is the account the next sign-in on that address will find, and
  // deleting it here would race the request that is using it.
  return await db
    .prepare(
      `SELECT a.id AS id, a.email AS email, a.created_at AS created_at
         FROM identities i JOIN accounts a ON a.id = i.account_id
        WHERE i.provider = ? AND i.subject = ?`,
    )
    .bind(provider, subject)
    .first<AccountRow>();
}

/** Whether a code is still waiting to be approved, for the page that offers to. */
export async function deviceCodeIsPending(
  db: D1Database,
  userCode: string,
  nowMs: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM device_codes
        WHERE user_code = ? AND approved_at IS NULL AND denied_at IS NULL AND expires_at > ?`,
    )
    .bind(userCode, nowMs)
    .first();

  return row !== null;
}

/**
 * Record an OAuth handshake against the code it is meant to approve, returning
 * false when there is no pending code to record it against.
 *
 * This is where a signed cookie would otherwise be minted. Keeping the handshake
 * in the row instead is what lets this Worker set no cookie anywhere, and it
 * costs nothing: the browser is not the thing being authorized, so it has
 * nothing to remember between the three requests.
 *
 * Starting a second handshake overwrites the first, which is what a person
 * pressing the other provider's button means. Only one can ever be finished,
 * because only the surviving `state` can be looked up.
 *
 * It also drops any identity the first handshake proved. Confirmation trusts
 * `account_id` as the person who signed in for *this* `state`; carrying it
 * across a restart would let anyone who knows the user code start a fresh
 * handshake, read its state off the provider redirect, and press approve for
 * an identity they never proved (https://github.com/Brevilabs/OpenArtifacts/pull/61#discussion_r3919988470).
 */
export async function startDeviceHandshake(
  db: D1Database,
  userCode: string,
  provider: string,
  state: string,
  verifier: string,
  nowMs: number,
): Promise<boolean> {
  const started = await db
    .prepare(
      `UPDATE device_codes
          SET provider = ?, state = ?, verifier = ?,
              account_id = NULL, confirm_token = NULL
        WHERE user_code = ? AND approved_at IS NULL AND denied_at IS NULL AND expires_at > ?
        RETURNING user_code`,
    )
    .bind(provider, state, verifier, userCode, nowMs)
    .first<{ user_code: string }>();

  return started !== null;
}

/**
 * Find the handshake a provider's redirect is answering.
 *
 * The `state` is the only thing that request carries, which is why it is the
 * lookup key rather than a value compared after one: the callback does not know
 * which device code it belongs to until this row answers. 256 random bits and a
 * unique index make that a safe key, and the confirm write clears it, so a state
 * names a handshake for as long as the handshake lasts and no longer.
 */
export async function findPendingHandshake(
  db: D1Database,
  state: string,
  nowMs: number,
): Promise<PendingHandshake | null> {
  // `return await`: see the note on the router's catch in index.ts.
  return await db
    .prepare(
      `SELECT user_code, provider, verifier, label FROM device_codes
        WHERE state = ? AND approved_at IS NULL AND denied_at IS NULL AND expires_at > ?`,
    )
    .bind(state, nowMs)
    .first<PendingHandshake>();
}

/**
 * Record whose email the handshake proved, and mint the token that can approve
 * it, without approving anything.
 *
 * The split between this and `confirmDeviceApproval` is the whole defence
 * against device-code phishing (RFC 8628 §5.4). A provider's redirect back is a
 * `GET` a link can cause, and a person already signed in to that provider is
 * carried through it without a prompt — so if the redirect completed the
 * approval, a link would be enough to attach somebody else's terminal to their
 * account. Identity is proved here; the approval is a `POST` a person has to
 * press, and until they do, `approved_at` is null and #57's poll sees nothing.
 *
 * `confirmToken` is what that press must carry, and it is minted here rather
 * than reusing `state` because `state` is not a secret from the attacker: they
 * start a handshake on their own code, read it out of the redirect they are
 * given, and send the provider's url to a victim. The victim's callback lands
 * here, on the attacker's row — and if the confirm keyed on `state`, the
 * attacker would then approve their own code as the victim, who pressed
 * nothing. This token is returned only in the page the victim's browser
 * receives, so the attacker never has it.
 *
 * `verifier IS NOT NULL` is the whole concurrency story. One authorization url
 * can be completed by two different people, and both callbacks read the
 * verifier before either exchange finishes; without this predicate the second
 * would overwrite the first's `account_id` after the confirm page for the first
 * had already been rendered, and that page would approve the wrong account.
 * Clearing the verifier in the same statement makes exactly one of them the
 * winner, and only the winner gets a confirm token.
 *
 * `state` survives, because the row still has to be findable while the confirm
 * page is open.
 */
export async function holdProvenIdentity(
  db: D1Database,
  state: string,
  accountId: string,
  confirmToken: string,
  nowMs: number,
): Promise<boolean> {
  const held = await db
    .prepare(
      `UPDATE device_codes
          SET account_id = ?, confirm_token = ?, verifier = NULL
        WHERE state = ?
          AND verifier IS NOT NULL
          AND approved_at IS NULL
          AND denied_at IS NULL
          AND expires_at > ?
        RETURNING user_code`,
    )
    .bind(accountId, confirmToken, state, nowMs)
    .first<{ user_code: string }>();

  return held !== null;
}

/**
 * Approve the device code a proven handshake belongs to, returning the code
 * approved or null when there is nothing to approve.
 *
 * **This one write is the contract between the approval page and the device
 * flow (#57).** `approved_at` moving from null is the whole signal that issue
 * polls for, and it can grow this statement's `SET` list — minting the token,
 * recording the machine label — without the page changing.
 *
 * Keyed on the confirm token rather than on `state`, because only the token is
 * a secret from whoever started the handshake. `holdProvenIdentity` says why
 * that distinction is the difference between a press and a link.
 *
 * Every reason to refuse is one null: no such token, an expired code, or a
 * confirm pressed twice. The predicates ride on the write rather than an
 * earlier read, so two presses produce exactly one approval, and clearing both
 * tokens is what makes the second find nothing.
 */
export async function confirmDeviceApproval(
  db: D1Database,
  confirmToken: string,
  atMs: number,
): Promise<string | null> {
  const approved = await db
    .prepare(
      `UPDATE device_codes
          SET approved_at = ?, state = NULL, confirm_token = NULL
        WHERE confirm_token = ?
          AND approved_at IS NULL
          AND denied_at IS NULL
          AND account_id IS NOT NULL
          AND expires_at > ?
        RETURNING user_code`,
    )
    .bind(atMs, confirmToken, atMs)
    .first<{ user_code: string }>();

  return approved?.user_code ?? null;
}

/**
 * Refuse the device code a proven handshake belongs to, returning the code
 * refused or null when there is nothing to refuse.
 *
 * The mirror image of `confirmDeviceApproval`, and it exists for the attack
 * that split confirmation into two steps in the first place. Someone who lands
 * on a confirmation page for a terminal that is not theirs — the RFC 8628 §5.4
 * case — can close the tab and let the code expire, but that leaves the
 * attacker's code live for the rest of its lifetime. This ends it now, and the
 * terminal polling it is told `access_denied` rather than waiting out the
 * expiry for news.
 *
 * Keyed on the confirm token for the same reason the approval is: only the
 * token is a secret from whoever started the handshake, so only the browser
 * that completed it can press either button.
 */
export async function denyDeviceApproval(
  db: D1Database,
  confirmToken: string,
  atMs: number,
): Promise<string | null> {
  const denied = await db
    .prepare(
      `UPDATE device_codes
          SET denied_at = ?, state = NULL, confirm_token = NULL, verifier = NULL
        WHERE confirm_token = ?
          AND approved_at IS NULL
          AND denied_at IS NULL
          AND expires_at > ?
        RETURNING user_code`,
    )
    .bind(atMs, confirmToken, atMs)
    .first<{ user_code: string }>();

  return denied?.user_code ?? null;
}

/**
 * Put a freshly minted code in the table, or answer false when its user code is
 * already taken.
 *
 * `user_code` is the primary key, so a collision is a refused insert rather than
 * an overwrite — which is the safe direction: overwriting would point a waiting
 * terminal's code at a different device code, and the approval a person then
 * gave would land on somebody else's terminal. The caller redraws instead.
 *
 * Eight characters of a twenty-letter alphabet against the handful of codes
 * alive at once makes a collision vanishingly rare; the sweep is what keeps it
 * that way, since a code that is never deleted is a code that can never be
 * drawn again.
 */
export async function insertDeviceCode(
  db: D1Database,
  code: Pick<
    DeviceCodeRow,
    "user_code" | "device_code_hash" | "label" | "expires_at" | "created_at"
  >,
): Promise<boolean> {
  const inserted = await db
    .prepare(
      `INSERT INTO device_codes (user_code, device_code_hash, label, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING user_code`,
    )
    .bind(code.user_code, code.device_code_hash, code.label, code.expires_at, code.created_at)
    .first<{ user_code: string }>();

  return inserted !== null;
}

/**
 * Delete every device code that has expired.
 *
 * **`user_code` is the primary key, so this is what makes a code reusable.**
 * Without it, the twenty-letter alphabet would be drawing against every code
 * ever issued rather than the few alive right now, and `insertDeviceCode` would
 * start refusing draws for codes nobody is waiting on.
 *
 * It runs on the mint path rather than on a cron trigger, because minting is
 * the only thing that creates these rows and the only thing that needs a free
 * code — so the sweep is exactly co-located with the need, and a deployment
 * that never mints never accumulates anything to sweep. A cron trigger would be
 * a second deployment concern and a scheduled handler to maintain for work one
 * indexed delete does in the request that cares about it.
 *
 * An approved code that is never collected takes nothing with it, because a
 * token is minted by the poll that collects one. There is no such thing here as
 * a credential nobody holds.
 */
export async function sweepExpired(db: D1Database, nowMs: number): Promise<void> {
  await db.prepare("DELETE FROM device_codes WHERE expires_at <= ?").bind(nowMs).run();
}

/** What a poll needs to decide what to tell the terminal. */
export type PolledDeviceCode = Pick<
  DeviceCodeRow,
  "user_code" | "approved_at" | "denied_at" | "expires_at" | "last_polled_at"
>;

/**
 * Find the code a poll is asking about, by the hash of the device code it
 * presented.
 *
 * The device code is the lookup key rather than the user code because it is the
 * half the terminal keeps to itself. A user code is read aloud and typed into
 * phones; if it could collect a token, every approval page would be showing the
 * credential to the room.
 */
export async function findPolledDeviceCode(
  db: D1Database,
  deviceCodeHash: string,
): Promise<PolledDeviceCode | null> {
  // `return await`: see the note on the router's catch in index.ts.
  return await db
    .prepare(
      `SELECT user_code, approved_at, denied_at, expires_at, last_polled_at
         FROM device_codes WHERE device_code_hash = ?`,
    )
    .bind(deviceCodeHash)
    .first<PolledDeviceCode>();
}

/** Record that the terminal polled, which is what the next `slow_down` is measured from. */
export async function recordDevicePoll(
  db: D1Database,
  deviceCodeHash: string,
  atMs: number,
): Promise<void> {
  await db
    .prepare("UPDATE device_codes SET last_polled_at = ? WHERE device_code_hash = ?")
    .bind(atMs, deviceCodeHash)
    .run();
}

/**
 * Issue the token an approved code earned, and consume the code doing it.
 *
 * **The token is minted here rather than when the person presses Approve**, and
 * that ordering is the whole reason a raw token never touches the database. If
 * approval issued it, the value would have to sit in a column until the
 * terminal came back for it — a bearer credential at rest, and one left behind
 * as a live token nobody holds whenever the terminal never comes back.
 * Minting on collection means a token exists exactly when someone holds it.
 *
 * Both statements are one D1 batch, which is one transaction. The insert is
 * predicated on the code being approved and the delete on the same condition,
 * so a poll that arrives before the approval changes nothing, and two polls
 * that arrive together cannot both collect: the second finds no row and
 * inserts nothing.
 *
 * Deleting the code rather than marking it spent is also what makes a replay
 * answer honestly. There is no third state to explain — a device code that has
 * been collected is gone, and a second poll with it gets exactly what a poll
 * with an expired code gets.
 *
 * @returns the label the token carries, or null when there was nothing to
 *   collect
 */
export async function collectDeviceToken(
  db: D1Database,
  deviceCodeHash: string,
  token: Pick<TokenRow, "id" | "token_hash" | "created_at">,
): Promise<{ label: string | null } | null> {
  const [issued] = await db.batch<{ label: string | null }>([
    db
      .prepare(
        `INSERT INTO tokens (id, token_hash, account_id, label, created_at)
         SELECT ?, ?, account_id, label, ?
           FROM device_codes
          WHERE device_code_hash = ? AND approved_at IS NOT NULL AND account_id IS NOT NULL
         RETURNING label`,
      )
      .bind(token.id, token.token_hash, token.created_at, deviceCodeHash),
    db
      .prepare(
        `DELETE FROM device_codes
          WHERE device_code_hash = ? AND approved_at IS NOT NULL AND account_id IS NOT NULL`,
      )
      .bind(deviceCodeHash),
  ]);

  const row = issued?.results[0];
  return row === undefined ? null : { label: row.label };
}

/**
 * The account behind a token, or null when the token is unknown or revoked.
 *
 * Looked up by hash, like a license key, so the value the caller sent is never
 * compared against anything stored — there is nothing stored to compare it to.
 * A revoked token keeps its row so that its hash stays taken and it goes on
 * failing; deleting the row would leave nothing for the next request to fail
 * against, and the same value could in principle be minted again.
 */
export async function findLiveToken(
  db: D1Database,
  tokenHash: string,
): Promise<Pick<TokenRow, "id" | "account_id" | "last_used_at"> | null> {
  // `return await`: see the note on the router's catch in index.ts.
  return await db
    .prepare(
      `SELECT id, account_id, last_used_at FROM tokens
        WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .bind(tokenHash)
    .first<Pick<TokenRow, "id" | "account_id" | "last_used_at">>();
}

/**
 * Move a token's `last_used_at` forward, but only when it is already stale.
 *
 * The predicate is what keeps this off the hot path: without it every
 * authenticated request — including every read — would carry a D1 write. The
 * column answers "which of my machines is still using this", and an hour's
 * resolution answers that as well as a millisecond's would.
 *
 * @param staleBefore the timestamp a recorded use has to predate to be worth
 *   rewriting, which the caller derives from `TOKEN_LAST_USED_RESOLUTION_MS`
 */
export async function touchTokenUse(
  db: D1Database,
  id: string,
  atMs: number,
  staleBefore: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE tokens SET last_used_at = ?
        WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
    )
    .bind(atMs, id, staleBefore)
    .run();
}

/** The live tokens on an account, newest first. Values and hashes stay in D1. */
export async function listAccountTokens(
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<ListedTokenRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, label, created_at, last_used_at FROM tokens
        WHERE account_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .bind(accountId, limit)
    .all<ListedTokenRow>();

  return results;
}

/**
 * Revoke one of an account's tokens, answering false when it has no such live
 * token.
 *
 * The account is a predicate on the write rather than a check before it, which
 * is what makes another account's token indistinguishable from one that never
 * existed — the 404-never-403 rule the doc endpoints follow, applied to the one
 * other thing this API can name.
 *
 * Revoking twice answers false the second time, like deleting a doc twice
 * answers 404. What repeats safely is the outcome: the token is dead either
 * way.
 */
export async function revokeAccountToken(
  db: D1Database,
  id: string,
  accountId: string,
  atMs: number,
): Promise<boolean> {
  const revoked = await db
    .prepare(
      `UPDATE tokens SET revoked_at = ?
        WHERE id = ? AND account_id = ? AND revoked_at IS NULL
        RETURNING id`,
    )
    .bind(atMs, id, accountId)
    .first<{ id: string }>();

  return revoked !== null;
}

/** Live tokens an account still holds, which is what a revoke reports back. */
export async function countLiveTokens(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM tokens WHERE account_id = ? AND revoked_at IS NULL")
    .bind(accountId)
    .first<{ n: number }>();

  return row?.n ?? 0;
}
