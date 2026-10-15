import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NO_ANALYTICS } from "../src/analytics.js";
import { deleteDoc } from "../src/api/manage.js";
import { addPerson } from "../src/api/access.js";
import { resolvePublisher, type Publisher } from "../src/auth.js";
import type { Env } from "../src/config.js";
import {
  deleteAccessRequest,
  findOrCreateAccount,
  insertAccessRequest,
  insertInvite,
  readAccess,
  type DocRow,
} from "../src/db.js";
import { DOC_ID_LENGTH, newAccountId } from "../src/ids.js";
import { linkExternalOwner } from "../src/owners.js";
import { docObjectPrefix, versionObjectKey } from "../src/storage.js";
import worker from "../src/index.js";

/**
 * Local routing has no configured hosts, so it falls back to path prefixes.
 * Deliberately not a real deployment host: these tests are about the surfaces,
 * not about which production domain carries them.
 */
const API_ORIGIN = "https://openartifacts.workers.dev";

const KEY_A = "cplus_live_a1b2c3d4e5f60718";
const KEY_B = "cplus_live_9988776655443322";
const KEY_FREE = "cplus_live_0102030405060708";

/** A doc id of the right shape that no push ever minted. */
/**
 * A well-formed id that is not in the database. Derived from DOC_ID_LENGTH, not
 * written out: a literal of the wrong length is rejected by `isDocId` on shape
 * before D1 is consulted, which silently turns every "not found" test into a
 * test of the shape check.
 */
const UNKNOWN_DOC_ID = "0123456789abcdefghjkmnpqrstvwxyz".repeat(2).slice(0, DOC_ID_LENGTH);

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Give a key a publisher row validated just now — what a real request leaves
 * behind after auth. These tests are about managing docs, not about
 * authenticating, so the license cache is warm and no license server is ever
 * reached.
 *
 * Each key gets its own account and a Believer plan by default. Passing an
 * account explicitly is how a test says "these two keys are the same person";
 * passing a plan exercises entitlement. Returns the account, which is what the
 * key's doc rows will carry.
 */
async function seedPublisher(key: string, owner?: string, plan = "believer"): Promise<string> {
  const keyHash = await sha256Hex(key);
  const account = owner ?? `account-${keyHash.slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO publishers (key_hash, plan, validated_at, owner)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(keyHash, plan, Date.now(), account)
    .run();
  return account;
}

let ownerA = "";
let ownerB = "";

beforeEach(async () => {
  ownerA = await seedPublisher(KEY_A);
  ownerB = await seedPublisher(KEY_B);
});

/** Statuses whose responses may not carry a body, per the Response constructor. */
const BODILESS = new Set([204, 205, 304]);

async function send(
  method: string,
  path: string,
  key: string | null,
  body?: unknown,
  overrides: Partial<Env> = {},
  extraHeaders: HeadersInit = {},
): Promise<Response> {
  const headers = new Headers(extraHeaders);
  if (key !== null) headers.set("authorization", `Bearer ${key}`);

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }

  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(path.startsWith("https://") ? path : `${API_ORIGIN}${path}`, init),
    {
      ...env,
      SERVING_HOST: "",
      API_HOST: "",
      LEGACY_SERVING_HOST: "",
      RETIRED_API_HOST: "",
      ...overrides,
    },
    ctx,
  );
  await waitOnExecutionContext(ctx);

  // A served page is an R2 stream; left open past the test's end the pool's
  // per-test storage isolation fails on it. Buffering here lets every test read
  // the body, or not, without having to remember to drain it.
  const buffered = await response.arrayBuffer();
  return new Response(BODILESS.has(response.status) ? null : buffered, {
    status: response.status,
    headers: response.headers,
  });
}

const del = (key: string | null, docId: string) => send("DELETE", `/api/v1/docs/${docId}`, key);

const list = (key: string | null, query = "") => send("GET", `/api/v1/docs${query}`, key);

const read = (path: string) => send("GET", path, null);

const page = (body: string) =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>A note</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

interface PushResponse {
  docId: string;
  url: string;
  version: number;
}

/**
 * Publish through the real push handler. Delete is a claim about what a push
 * left behind, so the setup has to be a real push rather than seeded rows.
 */
async function push(key: string, body: unknown, docId?: string): Promise<PushResponse> {
  const response =
    docId === undefined
      ? await send("POST", "/api/v1/docs", key, body)
      : await send("PUT", `/api/v1/docs/${docId}`, key, body);

  expect(response.status).toBe(docId === undefined ? 201 : 200);
  return (await response.json()) as PushResponse;
}

const publish = (key: string, title: string) => push(key, { title, html: page(`<p>${title}</p>`) });

interface ListedDoc {
  docId: string;
  title: string;
  url: string;
  version: number | null;
  updatedAt: number;
}

interface ListResponse {
  docs: ListedDoc[];
  cursor?: string;
}

async function listed(response: Response): Promise<ListResponse> {
  expect(response.status).toBe(200);
  return (await response.json()) as ListResponse;
}

const docRow = (docId: string) =>
  env.DB.prepare("SELECT * FROM docs WHERE id = ?").bind(docId).first<DocRow>();

const objectKeys = async (docId: string) =>
  (await env.DOCS.list({ prefix: docObjectPrefix(docId) })).objects.map((o) => o.key);

const allObjectKeys = async () => (await env.DOCS.list()).objects.map((o) => o.key);

/**
 * A doc row without going through push, so a test can control `created_at` to
 * the millisecond — which is what the cursor's tie-break is about.
 */
async function seedDoc(
  owner: string,
  id: string,
  createdAt: number,
  options: { versions?: number } = {},
): Promise<string> {
  const versions = options.versions ?? 1;
  await env.DB.prepare(
    `INSERT INTO docs (id, owner, title, latest_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, owner, `seeded ${id}`, versions, createdAt, createdAt)
    .run();

  for (let n = 1; n <= versions; n++) {
    await env.DB.prepare("INSERT INTO versions (doc_id, n, size, created_at) VALUES (?, ?, 1, ?)")
      .bind(id, n, createdAt)
      .run();
  }
  return id;
}

/** Valid doc ids that sort predictably, so a paging test can name what it expects. */
const seededId = (i: number) => String(i).padStart(DOC_ID_LENGTH, "0");

/** Every docId the list yields when walked to the end, in order. */
async function walk(key: string, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let query = `?limit=${limit}`;

  for (let requests = 0; requests <= 100; requests++) {
    const body = await listed(await list(key, query));
    ids.push(...body.docs.map((doc) => doc.docId));
    if (body.cursor === undefined) return ids;
    query = `?limit=${limit}&cursor=${encodeURIComponent(body.cursor)}`;
  }
  throw new Error("the list never ran out of pages");
}

describe("paid publishing plans", () => {
  it("lets a Plus subscriber publish and push a new version", async () => {
    await seedPublisher(KEY_A, ownerA, "plus");

    const created = await publish(KEY_A, "Plus v1");
    const updated = await push(
      KEY_A,
      { title: "Plus v2", html: page("<p>second draft</p>") },
      created.docId,
    );

    expect(created.version).toBe(1);
    expect(updated.version).toBe(2);
    expect((await read(`/d/${created.docId}`)).status).toBe(200);
    expect(await objectKeys(created.docId)).toEqual([
      versionObjectKey(created.docId, 1),
      versionObjectKey(created.docId, 2),
    ]);
  });
});

