/**
 * DocComments: one SQLite Durable Object per document, holding its comment
 * threads. `env.COMMENTS.idFromName(docId)` addresses it.
 *
 * Why a Durable Object and not D1 rows: comments are a per-document, write-heavy
 * workload that has to serialise (two people posting at once must not both slip
 * under a cap), and docs/cost-at-scale.md already says counters and hot rows go
 * in an object, not in D1. The Worker still decides who may do what; this class
 * only enforces what it can see for itself.
 *
 * ## RPC contract
 *
 * Callers use the stub's methods directly (`await stub.list({...})`). Every
 * method takes ONE argument object and returns plain data, never a Response:
 * `{ ok: true, ... }` or `{ ok: false, reason }`. Every argument object carries
 * `docId` (the object does not know its own name, and needs it for R2).
 *
 * Identity is passed in, never read from the client: `principal` is the
 * account (or license-owner) id the Worker derived from the credential, `kind`
 * is `"human"` for a browser token and `"agent"` for an account token or license
 * key, `onBehalfOf` is the account an agent acts for (null for a human), and
 * `agentName` is the client the agent named itself with (optional; null for a
 * human, for an agent that did not say, and for every record written before it
 * existed). The
 * object stores them verbatim and returns them verbatim; the Worker turns
 * principals into display names with one batched D1 query. `at` is not an
 * argument: the object stamps every write itself, after its last await, from
 * a clock that strictly increases per object, so a `since` cursor taken from one
 * answer can never skip a write that commits later. `version` is the document
 * version the caller's anchors are computed for (and, on writes, the version the
 * writer was looking at).
 *
 * Authorship is by owner scope. `scope` on `resolve`/`reopen`/`deleteComment` is
 * every id the caller's own comments may be stored under (the whole
 * `owner_scope`: a license key that commented before it was linked to an account
 * is the same author as that account), and "mine" means the author is in it.
 *
 *   list({docId, version, state?, since?})
 *     -> {ok, version, threads: ThreadRecord[]}
 *     state "open"|"resolved"|"all" (default all); since filters on a thread's
 *     last activity (epoch ms). Re-anchors every thread for `version` the first
 *     time that version is asked for, then answers from the memo.
 *   createThread({docId, principal, kind, onBehalfOf, anchor, body, version})
 *     -> {ok, threadId, commentId, anchorStatus: "anchored", thread}
 *   reply({docId, threadId, principal, kind, onBehalfOf, body, version})
 *     -> {ok, commentId, thread}
 *   resolve / reopen({docId, threadId, principal, kind, onBehalfOf, isOwner, scope, version})
 *     -> {ok, changed, thread}   (idempotent: a no-op reports changed:false)
 *   deleteComment({docId, commentId, scope})
 *     -> {ok, deleted: "comment"|"thread", threadId}
 *   purge()  -> {ok}   wipes all storage and leaves a tombstone; the caller sweeps R2 afterwards
 *
 * `thread` on a write is the thread as it stands, for the Worker's notification:
 * it already holds it, so a second call just to address an email is not made.
 *
 * Failure reasons: `invalid_anchor`, `invalid_body` (malformed input, the Worker
 * answers 400 `bad_request`), `anchor_not_found` (400), `thread_not_found`,
 * `comment_not_found` (404; for deleteComment this also covers "not your
 * comment", so a comment id cannot be probed), `forbidden` (resolve/reopen by
 * someone who is neither the owner nor the thread's author),
 * `limit_threads` / `limit_comments` (402 caps), `version_not_found` (the stored
 * HTML for `version` is missing), `purged` (the document was deleted; every
 * method refuses with it, the Worker answers 404).
 *
 * ## Purge
 *
 * `purge()` is final. It sets an in-memory flag first (so a write that is parked
 * on an R2 read when the purge runs sees it on resuming and writes nothing), then
 * wipes storage and leaves one durable `purged` key, so even a later call on an
 * evicted-and-woken object refuses. The schema is created lazily on first use and
 * never by `purge()`, so an object that was purged, or that never held a comment,
 * stays empty of tables. `snapshot()` is skipped once purged, because
 * `docs/{id}/threads.json` is swept right after and must not be rewritten.
 *
 * ## Storage
 *
 * The design's three tables (threads, comments, anchors). Two deliberate
 * additions to `threads`: `updated_at` (so `since` sees reopens, which leave no
 * other trace) and `resolved_kind` / `resolved_on_behalf_of` (a resolve card
 * has to say "by Alice's agent", and `resolved_by` alone cannot).
 *
 * After every mutation the object overwrites `docs/{docId}/threads.json` with a
 * full snapshot of its state (ids included), best effort and serialised so an
 * older snapshot can never land after a newer one. It is a snapshot to be
 * rebuilt from, never read-modify-written.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../config.js";
import { encodeBase32 } from "../ids.js";
import { threadsObjectKey, versionObjectKey } from "../storage.js";
import { canonicalText, locateAnchor, validateAnchor, type Anchor, type CanonicalText } from "./anchor.js";

export const MAX_THREADS = 500;
export const MAX_COMMENTS = 2000;
export const MAX_BODY = 4000;

export type AuthorKind = "human" | "agent";

/** Who did something, as the Worker told us. */
export type Actor = { principal: string; kind: AuthorKind; onBehalfOf: string | null; agentName: string | null };

