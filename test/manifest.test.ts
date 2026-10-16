import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config.js";
import { sha256Hex } from "../src/hash.js";
import { writeManifest } from "../src/manifest.js";
import { newAccountId, newApiToken, newTokenId } from "../src/ids.js";
import worker from "../src/index.js";
import { rebuildSql, rowsFromManifest, type ListedObject } from "../src/rebuild.js";
import { docObjectPrefix, manifestObjectKey, versionObjectKey } from "../src/storage.js";

/**
 * The per-document manifest in R2, through the real Worker, real D1 and real R2.
 * The point of the file is the last describe: a doc set truncated out of D1 and
 * rebuilt from the bucket alone still keeps its privacy, its people and its 410.
 */
const API = "https://api.openartifacts.ai";
const ADMIN = "manifest-admin-secret";

const HOSTS = {
  SERVING_HOST: "openartifacts.site",
  API_HOST: "api.openartifacts.ai",
  READER_SESSION_SECRET: "k".repeat(32),
  OAUTH_GITHUB_CLIENT_ID: "github-client",
  OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
  EMAIL: { send: async () => undefined },
  EMAIL_FROM: "share@mail.openartifacts.ai",
  ADMIN_API_KEY: ADMIN,
} as Partial<Env>;

const BODILESS = new Set([204, 205, 304]);

async function send(method: string, path: string, credential: string | null, body?: unknown): Promise<Response> {
  const headers = new Headers();
  if (credential !== null) headers.set("authorization", `Bearer ${credential}`);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(path.startsWith("https://") ? path : `${API}${path}`, init),
    { ...env, ...HOSTS } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const buffered = await response.arrayBuffer();
  return new Response(BODILESS.has(response.status) ? null : buffered, {
    status: response.status,
    headers: response.headers,
  });
}

