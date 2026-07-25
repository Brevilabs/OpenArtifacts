import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import { MAX_DOCS_PER_PUBLISHER, MAX_DOC_BYTES, MAX_PUSHES_PER_DAY } from "../src/config.js";
import type { DocRow, PushQuotaRow, VersionRow } from "../src/db.js";
import { isDocId } from "../src/ids.js";
import { MAX_REQUEST_BYTES, utcDay, utf8Length } from "../src/quota.js";
import { NOINDEX_META, UPDOC_FOOTER } from "../src/render.js";
import { versionObjectKey } from "../src/storage.js";
import worker from "../src/index.js";

/** v0 runs both surfaces on one workers.dev subdomain. */
const API_ORIGIN = "https://updoc.workers.dev";

const KEY_A = "cplus_live_a1b2c3d4e5f60718";
const KEY_B = "cplus_live_9988776655443322";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Give a key a publisher row validated just now.
 *
 * This is what a real request leaves behind after auth (phase 2), and it is
 * also what the `docs.publisher` foreign key needs. A fresh `validated_at`
 * means the license cache is warm, so no test here ever needs the license
 * server — these tests are about pushing, not about authenticating.
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

interface PushResponse {
  docId: string;
  url: string;
  version: number;
}

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
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${API_ORIGIN}${path}`, init),
    { ...env, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const post = (key: string | null, body?: unknown, overrides?: Partial<Env>) =>
  send("POST", "/api/v1/docs", key, body, overrides);

const put = (key: string | null, docId: string, body?: unknown, overrides?: Partial<Env>) =>
  send("PUT", `/api/v1/docs/${docId}`, key, body, overrides);

const page = (body: string) =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>A note</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

async function stored(docId: string, n: number): Promise<string | null> {
  const object = await env.DOCS.get(versionObjectKey(docId, n));
  return object === null ? null : object.text();
}

const docRow = (docId: string) =>
  env.DB.prepare("SELECT * FROM docs WHERE id = ?").bind(docId).first<DocRow>();

const versionRows = async (docId: string) =>
  (
    await env.DB.prepare("SELECT * FROM versions WHERE doc_id = ? ORDER BY n")
      .bind(docId)
      .all<VersionRow>()
  ).results;

const quotaRows = async () =>
  (await env.DB.prepare("SELECT * FROM push_quota").all<PushQuotaRow>()).results;

const allObjects = async () => (await env.DOCS.list()).objects;

async function pushedOk(response: Response, status: number): Promise<PushResponse> {
  expect(response.status).toBe(status);
  return (await response.json()) as PushResponse;
}

/** Fill a publisher's shelf without pushing 500 times through the handler. */
async function seedDocs(publisher: string, live: number, deleted = 0): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
     INSERT INTO docs (id, publisher, title, latest_version, created_at, updated_at, deleted_at)
     SELECT printf('%026d', i), ?, 'seeded', 1, ?, ?, CASE WHEN i > ? THEN ? END
       FROM seq`,
  )
    .bind(live + deleted, publisher, now, now, live, now)
    .run();
}