describe("DELETE /api/v1/docs/{docId}", () => {
  it("204s a doc I own and turns its public url into a 410", async () => {
    const created = await publish(KEY_A, "A note");
    expect((await read(`/d/${created.docId}`)).status).toBe(200);

    const response = await del(KEY_A, created.docId);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");

    // 410, not 404: a reader holding the link learns it was withdrawn rather
    // than concluding they mistyped it. That is what the kept row buys.
    const gone = await read(`/d/${created.docId}`);
    expect(gone.status).toBe(410);
    expect(gone.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await gone.text()).toContain("The author deleted this document.");
  });

  it("410s the doc's pinned versions too", async () => {
    const created = await publish(KEY_A, "A note");
    await push(KEY_A, { html: page("<p>second draft</p>") }, created.docId);

    expect((await del(KEY_A, created.docId)).status).toBe(204);

    for (const path of [`/d/${created.docId}/v1`, `/d/${created.docId}/v2`]) {
      expect({ path, status: (await read(path)).status }).toEqual({ path, status: 410 });
    }
  });

  it("destroys the bytes of every version, not just the latest", async () => {
    const created = await publish(KEY_A, "A note");
    await push(KEY_A, { html: page("<p>second draft</p>") }, created.docId);
    await push(KEY_A, { html: page("<p>third draft</p>") }, created.docId);
    expect(await objectKeys(created.docId)).toHaveLength(3);

    expect((await del(KEY_A, created.docId)).status).toBe(204);

    // The content is the part that actually had to disappear. Hiding the row
    // while leaving three copies of the doc readable by key would not be a delete.
    expect(await objectKeys(created.docId)).toEqual([]);
    expect(await env.DOCS.head(versionObjectKey(created.docId, 1))).toBeNull();
    // The row stays, so the serving path can still tell 410 from 404.
    expect(await docRow(created.docId)).toMatchObject({ deleted_at: expect.any(Number) });
  });

  it("clears a doc holding more objects than one R2 listing returns", async () => {
    const docId = await seedDoc(ownerA, seededId(1), Date.now());
    // 100 pushes a day compounds: a long-lived doc outgrows R2's 1000-key
    // listing page, and a delete that read only the first page would leave the
    // rest of the doc sitting in the bucket forever.
    //
    // Three objects over a page of two, not 1001 over a page of 1000: the
    // listing truncates either way, which is the only condition the loop turns
    // on. Called directly rather than over HTTP because the page size is the
    // point here, and every other delete test covers the route.
    for (let n = 1; n <= 3; n++) await env.DOCS.put(versionObjectKey(docId, n), "x");

    const publisher: Publisher = { owner: ownerA, plan: "believer" };
    const response = await deleteDoc(env, publisher, docId, NO_ANALYTICS, { objectBatch: 2 });

    expect(response.status).toBe(204);
    expect(await objectKeys(docId)).toEqual([]);
  });

  it("touches no other doc's bytes", async () => {
    const kept = await publish(KEY_A, "Kept");
    const dropped = await publish(KEY_A, "Dropped");

    expect((await del(KEY_A, dropped.docId)).status).toBe(204);

    expect(await allObjectKeys()).toEqual([versionObjectKey(kept.docId, 1)]);
    expect((await read(`/d/${kept.docId}`)).status).toBe(200);
  });

  it("404s another publisher's doc and leaves it completely untouched", async () => {
    const created = await publish(KEY_A, "Private");

    const response = await del(KEY_B, created.docId);

    // 404, never 403: a 403 would confirm the id is real.
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });

    expect(await docRow(created.docId)).toMatchObject({
      owner: ownerA,
      deleted_at: null,
    });
    expect(await objectKeys(created.docId)).toEqual([versionObjectKey(created.docId, 1)]);
    expect((await read(`/d/${created.docId}`)).status).toBe(200);
  });

  it("404s a second delete, and the doc stays deleted", async () => {
    const created = await publish(KEY_A, "A note");
    expect((await del(KEY_A, created.docId)).status).toBe(204);
    const deletedAt = (await docRow(created.docId))?.deleted_at;

    const again = await del(KEY_A, created.docId);

    // Not 204 twice: an already-deleted doc has to be indistinguishable from
    // one that never existed. What repeats safely is the outcome — the doc is
    // still deleted, at the same moment, with no bytes.
    expect(again.status).toBe(404);
    expect((await docRow(created.docId))?.deleted_at).toBe(deletedAt);
    expect(await objectKeys(created.docId)).toEqual([]);
    expect((await read(`/d/${created.docId}`)).status).toBe(410);
  });

  it("404s a doc that never existed", async () => {
    expect((await del(KEY_A, UNKNOWN_DOC_ID)).status).toBe(404);
  });

  it("still 204s when R2 fails after the row is already marked", async () => {
    const created = await publish(KEY_A, "A note");
    const brokenDocs = {
      list: () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket;

    const response = await send("DELETE", `/api/v1/docs/${created.docId}`, KEY_A, undefined, {
      DOCS: brokenDocs,
    });

    // The row is marked before R2 is touched, so by here the doc is withdrawn
    // from every reader whatever the bucket did. A 500 would tell the publisher
    // their unshare failed, and the retry it invites answers 404 — leaving them
    // certain the doc is still up when it is not.
    expect(response.status).toBe(204);
    expect((await read(`/d/${created.docId}`)).status).toBe(410);
    // What the failure actually costs: objects nothing can reach any more.
    expect(await objectKeys(created.docId)).toHaveLength(1);
  });

  it("404s an id that could never be a doc id", async () => {
    for (const id of [
      "not-a-doc-id",
      "0123456789abcdefghjkmnpqrsTOOLONG",
      "ilou00000000000000000000000",
      "0123456789ABCDEFGHJKMNPQRS",
    ]) {
      const response = await del(KEY_A, id);
      expect({ id, status: response.status }).toEqual({ id, status: 404 });
    }
  });

  it("401s an unauthenticated delete before it reaches a handler", async () => {
    const created = await publish(KEY_A, "A note");

    const response = await del(null, created.docId);

    expect(response.status).toBe(401);
    expect(await docRow(created.docId)).toMatchObject({ deleted_at: null });
    expect(await objectKeys(created.docId)).toHaveLength(1);
  });

  it("drops the doc out of its publisher's list", async () => {
    const kept = await publish(KEY_A, "Kept");
    const dropped = await publish(KEY_A, "Dropped");

    expect((await del(KEY_A, dropped.docId)).status).toBe(204);

    const body = await listed(await list(KEY_A));
    expect(body.docs.map((doc) => doc.docId)).toEqual([kept.docId]);
  });
});