let counter = 0;
async function owner(): Promise<{ id: string; token: string }> {
  const id = newAccountId();
  await env.DB.prepare(
    "INSERT INTO accounts (id, email, created_at, plan, plan_checked_at, display_name) VALUES (?, ?, ?, 'pro', ?, 'Owner')",
  )
    .bind(id, `owner${counter++}@acme.com`, Date.now(), Date.now())
    .run();
  const token = newApiToken();
  await env.DB.prepare("INSERT INTO tokens (id, token_hash, account_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(newTokenId(), await sha256Hex(token), id, Date.now())
    .run();
  return { id, token };
}

const page = (body: string) => `<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`;

async function publish(token: string, route: "docs" | "private-docs", title = "Report"): Promise<string> {
  const response = await send("POST", `/api/v1/${route}`, token, { title, html: page("<p>hello</p>") });
  expect(response.status).toBe(201);
  return ((await response.json()) as { docId: string }).docId;
}

async function manifestOf(docId: string): Promise<Record<string, unknown>> {
  const object = await env.DOCS.get(manifestObjectKey(docId));
  expect(object, "no manifest.json").not.toBeNull();
  expect(object!.httpMetadata?.contentType).toBe("application/json");
  return JSON.parse(await object!.text());
}

/** The manifest D1 implies, written out here rather than reusing the implementation. */
async function expectedFromD1(docId: string) {
  const d = (await env.DB.prepare("SELECT * FROM docs WHERE id = ?").bind(docId).first<Record<string, any>>())!;
  const people = await env.DB.prepare(
    "SELECT email, role, created_at FROM doc_invites WHERE doc_id = ? ORDER BY created_at, email",
  )
    .bind(docId)
    .all<{ email: string; role: string; created_at: number }>();
  return {
    schema: 1,
    docId,
    owner: d.owner,
    title: d.title,
    linkAccess: d.link_access,
    commentsEnabled: d.comments_enabled === 1,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    deletedAt: d.deleted_at,
    latestVersion: d.latest_version,
    people: people.results.map((p) => ({ email: p.email, role: p.role, createdAt: p.created_at })),
  };
}

async function expectInSync(docId: string) {
  const manifest = await manifestOf(docId);
  expect(manifest).toEqual(await expectedFromD1(docId));
  return manifest;
}

/** The real bucket, except that `put` runs `before` first, and may fail. */
function bucketWith(before: (key: string) => Promise<void>): R2Bucket {
  return {
    put: async (key: string, value: unknown, options?: R2PutOptions) => {
      await before(key);
      return env.DOCS.put(key, value as string, options);
    },
    get: (key: string) => env.DOCS.get(key),
    list: (options?: R2ListOptions) => env.DOCS.list(options),
    delete: (keys: string | string[]) => env.DOCS.delete(keys),
  } as unknown as R2Bucket;
}

const person = (docId: string, email: string) => `/api/v1/docs/${docId}/access/people/${encodeURIComponent(email)}`;

describe("a manifest follows every change to a document's state", () => {
  it("is written on a public create and on a private create", async () => {
    const o = await owner();
    const pub = await publish(o.token, "docs", "Public one");
    expect(await expectInSync(pub)).toMatchObject({
      owner: o.id, title: "Public one", linkAccess: "anyone", commentsEnabled: false,
      deletedAt: null, latestVersion: 1, people: [],
    });

    const priv = await publish(o.token, "private-docs", "Private one");
    expect(await expectInSync(priv)).toMatchObject({ owner: o.id, title: "Private one", linkAccess: "invited", latestVersion: 1 });
  });

  it("is rewritten on an update, including a retitle", async () => {
    const o = await owner();
    const docId = await publish(o.token, "docs", "First");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await send("PUT", `/api/v1/docs/${docId}`, o.token, { title: "Second", html: page("<p>v2</p>") });
    expect(updated.status).toBe(200);
    const manifest = await expectInSync(docId);
    expect(manifest).toMatchObject({ title: "Second", latestVersion: 2 });
    expect(manifest.updatedAt).toBeGreaterThan(manifest.createdAt as number);

    // A push that names no title leaves it alone, and the manifest says so.
    await send("PUT", `/api/v1/docs/${docId}`, o.token, { html: page("<p>v3</p>") });
    expect(await expectInSync(docId)).toMatchObject({ title: "Second", latestVersion: 3 });
  });

  it("follows the access mode both ways", async () => {
    const o = await owner();
    const docId = await publish(o.token, "docs");
    const flip = (linkAccess: string) => send("PUT", `/api/v1/docs/${docId}/access`, o.token, { linkAccess });

    expect((await flip("invited")).status).toBe(200);
    expect(await expectInSync(docId)).toMatchObject({ linkAccess: "invited" });
    expect((await flip("anyone")).status).toBe(200);
    expect(await expectInSync(docId)).toMatchObject({ linkAccess: "anyone" });
  });

  it("follows the invite list: add, role change, remove", async () => {
    const o = await owner();
    const docId = await publish(o.token, "private-docs");

    expect((await send("PUT", person(docId, "Alice@Acme.com"), o.token, { role: "view" })).status).toBe(200);
    expect(await expectInSync(docId)).toMatchObject({ people: [{ email: "alice@acme.com", role: "view" }] });

    expect((await send("PUT", person(docId, "alice@acme.com"), o.token, { role: "comment" })).status).toBe(200);
    expect(await expectInSync(docId)).toMatchObject({ people: [{ email: "alice@acme.com", role: "comment" }] });

    expect((await send("PUT", person(docId, "bob@acme.com"), o.token)).status).toBe(200);
    expect((await expectInSync(docId)).people).toHaveLength(2);

    expect((await send("DELETE", person(docId, "alice@acme.com"), o.token)).status).toBe(200);
    expect(await expectInSync(docId)).toMatchObject({ people: [{ email: "bob@acme.com" }] });
  });

  it("follows the comments switch", async () => {
    const o = await owner();
    const docId = await publish(o.token, "docs");
    const set = (comments: boolean) => send("PUT", `/api/v1/docs/${docId}/settings`, o.token, { comments });

    expect((await set(true)).status).toBe(200);
    expect(await expectInSync(docId)).toMatchObject({ commentsEnabled: true });
    expect((await set(false)).status).toBe(200);
    expect(await expectInSync(docId)).toMatchObject({ commentsEnabled: false });
  });

  it("rewrites the manifest when the plan lapsed before the retry of a switch to invited", async () => {
    const o = await owner();
    const docId = await publish(o.token, "private-docs");
    await env.DB.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(o.id).run();
    await env.DOCS.delete(manifestObjectKey(docId));

    const response = await send("PUT", `/api/v1/docs/${docId}/access`, o.token, { linkAccess: "invited" });
    expect(response.status).toBe(200);
    await expectInSync(docId);
  });

  it("is rewritten even when the write changed nothing, which is what lets a retry repair it", async () => {
    const o = await owner();
    const docId = await publish(o.token, "private-docs");
    await send("PUT", person(docId, "alice@acme.com"), o.token, { role: "view" });

    for (const repeat of [
      () => send("PUT", `/api/v1/docs/${docId}/access`, o.token, { linkAccess: "invited" }),
      () => send("PUT", person(docId, "alice@acme.com"), o.token, { role: "view" }),
      () => send("DELETE", person(docId, "nobody@acme.com"), o.token),
      () => send("PUT", `/api/v1/docs/${docId}/settings`, o.token, { comments: false }),
    ]) {
      await env.DOCS.delete(manifestObjectKey(docId));
      expect((await repeat()).status).toBe(200);
      await expectInSync(docId);
    }
  });

  it("settles on what D1 says when a newer change lands between a snapshot and its put", async () => {
    const o = await owner();
    const docId = await publish(o.token, "docs");
    let flipped = false;
    const racing = {
      ...env,
      ...HOSTS,
      DOCS: bucketWith(async () => {
        if (flipped) return;
        flipped = true;
        // The owner makes the page private after this writer read `anyone` and before its put.
        await env.DB.prepare("UPDATE docs SET link_access = 'invited' WHERE id = ?").bind(docId).run();
      }),
    } as unknown as Env;

    await writeManifest(racing, docId);
    expect(await manifestOf(docId)).toMatchObject({ linkAccess: "invited" });
    await expectInSync(docId);
  });

  it("fails loudly rather than leave a manifest that never settles", async () => {
    const o = await owner();
    const docId = await publish(o.token, "docs");
    let n = 0;
    const churning = {
      ...env,
      ...HOSTS,
      DOCS: bucketWith(async () => {
        await env.DB.prepare("UPDATE docs SET title = ? WHERE id = ?").bind(`T${n++}`, docId).run();
      }),
    } as unknown as Env;
    await expect(writeManifest(churning, docId)).rejects.toThrow(/did not settle/);
  });

  it("does not swallow the invite email when the manifest put fails", async () => {
    const o = await owner();
    const docId = await publish(o.token, "private-docs");
    const sent: unknown[] = [];
    const failing = {
      ...env,
      ...HOSTS,
      EMAIL: { send: async (message: unknown) => void sent.push(message) },
      DOCS: bucketWith(async () => { throw new Error("r2 down"); }),
    } as unknown as Env;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${API}${person(docId, "alice@acme.com")}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" },
        body: JSON.stringify({ role: "view" }),
      }),
      failing,
      ctx,
    ).catch(() => null);
    await waitOnExecutionContext(ctx).catch(() => undefined);

    expect(response === null || response.status >= 500).toBe(true);
    expect(sent).toHaveLength(1);
    // The retry is a pure repeat: it mails nobody and still repairs the manifest.
    expect((await send("PUT", person(docId, "alice@acme.com"), o.token, { role: "view" })).status).toBe(200);
    expect(await expectInSync(docId)).toMatchObject({ people: [{ email: "alice@acme.com" }] });
  });

  it("fails the access request when the put fails, so the retry can repair it", async () => {
    const o = await owner();
    const docId = await publish(o.token, "docs");
    const ctx = createExecutionContext();
    const broken = {
      ...env,
      ...HOSTS,
      DOCS: bucketWith(async () => { throw new Error("r2 down"); }),
    } as unknown as Env;
    const response = await worker.fetch(
      new Request(`${API}/api/v1/docs/${docId}/access`, {
        method: "PUT",
        headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" },
        body: JSON.stringify({ linkAccess: "invited" }),
      }),
      broken,
      ctx,
    ).catch(() => null);
    await waitOnExecutionContext(ctx).catch(() => undefined);
    // D1 flipped and the manifest still says anyone: the one dangerous direction, and it is loud.
    expect(response === null || response.status >= 500).toBe(true);
    expect(await manifestOf(docId)).toMatchObject({ linkAccess: "anyone" });
  });

  it("answers a create and an update normally when the manifest put fails", async () => {
    const o = await owner();
    const events: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit = {}) => {
      events.push(String(init.body));
      return new Response("1");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      ...env,
      ...HOSTS,
      POSTHOG_PROJECT_API_KEY: "phc_test_ingest_key",
      POSTHOG_HOST: "https://posthog.test",
      ANALYTICS_ENVIRONMENT: "test",
      DOCS: bucketWith(async (key) => {
        if (key.endsWith("manifest.json")) throw new Error("r2 down");
      }),
    } as unknown as Env;
    const call = async (method: string, path: string, body: unknown) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${API}${path}`, {
          method,
          headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        failing,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    };

    try {
      const created = await call("POST", "/api/v1/docs", { title: "Report", html: page("<p>hello</p>") });
      expect(created.status).toBe(201);
      const { docId } = (await created.json()) as { docId: string };
      expect((await send("GET", `https://openartifacts.site/d/${docId}`, null)).status).toBe(200);
      expect(await env.DOCS.get(manifestObjectKey(docId))).toBeNull();
      expect(events.some((body) => body.includes("document_published"))).toBe(true);

      expect((await call("PUT", `/api/v1/docs/${docId}`, { html: page("<p>v2</p>") })).status).toBe(200);
      expect(errors).toHaveBeenCalledWith("manifest write failed", expect.objectContaining({ docId }));
    } finally {
      vi.unstubAllGlobals();
      errors.mockRestore();
    }
  });
});