describe("POST /api/v1/docs", () => {
  it("publishes a 200KB doc and stores the bytes readers will get", async () => {
    const article = `<p>${"content ".repeat(26_000)}</p>`;
    expect(article.length).toBeGreaterThan(200 * 1024);

    const body = await pushedOk(await post(KEY_A, { title: "A note", html: page(article) }), 201);

    expect(isDocId(body.docId)).toBe(true);
    expect(body).toEqual({
      docId: body.docId,
      url: `${API_ORIGIN}/d/${body.docId}`,
      version: 1,
    });

    // The stored object is the served object (D11), so every claim about what a
    // reader sees is a claim about these bytes.
    const object = await env.DOCS.get(versionObjectKey(body.docId, 1));
    expect(object).not.toBeNull();
    const html = await object!.text();

    expect(html.slice(0, html.indexOf("</head>"))).toContain(NOINDEX_META);
    expect(html).toContain(`${UPDOC_FOOTER}</body>`);
    expect(html).toContain(article);
    expect(object!.httpMetadata?.contentType).toBe("text/html; charset=utf-8");

    // D1 is a pointer index: it has to agree with what R2 actually holds.
    expect(await docRow(body.docId)).toMatchObject({
      publisher: publisherA,
      title: "A note",
      latest_version: 1,
      deleted_at: null,
    });
    expect(await versionRows(body.docId)).toMatchObject([{ n: 1, size: object!.size }]);
  });

  it("keeps uploaded scripts intact (D6)", async () => {
    const interactive = '<script>window.__updoc = "runs";</script><canvas id="figure"></canvas>';

    const body = await pushedOk(
      await post(KEY_A, { title: "Figure", html: page(interactive) }),
      201,
    );

    expect(await stored(body.docId, 1)).toContain(interactive);
  });

  it("writes one object at the documented key and nothing else", async () => {
    const body = await pushedOk(await post(KEY_A, { title: "t", html: page("<p>x</p>") }), 201);

    // Spelled out rather than built with `versionObjectKey`, which is what every
    // other test here reads through: the key layout is a contract phase 4 and
    // the delete path both depend on, and a helper compared against itself
    // would agree with any change to it.
    expect((await allObjects()).map((o) => o.key)).toEqual([`docs/${body.docId}/v1.html`]);
  });

  it("gives every doc its own id", async () => {
    const first = await pushedOk(await post(KEY_A, { title: "t", html: page("<p>1</p>") }), 201);
    const second = await pushedOk(await post(KEY_A, { title: "t", html: page("<p>2</p>") }), 201);

    expect(second.docId).not.toBe(first.docId);
    expect(second.version).toBe(1);
  });

  it("publishes without a title rather than refusing the share", async () => {
    const body = await pushedOk(await post(KEY_A, { html: page("<p>x</p>") }), 201);

    expect((await docRow(body.docId))?.title).toBe("Untitled");
  });

  it("points the url at the serving host once one is configured (D3)", async () => {
    const body = await pushedOk(
      await post(KEY_A, { title: "t", html: page("<p>x</p>") }, { SERVING_HOST: "updoc.page" }),
      201,
    );

    expect(body.url).toBe(`https://updoc.page/d/${body.docId}`);
  });
});

