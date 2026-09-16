import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../src/config.js";
import { findOrCreateAccount } from "../src/db.js";
import { sha256Hex } from "../src/hash.js";
import { newApiToken, newTokenId } from "../src/ids.js";
import { linkExternalOwner } from "../src/owners.js";
import { reserveStorage, storedBytes } from "../src/storage-quota.js";
import worker from "../src/index.js";

const OWNER = "oa_aaaaaaaaaaaaaaaaaaaaaaaaaa";
let token: string;
const settings = (cap = 10): Env => ({ ...env, SERVING_HOST: "", API_HOST: "", LEGACY_SERVING_HOST: "", RETIRED_API_HOST: "",
  PLAN_LIMITS: JSON.stringify({ free: { documents: 1, pushesPerDay: 6, htmlBytes: 1048576 },
    pro: { documents: 500, pushesPerDay: 100, htmlBytes: 10485760 },
    pro_lifetime: { documents: 500, pushesPerDay: 100, htmlBytes: 10485760, storageBytes: cap } }) });
beforeEach(async () => {
  await findOrCreateAccount(env.DB, OWNER, "owner@example.test", Date.now());
  await env.DB.prepare("UPDATE accounts SET plan = 'pro_lifetime' WHERE id = ?").bind(OWNER).run();
  token = newApiToken();
  await env.DB.prepare("INSERT INTO tokens (id, token_hash, account_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(newTokenId(), await sha256Hex(token), OWNER, Date.now()).run();
});
async function request(method: string, path: string, html?: string, config = settings()) {
  const ctx = createExecutionContext();
  const result = await worker.fetch(new Request(`https://local.test${path}`, { method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(html === undefined ? {} : { body: JSON.stringify({ html }) }) }), config, ctx);
  await waitOnExecutionContext(ctx);
  return result;
}
async function create(html: string, config = settings()) {
  const response = await request("POST", "/api/v1/docs", html, config);
  expect(response.status).toBe(201);
  return response.json<{ docId: string; version: number }>();
}

it("counts UTF-8 versions at the exact cap; full accounts can read/list/delete and recover space", async () => {
  const doc = await create("éé"); // four bytes
  expect((await request("PUT", `/api/v1/docs/${doc.docId}`, "abcdef")).status).toBe(200);
  expect(await storedBytes(env.DB, OWNER)).toBe(10);
  const rejected = await request("PUT", `/api/v1/docs/${doc.docId}`, "x");
  expect(rejected.status).toBe(402);
  expect(await rejected.json()).toMatchObject({ error: { code: "limit_reached", limit: "storageBytes" } });
  expect((await request("POST", "/api/v1/docs", "x")).status).toBe(402);
  expect((await request("GET", `/d/${doc.docId}/v1`)).status).toBe(200);
  expect((await request("GET", `/d/${doc.docId}`)).status).toBe(200);
  expect((await request("GET", "/api/v1/docs")).status).toBe(200);
  expect(await (await request("GET", "/api/v1/account")).json()).toMatchObject({
    limits: { storageBytes: 10 }, usage: { storedBytes: 10, documents: 1, pushesToday: 2 },
  });
  expect((await request("DELETE", `/api/v1/docs/${doc.docId}`)).status).toBe(204);
  expect((await request("GET", `/d/${doc.docId}`)).status).toBe(410);
  expect((await request("DELETE", `/api/v1/docs/${doc.docId}`)).status).toBe(404);
  expect(await storedBytes(env.DB, OWNER)).toBe(0);
  await create("0123456789");
});

it("simultaneous creates and updates cannot overspend one shared byte allowance", async () => {
  const a = await create("a"), b = await create("b");
  const responses = await Promise.all([
    request("PUT", `/api/v1/docs/${a.docId}`, "12345678"),
    request("PUT", `/api/v1/docs/${b.docId}`, "12345678"),
    request("POST", "/api/v1/docs", "12345678"),
  ]);
  expect(responses.filter((r) => r.ok)).toHaveLength(1);
  expect(responses.filter((r) => r.status === 402)).toHaveLength(2);
  expect(await storedBytes(env.DB, OWNER)).toBe(10);
});

it("existing monthly/manual grants stay uncapped; linking includes their prior versions", async () => {
  await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(OWNER).run();
  const old = await create("01234567890");
  await env.DB.prepare("UPDATE docs SET owner = 'external-owner' WHERE id = ?").bind(old.docId).run();
  await linkExternalOwner(env.DB, "external-owner", OWNER, Date.now());
  expect(await storedBytes(env.DB, OWNER)).toBe(11);
  expect(await storedBytes(env.DB, "external-owner")).toBe(11);
  await env.DB.prepare("UPDATE accounts SET plan = 'pro_lifetime' WHERE id = ?").bind(OWNER).run();
  expect((await request("PUT", `/api/v1/docs/${old.docId}`, "x")).status).toBe(402);
  expect((await request("GET", `/d/${old.docId}`)).status).toBe(200);
  expect((await request("DELETE", `/api/v1/docs/${old.docId}`)).status).toBe(204);
  expect(await storedBytes(env.DB, OWNER)).toBe(0);
  await create("0123456789");
});

it("a tombstone or failed R2 deletion never credits retained bytes", async () => {
  const doc = await create("0123456789");
  const failure = vi.spyOn(env.DOCS, "delete").mockRejectedValue(new Error("R2 unavailable"));
  try { expect((await request("DELETE", `/api/v1/docs/${doc.docId}`)).status).toBe(204); }
  finally { failure.mockRestore(); }
  expect(await storedBytes(env.DB, OWNER)).toBe(10);
  expect((await request("POST", "/api/v1/docs", "x")).status).toBe(402);
  expect((await request("GET", `/d/${doc.docId}`)).status).toBe(410);
});

it("an uncertain put stays accounted even without a version row; withdrawal cleans its orphan", async () => {
  const original = env.DOCS.put.bind(env.DOCS);
  const failure = vi.spyOn(env.DOCS, "put").mockImplementation(async (...args) => {
    await original(...args);
    throw new Error("lost response after stored bytes");
  });
  try { expect((await request("POST", "/api/v1/docs", "0123456789")).status).toBe(500); }
  finally { failure.mockRestore(); }
  expect(await storedBytes(env.DB, OWNER)).toBe(10);
  expect((await request("POST", "/api/v1/docs", "x")).status).toBe(402);
  const row = await env.DB.prepare("SELECT id FROM docs WHERE owner = ?").bind(OWNER).first<{ id: string }>();
  expect((await request("DELETE", `/api/v1/docs/${row!.id}`)).status).toBe(204);
  expect(await storedBytes(env.DB, OWNER)).toBe(0);
});

it("deletion cannot release an in-flight reservation before that upload finishes", async () => {
  const doc = await create("a");
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { resume = resolve; });
  const original = env.DOCS.put.bind(env.DOCS);
  const pause = vi.spyOn(env.DOCS, "put").mockImplementation(async (...args) => {
    entered(); await pending; return original(...args);
  });
  const upload = request("PUT", `/api/v1/docs/${doc.docId}`, "123456789");
  try {
    await started;
    expect(await storedBytes(env.DB, OWNER)).toBe(10);
    expect((await request("DELETE", `/api/v1/docs/${doc.docId}`)).status).toBe(204);
    expect(await storedBytes(env.DB, OWNER)).toBe(9);
    expect((await request("POST", "/api/v1/docs", "xx")).status).toBe(402);
  } finally { resume(); pause.mockRestore(); }
  expect((await upload).status).toBe(404);
  expect(await storedBytes(env.DB, OWNER)).toBe(0);
  expect((await env.DOCS.list({ prefix: `docs/${doc.docId}/` })).objects).toHaveLength(0);
});