describe("delete", () => {
  it("leaves a tombstone manifest and sweeps everything else, however many pages the sweep takes", async () => {
    const o = await owner();
    const docId = await publish(o.token, "private-docs");
    await send("PUT", person(docId, "alice@acme.com"), o.token, { role: "comment" });
    await send("PUT", `/api/v1/docs/${docId}`, o.token, { html: page("<p>v2</p>") });
    await send("PUT", `/api/v1/docs/${docId}/settings`, o.token, { comments: true });

    const { deleteDoc } = await import("../src/api/manage.js");
    const { NO_ANALYTICS } = await import("../src/analytics.js");
    const publisher = { owner: o.id } as Parameters<typeof deleteDoc>[1];
    const response = await deleteDoc({ ...env, ...HOSTS } as Env, publisher, docId, NO_ANALYTICS, { objectBatch: 2 });
    expect(response.status).toBe(204);

    const keys = (await env.DOCS.list({ prefix: docObjectPrefix(docId) })).objects.map((object) => object.key);
    expect(keys).toEqual([manifestObjectKey(docId)]);

    const manifest = await expectInSync(docId);
    expect(manifest.deletedAt).toEqual(expect.any(Number));
    // The invite list goes with the bytes, in D1 and so in the tombstone.
    expect(manifest).toMatchObject({ owner: o.id, linkAccess: "invited", people: [] });

    // A second delete is the 404 it always was, and does not disturb the tombstone.
    expect((await send("DELETE", `/api/v1/docs/${docId}`, o.token)).status).toBe(404);
    expect(await manifestOf(docId)).toEqual(manifest);
    expect(await env.DOCS.get(versionObjectKey(docId, 1))).toBeNull();
  });

  it("sweeps the manifest too when the tombstone put fails, so the doc rebuilds closed", async () => {
    const { deleteDoc } = await import("../src/api/manage.js");
    const { NO_ANALYTICS } = await import("../src/analytics.js");
    const o = await owner();
    const publisher = { owner: o.id } as Parameters<typeof deleteDoc>[1];
    const docId = await publish(o.token, "docs");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const down = {
        ...env,
        ...HOSTS,
        DOCS: bucketWith(async () => { throw new Error("r2 down"); }),
      } as unknown as Env;
      expect((await deleteDoc(down, publisher, docId, NO_ANALYTICS)).status).toBe(204);
      expect(errors).toHaveBeenCalledWith("delete left a stale manifest", expect.objectContaining({ docId }));
    } finally {
      errors.mockRestore();
    }
    expect((await env.DOCS.list({ prefix: docObjectPrefix(docId) })).objects).toEqual([]);
    expect((await send("GET", `https://openartifacts.site/d/${docId}`, null)).status).toBe(410);
  });
});

