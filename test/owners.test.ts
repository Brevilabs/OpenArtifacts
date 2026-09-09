import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { insertDocWithinQuota, listPublisherDocs, ownsLiveDoc, reserveNextVersion, softDeleteDoc } from "../src/db.js";
import { sha256Hex } from "../src/hash.js";
import { newApiToken, newDocId, newTokenId } from "../src/ids.js";
import { linkExternalOwner } from "../src/owners.js";
import { refundDailyPush, reserveDailyPush } from "../src/quota.js";
import worker from "../src/index.js";

const ACCOUNT = "oa_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_ACCOUNT = "oa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const EXTERNAL = "external-owner-a";
const OTHER_EXTERNAL = "external-owner-b";
const DAY = "2026-09-09";
const KEY = "test-license-a";
const SECOND_KEY = "test-license-a2";
let token: string;
let tokenId: string;

beforeEach(async () => {
  for (const account of [ACCOUNT, OTHER_ACCOUNT]) {
    await env.DB.prepare("INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, 0, 'pro')")
      .bind(account, `${account}@example.test`).run();
  }
  token = newApiToken();
  tokenId = newTokenId();
  await env.DB.prepare("INSERT INTO tokens (id, token_hash, account_id, created_at) VALUES (?, ?, ?, 0)")
    .bind(tokenId, await sha256Hex(token), ACCOUNT).run();
  for (const key of [KEY, SECOND_KEY]) {
    await env.DB.prepare("INSERT INTO publishers (key_hash, plan, owner, validated_at) VALUES (?, 'plus', ?, ?)")
      .bind(await sha256Hex(key), EXTERNAL, Date.now()).run();
  }
});

const link = () => linkExternalOwner(env.DB, EXTERNAL, ACCOUNT, 123);
const doc = (owner: string, at = 0) => ({ id: newDocId(), owner, title: owner, created_at: at, updated_at: at });

async function send(method: string, path: string, credential: string, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://local.test${path}`, {
    method,
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { ...env, SERVING_HOST: "", API_HOST: "", LEGACY_SERVING_HOST: "", RETIRED_API_HOST: "" }, ctx);
  await waitOnExecutionContext(ctx);
  const bytes = await response.arrayBuffer();
  return new Response(response.status === 204 ? null : bytes, { status: response.status, headers: response.headers });
}

async function publish(credential: string) {
  const response = await send("POST", "/api/v1/docs", credential, { title: "Kept", html: "<!doctype html><html><body>Kept</body></html>" });
  expect(response.status).toBe(201);
  return await response.json() as { docId: string; url: string; version: number };
}

it("links one existing account once, without transfers, chains, or missing accounts", async () => {
  expect(await link()).toBe("linked");
  expect(await linkExternalOwner(env.DB, EXTERNAL, ACCOUNT, 999)).toBe("linked");
  expect(await linkExternalOwner(env.DB, EXTERNAL, OTHER_ACCOUNT, 999)).toBe("conflict");
  expect(await linkExternalOwner(env.DB, OTHER_EXTERNAL, ACCOUNT, 999)).toBe("conflict");
  expect(await linkExternalOwner(env.DB, OTHER_EXTERNAL, "oa_cccccccccccccccccccccccccc", 999)).toBe("account_not_found");
  for (const external of ["", " ", " trailing ", ACCOUNT, "x".repeat(257)]) {
    expect(await linkExternalOwner(env.DB, external, OTHER_ACCOUNT, 999)).toBe("invalid");
  }
  for (const account of [EXTERNAL, "oa_", "oa_" + "!".repeat(26)]) {
    expect(await linkExternalOwner(env.DB, OTHER_EXTERNAL, account, 999)).toBe("invalid");
  }
  expect(await env.DB.prepare("SELECT * FROM owner_links").all()).toMatchObject({ results: [
    { external_owner: EXTERNAL, account_id: ACCOUNT, created_at: 123 },
  ] });
  await expect(env.DB.prepare("UPDATE owner_links SET account_id = ?").bind(OTHER_ACCOUNT).run()).rejects.toThrow();
  await expect(env.DB.prepare("DELETE FROM owner_links").run()).rejects.toThrow();
});

it("resolves competing links atomically with one winner", async () => {
  const results = await Promise.all([
    linkExternalOwner(env.DB, EXTERNAL, ACCOUNT, 1),
    linkExternalOwner(env.DB, EXTERNAL, OTHER_ACCOUNT, 1),
  ]);
  expect(results.sort()).toEqual(["conflict", "linked"]);
});