export type CommentRecord = {
  commentId: string;
  author: Actor;
  body: string;
  createdAt: number;
  atVersion: number;
};

export type ThreadRecord = {
  threadId: string;
  anchor: Anchor;
  anchorStatus: "anchored" | "orphaned";
  /** The text this thread sits on in `version`; null when orphaned there. */
  matchedText: string | null;
  createdAtVersion: number;
  createdAt: number;
  /** Last create/reply/resolve/reopen, epoch ms. */
  updatedAt: number;
  /** The account that opened the thread (its first comment's author). */
  createdBy: string;
  state: "open" | "resolved";
  resolution: { by: Actor; atVersion: number; at: number } | null;
  comments: CommentRecord[];
};

type Failure<R extends string> = { ok: false; reason: R };
type VersionFailure = Failure<"version_not_found">;
/** The document was deleted; nothing is read or written any more. */
type PurgedFailure = Failure<"purged">;

export type ListArgs = {
  docId: string;
  version: number;
  state?: "open" | "resolved" | "all";
  since?: number;
};
export type ListResult =
  | { ok: true; version: number; threads: ThreadRecord[] }
  | VersionFailure
  | PurgedFailure;

/** `agentName` is the client an agent writes through, as it named itself; absent reads as null. */
type Writer = { docId: string; principal: string; kind: AuthorKind; onBehalfOf: string | null; agentName?: string | null };

export type CreateThreadArgs = Writer & { anchor: unknown; body: unknown; version: number };
export type CreateThreadResult =
  | {
      ok: true;
      threadId: string;
      commentId: string;
      anchorStatus: "anchored";
      thread: ThreadRecord;
    }
  | Failure<"invalid_anchor" | "invalid_body" | "anchor_not_found" | "limit_threads" | "limit_comments">
  | VersionFailure
  | PurgedFailure;

export type ReplyArgs = Writer & { threadId: string; body: unknown; version: number };
export type ReplyResult =
  | { ok: true; commentId: string; thread: ThreadRecord }
  | Failure<"invalid_body" | "thread_not_found" | "limit_comments">
  | VersionFailure
  | PurgedFailure;

export type TransitionArgs = Writer & { threadId: string; isOwner: boolean; scope: string[]; version: number };
export type TransitionResult =
  | { ok: true; changed: boolean; thread: ThreadRecord }
  | Failure<"thread_not_found" | "forbidden">
  | VersionFailure
  | PurgedFailure;

export type DeleteCommentArgs = { docId: string; commentId: string; scope: string[] };
export type DeleteCommentResult =
  | { ok: true; deleted: "comment" | "thread"; threadId: string }
  | Failure<"comment_not_found">
  | PurgedFailure;