describe("rowsFromManifest", () => {
  const ID = "0123456789abcdef";
  const objects: ListedObject[] = [
    { key: `docs/${ID}/v1.html`, size: 10, uploaded: 1000 },
    { key: `docs/${ID}/v3.html`, size: 30, uploaded: 3000 },
    { key: `docs/${ID}/threads.json`, size: 5, uploaded: 3500 },
    { key: `docs/${ID}/manifest.json`, size: 500, uploaded: 4000 },
    { key: `docs/${ID}/v0.html`, size: 1, uploaded: 1 },
  ];
  const manifest: Record<string, any> = {
    schema: 1, docId: ID, owner: "o1", title: "T", linkAccess: "anyone", commentsEnabled: true,
    createdAt: 100, updatedAt: 200, deletedAt: null, latestVersion: 5,
    people: [{ email: "a@b.c", role: "comment", createdAt: 150 }],
  };

  it("builds the three row kinds, taking versions from the objects", () => {
    const rows = rowsFromManifest(ID, manifest, objects);
    expect(rows.doc).toEqual({
      id: ID, owner: "o1", title: "T", latest_version: 5, created_at: 100, updated_at: 200,
      deleted_at: null, link_access: "anyone", comments_enabled: 1,
    });
    expect(rows.invites).toEqual([{ doc_id: ID, email: "a@b.c", role: "comment", created_at: 150 }]);
    expect(rows.versions).toEqual([
      { doc_id: ID, n: 1, size: 10, title: null, created_at: 1000 },
      { doc_id: ID, n: 3, size: 30, title: null, created_at: 3000 },
    ]);
  });

  it("never lets the counter fall below an object that exists", () => {
    expect(rowsFromManifest(ID, { ...manifest, latestVersion: 2 }, objects).doc.latest_version).toBe(3);
  });

  it("treats a manifest of any other shape as unreadable, and rebuilds closed", () => {
    const odd: unknown[] = [
      { ...manifest, schema: 2 },
      { ...manifest, schema: undefined },
      { ...manifest, people: "x@y.z" },
      { ...manifest, people: [{ role: "comment", createdAt: 1 }] },
      { ...manifest, people: [{ email: "x@y.z", role: "view" }] },
      { ...manifest, people: [{ email: "x@y.z", role: 1, createdAt: 1 }] },
      { ...manifest, people: [{ email: "x@y.z", role: "view", createdAt: 1 }, null] },
      { ...manifest, title: {} },
      { ...manifest, owner: undefined },
      { ...manifest, commentsEnabled: 1 },
      { ...manifest, createdAt: "100" },
      { ...manifest, updatedAt: null },
      { ...manifest, latestVersion: "5" },
      { ...manifest, deletedAt: undefined },
      { ...manifest, deletedAt: "now" },
      [],
      "manifest",
    ];
    for (const m of odd) {
      const rows = rowsFromManifest(ID, m, objects);
      expect(rows.doc).toMatchObject({ link_access: "invited", owner: "", title: "Untitled", deleted_at: null });
      expect(rows.invites).toEqual([]);
    }
  });

  it("fails closed on a missing or unknown linkAccess", () => {
    for (const linkAccess of [undefined, null, "", "Anyone", "public", true, 1, {}]) {
      expect(rowsFromManifest(ID, { ...manifest, linkAccess } as never, objects).doc.link_access).toBe("invited");
    }
    const { linkAccess: _omitted, ...without } = manifest;
    expect(rowsFromManifest(ID, without, objects).doc.link_access).toBe("invited");
  });

  it("restores an unknown role as view, and a missing manifest as private with no owner", () => {
    const people = [{ email: "x@y.z", role: "admin", createdAt: 1 }, { email: "w@y.z", role: "Comment", createdAt: 2 }];
    const rows = rowsFromManifest(ID, { ...manifest, people } as never, objects);
    expect(rows.invites.map((invite) => invite.role)).toEqual(["view", "view"]);

    expect(rowsFromManifest(ID, null, objects).doc).toMatchObject({ link_access: "invited", owner: "", deleted_at: null });
  });

  it("carries newlines and NULs in a title through D1Database.exec, which splits its input on newlines", async () => {
    const id = "newlinedoc0000000000000000000000";
    const title = "Plan\r\nof 'record'\n\nv2\n\0end\0";
    const sql = rebuildSql([rowsFromManifest(id, { ...manifest, docId: id, title, people: [{ email: "a\nb@x.y", role: "view", createdAt: 1 }] }, [])]);
    expect(sql.trimEnd().split("\n").every((line) => line.startsWith("INSERT OR IGNORE INTO "))).toBe(true);
    await env.DB.exec(sql.trim());
    const row = await env.DB.prepare("SELECT title FROM docs WHERE id = ?").bind(id).first<{ title: string }>();
    expect(row!.title).toBe(title);
    const invite = await env.DB.prepare("SELECT email FROM doc_invites WHERE doc_id = ?").bind(id).first<{ email: string }>();
    expect(invite!.email).toBe("a\nb@x.y");
  });

  it("quotes values into SQL", () => {
    const sql = rebuildSql([rowsFromManifest(ID, { ...manifest, title: "Bob's 'plan'" }, objects)]);
    expect(sql).toContain("'Bob''s ''plan'''");
    expect(sql.split("\n").filter((line) => line.includes("INTO storage_usage"))).toEqual([
      "INSERT OR IGNORE INTO storage_usage (doc_id, n, size) SELECT doc_id, n, size FROM versions WHERE size > 0;",
    ]);
  });
});