describe("PUT /api/v1/docs/{docId}", () => {
  it("mints version 2 at the same url and leaves version 1 untouched", async () => {
    const created = await pushedOk(
      await post(KEY_A, { title: "A note", html: page("<p>first draft</p>") }),
      201,
    );
    const v1 = await stored(created.docId, 1);

    const updated = await pushedOk(
      await put(KEY_A, created.docId, { html: page("<p>second draft</p>") }),
      200,
    );

    expect(updated).toEqual({ docId: created.docId, url: created.url, version: 2 });

    // Immutability is the point of the version: v1 must still be byte-identical.
    expect(await stored(created.docId, 1)).toBe(v1);
    expect(await stored(created.docId, 2)).toContain("<p>second draft</p>");
    expect(await stored(created.docId, 2)).toContain(NOINDEX_META);

    expect(await docRow(created.docId)).toMatchObject({ latest_version: 2, title: "A note" });
    expect(await versionRows(created.docId)).toMatchObject([{ n: 1 }, { n: 2 }]);
  });

  it("renames the doc when the push carries a title", async () => {
    const created = await pushedOk(
      await post(KEY_A, { title: "Draft", html: page("<p>x</p>") }),
      201,
    );

    await pushedOk(
      await put(KEY_A, created.docId, { title: "Final", html: page("<p>y</p>") }),
      200,
    );

    expect((await docRow(created.docId))?.title).toBe("Final");
  });

  it("404s another publisher's doc rather than admitting it exists", async () => {
    const created = await pushedOk(
      await post(KEY_A, { title: "Private", html: page("<p>x</p>") }),
      201,
    );

    const response = await put(KEY_B, created.docId, { html: page("<p>hijacked</p>") });

    // 404, never 403: a 403 would confirm the id is real.
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });

    expect(await env.DOCS.head(versionObjectKey(created.docId, 2))).toBeNull();
    expect(await stored(created.docId, 1)).toContain("<p>x</p>");
    expect(await docRow(created.docId)).toMatchObject({ latest_version: 1, publisher: publisherA });
    // And it cost the caller nothing: a push that never happened is not a push.
    expect(await quotaRows()).toMatchObject([{ publisher: publisherA, pushes: 1 }]);
  });

  it("404s a doc that does not exist", async () => {
    const response = await put(KEY_A, "0123456789abcdefghjkmnpqrs", { html: page("<p>x</p>") });

    expect(response.status).toBe(404);
    expect(await allObjects()).toHaveLength(0);
  });

  it("404s an id that could never be a doc id, without touching D1", async () => {
    const impossible = [
      "not-a-doc-id",
      "0123456789abcdefghjkmnpqrsTOOLONG",
      "ilou00000000000000000000000",
    ];

    for (const id of impossible) {
      const response = await put(KEY_A, id, { html: page("<p>x</p>") });
      expect(response.status).toBe(404);
    }
    expect(await quotaRows()).toHaveLength(0);
  });

  it("gives concurrent pushes different version numbers (D7)", async () => {
    const created = await pushedOk(await post(KEY_A, { title: "t", html: page("<p>x</p>") }), 201);

    const [first, second] = await Promise.all([
      put(KEY_A, created.docId, { html: page("<p>racer one</p>") }),
      put(KEY_A, created.docId, { html: page("<p>racer two</p>") }),
    ]);

    const versions = [
      (await pushedOk(first, 200)).version,
      (await pushedOk(second, 200)).version,
    ].sort();

    // Sharing a number would mean sharing an R2 key, and one racer silently
    // overwriting the other's immutable bytes.
    expect(versions).toEqual([2, 3]);
    expect(await docRow(created.docId)).toMatchObject({ latest_version: 3 });
    expect(await versionRows(created.docId)).toMatchObject([{ n: 1 }, { n: 2 }, { n: 3 }]);

    const bodies = [await stored(created.docId, 2), await stored(created.docId, 3)];
    expect(bodies.filter((html) => html?.includes("racer one"))).toHaveLength(1);
    expect(bodies.filter((html) => html?.includes("racer two"))).toHaveLength(1);
  });

  it("404s a deleted doc", async () => {
    const created = await pushedOk(await post(KEY_A, { title: "t", html: page("<p>x</p>") }), 201);
    await env.DB.prepare("UPDATE docs SET deleted_at = ? WHERE id = ?")
      .bind(Date.now(), created.docId)
      .run();

    const response = await put(KEY_A, created.docId, { html: page("<p>y</p>") });

    expect(response.status).toBe(404);
    expect(await env.DOCS.head(versionObjectKey(created.docId, 2))).toBeNull();
  });
});

describe("the 10MB body ceiling", () => {
  it("413s an html field over the ceiling and writes nothing", async () => {
    const oversized = "a".repeat(MAX_DOC_BYTES + 1);

    const response = await post(KEY_A, { title: "big", html: oversized });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "too_large", message: expect.any(String) },
    });

    expect(await allObjects()).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM docs").first<{ n: number }>(),
    ).toMatchObject({ n: 0 });
    // Rejected before it could cost a push, so a retry with a smaller doc works.
    expect(await quotaRows()).toHaveLength(0);
  });

  it("413s a request too large to be a legal doc at all, without buffering it", async () => {
    const response = await post(KEY_A, { title: "huge", html: "a".repeat(MAX_DOC_BYTES * 2) });

    expect(response.status).toBe(413);
    expect(await allObjects()).toHaveLength(0);
  });

  it("413s an oversized update without minting a version", async () => {
    const created = await pushedOk(await post(KEY_A, { title: "t", html: page("<p>x</p>") }), 201);

    const response = await put(KEY_A, created.docId, { html: "a".repeat(MAX_DOC_BYTES + 1) });

    expect(response.status).toBe(413);
    expect(await docRow(created.docId)).toMatchObject({ latest_version: 1 });
    expect(await env.DOCS.head(versionObjectKey(created.docId, 2))).toBeNull();
  });
});