it("failed metadata commit leaves the actual object charged until successful withdrawal", async () => {
  const original = env.DB.prepare.bind(env.DB);
  const failure = vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
    if (query.startsWith("INSERT INTO versions")) throw new Error("metadata unavailable");
    return original(query);
  });
  try { expect((await request("POST", "/api/v1/docs", "0123456789")).status).toBe(500); }
  finally { failure.mockRestore(); }
  expect(await storedBytes(env.DB, OWNER)).toBe(10);
  const row = await env.DB.prepare("SELECT id FROM docs WHERE owner = ?").bind(OWNER).first<{ id: string }>();
  expect((await env.DOCS.list({ prefix: `docs/${row!.id}/` })).objects).toHaveLength(1);
  expect((await request("DELETE", `/api/v1/docs/${row!.id}`)).status).toBe(204);
  expect(await storedBytes(env.DB, OWNER)).toBe(0);
});

it("partial cleanup with an uncertain response conservatively retains all unconfirmed bytes", async () => {
  const doc = await create("12345");
  expect((await request("PUT", `/api/v1/docs/${doc.docId}`, "67890")).status).toBe(200);
  const original = env.DOCS.delete.bind(env.DOCS);
  const failure = vi.spyOn(env.DOCS, "delete").mockImplementation(async (keys) => {
    await original(Array.isArray(keys) ? keys[0]! : keys);
    throw new Error("unknown cleanup outcome");
  });
  try { expect((await request("DELETE", `/api/v1/docs/${doc.docId}`)).status).toBe(204); }
  finally { failure.mockRestore(); }
  expect(await storedBytes(env.DB, OWNER)).toBe(10);
  expect((await env.DOCS.list({ prefix: `docs/${doc.docId}/` })).objects).toHaveLength(1);
  expect((await request("POST", "/api/v1/docs", "x")).status).toBe(402);
});