describe("GET /api/v1/docs", () => {
  it("lists only the caller's own docs", async () => {
    const mine = [await publish(KEY_A, "Mine one"), await publish(KEY_A, "Mine two")];
    const theirs = await publish(KEY_B, "Theirs");

    const forA = await listed(await list(KEY_A));
    const forB = await listed(await list(KEY_B));

    expect(new Set(forA.docs.map((doc) => doc.docId))).toEqual(
      new Set(mine.map((doc) => doc.docId)),
    );
    expect(forB.docs.map((doc) => doc.docId)).toEqual([theirs.docId]);
    // Not merely absent from the page: another publisher's doc is not listable
    // at all, whatever the caller does with limit.
    expect(forB.docs.map((doc) => doc.title)).toEqual(["Theirs"]);
  });

  it("reports each doc's id, title, public url, version and update time", async () => {
    const created = await publish(KEY_A, "A note");
    const updated = await push(
      KEY_A,
      { title: "A note, revised", html: page("<p>second draft</p>") },
      created.docId,
    );
    const row = await docRow(created.docId);

    const body = await listed(await list(KEY_A));

    expect(body.docs).toEqual([
      {
        docId: created.docId,
        title: "A note, revised",
        // The same url the push handed back, which is the one the publisher
        // pasted somewhere and the only one they can match a list entry against.
        url: created.url,
        version: updated.version,
        updatedAt: row?.updated_at,
        linkAccess: "anyone",
      },
    ]);
  });

  it("points list urls at the serving host once one is configured (D3)", async () => {
    const created = await publish(KEY_A, "A note");

    const response = await send("GET", "/api/v1/docs", KEY_A, undefined, {
      SERVING_HOST: "openartifacts.site",
      API_HOST: "openartifacts.workers.dev",
    });

    expect((await listed(response)).docs[0]?.url).toBe(
      `https://openartifacts.site/d/${created.docId}`,
    );
  });

  it("orders newest first", async () => {
    const ids = [3, 1, 2].map((i) => seededId(i));
    await seedDoc(ownerA, ids[0]!, 3_000);
    await seedDoc(ownerA, ids[1]!, 1_000);
    await seedDoc(ownerA, ids[2]!, 2_000);

    const body = await listed(await list(KEY_A));

    expect(body.docs.map((doc) => doc.docId)).toEqual([ids[0], ids[2], ids[1]]);
  });

  it("returns an empty list, and no cursor, for a publisher with no docs", async () => {
    await publish(KEY_B, "Theirs");

    expect(await listed(await list(KEY_A))).toEqual({ docs: [] });
  });

  it("lists a doc whose first push never wrote bytes, so it can be deleted", async () => {
    // The crash artifact push.ts documents: a row with no versions and no
    // object, whose id was never returned to anyone. It still counts against
    // the 500-doc ceiling, so hiding it would make it unclearable.
    const stranded = await seedDoc(ownerA, seededId(1), Date.now(), { versions: 0 });

    const body = await listed(await list(KEY_A));

    expect(body.docs).toMatchObject([{ docId: stranded, version: null }]);
    expect((await del(KEY_A, stranded)).status).toBe(204);
  });

  it("defaults to 50 docs a page", async () => {
    for (let i = 1; i <= 51; i++) await seedDoc(ownerA, seededId(i), i);

    const body = await listed(await list(KEY_A));

    expect(body.docs).toHaveLength(50);
    expect(body.cursor).toEqual(expect.any(String));
  });

  it("honours a limit, and omits the cursor on the last page", async () => {
    for (let i = 1; i <= 3; i++) await seedDoc(ownerA, seededId(i), i);

    const first = await listed(await list(KEY_A, "?limit=2"));
    expect(first.docs).toHaveLength(2);
    expect(first.cursor).toEqual(expect.any(String));

    const second = await listed(
      await list(KEY_A, `?limit=2&cursor=${encodeURIComponent(first.cursor!)}`),
    );
    expect(second.docs).toHaveLength(1);
    // No trailing empty page: a cursor on the last full page would cost every
    // client one more round trip to discover the end.
    expect(second.cursor).toBeUndefined();
  });

  it("400s a limit that is not a whole number in range", async () => {
    for (const limit of ["0", "-1", "101", "1000", "abc", "10.5", "1e2", "", " 10", "+1"]) {
      const response = await list(KEY_A, `?limit=${encodeURIComponent(limit)}`);
      expect({ limit, status: response.status }).toEqual({ limit, status: 400 });
      await expect(response.json()).resolves.toEqual({
        error: { code: "bad_request", message: expect.any(String) },
      });
    }
  });

  it("accepts the boundaries of the limit range", async () => {
    await publish(KEY_A, "A note");

    for (const limit of ["1", "100"]) {
      expect((await list(KEY_A, `?limit=${limit}`)).status).toBe(200);
    }
  });

  it("400s a cursor it did not issue", async () => {
    await publish(KEY_A, "A note");

    for (const cursor of [
      "",
      "not-base64!!",
      // Well-formed base64 over payloads that are not resume points.
      btoa("nonsense"),
      btoa(`${Date.now()}.not-a-doc-id`),
      btoa(`not-a-number.${UNKNOWN_DOC_ID}`),
      btoa(`${Number.MAX_SAFE_INTEGER}0.${UNKNOWN_DOC_ID}`),
    ]) {
      const response = await list(KEY_A, `?cursor=${encodeURIComponent(cursor)}`);
      expect({ cursor, status: response.status }).toEqual({ cursor, status: 400 });
    }
  });

  it("401s an unauthenticated list", async () => {
    await publish(KEY_A, "A note");

    expect((await list(null)).status).toBe(401);
  });
});

describe("paging through the list", () => {
  it("yields every doc exactly once, with no duplicates and no gaps", async () => {
    const expected: string[] = [];
    for (let i = 1; i <= 7; i++) {
      expected.push(await seedDoc(ownerA, seededId(i), 1_000 + i));
    }
    expected.reverse();

    for (const limit of [1, 2, 3, 7, 100]) {
      const walked = await walk(KEY_A, limit);
      expect({ limit, walked }).toEqual({ limit, walked: expected });
    }
  });

  it("keeps the order total when docs share a created_at", async () => {
    // Milliseconds collide — a client pushing a folder does it every time — so
    // `created_at` alone is not a cursor. Without the id tie-break these five
    // docs would repeat or vanish across page boundaries.
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push(await seedDoc(ownerA, seededId(i), 42));
    ids.reverse();

    expect(await walk(KEY_A, 2)).toEqual(ids);
  });

  it("never repeats a doc when a newer one is pushed mid-walk", async () => {
    for (let i = 1; i <= 4; i++) await seedDoc(ownerA, seededId(i), 1_000 + i);

    const first = await listed(await list(KEY_A, "?limit=2"));
    // OFFSET paging renumbers here and page 2 would re-serve a doc from page 1.
    await publish(KEY_A, "Pushed mid-walk");
    const second = await listed(
      await list(KEY_A, `?limit=2&cursor=${encodeURIComponent(first.cursor!)}`),
    );

    const seen = [...first.docs, ...second.docs].map((doc) => doc.docId);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([seededId(4), seededId(3), seededId(2), seededId(1)]);
  });

  it("skips a doc deleted mid-walk and keeps the rest whole", async () => {
    for (let i = 1; i <= 6; i++) await seedDoc(ownerA, seededId(i), 1_000 + i);

    // Page one takes 6 and 5.
    const first = await listed(await list(KEY_A, "?limit=2"));
    expect(first.docs.map((doc) => doc.docId)).toEqual([seededId(6), seededId(5)]);

    // One doc already read and one still ahead of the cursor. Neither may
    // disturb the walk: the resume point is a position in the ordering, not an
    // offset, so removing rows on either side of it cannot shift anything.
    expect((await del(KEY_A, seededId(6))).status).toBe(204);
    expect((await del(KEY_A, seededId(3))).status).toBe(204);

    const rest: string[] = [];
    let cursor = first.cursor;
    while (cursor !== undefined) {
      const next = await listed(await list(KEY_A, `?limit=2&cursor=${encodeURIComponent(cursor)}`));
      rest.push(...next.docs.map((doc) => doc.docId));
      cursor = next.cursor;
    }

    // 3 is gone because it was deleted before the page holding it was read; 4,
    // 2 and 1 each appear exactly once, and nothing repeats across the boundary
    // the deletes straddled.
    expect(rest).toEqual([seededId(4), seededId(2), seededId(1)]);
  });

  it("stops walking a publisher's page at their own docs", async () => {
    for (let i = 1; i <= 4; i++) await seedDoc(ownerA, seededId(i), 1_000 + i);
    for (let i = 5; i <= 8; i++) await seedDoc(ownerB, seededId(i), 1_000 + i);

    // B's docs are newer, so a scan that ignored the publisher predicate on the
    // resume step would walk straight into them.
    expect(await walk(KEY_A, 2)).toEqual([4, 3, 2, 1].map((i) => seededId(i)));
    expect(await walk(KEY_B, 3)).toEqual([8, 7, 6, 5].map((i) => seededId(i)));
  });
});

/**
 * The point of owning documents by account rather than by key: which key you
 * happen to be holding stops deciding what you can see.
 */