describe("the daily push quota", () => {
  const spend = (publisher: string, pushes: number, day = utcDay(Date.now())) =>
    env.DB.prepare("INSERT INTO push_quota (publisher, day, pushes) VALUES (?, ?, ?)")
      .bind(publisher, day, pushes)
      .run();

  it("429s a publisher who has used today's pushes", async () => {
    await spend(publisherA, MAX_PUSHES_PER_DAY);

    const response = await post(KEY_A, { title: "t", html: page("<p>x</p>") });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: { code: "quota_exceeded", message: expect.any(String) },
    });
    expect(await allObjects()).toHaveLength(0);
  });

  it("429s the update path too, and only after the last push is spent", async () => {
    await spend(publisherA, MAX_PUSHES_PER_DAY - 1);

    // The last push of the day: creating the doc.
    const created = await pushedOk(await post(KEY_A, { title: "t", html: page("<p>x</p>") }), 201);

    const response = await put(KEY_A, created.docId, { html: page("<p>y</p>") });

    expect(response.status).toBe(429);
    expect(await docRow(created.docId)).toMatchObject({ latest_version: 1 });
    expect(await env.DOCS.head(versionObjectKey(created.docId, 2))).toBeNull();
  });

  it("counts each publisher separately", async () => {
    await spend(publisherA, MAX_PUSHES_PER_DAY);

    expect((await post(KEY_A, { title: "t", html: page("<p>x</p>") })).status).toBe(429);
    expect((await post(KEY_B, { title: "t", html: page("<p>x</p>") })).status).toBe(201);
  });

  it("rolls over at the UTC day boundary", async () => {
    await spend(publisherA, MAX_PUSHES_PER_DAY, utcDay(Date.now() - 24 * 60 * 60 * 1000));

    expect((await post(KEY_A, { title: "t", html: page("<p>x</p>") })).status).toBe(201);
  });

  it("counts one push per request", async () => {
    await post(KEY_A, { title: "t", html: page("<p>x</p>") });
    await post(KEY_A, { title: "t", html: page("<p>y</p>") });

    expect(await quotaRows()).toMatchObject([
      { publisher: publisherA, day: utcDay(Date.now()), pushes: 2 },
    ]);
  });

  it("loses no increments when pushes land at once", async () => {
    const concurrent = 5;

    const responses = await Promise.all(
      Array.from({ length: concurrent }, (_, i) =>
        post(KEY_A, { title: "t", html: page(`<p>${i}</p>`) }),
      ),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(concurrent).fill(201));
    // Read-then-increment would let two pushes see the same count and one
    // increment vanish, which is the hole a claim-in-one-statement upsert closes.
    expect(await quotaRows()).toMatchObject([{ publisher: publisherA, pushes: concurrent }]);
  });

  it("gives the last push of the day to exactly one of two racing pushes", async () => {
    await spend(publisherA, MAX_PUSHES_PER_DAY - 1);

    const statuses = (
      await Promise.all([
        post(KEY_A, { title: "t", html: page("<p>a</p>") }),
        post(KEY_A, { title: "t", html: page("<p>b</p>") }),
      ])
    )
      .map((response) => response.status)
      .sort();

    expect(statuses).toEqual([201, 429]);
    expect(await quotaRows()).toMatchObject([{ pushes: MAX_PUSHES_PER_DAY }]);
  });
});

