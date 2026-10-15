import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  DocComments,
  MAX_COMMENTS,
  MAX_THREADS,
  type CreateThreadResult,
  type ThreadRecord,
} from "../src/comments/object.js";
import type { Env } from "../src/config.js";
import { threadsObjectKey, versionObjectKey } from "../src/storage.js";

let counter = 0;
/** A fresh document id per test, so objects never share state. */
const newDoc = () => `cmt${(++counter).toString().padStart(13, "0")}`;

const page = (body: string) => `<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`;

const publish = async (docId: string, n: number, body: string) =>
  await env.DOCS.put(versionObjectKey(docId, n), page(body));

const stubFor = (docId: string) => env.COMMENTS!.get(env.COMMENTS!.idFromName(docId));

const alice = { principal: "acct_alice", kind: "human" as const, onBehalfOf: null };
const bob = { principal: "acct_bob", kind: "human" as const, onBehalfOf: null };
const owner = { principal: "acct_owner", kind: "human" as const, onBehalfOf: null };

async function start(body = "<p>The quick brown fox jumps over the lazy dog.</p>") {
  const docId = newDoc();
  await publish(docId, 1, body);
  return { docId, stub: stubFor(docId) };
}

const mustCreate = (r: CreateThreadResult) => {
  if (!r.ok) throw new Error(`createThread failed: ${r.reason}`);
  return r;
};

const countRows = (state: DurableObjectState, table: string) =>
  state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;