it("backfills retained versions including tombstoned documents before activating the cap", async () => {
  const live = await create("1234"), withdrawn = await create("567890");
  await env.DB.prepare("UPDATE docs SET deleted_at = ? WHERE id = ?").bind(Date.now(), withdrawn.docId).run();
  // Reconstruct the pre-migration schema, retaining the real D1 rows and R2 objects.
  await env.DB.prepare("DROP TABLE storage_usage").run();
  await env.DB.prepare("DROP INDEX docs_by_owner").run();
  const migration = env.TEST_MIGRATIONS.find((item) => item.name.startsWith("0013"))!;
  await env.DB.batch(migration.queries.map((query) => env.DB.prepare(query)));
  expect(await storedBytes(env.DB, OWNER)).toBe(10);
  expect((await request("POST", "/api/v1/docs", "x")).status).toBe(402);
  expect((await request("GET", `/d/${live.docId}`)).status).toBe(200);
  expect((await request("GET", `/d/${withdrawn.docId}`)).status).toBe(410);
  expect((await request("DELETE", `/api/v1/docs/${live.docId}`)).status).toBe(204);
  expect(await storedBytes(env.DB, OWNER)).toBe(6);
});

it("concurrent linked-identity reservations use one canonical total", async () => {
  const a = await create("a"), b = await create("b");
  await env.DB.prepare("UPDATE docs SET owner = 'external-owner' WHERE id = ?").bind(b.docId).run();
  await linkExternalOwner(env.DB, "external-owner", OWNER, Date.now());
  const reserved = await Promise.all([
    reserveStorage(env.DB, OWNER, a.docId, 2, 8, 10),
    reserveStorage(env.DB, "external-owner", b.docId, 2, 8, 10),
  ]);
  expect(reserved.filter(Boolean)).toHaveLength(1);
  expect(await storedBytes(env.DB, OWNER)).toBe(10);
  expect(await storedBytes(env.DB, "external-owner")).toBe(10);
});