describe("a push whose write fails partway", () => {
  /** An R2 binding that refuses to store anything. */
  const brokenR2 = {
    put: () => Promise.reject(new Error("R2 unavailable")),
  } as unknown as R2Bucket;

  it("answers in the error contract rather than escaping the worker", async () => {
    const response = await post(KEY_A, { title: "t", html: page("<p>x</p>") }, { DOCS: brokenR2 });

    // An uncaught throw would be workerd's plain-text 500 — the one reply
    // Copilot cannot parse, since it reads `error.code` on every failure.
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal", message: expect.any(String) },
    });
  });

  it("never records a version whose bytes were not stored", async () => {
    const created = await pushedOk(await post(KEY_A, { title: "t", html: page("<p>x</p>") }), 201);

    const response = await put(KEY_A, created.docId, { html: page("<p>y</p>") }, { DOCS: brokenR2 });

    expect(response.status).toBe(500);
    // The reservation stands and version 2 is burned — the accepted trade. What
    // must not happen is a `versions` row for it: that row is what the serving
    // path follows to an object, and here there is no object to follow to.
    expect(await docRow(created.docId)).toMatchObject({ latest_version: 2 });
    expect(await versionRows(created.docId)).toMatchObject([{ n: 1 }]);
    expect(await env.DOCS.head(versionObjectKey(created.docId, 2))).toBeNull();
    expect(await stored(created.docId, 1)).toContain("<p>x</p>");
  });
});

describe("the live-doc quota", () => {
  it("429s a publisher already holding the maximum", async () => {
    await seedDocs(publisherA, MAX_DOCS_PER_PUBLISHER);

    const response = await post(KEY_A, { title: "one more", html: page("<p>x</p>") });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: { code: "quota_exceeded", message: expect.any(String) },
    });
    expect(await allObjects()).toHaveLength(0);
    // Refused before the daily counter, so being full does not also burn a push.
    expect(await quotaRows()).toHaveLength(0);
  });

  it("does not count deleted docs, so deleting one makes room", async () => {
    await seedDocs(publisherA, MAX_DOCS_PER_PUBLISHER - 1, 5);

    expect((await post(KEY_A, { title: "one more", html: page("<p>x</p>") })).status).toBe(201);
  });

  it("does not limit updates to docs the publisher already holds", async () => {
    const created = await pushedOk(await post(KEY_A, { title: "t", html: page("<p>x</p>") }), 201);
    await seedDocs(publisherA, MAX_DOCS_PER_PUBLISHER);

    expect((await put(KEY_A, created.docId, { html: page("<p>y</p>") })).status).toBe(200);
  });

  it("counts each publisher's docs separately", async () => {
    await seedDocs(publisherB, MAX_DOCS_PER_PUBLISHER);

    expect((await post(KEY_A, { title: "t", html: page("<p>x</p>") })).status).toBe(201);
  });
});

describe("malformed pushes", () => {
  const cases: [string, unknown][] = [
    ["a body that is not JSON", "<html>not json</html>"],
    ["a JSON array", ["html"]],
    ["a JSON string", '"just a string"'],
    ["no html field", { title: "t" }],
    ["an empty html field", { title: "t", html: "" }],
    ["a non-string html field", { title: "t", html: 42 }],
    ["a non-string title", { title: 42, html: "<p>x</p>" }],
  ];

  for (const [label, body] of cases) {
    it(`400s ${label}`, async () => {
      const response = await post(KEY_A, body);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "bad_request", message: expect.any(String) },
      });
      expect(await allObjects()).toHaveLength(0);
      expect(await quotaRows()).toHaveLength(0);
    });
  }

  it("400s a push with no body at all", async () => {
    expect((await post(KEY_A)).status).toBe(400);
  });
});

