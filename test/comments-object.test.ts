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
      await stub.createThread({ docId, ...alice, at: 1000, version: 1, anchor: { exact: "brown fox" }, body: "  why brown?  " }),
    );
    expect(made.matchedText).toBe("brown fox");
    const reply = await stub.reply({ docId, ...bob, at: 2000, version: 1, threadId: made.threadId, body: "because" });
    expect(reply.ok).toBe(true);

    const listed = await stub.list({ docId, version: 1, latestVersion: 3 });
    if (!listed.ok) throw new Error("list failed");
    expect(listed.latestVersion).toBe(3);
    expect(listed.threads).toHaveLength(1);
    const t = listed.threads[0] as ThreadRecord;
    expect(t).toMatchObject({
      threadId: made.threadId,
      anchorStatus: "anchored",
      matchedText: "brown fox",
      createdAtVersion: 1,
      createdAt: 1000,
      state: "open",
      resolution: null,
      createdBy: "acct_alice",
    });
    expect(t.comments.map((c) => [c.author.principal, c.body])).toEqual([
      ["acct_alice", "why brown?"],
      ["acct_bob", "because"],
    ]);
  });

  it("reads one thread as list would, and says when there is none", async () => {
    const { docId, stub } = await start();
    const made = mustCreate(
      await stub.createThread({ docId, ...alice, at: 1000, version: 1, anchor: { exact: "lazy dog" }, body: "x" }),
    );
    const found = await stub.getThread({ docId, threadId: made.threadId, version: 1 });
    if (!found.ok) throw new Error("getThread failed");
    expect(found.thread).toMatchObject({ threadId: made.threadId, anchorStatus: "anchored", matchedText: "lazy dog" });
    expect(await stub.getThread({ docId, threadId: "th_nope", version: 1 })).toEqual({ ok: false, reason: "thread_not_found" });
    expect(await stub.getThread({ docId, threadId: made.threadId, version: 7 })).toEqual({ ok: false, reason: "version_not_found" });
  });

  it("stores an agent's onBehalfOf and drops it for a human", async () => {
    const { docId, stub } = await start();
    const agent = { principal: "acct_alice", kind: "agent" as const, onBehalfOf: "acct_alice" };
    mustCreate(await stub.createThread({ docId, ...agent, at: 1, version: 1, anchor: { exact: "fox" }, body: "x" }));
    mustCreate(
      await stub.createThread({
        docId,
        ...alice,
        onBehalfOf: "acct_smuggled",
        at: 2,
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
    const base = { docId, ...alice, at: 1, version: 1 };
    expect(await stub.createThread({ ...base, anchor: { exact: "" }, body: "x" })).toEqual({ ok: false, reason: "invalid_anchor" });
    expect(await stub.createThread({ ...base, anchor: { exact: "fox" }, body: "   " })).toEqual({ ok: false, reason: "invalid_body" });
    expect(await stub.createThread({ ...base, anchor: { exact: "fox" }, body: "x".repeat(4001) })).toEqual({ ok: false, reason: "invalid_body" });
    expect(await stub.createThread({ ...base, anchor: { exact: "no such text" }, body: "x" })).toEqual({ ok: false, reason: "anchor_not_found" });
    expect(await stub.createThread({ ...base, version: 9, anchor: { exact: "fox" }, body: "x" })).toEqual({ ok: false, reason: "version_not_found" });
    expect(await stub.createThread({ ...base, anchor: { exact: "fox" }, body: "x".repeat(4000) })).toMatchObject({ ok: true });
  });

  it("refuses an ambiguous quote at post time, accepts it with context", async () => {
    const { docId, stub } = await start("<p>the end</p><p>the end</p>");
    const base = { docId, ...alice, at: 1, version: 1, body: "x" };
    expect(await stub.createThread({ ...base, anchor: { exact: "the end" } })).toEqual({ ok: false, reason: "anchor_not_found" });
    expect(await stub.createThread({ ...base, anchor: { exact: "the end", prefix: "the end" } })).toMatchObject({ ok: true });
  });

  it("serialises concurrent posts: every one lands, ids are distinct", async () => {
    const { docId, stub } = await start();
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        stub.createThread({ docId, ...alice, at: i, version: 1, anchor: { exact: "fox" }, body: `c${i}` }),
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
    await runInDurableObject(stub, async (_instance: DocComments, state) => {
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
        stub.createThread({ docId, ...alice, at: i, version: 1, anchor: { exact: "fox" }, body: `c${i}` }),
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
    await runInDurableObject(stub, async (_instance: DocComments, state) => {
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
    expect(await stub.reply({ docId, ...alice, at: 1, version: 1, threadId: "th_0", body: "x" })).toEqual({
      ok: false,
      reason: "limit_comments",
    });
    expect(await stub.createThread({ docId, ...alice, at: 1, version: 1, anchor: { exact: "fox" }, body: "x" })).toEqual({
      ok: false,
      reason: "limit_comments",
    });
  });

  it("re-anchors once per version and answers later reads from the memo", async () => {
    const { docId, stub } = await start("<p>Keep this sentence. Also this one.</p>");
    mustCreate(await stub.createThread({ docId, ...alice, at: 1, version: 1, anchor: { exact: "this sentence" }, body: "a" }));
    mustCreate(await stub.createThread({ docId, ...alice, at: 2, version: 1, anchor: { exact: "this one" }, body: "b" }));

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
    mustCreate(await stub.createThread({ docId, ...alice, at: 1, version: 1, anchor: { exact: "The sentence" }, body: "a" }));
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
    mustCreate(await stub.createThread({ docId, ...alice, at: 1, version: 1, anchor: { exact: "one two three" }, body: "a" }));
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
    const a = mustCreate(await stub.createThread({ docId, ...alice, at: 100, version: 1, anchor: { exact: "fox" }, body: "a" }));
    mustCreate(await stub.createThread({ docId, ...alice, at: 200, version: 1, anchor: { exact: "dog" }, body: "b" }));
    await stub.resolve({ docId, ...owner, isOwner: true, at: 300, version: 1, threadId: a.threadId });
    const states = async (args: { state?: "open" | "resolved" | "all"; since?: number }) => {
      const r = await stub.list({ docId, version: 1, ...args });
      if (!r.ok) throw new Error();
      return r.threads.map((t) => t.state);
    };
    expect(await states({ state: "open" })).toEqual(["open"]);
    expect(await states({ state: "resolved" })).toEqual(["resolved"]);
    expect(await states({ state: "all" })).toEqual(["resolved", "open"]);
    expect(await states({ since: 250 })).toEqual(["resolved"]);
    await stub.reopen({ docId, ...owner, isOwner: true, at: 400, version: 1, threadId: a.threadId });
    expect(await states({ since: 350 })).toEqual(["open"]);
  });

  it("resolve and reopen: owner or thread author only, idempotent, recorded", async () => {
    const { docId, stub } = await start();
    const t = mustCreate(await stub.createThread({ docId, ...alice, at: 1, version: 1, anchor: { exact: "fox" }, body: "a" }));
    const base = { docId, threadId: t.threadId, version: 1 };

    expect(await stub.resolve({ ...base, ...bob, isOwner: false, at: 2 })).toEqual({ ok: false, reason: "forbidden" });
    expect(await stub.resolve({ ...base, ...bob, isOwner: false, at: 2, threadId: "th_missing" })).toEqual({
      ok: false,
      reason: "thread_not_found",
    });

    const byAuthor = await stub.resolve({ ...base, ...alice, isOwner: false, at: 3 });
    expect(byAuthor).toMatchObject({ ok: true, changed: true });
    if (!byAuthor.ok) throw new Error();
    expect(byAuthor.thread).toMatchObject({
      state: "resolved",
      resolution: { by: alice, atVersion: 1, at: 3 },
    });

    // A second resolve changes nothing, and does not rewrite who resolved it.
    const second = await stub.resolve({ ...base, ...owner, isOwner: true, at: 4 });
    expect(second).toMatchObject({ ok: true, changed: false });
    if (!second.ok) throw new Error();
    expect(second.thread.resolution?.by.principal).toBe("acct_alice");

    expect(await stub.reopen({ ...base, ...bob, isOwner: false, at: 5 })).toEqual({ ok: false, reason: "forbidden" });
    const reopened = await stub.reopen({ ...base, ...owner, isOwner: true, at: 6 });
    expect(reopened).toMatchObject({ ok: true, changed: true });
    if (!reopened.ok) throw new Error();
    expect(reopened.thread).toMatchObject({ state: "open", resolution: null });
    expect(await stub.reopen({ ...base, ...owner, isOwner: true, at: 7 })).toMatchObject({ ok: true, changed: false });
  });

  it("an agent's resolve keeps its kind and account", async () => {
    const { docId, stub } = await start();
    const t = mustCreate(await stub.createThread({ docId, ...alice, at: 1, version: 1, anchor: { exact: "fox" }, body: "a" }));
    const agent = { principal: "lic_owner", kind: "agent" as const, onBehalfOf: "acct_owner" };
    const r = await stub.resolve({ docId, threadId: t.threadId, version: 1, ...agent, isOwner: true, at: 2 });
    if (!r.ok) throw new Error();
    expect(r.thread.resolution?.by).toEqual(agent);
  });

  it("resolving at a version the object cannot anchor changes nothing", async () => {
    const { docId, stub } = await start();
    const t = mustCreate(await stub.createThread({ docId, ...alice, at: 1, version: 1, anchor: { exact: "fox" }, body: "a" }));
    expect(await stub.resolve({ docId, threadId: t.threadId, version: 5, ...owner, isOwner: true, at: 2 })).toEqual({
      ok: false,
      reason: "version_not_found",
    });
    const listed = await stub.list({ docId, version: 1 });
    if (!listed.ok) throw new Error();
    expect(listed.threads[0]?.state).toBe("open");
  });

  it("a resolved thread still takes replies and keeps its resolution", async () => {
    const { docId, stub } = await start();
    const t = mustCreate(await stub.createThread({ docId, ...alice, at: 1, version: 1, anchor: { exact: "fox" }, body: "a" }));
    await stub.resolve({ docId, threadId: t.threadId, version: 1, ...owner, isOwner: true, at: 2 });
    expect(await stub.reply({ docId, threadId: t.threadId, version: 1, ...bob, at: 3, body: "thanks" })).toMatchObject({ ok: true });
    const listed = await stub.list({ docId, version: 1 });
    if (!listed.ok) throw new Error();
    expect(listed.threads[0]?.state).toBe("resolved");
    expect(listed.threads[0]?.comments).toHaveLength(2);
  });

  it("replying to a missing thread fails", async () => {
    const { docId, stub } = await start();
    expect(await stub.reply({ docId, threadId: "th_nope", version: 1, ...bob, at: 1, body: "x" })).toEqual({
      ok: false,
      reason: "thread_not_found",
    });
  });

  it("deleting a reply removes only it; deleting the first comment removes the thread", async () => {
    const { docId, stub } = await start();
    const t = mustCreate(await stub.createThread({ docId, ...alice, at: 1, version: 1, anchor: { exact: "fox" }, body: "first" }));
    const r1 = await stub.reply({ docId, threadId: t.threadId, version: 1, ...bob, at: 2, body: "r1" });
    const r2 = await stub.reply({ docId, threadId: t.threadId, version: 1, ...alice, at: 3, body: "r2" });
    if (!r1.ok || !r2.ok) throw new Error();

    // Not yours, and missing, answer alike.
    expect(await stub.deleteComment({ docId, commentId: r1.commentId, principal: "acct_alice" })).toEqual({
      ok: false,
      reason: "comment_not_found",
    });
    expect(await stub.deleteComment({ docId, commentId: "cm_nope", principal: "acct_alice" })).toEqual({
      ok: false,
      reason: "comment_not_found",
    });

    expect(await stub.deleteComment({ docId, commentId: r1.commentId, principal: "acct_bob" })).toEqual({
      ok: true,
      deleted: "comment",
      threadId: t.threadId,
    });
    let listed = await stub.list({ docId, version: 1 });
    if (!listed.ok) throw new Error();
    expect(listed.threads[0]?.comments.map((c) => c.body)).toEqual(["first", "r2"]);

    expect(await stub.deleteComment({ docId, commentId: t.commentId, principal: "acct_alice" })).toEqual({
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

    const t = mustCreate(await stub.createThread({ docId, ...alice, at: 1, version: 1, anchor: { exact: "fox" }, body: "first" }));
    const read = async () =>
      (await (await env.DOCS.get(key))!.json()) as { docId: string; threads: Array<Record<string, unknown>> };
    let snap = await read();
    expect(snap.docId).toBe(docId);
    expect(snap.threads).toHaveLength(1);
    expect(snap.threads[0]).toMatchObject({ threadId: t.threadId, createdBy: "acct_alice", state: "open" });
    expect(snap.threads[0]?.anchors).toEqual([{ version: 1, status: "anchored", matchedText: "fox" }]);

    await stub.reply({ docId, threadId: t.threadId, version: 1, ...bob, at: 2, body: "r" });
    snap = await read();
    expect((snap.threads[0]?.comments as unknown[]).length).toBe(2);

    await stub.resolve({ docId, threadId: t.threadId, version: 1, ...owner, isOwner: true, at: 3 });
    snap = await read();
    expect(snap.threads[0]?.state).toBe("resolved");

    await stub.deleteComment({ docId, commentId: t.commentId, principal: "acct_alice" });
    snap = await read();
    expect(snap.threads).toEqual([]);
  });

  it("leaves the last snapshot carrying the latest state when mutations race", async () => {
    const { docId, stub } = await start();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        stub.createThread({ docId, ...alice, at: i, version: 1, anchor: { exact: "fox" }, body: `c${i}` }),
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
      const r = await instance.createThread({ docId, ...alice, at: 1, version: 1, anchor: { exact: "fox" }, body: "x" });
      expect(r.ok).toBe(true);
    });
  });

  it("purge wipes the object and the object keeps working afterwards", async () => {
    const { docId, stub } = await start();
    mustCreate(await stub.createThread({ docId, ...alice, at: 1, version: 1, anchor: { exact: "fox" }, body: "x" }));
    expect(await stub.purge()).toEqual({ ok: true });
    const listed = await stub.list({ docId, version: 1 });
    if (!listed.ok) throw new Error();
    expect(listed.threads).toEqual([]);
    expect(await stub.createThread({ docId, ...alice, at: 2, version: 1, anchor: { exact: "dog" }, body: "again" })).toMatchObject({ ok: true });
  });

  it("is addressed per document: two ids share nothing", async () => {
    const a = await start();
    const b = await start();
    mustCreate(await a.stub.createThread({ docId: a.docId, ...alice, at: 1, version: 1, anchor: { exact: "fox" }, body: "x" }));
    const listed = await b.stub.list({ docId: b.docId, version: 1 });
    if (!listed.ok) throw new Error();
    expect(listed.threads).toEqual([]);
  });
});
