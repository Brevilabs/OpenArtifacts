import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import type { DocRow } from "../src/db.js";
import { docObjectPrefix, versionObjectKey } from "../src/storage.js";
import worker from "../src/index.js";

/** v0 runs both surfaces on one workers.dev subdomain. */
const API_ORIGIN = "https://updoc.workers.dev";

const KEY_A = "cplus_live_a1b2c3d4e5f60718";
const KEY_B = "cplus_live_9988776655443322";

/** A doc id of the right shape that no push ever minted. */
const UNKNOWN_DOC_ID = "0123456789abcdefghjkmnpqrs";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Give a key a publisher row validated just now — what a real request leaves
 * behind after auth, and what `docs.publisher` needs as a foreign key. These
 * tests are about managing docs, not about authenticating, so the license cache
 * is warm and no license server is ever reached.
 */
async function seedPublisher(key: string): Promise<string> {
  const id = await sha256Hex(key);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO publishers (key_hash, plan, validated_at) VALUES (?, 'plus', ?)",
  )
    .bind(id, Date.now())
    .run();
  return id;
}

let publisherA = "";
let publisherB = "";

beforeEach(async () => {
  publisherA = await seedPublisher(KEY_A);
  publisherB = await seedPublisher(KEY_B);
});

/** Statuses whose responses may not carry a body, per the Response constructor. */
const BODILESS = new Set([204, 205, 304]);

async function send(
  method: string,
  path: string,
  key: string | null,
  body?: unknown,
  overrides: Partial<Env> = {},
): Promise<Response> {
  const headers = new Headers();
  if (key !== null) headers.set("authorization", `Bearer ${key}`);

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }

  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${API_ORIGIN}${path}`, init),
    { ...env, ...overrides },
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
  publisher: string,
  id: string,
  createdAt: number,
  options: { versions?: number } = {},
): Promise<string> {
  const versions = options.versions ?? 1;
  await env.DB.prepare(
    `INSERT INTO docs (id, publisher, title, latest_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, publisher, `seeded ${id}`, versions, createdAt, createdAt)
    .run();

  for (let n = 1; n <= versions; n++) {
    await env.DB.prepare("INSERT INTO versions (doc_id, n, size, created_at) VALUES (?, ?, 1, ?)")
      .bind(id, n, createdAt)
      .run();
  }
  return id;
}

/** Valid doc ids that sort predictably, so a paging test can name what it expects. */
const seededId = (i: number) => String(i).padStart(26, "0");

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
    await expect(gone.json()).resolves.toEqual({
      error: { code: "gone", message: expect.any(String) },
    });
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
    const docId = await seedDoc(publisherA, seededId(1), Date.now());
    // 100 pushes a day compounds: a long-lived doc outgrows R2's 1000-key
    // listing page, and a delete that read only the first page would leave the
    // rest of the doc sitting in the bucket forever.
    await Promise.all(
      Array.from({ length: 1001 }, (_, i) => env.DOCS.put(versionObjectKey(docId, i + 1), "x")),
    );

    expect((await del(KEY_A, docId)).status).toBe(204);

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
      publisher: publisherA,
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
      },
    ]);
  });

  it("points list urls at the serving host once one is configured (D3)", async () => {
    const created = await publish(KEY_A, "A note");

    const response = await send("GET", "/api/v1/docs", KEY_A, undefined, {
      SERVING_HOST: "updoc.page",
    });

    expect((await listed(response)).docs[0]?.url).toBe(`https://updoc.page/d/${created.docId}`);
  });

  it("orders newest first", async () => {
    const ids = [3, 1, 2].map((i) => seededId(i));
    await seedDoc(publisherA, ids[0]!, 3_000);
    await seedDoc(publisherA, ids[1]!, 1_000);
    await seedDoc(publisherA, ids[2]!, 2_000);

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
    const stranded = await seedDoc(publisherA, seededId(1), Date.now(), { versions: 0 });

    const body = await listed(await list(KEY_A));

    expect(body.docs).toMatchObject([{ docId: stranded, version: null }]);
    expect((await del(KEY_A, stranded)).status).toBe(204);
  });

  it("defaults to 50 docs a page", async () => {
    for (let i = 1; i <= 51; i++) await seedDoc(publisherA, seededId(i), i);

    const body = await listed(await list(KEY_A));

    expect(body.docs).toHaveLength(50);
    expect(body.cursor).toEqual(expect.any(String));
  });

  it("honours a limit, and omits the cursor on the last page", async () => {
    for (let i = 1; i <= 3; i++) await seedDoc(publisherA, seededId(i), i);

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
      expected.push(await seedDoc(publisherA, seededId(i), 1_000 + i));
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
    for (let i = 1; i <= 5; i++) ids.push(await seedDoc(publisherA, seededId(i), 42));
    ids.reverse();

    expect(await walk(KEY_A, 2)).toEqual(ids);
  });

  it("never repeats a doc when a newer one is pushed mid-walk", async () => {
    for (let i = 1; i <= 4; i++) await seedDoc(publisherA, seededId(i), 1_000 + i);

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
    for (let i = 1; i <= 6; i++) await seedDoc(publisherA, seededId(i), 1_000 + i);

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
    for (let i = 1; i <= 4; i++) await seedDoc(publisherA, seededId(i), 1_000 + i);
    for (let i = 5; i <= 8; i++) await seedDoc(publisherB, seededId(i), 1_000 + i);

    // B's docs are newer, so a scan that ignored the publisher predicate on the
    // resume step would walk straight into them.
    expect(await walk(KEY_A, 2)).toEqual([4, 3, 2, 1].map((i) => seededId(i)));
    expect(await walk(KEY_B, 3)).toEqual([8, 7, 6, 5].map((i) => seededId(i)));
  });
});