describe("the columns the manifest and the rebuild were written against", () => {
  // A new column on `docs` or `doc_invites` must be added here, with a decision
  // whether it belongs in the manifest (src/manifest.ts) and in the rebuild
  // (src/rebuild.ts). A column that is neither is state a rebuild silently loses.
  it("has not gained a column nobody decided about", async () => {
    const columns = async (table: string) =>
      (await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((column) => column.name);
    expect(await columns("docs")).toEqual([
      "id", "owner", "title", "latest_version", "created_at", "updated_at", "deleted_at", "link_access", "comments_enabled",
    ]);
    expect(await columns("doc_invites")).toEqual(["doc_id", "email", "role", "created_at"]);
  });
});

describe("rebuilding D1 from R2 alone", () => {
  it("keeps a private page private, a withdrawn page 410 and a public page public, with every role", async () => {
    const o = await owner();
    const pub = await publish(o.token, "docs", "Public");
    const priv = await publish(o.token, "private-docs", "Private");
    await send("PUT", person(priv, "alice@acme.com"), o.token, { role: "comment" });
    await send("PUT", person(priv, "bob@acme.com"), o.token, { role: "view" });
    await send("PUT", `/api/v1/docs/${priv}/settings`, o.token, { comments: true });
    await send("PUT", `/api/v1/docs/${priv}`, o.token, { title: "Private v2", html: page("<p>second</p>") });
    const gone = await publish(o.token, "docs", "Gone");
    expect((await send("DELETE", `/api/v1/docs/${gone}`, o.token)).status).toBe(204);

    const ids = [pub, priv, gone];
    const snapshot = async () => ({
      docs: (await env.DB.prepare("SELECT * FROM docs WHERE id IN (?, ?, ?) ORDER BY id").bind(...ids).all()).results,
      invites: (await env.DB.prepare("SELECT * FROM doc_invites WHERE doc_id IN (?, ?, ?) ORDER BY doc_id, email").bind(...ids).all()).results,
      versions: (await env.DB.prepare("SELECT doc_id, n, size FROM versions WHERE doc_id IN (?, ?, ?) ORDER BY doc_id, n").bind(...ids).all()).results,
    });
    const before = await snapshot();

    // Lose D1's document state completely.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM storage_usage"),
      env.DB.prepare("DELETE FROM versions"),
      env.DB.prepare("DELETE FROM doc_invites"),
      env.DB.prepare("DELETE FROM docs"),
    ]);
    expect((await send("GET", `https://openartifacts.site/d/${pub}`, null)).status).toBe(404);

    // Rebuild from the bucket: the listing and the manifest, nothing from D1.
    const rebuilt = [];
    for (const id of ids) {
      const listing = await env.DOCS.list({ prefix: docObjectPrefix(id) });
      const objects = listing.objects.map((object) => ({
        key: object.key, size: object.size, uploaded: object.uploaded.getTime(),
      }));
      const stored = await env.DOCS.get(manifestObjectKey(id));
      rebuilt.push(rowsFromManifest(id, stored ? JSON.parse(await stored.text()) : null, objects));
    }
    await env.DB.exec(rebuildSql(rebuilt).trim());

    // Private stays private: an anonymous reader is sent to sign in, at every url.
    for (const suffix of ["", "/v1", "/v2"]) {
      const response = await send("GET", `https://openartifacts.site/d/${priv}${suffix}`, null);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`${API}/open/${priv}${suffix}`);
    }
    // Withdrawn stays withdrawn, not "never existed".
    expect((await send("GET", `https://openartifacts.site/d/${gone}`, null)).status).toBe(410);
    // Public serves.
    const served = await send("GET", `https://openartifacts.site/d/${pub}`, null);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("hello");

    // The people, their roles, the switch and the title came back; the owner still manages it.
    expect(await env.DB.prepare("SELECT email, role FROM doc_invites WHERE doc_id = ? ORDER BY email").bind(priv).all()).toMatchObject({
      results: [{ email: "alice@acme.com", role: "comment" }, { email: "bob@acme.com", role: "view" }],
    });
    const access = await send("GET", `/api/v1/docs/${priv}/access`, o.token);
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({ linkAccess: "invited" });

    // Row for row what D1 held. The withdrawn doc's version rows are the one loss: their bytes are
    // gone, so nothing in R2 names them, and nothing reads them.
    const after = await snapshot();
    expect(after.docs).toEqual(before.docs);
    expect(after.invites).toEqual(before.invites);
    expect(after.versions).toEqual(before.versions.filter((v) => v.doc_id !== gone));

    // The storage ledger came back too, so the quota still counts the retained bytes.
    const ledger = await env.DB.prepare("SELECT COUNT(*) AS n FROM storage_usage").first<{ n: number }>();
    expect(ledger!.n).toBe(after.versions.length);
  });
});