describe("DocComments", () => {
  it("creates a thread, lists it with its comment and the principal data", async () => {
    const { docId, stub } = await start();
    const made = mustCreate(
      await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "brown fox" }, body: "  why brown?  " }),
    );
    expect(made.thread.matchedText).toBe("brown fox");
    const reply = await stub.reply({ docId, ...bob, version: 1, threadId: made.threadId, body: "because" });
    expect(reply.ok).toBe(true);

    const listed = await stub.list({ docId, version: 1 });
    if (!listed.ok) throw new Error("list failed");
    expect(listed.threads).toHaveLength(1);
    const t = listed.threads[0] as ThreadRecord;
    expect(t).toMatchObject({
      threadId: made.threadId,
      anchorStatus: "anchored",
      matchedText: "brown fox",
      createdAtVersion: 1,
      createdAt: expect.any(Number),
      state: "open",
      resolution: null,
      createdBy: "acct_alice",
    });
    expect(t.comments.map((c) => [c.author.principal, c.body])).toEqual([
      ["acct_alice", "why brown?"],
      ["acct_bob", "because"],
    ]);
  });

  it("hands a write back the thread it made, anchored, so nothing asks again to address an email", async () => {
    const { docId, stub } = await start();
    const made = mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "lazy dog" }, body: "x" }));
    expect(made.thread).toMatchObject({ threadId: made.threadId, anchorStatus: "anchored", matchedText: "lazy dog" });
    const reply = await stub.reply({ docId, ...bob, version: 1, threadId: made.threadId, body: "y" });
    if (!reply.ok) throw new Error("reply failed");
    expect(reply.thread.comments.map((c) => c.body)).toEqual(["x", "y"]);
    expect(reply.thread).toMatchObject({ anchorStatus: "anchored", matchedText: "lazy dog" });
  });

  it("stores an agent's onBehalfOf and drops it for a human", async () => {
    const { docId, stub } = await start();
    const agent = { principal: "acct_alice", kind: "agent" as const, onBehalfOf: "acct_alice" };
    mustCreate(await stub.createThread({ docId, ...agent, version: 1, anchor: { exact: "fox" }, body: "x" }));
    mustCreate(
      await stub.createThread({
        docId,
        ...alice,
        onBehalfOf: "acct_smuggled",
        version: 1,
        anchor: { exact: "dog" },
        body: "y",
      }),
    );
    const listed = await stub.list({ docId, version: 1 });
    if (!listed.ok) throw new Error();
    expect(listed.threads.map((t) => t.comments[0]?.author)).toEqual([
      { principal: "acct_alice", kind: "agent", onBehalfOf: "acct_alice" },
      { principal: "acct_alice", kind: "human", onBehalfOf: null },
    ]);
  });

  it("refuses malformed input and a quote that is not in the version", async () => {
    const { docId, stub } = await start();
    const base = { docId, ...alice, version: 1 };
    expect(await stub.createThread({ ...base, anchor: { exact: "" }, body: "x" })).toEqual({ ok: false, reason: "invalid_anchor" });
    expect(await stub.createThread({ ...base, anchor: { exact: "fox" }, body: "   " })).toEqual({ ok: false, reason: "invalid_body" });
    expect(await stub.createThread({ ...base, anchor: { exact: "fox" }, body: "x".repeat(4001) })).toEqual({ ok: false, reason: "invalid_body" });
    expect(await stub.createThread({ ...base, anchor: { exact: "no such text" }, body: "x" })).toEqual({ ok: false, reason: "anchor_not_found" });
    expect(await stub.createThread({ ...base, version: 9, anchor: { exact: "fox" }, body: "x" })).toEqual({ ok: false, reason: "version_not_found" });
    expect(await stub.createThread({ ...base, anchor: { exact: "fox" }, body: "x".repeat(4000) })).toMatchObject({ ok: true });
  });

  it("refuses an ambiguous quote at post time, accepts it with context", async () => {
    const { docId, stub } = await start("<p>the end</p><p>the end</p>");
    const base = { docId, ...alice, version: 1, body: "x" };
    expect(await stub.createThread({ ...base, anchor: { exact: "the end" } })).toEqual({ ok: false, reason: "anchor_not_found" });
    expect(await stub.createThread({ ...base, anchor: { exact: "the end", prefix: "the end" } })).toMatchObject({ ok: true });
  });

  it("serialises concurrent posts: every one lands, ids are distinct", async () => {
    const { docId, stub } = await start();
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: `c${i}` }),
      ),
    );
    expect(attempts.every((a) => a.ok)).toBe(true);
    const listed = await stub.list({ docId, version: 1 });
    if (!listed.ok) throw new Error();
    expect(listed.threads).toHaveLength(12);
    expect(new Set(listed.threads.map((t) => t.threadId)).size).toBe(12);
  });

  it("holds the thread cap under a race at the boundary", async () => {
    const { docId, stub } = await start();
    await runInDurableObject(stub, async (instance: DocComments, state) => {
      (instance as unknown as { usable(): boolean }).usable(); // the schema is created on first use
      const sql = state.storage.sql;
      for (let i = 0; i < MAX_THREADS - 3; i++) {
        sql.exec(
          `INSERT INTO threads (id, created_version, created_by, created_at, updated_at, anchor_exact) VALUES (?, 1, 'x', ?, ?, 'fox')`,
          `th_${i}`,
          i,
          i,
        );
        sql.exec(
          `INSERT INTO comments (id, thread_id, author, author_kind, body, created_at, at_version) VALUES (?, ?, 'x', 'human', 'b', ?, 1)`,
          `cm_${i}`,
          `th_${i}`,
          i,
        );
      }
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: `c${i}` }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.reason === "limit_threads")).toHaveLength(5);
    await runInDurableObject(stub, async (_i: DocComments, state) => {
      expect(countRows(state, "threads")).toBe(MAX_THREADS);
    });
  });

  it("caps comments at 2000, for replies and for new threads", async () => {
    const { docId, stub } = await start();
    await runInDurableObject(stub, async (instance: DocComments, state) => {
      (instance as unknown as { usable(): boolean }).usable(); // the schema is created on first use
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO threads (id, created_version, created_by, created_at, updated_at, anchor_exact) VALUES ('th_0', 1, 'x', 0, 0, 'fox')`);
      for (let i = 0; i < MAX_COMMENTS; i++) {
        sql.exec(
          `INSERT INTO comments (id, thread_id, author, author_kind, body, created_at, at_version) VALUES (?, 'th_0', 'x', 'human', 'b', ?, 1)`,
          `cm_${i}`,
          i,
        );
      }
    });
    expect(await stub.reply({ docId, ...alice, version: 1, threadId: "th_0", body: "x" })).toEqual({
      ok: false,
      reason: "limit_comments",
    });
    expect(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: "x" })).toEqual({
      ok: false,
      reason: "limit_comments",
    });
  });

  it("re-anchors once per version and answers later reads from the memo", async () => {
    const { docId, stub } = await start("<p>Keep this sentence. Also this one.</p>");
    mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "this sentence" }, body: "a" }));
    mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "this one" }, body: "b" }));

    await publish(docId, 2, "<p>Keep this sentence. A different ending.</p>");
    const first = await stub.list({ docId, version: 2 });
    if (!first.ok) throw new Error();
    expect(first.threads.map((t) => t.anchorStatus)).toEqual(["anchored", "orphaned"]);
    expect(first.threads[1]?.matchedText).toBeNull();

    // The memo is stored: v2 is gone from R2 and still answers.
    await env.DOCS.delete(versionObjectKey(docId, 2));
    const again = await stub.list({ docId, version: 2 });
    if (!again.ok) throw new Error();
    expect(again.threads.map((t) => t.anchorStatus)).toEqual(["anchored", "orphaned"]);
    await runInDurableObject(stub, async (_i: DocComments, state) => {
      const n = state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM anchors WHERE version = 2`).one().n;
      expect(n).toBe(2);
    });

    // A version R2 does not have, and nothing is memoised for, is an error.
    expect(await stub.list({ docId, version: 3 })).toEqual({ ok: false, reason: "version_not_found" });
  });

  it("does not read R2 for a version with no threads to anchor", async () => {
    const { docId, stub } = await start();
    const listed = await stub.list({ docId, version: 7 });
    expect(listed).toMatchObject({ ok: true, threads: [] });
  });

  it("anchors again when text returns in a later version", async () => {
    const { docId, stub } = await start("<p>The sentence lives.</p>");
    mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "The sentence" }, body: "a" }));
    await publish(docId, 2, "<p>Gone.</p>");
    await publish(docId, 3, "<p>The sentence is back.</p>");
    const v2 = await stub.list({ docId, version: 2 });
    const v3 = await stub.list({ docId, version: 3 });
    if (!v2.ok || !v3.ok) throw new Error();
    expect(v2.threads[0]?.anchorStatus).toBe("orphaned");
    expect(v3.threads[0]?.anchorStatus).toBe("anchored");
  });

  it("rewrites the stored quote when only whitespace changed", async () => {
    const { docId, stub } = await start("<p>one two three</p>");
    mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "one two three" }, body: "a" }));
    await publish(docId, 2, "<p>one\n   two   three</p>");
    const listed = await stub.list({ docId, version: 2 });
    if (!listed.ok) throw new Error();
    expect(listed.threads[0]).toMatchObject({
      anchorStatus: "anchored",
      matchedText: "one\n   two   three",
      anchor: { exact: "one\n   two   three" },
    });
  });

  it("filters by state and since", async () => {
    const { docId, stub } = await start();
    const a = mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: "a" }));
    const b = mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "dog" }, body: "b" }));
    await stub.resolve({ docId, ...owner, scope: [owner.principal], isOwner: true, version: 1, threadId: a.threadId });
    const states = async (args: { state?: "open" | "resolved" | "all"; since?: number }) => {
      const r = await stub.list({ docId, version: 1, ...args });
      if (!r.ok) throw new Error();
      return r.threads.map((t) => t.state);
    };
    const activity = async (id: string) => {
      const r = await stub.list({ docId, version: 1 });
      if (!r.ok) throw new Error();
      return r.threads.find((t) => t.threadId === id)!.updatedAt;
    };
    expect(await states({ state: "open" })).toEqual(["open"]);
    expect(await states({ state: "resolved" })).toEqual(["resolved"]);
    expect(await states({ state: "all" })).toEqual(["resolved", "open"]);
    expect(await states({ since: await activity(b.threadId) })).toEqual(["resolved"]);
    const resolvedAt = await activity(a.threadId);
    await stub.reopen({ docId, ...owner, scope: [owner.principal], isOwner: true, version: 1, threadId: a.threadId });
    expect(await states({ since: resolvedAt })).toEqual(["open"]);
  });

  it("stamps every write itself, from a clock that only moves forward, and a deleted reply counts as activity", async () => {
    const { docId, stub } = await start();
    const made = mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: "a" }));
    const stamps: number[] = [];
    const updated = async () => {
      const r = await stub.list({ docId, version: 1 });
      if (!r.ok) throw new Error();
      stamps.push(r.threads[0]!.updatedAt);
    };
    await updated();
    // Back-to-back writes inside one millisecond still get distinct, increasing stamps.
    const reply = await stub.reply({ docId, ...bob, version: 1, threadId: made.threadId, body: "b" });
    if (!reply.ok) throw new Error();
    await updated();
    await stub.resolve({ docId, ...owner, scope: [owner.principal], isOwner: true, version: 1, threadId: made.threadId });
    await updated();
    await stub.reopen({ docId, ...owner, scope: [owner.principal], isOwner: true, version: 1, threadId: made.threadId });
    await updated();
    expect(await stub.deleteComment({ docId, commentId: reply.commentId, scope: [bob.principal] })).toMatchObject({ ok: true, deleted: "comment" });
    await updated();
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]!).toBeGreaterThan(stamps[i - 1]!);
  });

  it("treats every id in the caller's owner scope as the same author", async () => {
    const { docId, stub } = await start();
    // Written by a license key before it was linked; the caller is now the linked account.
    const made = mustCreate(
      await stub.createThread({ docId, principal: "lic_dave", kind: "agent", onBehalfOf: "lic_dave", version: 1, anchor: { exact: "fox" }, body: "a" }),
    );
    const linked = ["acct_dave", "lic_dave"];
    const base = { docId, threadId: made.threadId, version: 1, principal: "acct_dave", kind: "human" as const, onBehalfOf: null, isOwner: false };
    expect(await stub.resolve({ ...base, scope: ["acct_other"] })).toEqual({ ok: false, reason: "forbidden" });
    expect(await stub.resolve({ ...base, scope: linked })).toMatchObject({ ok: true, changed: true });
    expect(await stub.reopen({ ...base, scope: linked })).toMatchObject({ ok: true, changed: true });
    expect(await stub.deleteComment({ docId, commentId: made.commentId, scope: ["acct_dave"] })).toEqual({ ok: false, reason: "comment_not_found" });
    expect(await stub.deleteComment({ docId, commentId: made.commentId, scope: linked })).toMatchObject({ ok: true, deleted: "thread" });
  });

  it("resolve and reopen: owner or thread author only, idempotent, recorded", async () => {
    const { docId, stub } = await start();
    const t = mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: "a" }));
    const base = { docId, threadId: t.threadId, version: 1 };

    expect(await stub.resolve({ ...base, ...bob, scope: [bob.principal], isOwner: false })).toEqual({ ok: false, reason: "forbidden" });
    expect(await stub.resolve({ ...base, ...bob, scope: [bob.principal], isOwner: false, threadId: "th_missing" })).toEqual({
      ok: false,
      reason: "thread_not_found",
    });

    const byAuthor = await stub.resolve({ ...base, ...alice, scope: [alice.principal], isOwner: false });
    expect(byAuthor).toMatchObject({ ok: true, changed: true });
    if (!byAuthor.ok) throw new Error();
    expect(byAuthor.thread).toMatchObject({
      state: "resolved",
      resolution: { by: alice, atVersion: 1 },
    });

    // A second resolve changes nothing, and does not rewrite who resolved it.
    const second = await stub.resolve({ ...base, ...owner, scope: [owner.principal], isOwner: true });
    expect(second).toMatchObject({ ok: true, changed: false });
    if (!second.ok) throw new Error();
    expect(second.thread.resolution?.by.principal).toBe("acct_alice");

    expect(await stub.reopen({ ...base, ...bob, scope: [bob.principal], isOwner: false })).toEqual({ ok: false, reason: "forbidden" });
    const reopened = await stub.reopen({ ...base, ...owner, scope: [owner.principal], isOwner: true });
    expect(reopened).toMatchObject({ ok: true, changed: true });
    if (!reopened.ok) throw new Error();
    expect(reopened.thread).toMatchObject({ state: "open", resolution: null });
    expect(await stub.reopen({ ...base, ...owner, scope: [owner.principal], isOwner: true })).toMatchObject({ ok: true, changed: false });
  });

  it("an agent's resolve keeps its kind and account", async () => {
    const { docId, stub } = await start();
    const t = mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: "a" }));
    const agent = { principal: "lic_owner", kind: "agent" as const, onBehalfOf: "acct_owner" };
    const r = await stub.resolve({ docId, threadId: t.threadId, version: 1, ...agent, scope: [agent.principal], isOwner: true });
    if (!r.ok) throw new Error();
    expect(r.thread.resolution?.by).toEqual(agent);
  });

  it("resolving at a version the object cannot anchor changes nothing", async () => {
    const { docId, stub } = await start();
    const t = mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: "a" }));
    expect(await stub.resolve({ docId, threadId: t.threadId, version: 5, ...owner, scope: [owner.principal], isOwner: true })).toEqual({
      ok: false,
      reason: "version_not_found",
    });
    const listed = await stub.list({ docId, version: 1 });
    if (!listed.ok) throw new Error();
    expect(listed.threads[0]?.state).toBe("open");
  });

  it("a resolved thread still takes replies and keeps its resolution", async () => {
    const { docId, stub } = await start();
    const t = mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: "a" }));
    await stub.resolve({ docId, threadId: t.threadId, version: 1, ...owner, scope: [owner.principal], isOwner: true });
    expect(await stub.reply({ docId, threadId: t.threadId, version: 1, ...bob, body: "thanks" })).toMatchObject({ ok: true });
    const listed = await stub.list({ docId, version: 1 });
    if (!listed.ok) throw new Error();
    expect(listed.threads[0]?.state).toBe("resolved");
    expect(listed.threads[0]?.comments).toHaveLength(2);
  });

  it("replying to a missing thread fails", async () => {
    const { docId, stub } = await start();
    expect(await stub.reply({ docId, threadId: "th_nope", version: 1, ...bob, body: "x" })).toEqual({
      ok: false,
      reason: "thread_not_found",
    });
  });

  it("deleting a reply removes only it; deleting the first comment removes the thread", async () => {
    const { docId, stub } = await start();
    const t = mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: "first" }));
    const r1 = await stub.reply({ docId, threadId: t.threadId, version: 1, ...bob, body: "r1" });
    const r2 = await stub.reply({ docId, threadId: t.threadId, version: 1, ...alice, body: "r2" });
    if (!r1.ok || !r2.ok) throw new Error();

    // Not yours, and missing, answer alike.
    expect(await stub.deleteComment({ docId, commentId: r1.commentId, scope: ["acct_alice"] })).toEqual({
      ok: false,
      reason: "comment_not_found",
    });
    expect(await stub.deleteComment({ docId, commentId: "cm_nope", scope: ["acct_alice"] })).toEqual({
      ok: false,
      reason: "comment_not_found",
    });

    expect(await stub.deleteComment({ docId, commentId: r1.commentId, scope: ["acct_bob"] })).toEqual({
      ok: true,
      deleted: "comment",
      threadId: t.threadId,
    });
    let listed = await stub.list({ docId, version: 1 });
    if (!listed.ok) throw new Error();
    expect(listed.threads[0]?.comments.map((c) => c.body)).toEqual(["first", "r2"]);

    expect(await stub.deleteComment({ docId, commentId: t.commentId, scope: ["acct_alice"] })).toEqual({
      ok: true,
      deleted: "thread",
      threadId: t.threadId,
    });
    listed = await stub.list({ docId, version: 1 });
    if (!listed.ok) throw new Error();
    expect(listed.threads).toEqual([]);
    await runInDurableObject(stub, async (_i: DocComments, state) => {
      expect([countRows(state, "threads"), countRows(state, "comments"), countRows(state, "anchors")]).toEqual([0, 0, 0]);
    });
  });

  it("writes a full snapshot to R2 after every mutation", async () => {
    const { docId, stub } = await start();
    const key = threadsObjectKey(docId);
    expect(await env.DOCS.head(key)).toBeNull();

    const t = mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: "first" }));
    const read = async () =>
      (await (await env.DOCS.get(key))!.json()) as { docId: string; threads: Array<Record<string, unknown>> };
    let snap = await read();
    expect(snap.docId).toBe(docId);
    expect(snap.threads).toHaveLength(1);
    expect(snap.threads[0]).toMatchObject({ threadId: t.threadId, createdBy: "acct_alice", state: "open" });
    expect(snap.threads[0]?.anchors).toEqual([{ version: 1, status: "anchored", matchedText: "fox" }]);

    await stub.reply({ docId, threadId: t.threadId, version: 1, ...bob, body: "r" });
    snap = await read();
    expect((snap.threads[0]?.comments as unknown[]).length).toBe(2);

    await stub.resolve({ docId, threadId: t.threadId, version: 1, ...owner, scope: [owner.principal], isOwner: true });
    snap = await read();
    expect(snap.threads[0]?.state).toBe("resolved");

    await stub.deleteComment({ docId, commentId: t.commentId, scope: ["acct_alice"] });
    snap = await read();
    expect(snap.threads).toEqual([]);
  });

  it("leaves the last snapshot carrying the latest state when mutations race", async () => {
    const { docId, stub } = await start();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: `c${i}` }),
      ),
    );
    const snap = (await (await env.DOCS.get(threadsObjectKey(docId)))!.json()) as { threads: unknown[] };
    expect(snap.threads).toHaveLength(8);
  });

  it("a failed snapshot does not fail the mutation", async () => {
    const { docId, stub } = await start();
    await runInDurableObject(stub, async (instance: DocComments) => {
      const inner = instance as unknown as { env: Env };
      const real = inner.env.DOCS;
      const broken = {
        get: real.get.bind(real),
        put: async () => {
          throw new Error("r2 down");
        },
      };
      inner.env = { ...inner.env, DOCS: broken as unknown as R2Bucket };
      const r = await instance.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: "x" });
      expect(r.ok).toBe(true);
    });
  });

  it("purge wipes the object, leaves it empty, and refuses everything afterwards", async () => {
    const { docId, stub } = await start();
    const made = mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: "x" }));
    await env.DOCS.delete(threadsObjectKey(docId)); // the sweep's job; so a snapshot found later was written after the purge
    expect(await stub.purge()).toEqual({ ok: true });

    const purged = { ok: false, reason: "purged" };
    expect(await stub.list({ docId, version: 1 })).toEqual(purged);
    expect(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "dog" }, body: "again" })).toEqual(purged);
    expect(await stub.reply({ docId, ...bob, version: 1, threadId: made.threadId, body: "y" })).toEqual(purged);
    expect(await stub.resolve({ docId, ...owner, scope: [owner.principal], isOwner: true, version: 1, threadId: made.threadId })).toEqual(purged);
    expect(await stub.deleteComment({ docId, commentId: made.commentId, scope: [alice.principal] })).toEqual(purged);

    // Nothing was recreated: no tables (the schema is lazy), only the tombstone, and no snapshot.
    await runInDurableObject(stub, async (_i: DocComments, state) => {
      const tables = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'`)
        .one().n;
      expect(tables).toBe(0);
      expect(await state.storage.get("purged")).toBe(true);
    });
    expect(await env.DOCS.head(threadsObjectKey(docId))).toBeNull();
  });

  it("purge beats a write that was parked on its R2 read: nothing lands, no snapshot is written", async () => {
    const { docId, stub } = await start();
    mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "fox" }, body: "x" }));
    await env.DOCS.delete(threadsObjectKey(docId)); // so any snapshot found later was written after this point
    await runInDurableObject(stub, async (instance: DocComments, state) => {
      const inner = instance as unknown as { env: Env; canonical: Map<number, unknown> };
      const real = inner.env.DOCS;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      inner.canonical.clear();
      inner.env = {
        ...inner.env,
        DOCS: {
          get: async (key: string) => {
            await gate;
            return await real.get(key);
          },
          put: real.put.bind(real),
        } as unknown as R2Bucket,
      };
      const parked = instance.createThread({ docId, ...alice, version: 1, anchor: { exact: "dog" }, body: "late" });
      await instance.purge();
      release();
      expect(await parked).toEqual({ ok: false, reason: "purged" });
      const tables = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('threads', 'comments', 'anchors')`)
        .one().n;
      expect(tables).toBe(0);
    });
    // The parked write wrote no snapshot after the purge (the earlier one was removed above).
    expect(await env.DOCS.head(threadsObjectKey(docId))).toBeNull();
  });

  it("re-anchoring writes a snapshot, so a rewritten quote and the new version's anchor are in it", async () => {
    const { docId, stub } = await start("<p>one two three</p>");
    const made = mustCreate(await stub.createThread({ docId, ...alice, version: 1, anchor: { exact: "one two three" }, body: "a" }));
    await publish(docId, 2, "<p>one\n   two   three</p>");
    await env.DOCS.delete(threadsObjectKey(docId));
    const listed = await stub.list({ docId, version: 2 });
    expect(listed.ok).toBe(true);
    const snap = (await (await env.DOCS.get(threadsObjectKey(docId)))!.json()) as {
      threads: Array<{ threadId: string; anchor: { exact: string }; anchors: Array<{ version: number }> }>;
    };
    const t = snap.threads.find((x) => x.threadId === made.threadId)!;
    expect(t.anchor.exact).toBe("one\n   two   three");
    expect(t.anchors.map((a) => a.version)).toEqual([1, 2]);
  });

  it("is addressed per document: two ids share nothing", async () => {
    const a = await start();
    const b = await start();
    mustCreate(await a.stub.createThread({ docId: a.docId, ...alice, version: 1, anchor: { exact: "fox" }, body: "x" }));
    const listed = await b.stub.list({ docId: b.docId, version: 1 });
    if (!listed.ok) throw new Error();
    expect(listed.threads).toEqual([]);
  });
});
