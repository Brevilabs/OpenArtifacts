import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import { deleteDocRow, insertDocWithinQuota, insertVersion, reserveNextVersion } from "../src/db.js";
import { sha256Hex } from "../src/hash.js";
import { newApiToken, newDocId, newTokenId } from "../src/ids.js";
import { linkExternalOwner, publisherSuspended } from "../src/owners.js";
import { removeDocument } from "../src/operator.js";
import worker from "../src/index.js";
const ACCOUNT = "oa_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const EXTERNAL = "external-a";
const SERVICE = "operator-service-fixture";
let token: string;
beforeEach(async () => {
  await env.DB.prepare("INSERT INTO accounts (id, email, created_at, plan) VALUES (?, 'a@example.test', 0, 'pro')").bind(ACCOUNT).run();
  token = newApiToken();
  await env.DB.prepare("INSERT INTO tokens (id, token_hash, account_id, created_at) VALUES (?, ?, ?, 0)")
    .bind(newTokenId(), await sha256Hex(token), ACCOUNT).run();
  await env.DB.prepare("INSERT INTO publishers (key_hash, plan, owner, validated_at) VALUES (?, 'plus', ?, ?)")
    .bind(await sha256Hex("license-fixture"), EXTERNAL, Date.now()).run();
});
async function send(method: string, path: string, credential = SERVICE, body?: unknown, overrides: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const result = await worker.fetch(new Request(`https://api.local.test${path}`, {
    method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { ...env, ADMIN_API_KEY: SERVICE, SERVING_HOST: "", API_HOST: "", LEGACY_SERVING_HOST: "", RETIRED_API_HOST: "", ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  const bytes = await result.arrayBuffer();
  return new Response(result.status === 204 ? null : bytes, { status: result.status, headers: result.headers });
}
const suspend = (owner = ACCOUNT, suspended = true) => send("PUT", `/admin/v1/publishers/${owner}/suspension`, SERVICE, { suspended });
const push = (id?: string, credential = token) => send(id ? "PUT" : "POST", `/api/v1/docs${id ? `/${id}` : ""}`, credential, { title: "Kept", html: "<html><body>Kept</body></html>" });
async function published(credential = token) {
  const result = await push(undefined, credential); expect(result.status).toBe(201);
  return (await result.json() as { docId: string }).docId;
}
const quota = async () => (await env.DB.prepare("SELECT COALESCE(SUM(pushes), 0) AS n FROM push_quota").first<{ n: number }>())!.n;
const doc = (id = newDocId()) => ({ id, owner: ACCOUNT, title: "Kept", created_at: 0, updated_at: 0 });

it("requires the service credential on the API host and validates exact inputs", async () => {
  const path = `/admin/v1/publishers/${ACCOUNT}/suspension`;
  for (const credential of [token, "license-fixture", "bad"]) expect((await send("PUT", path, credential, { suspended: true })).status).toBe(401);
  expect((await send("PUT", path, SERVICE, { suspended: true }, { ADMIN_API_KEY: "" })).status).toBe(404);
  expect((await send("PUT", path, SERVICE, { suspended: true }, { API_HOST: "different.test" })).status).toBe(404);
  expect((await send("PUT", path, SERVICE, { suspended: true }, { SERVING_HOST: "api.local.test" })).status).toBe(404);
  expect((await send("PUT", path, SERVICE, { suspended: true }, { RETIRED_API_HOST: "api.local.test" })).status).toBe(410);
  for (const body of [null, [], {}, { suspended: "true" }, { suspended: true, owner: ACCOUNT }, { suspended: "x".repeat(1025) }]) {
    expect((await send("PUT", path, SERVICE, body)).status).toBe(400);
  }
  for (const owner of ["%00", "%20x", "oa_bad", "%E0%A4%A", "x".repeat(257)]) expect((await suspend(owner)).status).toBe(400);
  expect((await send("POST", path, SERVICE, { suspended: true })).status).toBe(404);
  expect(await publisherSuspended(env.DB, ACCOUNT)).toBe(false);
});

it("inherits suspensions across future links and clears the whole joined scope without changing credentials or plan", async () => {
  const id = await published();
  const externalId = await published("license-fixture");
  expect((await suspend(EXTERNAL)).status).toBe(200);
  expect(await publisherSuspended(env.DB, ACCOUNT)).toBe(false);
  expect(await linkExternalOwner(env.DB, EXTERNAL, ACCOUNT, 1)).toBe("linked");
  await suspend(ACCOUNT);
  for (const credential of [token, "license-fixture"]) {
    expect((await push(undefined, credential)).status).toBe(403);
    expect((await push(id, credential)).status).toBe(403);
    expect((await push(newDocId(), credential)).status).toBe(404);
    expect((await send("GET", "/api/v1/docs", credential)).status).toBe(200);
  }
  expect(await quota()).toBe(2);
  expect((await send("GET", "/api/v1/account", token)).status).toBe(200);
  expect((await send("GET", "/api/v1/tokens", token)).status).toBe(200);
  expect((await send("DELETE", `/api/v1/docs/${externalId}`, token)).status).toBe(204);
  expect((await push(externalId)).status).toBe(404);
  expect((await suspend(EXTERNAL, false)).status).toBe(200);
  expect(await publisherSuspended(env.DB, ACCOUNT)).toBe(false);
  expect(await publisherSuspended(env.DB, EXTERNAL)).toBe(false);
  expect((await push(id, "license-fixture")).status).toBe(200);
  expect(await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(ACCOUNT).first()).toEqual({ plan: "pro" });
});

it("rejects create and version reservations atomically without consuming a slot or version", async () => {
  const row = doc(); expect(await insertDocWithinQuota(env.DB, row, 500)).toBe(true);
  await suspend();
  expect(await insertDocWithinQuota(env.DB, doc(), 500)).toBe(false);
  expect(await reserveNextVersion(env.DB, row.id, ACCOUNT)).toBeNull();
  expect(await env.DB.prepare("SELECT latest_version FROM docs WHERE id = ?").bind(row.id).first()).toEqual({ latest_version: 1 });
});

it("rolls back an empty create and refunds its exact daily reservation when suspension follows reservation", async () => {
  await env.DB.exec(`CREATE TRIGGER suspend_create AFTER INSERT ON docs BEGIN INSERT INTO publisher_suspensions VALUES (NEW.owner, 1); END`);
  const result = await push(); expect(result.status).toBe(403);
  expect(await result.json()).toMatchObject({ error: { code: "publisher_suspended" } });
  expect(await env.DB.prepare("SELECT id FROM docs").first()).toBeNull();
  expect(await quota()).toBe(0);
  expect((await env.DOCS.list()).objects).toHaveLength(0);
});

it("preserves the previous bytes and metadata when suspension follows an update reservation", async () => {
  const id = await published();
  await env.DB.exec(`CREATE TRIGGER suspend_update AFTER UPDATE OF latest_version ON docs BEGIN INSERT INTO publisher_suspensions VALUES (NEW.owner, 1); END`);
  expect((await push(id)).status).toBe(403);
  expect(await quota()).toBe(1);
  expect((await env.DOCS.list({ prefix: `docs/${id}/` })).objects.map(o => o.key)).toEqual([`docs/${id}/v1.html`]);
  expect(await env.DB.prepare("SELECT n, title FROM versions WHERE doc_id = ?").bind(id).all()).toMatchObject({ results: [{ n: 1, title: "Kept" }] });
  expect((await send("GET", `/d/${id}`)).status).toBe(200);
});

it("checks the current joined scope at version commit, including a link after reservation", async () => {
  const row = doc(); await insertDocWithinQuota(env.DB, row, 500);
  await suspend(EXTERNAL);
  await linkExternalOwner(env.DB, EXTERNAL, ACCOUNT, 1);
  expect(await insertVersion(env.DB, { doc_id: row.id, n: 1, size: 1, title: null, created_at: 0 }, ACCOUNT)).toBe(false);
  expect(await env.DB.prepare("SELECT n FROM versions").first()).toBeNull();
});

it("keeps a version committed before suspension rather than deleting it afterwards", async () => {
  await env.DB.exec(`CREATE TRIGGER suspend_committed AFTER INSERT ON versions BEGIN INSERT INTO publisher_suspensions SELECT owner, 1 FROM docs WHERE id = NEW.doc_id; END`);
  const id = await published();
  expect(await publisherSuspended(env.DB, ACCOUNT)).toBe(true);
  expect((await send("GET", `/d/${id}/v1`)).status).toBe(200);
});

it("preserves a tombstone created before the first version commit and cleans its late object", async () => {
  await env.DB.exec(`CREATE TRIGGER remove_reserved AFTER INSERT ON docs BEGIN UPDATE docs SET deleted_at = 1 WHERE id = NEW.id; END`);
  expect((await push()).status).toBe(404);
  const row = await env.DB.prepare("SELECT id, deleted_at FROM docs").first<{ id: string; deleted_at: number }>();
  expect(row?.deleted_at).toBe(1);
  expect((await send("GET", `/d/${row!.id}`)).status).toBe(410);
  expect(await quota()).toBe(0);
  expect((await env.DOCS.list()).objects).toHaveLength(0);
});

it("compensates for a takedown after version insertion without deleting the tombstone", async () => {
  await env.DB.exec(`CREATE TRIGGER remove_committed AFTER INSERT ON versions BEGIN UPDATE docs SET deleted_at = 1 WHERE id = NEW.doc_id; END`);
  expect((await push()).status).toBe(404);
  expect(await quota()).toBe(0);
  expect((await env.DOCS.list()).objects).toHaveLength(0);
  expect(await env.DB.prepare("SELECT n FROM versions").first()).toBeNull();
  expect(await env.DB.prepare("SELECT deleted_at FROM docs").first()).toEqual({ deleted_at: 1 });
});

it("never rolls back a live placeholder that another writer has populated", async () => {
  const id = await published(); await deleteDocRow(env.DB, id);
  expect((await send("GET", `/d/${id}`)).status).toBe(200);
});

it("withdraws before cleanup failure, returns retryable 500, and removes all R2 pages on retry", async () => {
  const id = await published();
  for (let n = 2; n <= 5; n++) await env.DOCS.put(`docs/${id}/v${n}.html`, "orphan or old version");
  const broken = new Proxy(env.DOCS, { get(target, prop, receiver) {
    if (prop === "delete") return () => Promise.reject(new Error("synthetic R2 failure"));
    return Reflect.get(target, prop, receiver);
  } });
  expect((await send("DELETE", `/admin/v1/docs/${id}`, token)).status).toBe(401);
  expect((await send("DELETE", `/admin/v1/docs/${id}`, SERVICE, undefined, { DOCS: broken })).status).toBe(500);
  const tombstone = await env.DB.prepare("SELECT deleted_at FROM docs WHERE id = ?").bind(id).first();
  for (const suffix of ["", "/v1"]) expect((await send("GET", `/d/${id}${suffix}`)).status).toBe(410);
  expect((await removeDocument(env, id, 2)).status).toBe(204);
  expect((await env.DOCS.list({ prefix: `docs/${id}/` })).objects).toHaveLength(0);
  expect((await send("DELETE", `/admin/v1/docs/${id}`)).status).toBe(204);
  expect(await env.DB.prepare("SELECT deleted_at FROM docs WHERE id = ?").bind(id).first()).toEqual(tombstone);
  expect((await send("DELETE", `/admin/v1/docs/${newDocId()}`)).status).toBe(404);
  expect((await send("DELETE", "/admin/v1/docs/invalid")).status).toBe(404);
});