type ThreadRow = {
  id: string;
  created_version: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  section: string | null;
  anchor_exact: string;
  anchor_prefix: string | null;
  anchor_suffix: string | null;
  state: "open" | "resolved";
  resolved_by: string | null;
  resolved_kind: AuthorKind | null;
  resolved_on_behalf_of: string | null;
  resolved_agent_name: string | null;
  resolved_at: number | null;
  resolved_at_version: number | null;
};

type CommentRow = {
  id: string;
  thread_id: string;
  author: string;
  author_kind: AuthorKind;
  on_behalf_of: string | null;
  agent_name: string | null;
  body: string;
  created_at: number;
  at_version: number;
};

type AnchorRow = { thread_id: string; version: number; status: "anchored" | "orphaned"; matched_text: string | null };

/** Canonical texts kept in memory. Versions are immutable, so a hit is always right. */
const CANONICAL_CACHE = 2;

/** The durable tombstone `purge()` leaves. */
const PURGED_KEY = "purged";

/** Columns added after the first deploy: a table made before them gets them on first use. */
const ADDED_COLUMNS: Array<[table: string, column: string]> = [
  ["threads", "resolved_agent_name"],
  ["comments", "agent_name"],
];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS threads (
     id TEXT PRIMARY KEY,
     created_version INTEGER NOT NULL,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     section TEXT,
     anchor_exact TEXT NOT NULL,
     anchor_prefix TEXT,
     anchor_suffix TEXT,
     state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
     resolved_by TEXT,
     resolved_kind TEXT,
     resolved_on_behalf_of TEXT,
     resolved_agent_name TEXT,
     resolved_at INTEGER,
     resolved_at_version INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS comments (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
     author TEXT NOT NULL,
     author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent')),
     on_behalf_of TEXT,
     agent_name TEXT,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     at_version INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS comments_by_thread ON comments (thread_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS anchors (
     thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
     version INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('anchored', 'orphaned')),
     matched_text TEXT,
     PRIMARY KEY (thread_id, version)
   )`,
];

function newId(prefix: "th_" | "cm_"): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return prefix + encodeBase32(bytes);
}

/** A comment body: a non-empty string of at most MAX_BODY characters once trimmed. */
function cleanBody(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const text = body.trim();
  return text.length >= 1 && text.length <= MAX_BODY ? text : null;
}

export class DocComments extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly canonical = new Map<number, CanonicalText>();
  private readonly loading = new Map<number, Promise<CanonicalText | null>>();
  /** The tail of the snapshot queue; each write rebuilds from current state. */
  private snapshots: Promise<void> = Promise.resolve();
  /** Purged: set the instant `purge()` starts, and restored from storage on wake. Final. */
  private gone = false;
  private schema = false;
  /** The last stamp handed out, so the clock never repeats or runs backwards. */
  private clock = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.gone = (await ctx.storage.get(PURGED_KEY)) === true;
    });
  }

  /**
   * Whether the object may be used, creating its tables on first use. Lazy so
   * that a purged object (and one that never held a comment) stays empty and
   * can be reclaimed, which a constructor that created tables would prevent.
   */
  private usable(): boolean {
    if (this.gone) return false;
    if (!this.schema) {
      for (const statement of SCHEMA) this.sql.exec(statement);
      for (const [table, column] of ADDED_COLUMNS) {
        const has = this.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray().some((c) => c.name === column);
        if (!has) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
      this.schema = true;
    }
    return true;
  }

  /**
   * The time a write happens: now, but always later than any stamp already in
   * this object. Taken after a write's last await, so `updated_at` is when the
   * row became visible, not when the Worker began the request, and a client
   * that polls with `since` cannot miss it.
   */
  private stamp(): number {
    const newest = this.sql.exec<{ n: number | null }>(`SELECT MAX(updated_at) AS n FROM threads`).one().n ?? 0;
    this.clock = Math.max(Date.now(), this.clock + 1, newest + 1);
    return this.clock;
  }

  // ---------------------------------------------------------------- reads

  async list(args: ListArgs): Promise<ListResult> {
    if (!this.usable()) return { ok: false, reason: "purged" };
    const ready = await this.ensureAnchors(args.docId, args.version);
    if (!ready.ok) return ready;
    const state = args.state ?? "all";
    const since = args.since;
    const threads = this.readThreads(args.version).filter(
      (t) => (state === "all" || t.state === state) && (since === undefined || t.updatedAt > since),
    );
    return { ok: true, version: args.version, threads };
  }

  // --------------------------------------------------------------- writes

  async createThread(args: CreateThreadArgs): Promise<CreateThreadResult> {
    const anchor = validateAnchor(args.anchor);
    if (anchor === null) return { ok: false, reason: "invalid_anchor" };
    const body = cleanBody(args.body);
    if (body === null) return { ok: false, reason: "invalid_body" };

    if (!this.usable()) return { ok: false, reason: "purged" };

    const canon = await this.loadCanonical(args.docId, args.version);
    // The read parked this call with the input gate open, so a purge may have run.
    if (this.gone) return { ok: false, reason: "purged" };
    if (canon === null) return { ok: false, reason: "version_not_found" };
    const located = locateAnchor(canon, anchor);
    if (located.status !== "anchored") {
      // `canonicalText` re-implements the browser's text, so a divergence from a
      // real page surfaces here; the lengths and quote let a report be diagnosed.
      console.warn(
        JSON.stringify({
          event: "anchor_not_found",
          docId: args.docId,
          version: args.version,
          quoteLength: anchor.exact.length,
          canonicalLength: canon.text.length,
          quote: anchor.exact.slice(0, 200),
        }),
      );
      return { ok: false, reason: "anchor_not_found" };
    }

    // From here to the insert there is no await, so two posts cannot both pass
    // the caps: the object runs this block to completion before any other.
    if (this.count("threads") >= MAX_THREADS) return { ok: false, reason: "limit_threads" };
    if (this.count("comments") >= MAX_COMMENTS) return { ok: false, reason: "limit_comments" };

    const threadId = newId("th_");
    const commentId = newId("cm_");
    const at = this.stamp();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO threads (id, created_version, created_by, created_at, updated_at, section, anchor_exact, anchor_prefix, anchor_suffix)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        threadId,
        args.version,
        args.principal,
        at,
        at,
        anchor.section ?? null,
        // A whitespace-collapsed match stores the text as it reads, so later
        // versions are judged against what the document actually said.
        located.matchedText,
        anchor.prefix ?? null,
        anchor.suffix ?? null,
      );
      this.insertComment(commentId, threadId, args, body, at);
      this.sql.exec(
        `INSERT INTO anchors (thread_id, version, status, matched_text) VALUES (?, ?, 'anchored', ?)`,
        threadId,
        args.version,
        located.matchedText,
      );
    });
    this.ctx.waitUntil(this.snapshot(args.docId));
    const thread = this.readThreads(args.version, threadId)[0] as ThreadRecord;
    return { ok: true, threadId, commentId, anchorStatus: "anchored", thread };
  }

  async reply(args: ReplyArgs): Promise<ReplyResult> {
    const body = cleanBody(args.body);
    if (body === null) return { ok: false, reason: "invalid_body" };
    if (!this.usable()) return { ok: false, reason: "purged" };
    if (!this.threadRow(args.threadId)) return { ok: false, reason: "thread_not_found" };
    // Anchor first, as resolve does: a version number a failed push burned is
    // not a page, and a reply must not record that it was written there.
    const ready = await this.ensureAnchors(args.docId, args.version);
    if (!ready.ok) return ready;
    if (this.gone) return { ok: false, reason: "purged" };
    // The thread may have been deleted while R2 was being read.
    if (!this.threadRow(args.threadId)) return { ok: false, reason: "thread_not_found" };
    if (this.count("comments") >= MAX_COMMENTS) return { ok: false, reason: "limit_comments" };
    const commentId = newId("cm_");
    const at = this.stamp();
    this.ctx.storage.transactionSync(() => {
      this.insertComment(commentId, args.threadId, args, body, at);
      this.sql.exec(`UPDATE threads SET updated_at = ? WHERE id = ?`, at, args.threadId);
    });
    this.ctx.waitUntil(this.snapshot(args.docId));
    const thread = this.readThreads(args.version, args.threadId)[0] as ThreadRecord;
    return { ok: true, commentId, thread };
  }

  resolve(args: TransitionArgs): Promise<TransitionResult> {
    return this.transition(args, "resolved");
  }

  reopen(args: TransitionArgs): Promise<TransitionResult> {
    return this.transition(args, "open");
  }

  async deleteComment(args: DeleteCommentArgs): Promise<DeleteCommentResult> {
    if (!this.usable()) return { ok: false, reason: "purged" };
    const row = this.sql
      .exec<CommentRow>(`SELECT * FROM comments WHERE id = ?`, args.commentId)
      .toArray()[0];
    // Someone else's comment answers exactly like a missing one. "Theirs" is any
    // id in the caller's owner scope: a key's comments survive its being linked.
    if (!row || !args.scope.includes(row.author)) return { ok: false, reason: "comment_not_found" };

    const first = this.sql
      .exec<{ id: string }>(`SELECT id FROM comments WHERE thread_id = ? ORDER BY created_at, rowid LIMIT 1`, row.thread_id)
      .one().id;
    let deleted: "comment" | "thread" = "comment";
    this.ctx.storage.transactionSync(() => {
      if (first === row.id) {
        deleted = "thread";
        this.sql.exec(`DELETE FROM comments WHERE thread_id = ?`, row.thread_id);
        this.sql.exec(`DELETE FROM anchors WHERE thread_id = ?`, row.thread_id);
        this.sql.exec(`DELETE FROM threads WHERE id = ?`, row.thread_id);
      } else {
        this.sql.exec(`DELETE FROM comments WHERE id = ?`, row.id);
        // A removed reply is activity on the thread, which `since` must show.
        this.sql.exec(`UPDATE threads SET updated_at = ? WHERE id = ?`, this.stamp(), row.thread_id);
      }
    });
    this.ctx.waitUntil(this.snapshot(args.docId));
    return { ok: true, deleted, threadId: row.thread_id };
  }

  /**
   * Wipe everything and refuse every call from now on. Delete calls this
   * best-effort before sweeping the R2 prefix (which holds `threads.json`), so a
   * deleted document leaves neither. The tombstone is the object's only content:
   * no tables are recreated, so an emptied object holds nothing a write could
   * resume from.
   */
  async purge(): Promise<{ ok: true }> {
    this.gone = true;
    await this.snapshots.catch(() => {});
    this.canonical.clear();
    this.loading.clear();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put(PURGED_KEY, true);
    return { ok: true };
  }

  // ------------------------------------------------------------- internals

  private async transition(args: TransitionArgs, to: "open" | "resolved"): Promise<TransitionResult> {
    if (!this.usable()) return { ok: false, reason: "purged" };
    const thread = this.threadRow(args.threadId);
    if (!thread) return { ok: false, reason: "thread_not_found" };
    if (!args.isOwner && !args.scope.includes(thread.created_by)) return { ok: false, reason: "forbidden" };

    // Anchor first: a missing version must not leave the mutation half done.
    const ready = await this.ensureAnchors(args.docId, args.version);
    if (!ready.ok) return ready;
    if (this.gone) return { ok: false, reason: "purged" };
    // The thread may have been deleted while R2 was being read.
    const current = this.threadRow(args.threadId);
    if (!current) return { ok: false, reason: "thread_not_found" };

    const changed = current.state !== to;
    if (changed) {
      const at = this.stamp();
      if (to === "resolved") {
        this.sql.exec(
          `UPDATE threads SET state = 'resolved', resolved_by = ?, resolved_kind = ?, resolved_on_behalf_of = ?,
             resolved_agent_name = ?, resolved_at = ?, resolved_at_version = ?, updated_at = ? WHERE id = ?`,
          args.principal,
          args.kind,
          args.onBehalfOf,
          args.kind === "agent" ? (args.agentName ?? null) : null,
          at,
          args.version,
          at,
          args.threadId,
        );
      } else {
        this.sql.exec(
          `UPDATE threads SET state = 'open', resolved_by = NULL, resolved_kind = NULL, resolved_on_behalf_of = NULL,
             resolved_agent_name = NULL, resolved_at = NULL, resolved_at_version = NULL, updated_at = ? WHERE id = ?`,
          at,
          args.threadId,
        );
      }
      this.ctx.waitUntil(this.snapshot(args.docId));
    }
    const record = this.readThreads(args.version, args.threadId)[0] as ThreadRecord;
    return { ok: true, changed, thread: record };
  }

  private count(table: "threads" | "comments"): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
  }

  private threadRow(id: string): ThreadRow | undefined {
    return this.sql.exec<ThreadRow>(`SELECT * FROM threads WHERE id = ?`, id).toArray()[0];
  }

  private insertComment(commentId: string, threadId: string, who: Writer & { version: number }, body: string, at: number): void {
    this.sql.exec(
      `INSERT INTO comments (id, thread_id, author, author_kind, on_behalf_of, agent_name, body, created_at, at_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      commentId,
      threadId,
      who.principal,
      who.kind,
      who.kind === "agent" ? who.onBehalfOf : null,
      who.kind === "agent" ? (who.agentName ?? null) : null,
      body,
      at,
      who.version,
    );
  }

  /**
   * Canonical text of a stored version, from memory or R2; null when R2 has no
   * such version. Concurrent callers share one read. At most CANONICAL_CACHE
   * versions stay resident (a 10 MB document is a lot of strings).
   */
  private loadCanonical(docId: string, version: number): Promise<CanonicalText | null> {
    const hit = this.canonical.get(version);
    if (hit) {
      this.canonical.delete(version);
      this.canonical.set(version, hit);
      return Promise.resolve(hit);
    }
    const inflight = this.loading.get(version);
    if (inflight) return inflight;
    const load = (async () => {
      try {
        const object = await this.env.DOCS.get(versionObjectKey(docId, version));
        if (!object) return null;
        const canon = await canonicalText(object.body);
        this.canonical.set(version, canon);
        while (this.canonical.size > CANONICAL_CACHE) {
          this.canonical.delete(this.canonical.keys().next().value as number);
        }
        return canon;
      } finally {
        this.loading.delete(version);
      }
    })();
    this.loading.set(version, load);
    return load;
  }

  private lacking(version: number): ThreadRow[] {
    return this.sql
      .exec<ThreadRow>(
        `SELECT t.* FROM threads t
         WHERE NOT EXISTS (SELECT 1 FROM anchors a WHERE a.thread_id = t.id AND a.version = ?)`,
        version,
      )
      .toArray();
  }

  /**
   * Run the ladder for every thread that has no answer for `version` yet, and
   * store the answers. After the first call for a version this is one indexed
   * query and no R2 read: the push path never touches comments, and a version
   * is anchored once, by whoever asks first.
   */
  private async ensureAnchors(docId: string, version: number): Promise<{ ok: true } | VersionFailure | PurgedFailure> {
    if (this.lacking(version).length === 0) return { ok: true };
    const canon = await this.loadCanonical(docId, version);
    if (this.gone) return { ok: false, reason: "purged" };
    if (canon === null) return { ok: false, reason: "version_not_found" };
    // Re-read after the await: another call may have anchored some of them.
    let anchored = 0;
    this.ctx.storage.transactionSync(() => {
      for (const t of this.lacking(version)) {
        anchored++;
        const anchor: Anchor = { exact: t.anchor_exact };
        if (t.anchor_prefix !== null) anchor.prefix = t.anchor_prefix;
        if (t.anchor_suffix !== null) anchor.suffix = t.anchor_suffix;
        if (t.section !== null) anchor.section = t.section;
        const located = locateAnchor(canon, anchor);
        if (located.status === "anchored") {
          if (located.rung === 2) {
            this.sql.exec(`UPDATE threads SET anchor_exact = ? WHERE id = ?`, located.matchedText, t.id);
          }
          this.sql.exec(
            `INSERT INTO anchors (thread_id, version, status, matched_text) VALUES (?, ?, 'anchored', ?)`,
            t.id,
            version,
            located.matchedText,
          );
        } else {
          this.sql.exec(
            `INSERT INTO anchors (thread_id, version, status, matched_text) VALUES (?, ?, 'orphaned', NULL)`,
            t.id,
            version,
          );
        }
      }
    });
    // Re-anchoring is a mutation (rows, and on rung 2 a rewritten quote), so the
    // snapshot that rebuilds this object has to carry it too.
    if (anchored > 0) this.ctx.waitUntil(this.snapshot(docId));
    return { ok: true };
  }

  /** Threads with their comments and the memoised anchor for `version`. */
  private readThreads(version: number, only?: string): ThreadRecord[] {
    const rows = only
      ? this.sql.exec<ThreadRow>(`SELECT * FROM threads WHERE id = ?`, only).toArray()
      : this.sql.exec<ThreadRow>(`SELECT * FROM threads ORDER BY created_at, rowid`).toArray();
    const comments = new Map<string, CommentRecord[]>();
    const commentRows = only
      ? this.sql.exec<CommentRow>(`SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at, rowid`, only)
      : this.sql.exec<CommentRow>(`SELECT * FROM comments ORDER BY created_at, rowid`);
    for (const c of commentRows) {
      const list = comments.get(c.thread_id) ?? [];
      list.push({
        commentId: c.id,
        author: { principal: c.author, kind: c.author_kind, onBehalfOf: c.on_behalf_of, agentName: c.agent_name },
        body: c.body,
        createdAt: c.created_at,
        atVersion: c.at_version,
      });
      comments.set(c.thread_id, list);
    }
    const anchors = new Map<string, AnchorRow>();
    for (const a of this.sql.exec<AnchorRow>(`SELECT * FROM anchors WHERE version = ?`, version)) {
      anchors.set(a.thread_id, a);
    }
    return rows.map((t) => {
      const anchor: Anchor = { exact: t.anchor_exact };
      if (t.anchor_prefix !== null) anchor.prefix = t.anchor_prefix;
      if (t.anchor_suffix !== null) anchor.suffix = t.anchor_suffix;
      if (t.section !== null) anchor.section = t.section;
      const memo = anchors.get(t.id);
      return {
        threadId: t.id,
        anchor,
        anchorStatus: memo?.status ?? "orphaned",
        matchedText: memo?.status === "anchored" ? memo.matched_text : null,
        createdAtVersion: t.created_version,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        createdBy: t.created_by,
        state: t.state,
        resolution:
          t.state === "resolved" && t.resolved_by !== null
            ? {
                by: {
                  principal: t.resolved_by,
                  kind: t.resolved_kind ?? "human",
                  onBehalfOf: t.resolved_on_behalf_of,
                  agentName: t.resolved_agent_name,
                },
                atVersion: t.resolved_at_version as number,
                at: t.resolved_at as number,
              }
            : null,
        comments: comments.get(t.id) ?? [],
      };
    });
  }

  /**
   * Overwrite `docs/{docId}/threads.json` with the whole of this object's
   * state. Queued so writes land in order, and each one is built when it runs,
   * so the last to run always carries the latest state. Failure is logged and
   * swallowed: the mutation already happened, and the next one rewrites it.
   */
  private snapshot(docId: string): Promise<void> {
    const run = async () => {
      // A deleted document's threads.json is swept right after the purge; never rewrite it.
      if (this.gone) return;
      try {
        const anchors = this.sql.exec<AnchorRow>(`SELECT * FROM anchors ORDER BY thread_id, version`).toArray();
        const full = this.readThreads(0).map((t) => {
          const { anchorStatus: _s, matchedText: _m, ...rest } = t;
          return {
            ...rest,
            anchors: anchors
              .filter((a) => a.thread_id === t.threadId)
              .map((a) => ({ version: a.version, status: a.status, matchedText: a.matched_text })),
          };
        });
        await this.env.DOCS.put(
          threadsObjectKey(docId),
          JSON.stringify({ docId, schema: 1, threads: full }),
          { httpMetadata: { contentType: "application/json" } },
        );
      } catch (error) {
        console.error("comments snapshot failed", { docId, error });
      }
    };
    this.snapshots = this.snapshots.then(run, run);
    return this.snapshots;
  }
}