describe("the push routes themselves", () => {
  it("401s an unauthenticated push before it reaches a handler", async () => {
    const response = await post(null, { title: "t", html: page("<p>x</p>") });

    expect(response.status).toBe(401);
    expect(await allObjects()).toHaveLength(0);
  });

  it("404s methods and shapes no route claims", async () => {
    const created = await pushedOk(await post(KEY_A, { title: "t", html: page("<p>x</p>") }), 201);

    for (const [method, path] of [
      ["POST", `/api/v1/docs/${created.docId}`],
      ["PUT", "/api/v1/docs"],
      ["PATCH", `/api/v1/docs/${created.docId}`],
      ["PUT", `/api/v1/docs/${created.docId}/v2`],
    ] as const) {
      const response = await send(method, path, KEY_A, { html: page("<p>x</p>") });
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 });
    }

    expect(await docRow(created.docId)).toMatchObject({ latest_version: 1 });
  });
});

describe("races the review found", () => {
  /**
   * A delete that lands between the version reservation and the R2 write has
   * already scanned the prefix, so it cannot see the object the push is about
   * to add. Unshare has to mean the bytes are gone, so the push cleans up after
   * itself rather than leaving content behind a doc that reports 410.
   */
  it("removes the version it just wrote when a delete beat it to the doc", async () => {
    const created = await pushedOk(await post(KEY_A, { title: "t", html: page("<p>v1</p>") }), 201);

    // The race needs the delete to land *between* the version reservation and
    // the R2 write, which is the one ordering the handler cannot see coming. A
    // DB that soft-deletes the doc at the moment the version row is inserted
    // puts it exactly there, deterministically.
    let raced = false;
    const racingDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("INSERT INTO versions")) return statement;
          return new Proxy(statement, {
            get(stmtTarget, stmtProp, stmtReceiver) {
              if (stmtProp !== "bind") return Reflect.get(stmtTarget, stmtProp, stmtReceiver);
              return (...args: unknown[]) => {
                const bound = stmtTarget.bind(...args);
                return new Proxy(bound, {
                  get(boundTarget, boundProp, boundReceiver) {
                    if (boundProp !== "run") {
                      return Reflect.get(boundTarget, boundProp, boundReceiver);
                    }
                    return async () => {
                      const result = await boundTarget.run();
                      if (!raced) {
                        raced = true;
                        // The concurrent DELETE: mark it gone, then scan the
                        // prefix — which cannot yet see the object just written.
                        await env.DB.prepare("UPDATE docs SET deleted_at = ? WHERE id = ?")
                          .bind(Date.now(), created.docId)
                          .run();
                        for (const object of (await env.DOCS.list()).objects) {
                          await env.DOCS.delete(object.key);
                        }
                      }
                      return result;
                    };
                  },
                });
              };
            },
          });
        };
      },
    }) as D1Database;

    const racing = await put(KEY_A, created.docId, { html: page("<p>v2</p>") }, { DB: racingDb });

    expect(raced).toBe(true);
    // The push loses: it reports the doc gone rather than handing back a url
    // that serves 410, and the bucket is empty because it undid its own write.
    // Version 1 keeps its row — the stand-in delete above only soft-deleted the
    // doc and cleared the bucket, so a row for 2 could only come from the push.
    expect(racing.status).toBe(404);
    expect(await allObjects()).toHaveLength(0);
    expect((await versionRows(created.docId)).map((row) => row.n)).toEqual([1]);
  });

  it("leaves listing metadata on the last version that actually landed", async () => {
    const created = await pushedOk(
      await post(KEY_A, { title: "first", html: page("<p>v1</p>") }),
      201,
    );
    const before = await docRow(created.docId);

    // An R2 that refuses the write: the version is already reserved, so this is
    // the window where title and updated_at must not have moved yet.
    const failingDocs = new Proxy(env.DOCS, {
      get(target, prop, receiver) {
        if (prop !== "put") return Reflect.get(target, prop, receiver);
        return () => Promise.reject(new Error("R2 is down"));
      },
    }) as R2Bucket;

    const response = await put(
      KEY_A,
      created.docId,
      { title: "second", html: page("<p>v2</p>") },
      { DOCS: failingDocs },
    );
    expect(response.status).toBe(500);

    const after = await docRow(created.docId);
    // The version number is burned — that trade is deliberate. The metadata is
    // not: it still describes v1, which is what the public url is still serving.
    expect(after).toMatchObject({ title: "first", updated_at: before!.updated_at });
    expect(after!.latest_version).toBe(2);
    expect(await stored(created.docId, 2)).toBeNull();
  });

  it("gives back the push when the version reservation loses to a delete", async () => {
    const created = await pushedOk(await post(KEY_A, { title: "t", html: page("<p>v1</p>") }), 201);
    const spentAfterCreate = (await quotaRows())[0]?.pushes;

    // The delete lands after ownsLiveDoc has already passed, so the push is paid
    // for by the time reserveNextVersion refuses it.
    await env.DB.prepare("UPDATE docs SET deleted_at = ? WHERE id = ?")
      .bind(Date.now(), created.docId)
      .run();

    const response = await put(KEY_A, created.docId, { html: page("<p>v2</p>") });

    expect(response.status).toBe(404);
    // A rejected push costs nothing — the same promise the ownership check makes.
    expect((await quotaRows())[0]?.pushes).toBe(spentAfterCreate);
  });

  it("budgets the request cap for worst-case JSON escaping, not typical", async () => {
    // The bug this pins: a cap of doc-ceiling + 1MiB is a second, stricter and
    // undocumented limit, because every `"` and `\\` doubles inside a JSON
    // string. A document at the published ceiling made entirely of quotes
    // serializes to twice its size, and must still be accepted.
    expect(MAX_REQUEST_BYTES).toBeGreaterThanOrEqual(2 * MAX_DOC_BYTES);
    // Deliberately not 6x for `\uXXXX` control-character escapes: those are not
    // valid in HTML text, and budgeting for them would hold ~60MB against a
    // 128MB isolate to accept a document nobody writes.

    // Asserted on the constants rather than by pushing a 10MB body: the failure
    // is a threshold relationship, and allocating tens of megabytes per run to
    // rediscover it would buy nothing.
  });

  it("stores quote-dense HTML unaltered", async () => {
    const attributes = Array.from(
      { length: 20_000 },
      (_, i) => `<span class="a${i}" data-k="v" title="q">x</span>`,
    ).join("");
    const html = page(attributes);

    // Escaping inflates the envelope well past the document's own size.
    expect(utf8Length(JSON.stringify({ html }))).toBeGreaterThan(utf8Length(html) * 1.1);

    const created = await pushedOk(await post(KEY_A, { title: "quoted", html }), 201);
    expect(await stored(created.docId, 1)).toContain('data-k="v"');
  });

  /**
   * The ceiling is documented as a hard number, so it has to hold when a
   * publisher at the edge pushes concurrently rather than one at a time.
   */
  it("holds the doc ceiling when creates arrive together", async () => {
    await seedDocs(publisherA, MAX_DOCS_PER_PUBLISHER - 1);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => post(KEY_A, { title: "t", html: page("<p>x</p>") })),
    );

    const created = responses.filter((r) => r.status === 201);
    const refused = responses.filter((r) => r.status === 429);

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(7);

    const { n } = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM docs WHERE publisher = ? AND deleted_at IS NULL",
    )
      .bind(publisherA)
      .first<{ n: number }>()) ?? { n: -1 };
    expect(n).toBe(MAX_DOCS_PER_PUBLISHER);
  });

  it("does not spend a doc slot on a push refused by the daily quota", async () => {
    await env.DB.prepare(
      "INSERT INTO push_quota (publisher, day, pushes) VALUES (?, ?, ?)",
    )
      .bind(publisherA, utcDay(Date.now()), MAX_PUSHES_PER_DAY)
      .run();

    const response = await post(KEY_A, { title: "t", html: page("<p>x</p>") });

    expect(response.status).toBe(429);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE publisher = ?")
      .bind(publisherA)
      .first<{ n: number }>()) ?? { n: -1 };
    expect(n).toBe(0);
    expect(await allObjects()).toHaveLength(0);
  });
});