describe("POST /admin/v1/manifests/backfill (temporary)", () => {
  it("needs the admin key", async () => {
    expect((await send("POST", "/admin/v1/manifests/backfill", null)).status).toBe(401);
    expect((await send("POST", "/admin/v1/manifests/backfill", "wrong")).status).toBe(401);
    expect((await send("POST", "/admin/v1/manifests/backfill", (await owner()).token)).status).toBe(401);
  });

  it("writes a manifest for every existing doc, deleted ones included, and is safe to repeat", async () => {
    const o = await owner();
    const live = await publish(o.token, "docs", "Live");
    const priv = await publish(o.token, "private-docs", "Priv");
    await send("PUT", person(priv, "alice@acme.com"), o.token, { role: "view" });
    const gone = await publish(o.token, "docs", "Gone");
    await send("DELETE", `/api/v1/docs/${gone}`, o.token);
    const ids = [live, priv, gone];

    // The state before manifests existed.
    for (const id of ids) await env.DOCS.delete(manifestObjectKey(id));

    const first = await send("POST", "/admin/v1/manifests/backfill", ADMIN);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const body = (await first.json()) as { written: number; cursor?: string };
    expect(body.written).toBeGreaterThanOrEqual(3);
    expect(body.cursor).toBeUndefined();
    const snapshots = await Promise.all(ids.map((id) => expectInSync(id)));
    expect(snapshots[1]).toMatchObject({ linkAccess: "invited", people: [{ email: "alice@acme.com", role: "view" }] });
    expect(snapshots[2]!.deletedAt).toEqual(expect.any(Number));

    await send("POST", "/admin/v1/manifests/backfill", ADMIN);
    expect(await Promise.all(ids.map((id) => manifestOf(id)))).toEqual(snapshots);
  });
});