describe("two keys belonging to one account", () => {
  const ACCOUNT = "e2b7a0c4-1f3d-4a6b-9c8e-2d5f7a1b3c9d";

  beforeEach(async () => {
    // Re-seed both keys onto the same account, over the per-key rows the outer
    // `beforeEach` wrote.
    await seedPublisher(KEY_A, ACCOUNT);
    await seedPublisher(KEY_B, ACCOUNT);
  });

  it("list one merged shelf, whichever key asks", async () => {
    const fromA = await publish(KEY_A, "Pushed with A");
    const fromB = await publish(KEY_B, "Pushed with B");

    for (const key of [KEY_A, KEY_B]) {
      const body = await listed(await list(key));
      expect(body.docs.map((doc) => doc.docId).sort()).toEqual([fromA.docId, fromB.docId].sort());
    }
  });

  it("can each unshare what the other published", async () => {
    const fromA = await publish(KEY_A, "Pushed with A");

    expect((await del(KEY_B, fromA.docId)).status).toBe(204);
  });

  it("store the account id on the doc, not the key hash", async () => {
    const created = await publish(KEY_A, "A note");

    expect(await docRow(created.docId)).toMatchObject({ owner: ACCOUNT });
  });

  it("stay invisible to a key on a different account", async () => {
    const other = "9a1c3e5f-7b9d-4f2a-8c6e-0d4b8f2a6c1e";
    await seedPublisher(KEY_B, other);
    const fromA = await publish(KEY_A, "Mine");

    expect(await listed(await list(KEY_B))).toEqual({ docs: [] });
    // 404, never 403: another account's doc is indistinguishable from one that
    // never existed, on every endpoint.
    expect((await del(KEY_B, fromA.docId)).status).toBe(404);
  });
});

/**
 * The entitlement gate is per *operation*. A publisher who was entitled when
 * they published and has since been downgraded keeps every power over what they
 * already put on the internet — most of all the power to take it down.
 */
describe("a publisher whose plan may no longer publish", () => {
  /** Mark it ineligible, with the cache left warm so no license server is reached. */
  const makeIneligible = async (key: string) =>
    env.DB.prepare("UPDATE publishers SET plan = 'unknown', validated_at = ? WHERE key_hash = ?")
      .bind(Date.now(), await sha256Hex(key))
      .run();

  it("can still unshare a doc it published while it was entitled", async () => {
    const created = await publish(KEY_A, "Published while entitled");
    await makeIneligible(KEY_A);

    expect((await del(KEY_A, created.docId)).status).toBe(204);

    // The bytes are what had to disappear. Refusing the delete would have left
    // this doc readable by anyone holding the link, with its author locked out
    // of withdrawing it — worse than never letting them publish it.
    expect(await objectKeys(created.docId)).toEqual([]);
    expect((await read(`/d/${created.docId}`)).status).toBe(410);
  });

  it("can still list what it has published, which is how it finds what to unshare", async () => {
    const created = await publish(KEY_A, "Still mine");
    await makeIneligible(KEY_A);

    const { docs } = await listed(await list(KEY_A));

    expect(docs.map((doc) => doc.docId)).toEqual([created.docId]);
  });

  it("cannot publish a new doc", async () => {
    await makeIneligible(KEY_A);

    const response = await send("POST", "/api/v1/docs", KEY_A, { html: page("<p>new</p>") });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    const body = (await response.json()) as { error: { code: string; message: string } };
    // The frozen code, so a client matching on `code` is unaffected; only the
    // message carries the distinction.
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toContain("paid plan");
  });

  it("cannot push a new version over a doc it already owns", async () => {
    const created = await publish(KEY_A, "Frozen at v1");
    await makeIneligible(KEY_A);

    const response = await send("PUT", `/api/v1/docs/${created.docId}`, KEY_A, {
      html: page("<p>v2</p>"),
    });

    expect(response.status).toBe(401);
    // Unchanged: update is publishing, so the public page still serves v1.
    expect(await objectKeys(created.docId)).toEqual([versionObjectKey(created.docId, 1)]);
    expect((await docRow(created.docId))?.latest_version).toBe(1);
  });
});

it("marks a rejected credential without losing its documents or another key's access", async () => {
  await seedPublisher(KEY_B, ownerA);
  const doc = await publish(KEY_A, "Keep this document");
  const before = await docRow(doc.docId);
  const keys = await objectKeys(doc.docId);
  await env.DB.prepare("UPDATE publishers SET validated_at = 0 WHERE key_hash = ?")
    .bind(await sha256Hex(KEY_A)).run();

  const rejected = await resolvePublisher(KEY_A, {
    ...env, LICENSE_API_URL: "https://license.test", LICENSE_API_KEY: "test-server-key",
  }, {
    fetch: (async () => Response.json({
      error: { json: { data: { code: "NOT_FOUND" } } },
    }, { status: 404 })) as typeof fetch,
  });
  expect(rejected).toMatchObject({ ok: false, reason: "invalid_license" });
  expect(await env.DB.prepare("SELECT rejected_at FROM publishers WHERE key_hash = ?")
    .bind(await sha256Hex(KEY_A)).first()).toEqual({ rejected_at: expect.any(Number) });
  expect(await docRow(doc.docId)).toEqual(before);
  expect(await objectKeys(doc.docId)).toEqual(keys);
  expect(await env.DB.prepare("SELECT n FROM versions WHERE doc_id = ?")
    .bind(doc.docId).first()).toEqual({ n: 1 });
  const response = await list(KEY_B);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(doc.docId);
  expect(await resolvePublisher(KEY_A, { ...env, LICENSE_API_URL: "" }))
    .toMatchObject({ ok: false, reason: "license_unavailable" });
});