it("joins both live collections with stable pagination and preserves deleted provenance", async () => {
  const a = doc(EXTERNAL, 1);
  const b = doc(ACCOUNT, 2);
  const c = doc(EXTERNAL, 3);
  const unrelated = doc(OTHER_ACCOUNT, 4);
  for (const row of [a, b, c, unrelated]) expect(await insertDocWithinQuota(env.DB, row, 10)).toBe(true);
  await softDeleteDoc(env.DB, c.id, EXTERNAL, 4);
  expect(await ownsLiveDoc(env.DB, a.id, ACCOUNT)).toBe(false);
  await link();
  for (const owner of [ACCOUNT, EXTERNAL]) {
    const first = await listPublisherDocs(env.DB, owner, null, 1);
    expect(first.map((r) => r.id)).toEqual([b.id]);
    expect((await listPublisherDocs(env.DB, owner, { created_at: b.created_at, id: b.id }, 1)).map((r) => r.id)).toEqual([a.id]);
    expect(await ownsLiveDoc(env.DB, unrelated.id, owner)).toBe(false);
    expect(await reserveNextVersion(env.DB, unrelated.id, owner)).toBeNull();
    expect(await softDeleteDoc(env.DB, unrelated.id, owner, 5)).toBe(false);
  }
  expect(await reserveNextVersion(env.DB, a.id, ACCOUNT)).toBe(2);
  expect(await softDeleteDoc(env.DB, b.id, EXTERNAL, 5)).toBe(true);
  expect(await env.DB.prepare("SELECT owner, deleted_at FROM docs WHERE id = ?").bind(c.id).first())
    .toEqual({ owner: EXTERNAL, deleted_at: 4 });
});

it("counts both document owners inside reservation, including requests started before linking", async () => {
  const oldRequest = doc(EXTERNAL);
  expect(await insertDocWithinQuota(env.DB, doc(ACCOUNT), 3)).toBe(true);
  await link();
  const attempts = await Promise.all([
    insertDocWithinQuota(env.DB, oldRequest, 2),
    insertDocWithinQuota(env.DB, doc(ACCOUNT), 2),
  ]);
  expect(attempts.filter(Boolean)).toHaveLength(1);
  expect(await insertDocWithinQuota(env.DB, doc(EXTERNAL), 2)).toBe(false);
  expect(await insertDocWithinQuota(env.DB, doc(ACCOUNT), 2)).toBe(false);
});

it("combines existing daily usage and refunds its original bucket across linking", async () => {
  expect(await reserveDailyPush(env.DB, EXTERNAL, DAY, 3)).toBe(true);
  expect(await reserveDailyPush(env.DB, ACCOUNT, DAY, 3)).toBe(true);
  await link();
  const claims = await Promise.all([
    reserveDailyPush(env.DB, EXTERNAL, DAY, 3), reserveDailyPush(env.DB, ACCOUNT, DAY, 3),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  await refundDailyPush(env.DB, EXTERNAL, DAY);
  expect(await reserveDailyPush(env.DB, ACCOUNT, DAY, 3)).toBe(true);
  expect(await reserveDailyPush(env.DB, EXTERNAL, DAY, 3)).toBe(false);
  expect(await reserveDailyPush(env.DB, EXTERNAL, "2026-09-10", 3)).toBe(true);
  expect(await reserveDailyPush(env.DB, OTHER_EXTERNAL, DAY, 3)).toBe(true);
  expect(await env.DB.prepare("SELECT SUM(pushes) AS n FROM push_quota WHERE day = ? AND owner IN (?, ?)")
    .bind(DAY, EXTERNAL, ACCOUNT).first()).toEqual({ n: 3 });
});

it("handles linking between document and daily reservations without quota reset", async () => {
  const pending = doc(EXTERNAL);
  expect(await insertDocWithinQuota(env.DB, pending, 1)).toBe(true);
  expect(await reserveDailyPush(env.DB, ACCOUNT, DAY, 1)).toBe(true);
  await link();
  expect(await reserveDailyPush(env.DB, EXTERNAL, DAY, 1)).toBe(false);
  expect(await insertDocWithinQuota(env.DB, doc(ACCOUNT), 1)).toBe(false);
});

it("keeps URLs, versions, active tokens, and legacy key access without token administration", async () => {
  const legacy = await publish(KEY);
  const native = await publish(token);
  const original = await env.DOCS.get(`docs/${legacy.docId}/v1.html`);
  const originalBytes = await original!.text();
  await link();
  for (const credential of [KEY, SECOND_KEY, token]) {
    const response = await send("GET", "/api/v1/docs", credential);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(legacy.docId);
    expect(text).toContain(native.docId);
  }
  const update = await send("PUT", `/api/v1/docs/${legacy.docId}`, token, { html: "<!doctype html><html><body>Updated</body></html>" });
  expect(update.status).toBe(200);
  expect(await update.json()).toMatchObject({ docId: legacy.docId, url: legacy.url, version: 2 });
  expect(await (await env.DOCS.get(`docs/${legacy.docId}/v1.html`))!.text()).toBe(originalBytes);
  expect(await (await send("GET", "/api/v1/tokens", KEY)).json()).toEqual({ tokens: [] });
  expect((await send("DELETE", `/api/v1/tokens/${tokenId}`, KEY)).status).toBe(404);
  expect((await send("GET", "/api/v1/tokens", token)).status).toBe(200);
  expect((await send("DELETE", `/api/v1/docs/${native.docId}`, SECOND_KEY)).status).toBe(204);
  expect((await send("GET", `/d/${native.docId}`, token)).status).toBe(410);
});