describe("private sharing through the owner's credential", () => {
  const KEY_PLUS = "cplus_live_5544332211009988";
  const API = "https://api.openartifacts.ai";
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const hosts = {
    SERVING_HOST: "openartifacts.site",
    API_HOST: "api.openartifacts.ai",
    READER_SESSION_SECRET: "k".repeat(32),
    EMAIL: { send: async (message: { to: string; subject: string; text: string }) => void sent.push(message) },
    EMAIL_FROM: "share@mail.openartifacts.ai",
  } as Partial<Env>;

  async function privateDoc(): Promise<PushResponse & { linkAccess: string }> {
    await seedPublisher(KEY_PLUS, undefined, "plus");
    const created = await send("POST", `${API}/api/v1/private-docs`, KEY_PLUS, {
      title: "Q3 client report",
      html: page("<p>owner only</p>"),
    }, hosts);
    expect(created.status).toBe(201);
    return (await created.json()) as PushResponse & { linkAccess: string };
  }

  it("creates a private page through its own route, private from the first insert, and says so in the receipt", async () => {
    const created = await privateDoc();
    expect(created).toEqual({ docId: created.docId, url: `https://openartifacts.site/d/${created.docId}`, version: 1, linkAccess: "invited" });
    expect(await env.DB.prepare("SELECT link_access FROM docs WHERE id = ?").bind(created.docId).first()).toEqual({ link_access: "invited" });

    // The listing reports the stored mode, and the apex never serves the bytes.
    const listed = (await (await send("GET", `${API}/api/v1/docs`, KEY_PLUS, undefined, hosts)).json()) as { docs: Array<{ docId: string; linkAccess: string }> };
    expect(listed.docs.find((doc) => doc.docId === created.docId)?.linkAccess).toBe("invited");

    // The route takes POST and nothing else; every other method is an unclaimed path.
    expect((await send("GET", `${API}/api/v1/private-docs`, KEY_PLUS, undefined, hosts)).status).toBe(404);
    expect((await send("PUT", `${API}/api/v1/private-docs/${created.docId}`, KEY_PLUS, { html: page("x") }, hosts)).status).toBe(404);
  });

  it("keeps POST /docs public: the receipt says anyone, a linkAccess field is ignored, and a PUT never changes access", async () => {
    await seedPublisher(KEY_PLUS, undefined, "plus");
    const created = await send("POST", `${API}/api/v1/docs`, KEY_PLUS, { html: page("<p>public</p>"), linkAccess: "invited" }, hosts);
    expect(created.status).toBe(201);
    const receipt = (await created.json()) as { docId: string; linkAccess: string };
    expect(receipt.linkAccess).toBe("anyone");
    expect(await env.DB.prepare("SELECT link_access FROM docs WHERE id = ?").bind(receipt.docId).first()).toEqual({ link_access: "anyone" });

    // Not even a nonsense value is refused: it is an unknown field, as before. The update receipt is the one it always was.
    const updated = await send("PUT", `${API}/api/v1/docs/${receipt.docId}`, KEY_PLUS, { html: page("<p>v2</p>"), linkAccess: "nonsense" }, hosts);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ docId: receipt.docId, url: `https://openartifacts.site/d/${receipt.docId}`, version: 2 });
    expect(await env.DB.prepare("SELECT link_access FROM docs WHERE id = ?").bind(receipt.docId).first()).toEqual({ link_access: "anyone" });
  });

  it("opens the owner's private page with no sign-in, and nobody else's", async () => {
    const created = await privateDoc();
    expect(created.linkAccess).toBe("invited");

    const opened = await send("POST", `${API}/api/v1/docs/${created.docId}/open`, KEY_PLUS, undefined, hosts);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("cache-control")).toBe("no-store");
    const { url, expiresAt } = (await opened.json()) as { url: string; expiresAt: number };
    // The grant lives sixty seconds, no more.
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);

    // Follow it as a browser would: the grant becomes a cookie, and the cookie reads the page.
    const swapped = await send("GET", url, null, undefined, hosts);
    expect(swapped.status).toBe(303);
    const cookie = swapped.headers.get("set-cookie")!.split(";")[0]!;
    const page = await send("GET", new URL(url).origin + new URL(url).pathname, null, undefined, hosts, { cookie });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("owner only");

    // A publisher who does not own it is told it does not exist, as everywhere else.
    expect((await send("POST", `${API}/api/v1/docs/${created.docId}/open`, KEY_B, undefined, hosts)).status).toBe(404);
  });

  it("adds a person once, emails them the link and no credential, and removes them again", async () => {
    const created = await privateDoc();
    const person = `${API}/api/v1/docs/${created.docId}/access/people/Alice%40Acme.com`;
    const listOf = async (response: Response) =>
      ((await response.json()) as { people: Array<{ email: string }> }).people.map((p) => p.email);

    sent.length = 0;
    const first = await send("PUT", person, KEY_PLUS, undefined, hosts);
    const again = await send("PUT", person, KEY_PLUS, undefined, hosts);
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(await listOf(first)).toEqual(["alice@acme.com"]);
    expect(await listOf(again)).toEqual(["alice@acme.com"]);

    // Exactly one invite, whoever retried: the title alone in the subject, the
    // canonical link, the address to sign in with, and no credential.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("alice@acme.com");
    expect(sent[0]!.subject).toBe("\u201cQ3 client report\u201d was shared with you");
    expect(sent[0]!.text).toContain(`https://openartifacts.site/d/${created.docId}`);
    expect(sent[0]!.text).toContain("Q3 client report");
    expect(sent[0]!.text).toContain("Sign in with this address, alice@acme.com, to open it.");
    expect(sent[0]!.text).not.toContain("grant=");

    expect(await listOf(await send("DELETE", person, KEY_PLUS, undefined, hosts))).toEqual([]);
  });

  it("answers a repeat add on a lapsed license plan with 200 and sends no email", async () => {
    const created = await privateDoc();
    const person = `${API}/api/v1/docs/${created.docId}/access/people/alice%40acme.com`;
    expect((await send("PUT", person, KEY_PLUS, undefined, hosts)).status).toBe(200);
    await env.DB.prepare("UPDATE publishers SET plan = 'free' WHERE key_hash = ?").bind(await sha256Hex(KEY_PLUS)).run();
    sent.length = 0;

    for (let i = 0; i < 2; i += 1) {
      const repeat = await send("PUT", person, KEY_PLUS, undefined, hosts);
      expect(repeat.status).toBe(200);
      expect(await repeat.json()).toMatchObject({ people: [{ email: "alice@acme.com" }] });
    }
    expect(sent).toEqual([]);
  });

  it("caps new invites at 100 per owner in a rolling 24 hours, across documents, and refuses nothing else", async () => {
    const first = await privateDoc();
    const second = await privateDoc();
    const owner = await seedPublisher(KEY_PLUS, undefined, "plus");
    const other = await push(KEY_B, { title: "Not mine", html: page("<p>b</p>") });
    const now = Date.now();
    const seed = async (docId: string, email: string, createdAt: number) => {
      await env.DB.prepare("INSERT INTO doc_invites (doc_id, email, created_at) VALUES (?, ?, ?)").bind(docId, email, createdAt).run();
      const row = await env.DB.prepare("SELECT owner FROM docs WHERE id = ?").bind(docId).first<{ owner: string }>();
      await env.DB.prepare("INSERT INTO invite_sends (owner, created_at) VALUES (?, ?)").bind(row!.owner, createdAt).run();
    };
    for (let i = 0; i < 99; i += 1) await seed(i % 2 === 0 ? first.docId : second.docId, `recent${i}@acme.com`, now - 1000);
    // Outside the window, and another publisher's: neither counts.
    for (let i = 0; i < 5; i += 1) await seed(first.docId, `old${i}@acme.com`, now - 86_400_001);
    for (let i = 0; i < 100; i += 1) await seed(other.docId, `theirs${i}@acme.com`, now - 1000);
    const bob = (await findOrCreateAccount(env.DB, newAccountId(), "late@acme.com", now)).id;
    expect(await insertAccessRequest(env.DB, second.docId, bob, now, 100)).not.toBeNull();
    sent.length = 0;
    const put = (docId: string, email: string, body?: unknown) =>
      send("PUT", `${API}/api/v1/docs/${docId}/access/people/${email}`, KEY_PLUS, body, hosts);

    // The 100th new invite in the window is the last one.
    expect((await put(first.docId, "hundredth%40acme.com")).status).toBe(200);
    expect(sent.map((message) => message.to)).toEqual(["hundredth@acme.com"]);

    const refused = await put(second.docId, "late%40acme.com");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: { code: "quota_exceeded", message: expect.stringContaining("100") } });
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM doc_invites WHERE doc_id = ?").bind(second.docId).first<{ n: number }>())!.n,
    ).toBe(49);
    expect(sent).toHaveLength(1);
    expect((await readAccess(env.DB, second.docId))!.requests.map((request) => request.email)).toEqual(["late@acme.com"]);

    // A linked account draws on the same allowance.
    const mine = (await findOrCreateAccount(env.DB, newAccountId(), "me@acme.com", now)).id;
    expect(await linkExternalOwner(env.DB, owner, mine, 1000)).toBe("linked");
    const asAccount: Publisher = { owner: mine, plan: "pro", authKind: "account" };
    const viaAccount = await addPerson({ ...env, ...hosts } as Env, new URL(`${API}/api/v1/docs`), asAccount, second.docId, "zed@acme.com", undefined, NO_ANALYTICS);
    expect(viaAccount).toEqual({ ok: false, refusal: "invite_quota" });

    // Repeats, role changes and removals are not new invites.
    expect((await put(first.docId, "recent0%40acme.com")).status).toBe(200);
    expect((await put(first.docId, "recent0%40acme.com", { role: "view" })).status).toBe(200);
    const removed = await send("DELETE", `${API}/api/v1/docs/${first.docId}/access/people/recent0%40acme.com`, KEY_PLUS, undefined, hosts);
    expect(removed.status).toBe(200);
  });

  it("counts sends, not listed rows: removing an invite or unsharing a document frees nothing", async () => {
    const first = await privateDoc();
    const second = await privateDoc();
    const sends = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM invite_sends").first<{ n: number }>())!.n;
    // No Email binding: a hundred real adds must not spend the invite email limiter other tests share.
    const quiet = { ...hosts, EMAIL: undefined, OAUTH_GOOGLE_CLIENT_ID: "id", OAUTH_GOOGLE_CLIENT_SECRET: "secret" } as Partial<Env>;
    const put = (docId: string, email: string) => send("PUT", `${API}/api/v1/docs/${docId}/access/people/${email}`, KEY_PLUS, undefined, quiet);
    // 99 recent sends through the API, then the 100th: the cap is reached by real adds.
    for (let i = 0; i < 99; i += 1) {
      expect((await put(i % 2 === 0 ? first.docId : second.docId, `a${i}%40acme.com`)).status).toBe(200);
    }
    expect((await put(first.docId, "hundredth%40acme.com")).status).toBe(200);
    expect(await sends()).toBe(100);
    expect((await put(first.docId, "over%40acme.com")).status).toBe(429);
    // A refused add records nothing.
    expect(await sends()).toBe(100);

    // Removing an invite hands nothing back.
    expect((await send("DELETE", `${API}/api/v1/docs/${first.docId}/access/people/a0%40acme.com`, KEY_PLUS, undefined, quiet)).status).toBe(200);
    expect((await put(first.docId, "over%40acme.com")).status).toBe(429);
    // Re-adding the removed address is a new send, so it is refused too.
    expect((await put(first.docId, "a0%40acme.com")).status).toBe(429);

    // Neither does unsharing a document.
    expect((await send("DELETE", `${API}/api/v1/docs/${second.docId}`, KEY_PLUS, undefined, quiet)).status).toBe(204);
    expect((await put(first.docId, "again%40acme.com")).status).toBe(429);
    expect(await sends()).toBe(100);
  });

  it("records one send per new invite, none for repeats, and prunes the owner's expired rows on the next add", async () => {
    const doc = await privateDoc();
    const owner = (await env.DB.prepare("SELECT owner FROM docs WHERE id = ?").bind(doc.docId).first<{ owner: string }>())!.owner;
    const put = (email: string, body?: unknown) =>
      send("PUT", `${API}/api/v1/docs/${doc.docId}/access/people/${email}`, KEY_PLUS, body, hosts);
    const rows = async () =>
      (await env.DB.prepare("SELECT owner, created_at FROM invite_sends ORDER BY created_at").all<{ owner: string; created_at: number }>()).results;
    await env.DB.prepare("INSERT INTO invite_sends (owner, created_at) VALUES (?, ?), ('someone-else', ?)")
      .bind(owner, Date.now() - 86_400_001, Date.now() - 86_400_001)
      .run();

    expect((await put("a%40acme.com")).status).toBe(200);
    expect((await put("a%40acme.com")).status).toBe(200);
    expect((await put("a%40acme.com", { role: "view" })).status).toBe(200);

    const after = await rows();
    // The owner's expired row is gone, another owner's is untouched, and the owner has exactly one send.
    expect(after.filter((row) => row.owner === owner)).toHaveLength(1);
    expect(after.filter((row) => row.owner === "someone-else")).toHaveLength(1);
  });
});

describe("access requests", () => {
  const KEY_PLUS = "cplus_live_5544332211009988";
  const API = "https://api.openartifacts.ai";
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const hosts = {
    SERVING_HOST: "openartifacts.site",
    API_HOST: "api.openartifacts.ai",
    READER_SESSION_SECRET: "k".repeat(32),
    EMAIL: { send: async (message: { to: string; subject: string; text: string }) => void sent.push(message) },
    EMAIL_FROM: "share@mail.openartifacts.ai",
  } as Partial<Env>;
  let ownerPlus = "";

  /** A private page owned by the Plus key, and the id of its owner. */
  async function privateDoc(): Promise<string> {
    ownerPlus = await seedPublisher(KEY_PLUS, undefined, "plus");
    const created = await send("POST", `${API}/api/v1/docs`, KEY_PLUS, { title: "Q3 client report", html: page("<p>owner only</p>") }, hosts);
    expect(created.status).toBe(201);
    const { docId } = (await created.json()) as PushResponse;
    await env.DB.prepare("UPDATE docs SET link_access = 'invited' WHERE id = ?").bind(docId).run();
    return docId;
  }

  const account = async (email: string) => (await findOrCreateAccount(env.DB, newAccountId(), email, Date.now())).id;
  const count = async (table: string, docId: string) =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE doc_id = ?`).bind(docId).first<{ n: number }>())!.n;

  it("stores one request per account, only for a live invited-only document the account cannot already read", async () => {
    const docId = await privateDoc();
    const bob = await account("bob@other.com");

    const first = await insertAccessRequest(env.DB, docId, bob, 1000, 100);
    expect(first).toEqual({ email: "bob@other.com", title: "Q3 client report", owner: ownerPlus });
    // A repeat reports nothing and keeps the original time.
    expect(await insertAccessRequest(env.DB, docId, bob, 2000, 100)).toBeNull();
    expect(await env.DB.prepare("SELECT created_at FROM doc_access_requests WHERE doc_id = ?").bind(docId).first()).toEqual({ created_at: 1000 });
    expect((await readAccess(env.DB, docId))!.requests).toEqual([{ email: "bob@other.com", created_at: 1000 }]);

    // Already on the list, or the owner's own linked account: nothing to ask for.
    const alice = await account("alice@acme.com");
    await insertInvite(env.DB, docId, ownerPlus, "alice@acme.com", 1000, 100);
    const mine = await account("me@acme.com");
    expect(await linkExternalOwner(env.DB, ownerPlus, mine, 1000)).toBe("linked");
    expect(await insertAccessRequest(env.DB, docId, alice, 1000, 100)).toBeNull();
    expect(await insertAccessRequest(env.DB, docId, mine, 1000, 100)).toBeNull();

    // Unknown id, public page, withdrawn page: nothing stored, and no way to tell which.
    const carol = await account("carol@other.com");
    expect(await insertAccessRequest(env.DB, UNKNOWN_DOC_ID, carol, 1000, 100)).toBeNull();
    await env.DB.prepare("UPDATE docs SET link_access = 'anyone' WHERE id = ?").bind(docId).run();
    expect(await insertAccessRequest(env.DB, docId, carol, 1000, 100)).toBeNull();
    await env.DB.prepare("UPDATE docs SET link_access = 'invited', deleted_at = 1 WHERE id = ?").bind(docId).run();
    expect(await insertAccessRequest(env.DB, docId, carol, 1000, 100)).toBeNull();
    expect(await count("doc_access_requests", docId)).toBe(1);
  });

  it("stops at the cap without saying so", async () => {
    const docId = await privateDoc();
    expect(await insertAccessRequest(env.DB, docId, await account("a@other.com"), 1000, 2)).not.toBeNull();
    expect(await insertAccessRequest(env.DB, docId, await account("b@other.com"), 1000, 2)).not.toBeNull();
    expect(await insertAccessRequest(env.DB, docId, await account("c@other.com"), 1000, 2)).toBeNull();
    expect(await count("doc_access_requests", docId)).toBe(2);
  });

  it("clears a request when the address is added, and only the owner can decline one", async () => {
    const docId = await privateDoc();
    for (const email of ["bob@other.com", "carol@other.com"]) {
      expect(await insertAccessRequest(env.DB, docId, await account(email), 1000, 100)).not.toBeNull();
    }
    const before = sent.length;

    // Approving is adding: one call lists the person and clears the request.
    const added = await send("PUT", `${API}/api/v1/docs/${docId}/access/people/bob%40other.com`, KEY_PLUS, undefined, hosts);
    expect(added.status).toBe(200);
    expect(sent.slice(before).map((message) => message.to)).toEqual(["bob@other.com"]);
    const access = (await readAccess(env.DB, docId))!;
    expect(access.people.map((person) => [person.email, person.role])).toEqual([["bob@other.com", "comment"]]);
    expect(access.requests.map((request) => request.email)).toEqual(["carol@other.com"]);

    // A publisher who does not own the page declines nothing; the owner declines, and may repeat.
    await deleteAccessRequest(env.DB, docId, ownerB, "carol@other.com");
    expect(await count("doc_access_requests", docId)).toBe(1);
    await deleteAccessRequest(env.DB, docId, ownerPlus, "carol@other.com");
    await deleteAccessRequest(env.DB, docId, ownerPlus, "carol@other.com");
    expect(await count("doc_access_requests", docId)).toBe(0);
  });

  it("keeps a request on a full list rather than dropping it", async () => {
    const docId = await privateDoc();
    expect(await insertAccessRequest(env.DB, docId, await account("bob@other.com"), 1000, 100)).not.toBeNull();
    expect(await insertInvite(env.DB, docId, ownerPlus, "alice@acme.com", 1000, 1)).toBe(true);
    expect(await insertInvite(env.DB, docId, ownerPlus, "bob@other.com", 1000, 1)).toBe(false);
    expect((await readAccess(env.DB, docId))!.requests.map((request) => request.email)).toEqual(["bob@other.com"]);
  });

  it("deletes the invites and the pending requests with the bytes, and keeps the row for the 410", async () => {
    const docId = await privateDoc();
    await insertInvite(env.DB, docId, ownerPlus, "alice@acme.com", 1000, 100);
    expect(await insertAccessRequest(env.DB, docId, await account("bob@other.com"), 1000, 100)).not.toBeNull();

    const deleted = await send("DELETE", `${API}/api/v1/docs/${docId}`, KEY_PLUS, undefined, hosts);
    expect(deleted.status).toBe(204);

    expect(await count("doc_invites", docId)).toBe(0);
    expect(await count("doc_access_requests", docId)).toBe(0);
    expect(await env.DB.prepare("SELECT deleted_at FROM docs WHERE id = ?").bind(docId).first("deleted_at")).not.toBeNull();
  });

  it("switches the mode in both directions, keeps the list and the requests, and refuses a mode it does not know", async () => {
    await seedPublisher(KEY_PLUS, undefined, "plus");
    const created = await send("POST", `${API}/api/v1/docs`, KEY_PLUS, { html: page("<p>was public</p>") }, hosts);
    const { docId } = (await created.json()) as PushResponse;
    const access = `${API}/api/v1/docs/${docId}/access`;
    const mode = async (body: unknown) => send("PUT", access, KEY_PLUS, body, hosts);

    const invited = await mode({ linkAccess: "invited" });
    expect(invited.status).toBe(200);
    expect(await invited.json()).toMatchObject({ linkAccess: "invited", people: [], requests: [] });
    expect(await env.DB.prepare("SELECT link_access FROM docs WHERE id = ?").bind(docId).first()).toEqual({ link_access: "invited" });

    expect((await send("PUT", `${access}/people/alice%40acme.com`, KEY_PLUS, undefined, hosts)).status).toBe(200);
    expect(await insertAccessRequest(env.DB, docId, await account("bob@other.com"), 1000, 100)).not.toBeNull();

    // Back to public: the list and the request stay for the next time it goes private.
    const anyone = await mode({ linkAccess: "anyone" });
    expect(await anyone.json()).toMatchObject({
      linkAccess: "anyone",
      people: [{ email: "alice@acme.com" }],
      requests: [{ email: "bob@other.com" }],
    });
    expect(await mode({ linkAccess: "invited" })).toMatchObject({ status: 200 });
    expect((await readAccess(env.DB, docId))!.people).toHaveLength(1);

    for (const bad of [{ linkAccess: "everyone" }, { linkAccess: 1 }, {}, { linkAccess: "anyone", extra: 1 }]) {
      expect((await mode(bad)).status).toBe(400);
    }
    expect((await send("PUT", `${API}/api/v1/docs/${UNKNOWN_DOC_ID}/access`, KEY_PLUS, { linkAccess: "invited" }, hosts)).status).toBe(404);
    expect((await send("PUT", access, KEY_B, { linkAccess: "anyone" }, hosts)).status).toBe(404);
  });

  it("reports the whole Access: the canonical url, whether this server mails, the people with their roles and the pending requests", async () => {
    const docId = await privateDoc();
    const alice = await send("PUT", `${API}/api/v1/docs/${docId}/access/people/alice%40acme.com`, KEY_PLUS, undefined, hosts);
    expect(alice.status).toBe(200);
    expect(await insertAccessRequest(env.DB, docId, await account("bob@other.com"), 2000, 100)).not.toBeNull();

    const read = await send("GET", `${API}/api/v1/docs/${docId}/access`, KEY_PLUS, undefined, hosts);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    const people = (await env.DB.prepare("SELECT created_at FROM doc_invites WHERE doc_id = ?").bind(docId).first<{ created_at: number }>())!;
    expect(await read.json()).toEqual({
      docId,
      url: `https://openartifacts.site/d/${docId}`,
      linkAccess: "invited",
      email: true,
      people: [{ email: "alice@acme.com", role: "comment", addedAt: people.created_at }],
      requests: [{ email: "bob@other.com", requestedAt: 2000 }],
    });

    // A deployment with Google and no Email Service binding still does private sharing, and says it sends nothing.
    const google = { OAUTH_GOOGLE_CLIENT_ID: "id", OAUTH_GOOGLE_CLIENT_SECRET: "secret" };
    const quiet = await send("GET", `${API}/api/v1/docs/${docId}/access`, KEY_PLUS, undefined, { ...hosts, ...google, EMAIL: undefined });
    expect(((await quiet.json()) as { email: boolean }).email).toBe(false);
  });

  it("approves a request with the add: lists the person, clears the request and sends exactly one invite", async () => {
    const docId = await privateDoc();
    expect(await insertAccessRequest(env.DB, docId, await account("bob@other.com"), 2000, 100)).not.toBeNull();
    sent.length = 0;

    const approved = await send("PUT", `${API}/api/v1/docs/${docId}/access/people/bob%40other.com`, KEY_PLUS, undefined, hosts);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      people: [{ email: "bob@other.com", role: "comment" }],
      requests: [],
    });
    expect(sent.map((message) => message.to)).toEqual(["bob@other.com"]);

    // Approving again changes nothing and mails nobody.
    expect((await send("PUT", `${API}/api/v1/docs/${docId}/access/people/bob%40other.com`, KEY_PLUS, undefined, hosts)).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("declines a request silently: clears it, sends nothing, and may be repeated", async () => {
    const docId = await privateDoc();
    expect(await insertAccessRequest(env.DB, docId, await account("bob@other.com"), 2000, 100)).not.toBeNull();
    sent.length = 0;
    const path = `${API}/api/v1/docs/${docId}/access/requests/Bob%40Other.com`;

    // Not the owner: a 404, and the request is still there.
    expect((await send("DELETE", path, KEY_B, undefined, hosts)).status).toBe(404);
    expect(await count("doc_access_requests", docId)).toBe(1);

    const declined = await send("DELETE", path, KEY_PLUS, undefined, hosts);
    expect(declined.status).toBe(200);
    expect(await declined.json()).toMatchObject({ people: [], requests: [] });
    const repeated = await send("DELETE", path, KEY_PLUS, undefined, hosts);
    expect(repeated.status).toBe(200);
    expect(sent).toEqual([]);
    expect(await count("doc_invites", docId)).toBe(0);

    const malformed = await send("DELETE", `${API}/api/v1/docs/${docId}/access/requests/not-an-address`, KEY_PLUS, undefined, hosts);
    expect(malformed.status).toBe(400);
  });

  it("takes an optional role: comment by default, view or comment when named, and a repeat changes it without mailing again", async () => {
    const docId = await privateDoc();
    const put = (email: string, body?: unknown) =>
      send("PUT", `${API}/api/v1/docs/${docId}/access/people/${email}`, KEY_PLUS, body, hosts);
    const roles = async () =>
      Object.fromEntries((await readAccess(env.DB, docId))!.people.map((person) => [person.email, person.role]));
    sent.length = 0;

    expect((await put("a%40acme.com")).status).toBe(200);
    expect((await put("b%40acme.com", {})).status).toBe(200);
    expect((await put("c%40acme.com", { role: "view" })).status).toBe(200);
    expect((await put("d%40acme.com", { role: "comment" })).status).toBe(200);
    expect(await roles()).toEqual({ "a@acme.com": "comment", "b@acme.com": "comment", "c@acme.com": "view", "d@acme.com": "comment" });
    expect(sent).toHaveLength(4);

    // Naming no role leaves an existing person alone; naming one updates it. Neither mails.
    expect((await put("c%40acme.com")).status).toBe(200);
    expect((await roles())["c@acme.com"]).toBe("view");
    const updated = await put("c%40acme.com", { role: "comment" });
    expect(((await updated.json()) as { people: Array<{ email: string; role: string }> }).people.find((person) => person.email === "c@acme.com")?.role).toBe("comment");
    expect(sent).toHaveLength(4);

    for (const bad of [{ role: "edit" }, { role: 1 }, { role: "view", extra: true }, { other: "view" }, [], "view"]) {
      expect((await put("e%40acme.com", bad)).status).toBe(400);
    }
    // No body at all is fine: the role is optional.
    expect((await put("e%40acme.com")).status).toBe(200);
    expect(await count("doc_invites", docId)).toBe(5);
  });

  it("names the sharer only when the Worker knows them, and limits invites under one publisher whichever credential adds", async () => {
    const docId = await privateDoc();
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) };
    const withLimiter = { ...hosts, INVITE_EMAIL_LIMITER: limiter } as Partial<Env>;
    sent.length = 0;

    // A license key nobody has linked: the invite cannot name the sender, and does not pretend to.
    expect((await send("PUT", `${API}/api/v1/docs/${docId}/access/people/a%40acme.com`, KEY_PLUS, undefined, withLimiter)).status).toBe(200);
    expect(sent[0]!.text).not.toContain("Shared by");
    expect(sent[0]!.text).not.toContain("Someone");

    // Once linked, the same publisher adds from the account and the sender is named. Both draw on one allowance.
    const mine = await account("me@acme.com");
    expect(await linkExternalOwner(env.DB, ownerPlus, mine, 1000)).toBe("linked");
    const asAccount: Publisher = { owner: mine, plan: "pro", authKind: "account" };
    const result = await addPerson({ ...env, ...withLimiter } as Env, new URL(`${API}/api/v1/docs`), asAccount, docId, "b@acme.com", undefined, NO_ANALYTICS);
    expect(result.ok).toBe(true);
    expect(sent.map((message) => message.to)).toEqual(["a@acme.com", "b@acme.com"]);
    expect(sent[1]!.text).toContain("Shared by me@acme.com");
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("refuses an address that is not one, and the 101st person", async () => {
    const docId = await privateDoc();
    const put = (email: string) => send("PUT", `${API}/api/v1/docs/${docId}/access/people/${email}`, KEY_PLUS, undefined, hosts);

    for (const bad of ["no-at-sign", "a%40", "%40b.com", "a%01%40b.com", "a%7F%40b.com", "a%00%40b.com", `${"x".repeat(250)}%40b.com`, "%E0%A4%A"]) {
      const response = await put(bad);
      expect(response.status, bad).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
    }
    expect(await count("doc_invites", docId)).toBe(0);

    for (let i = 0; i < 100; i += 1) {
      await env.DB.prepare("INSERT INTO doc_invites (doc_id, email, created_at) VALUES (?, ?, ?)").bind(docId, `p${i}@acme.com`, i).run();
    }
    sent.length = 0;
    expect(await insertAccessRequest(env.DB, docId, await account("bob@other.com"), 1000, 100)).not.toBeNull();
    const full = await put("one-more%40acme.com");
    expect(full.status).toBe(400);
    expect(await full.json()).toMatchObject({ error: { code: "bad_request", message: expect.stringContaining("100") } });
    // Refused means nothing was added, nobody was mailed, and a pending request was not dropped.
    expect(await count("doc_invites", docId)).toBe(100);
    expect(sent).toEqual([]);
    expect(await put("p3%40acme.com")).toMatchObject({ status: 200 });
    expect((await readAccess(env.DB, docId))!.requests).toHaveLength(1);
  });

  it("answers 404 to the private family on a server with no reader sign-in, after authentication and before any plan check", async () => {
    const plusDoc = await privateDoc();
    const believerDoc = (await push(KEY_A, { title: "Mine", html: page("<p>mine</p>") })).docId;
    const off = { ...hosts, READER_SESSION_SECRET: undefined } as Partial<Env>;
    const routes = (docId: string): Array<[string, string, unknown?]> => [
      ["GET", `${API}/api/v1/docs/${docId}/access`],
      ["PUT", `${API}/api/v1/docs/${docId}/access`, { linkAccess: "invited" }],
      ["PUT", `${API}/api/v1/docs/${docId}/access/people/alice%40acme.com`],
      ["DELETE", `${API}/api/v1/docs/${docId}/access/people/alice%40acme.com`],
      ["DELETE", `${API}/api/v1/docs/${docId}/access/requests/alice%40acme.com`],
      ["POST", `${API}/api/v1/docs/${docId}/open`],
      ["POST", `${API}/api/v1/private-docs`, { html: page("<p>x</p>") }],
    ];

    for (const [key, docId] of [[KEY_PLUS, plusDoc], [KEY_A, believerDoc]] as const) {
      for (const [method, path, body] of routes(docId)) {
        // Authentication first: a caller with no credential is 401 as ever.
        expect((await send(method, path, null, body, off)).status).toBe(401);
        // The caller's own document, whatever their plan: an old Worker has no such route.
        const response = await send(method, path, key, body, off);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
      }
    }
    // A key whose plan may not publish at all is told the route does not exist, as an old Worker would: not that it may not publish.
    await seedPublisher(KEY_FREE, undefined, "free");
    const ineligible = await send("POST", `${API}/api/v1/private-docs`, KEY_FREE, { html: page("<p>x</p>") }, off);
    expect(ineligible.status).toBe(404);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE owner = ?").bind(`account-${(await sha256Hex(KEY_FREE)).slice(0, 8)}`).first()).toEqual({ n: 0 });
    // On a configured server the same write by the same Supporter key goes through, so the 404 above was the gate.
    expect((await send("PUT", `${API}/api/v1/docs/${believerDoc}/access`, KEY_A, { linkAccess: "invited" }, hosts)).status).toBe(200);
    // The owner's own bytes stay reachable: `get` depends on them, and they reveal nothing new.
    expect((await send("GET", `${API}/api/v1/docs/${plusDoc}/html`, KEY_PLUS, undefined, off)).status).toBe(200);
  });
});
