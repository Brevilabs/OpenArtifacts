import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import { sha256Hex } from "../src/hash.js";
import { newApiToken, newTokenId } from "../src/ids.js";
import worker from "../src/index.js";

const ACCOUNT = "oa_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "oa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const SERVICE = "test-service-secret";
const EXTERNAL = "external-account";
let token: string;
let tokenId: string;
let otherToken: string;
const defaults = { ADMIN_API_KEY: SERVICE, ACCOUNT_ACTION_URL: "https://actions.example.test/continue" };

beforeEach(async () => {
  for (const id of [ACCOUNT, OTHER]) {
    await env.DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)")
      .bind(id, `${id}@example.test`).run();
  }
  token = newApiToken(); tokenId = newTokenId(); otherToken = newApiToken();
  for (const [id, value, account] of [[tokenId, token, ACCOUNT], [newTokenId(), otherToken, OTHER]]) {
    await env.DB.prepare("INSERT INTO tokens (id, token_hash, account_id, created_at) VALUES (?, ?, ?, 0)")
      .bind(id, await sha256Hex(value!), account).run();
  }
});

async function send(method: string, path: string, credential: string, body?: unknown, overrides: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://api.local.test${path}`, {
    method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { ...env, ...defaults, SERVING_HOST: "", API_HOST: "", LEGACY_SERVING_HOST: "", RETIRED_API_HOST: "", ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const consume = (code: string, credential = SERVICE) => send("POST", "/admin/v1/handoffs/consume", credential, { code });
const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM account_handoffs").first<{ n: number }>())!.n;
async function mint(purpose = "upgrade", credential = token) {
  const response = await send("POST", "/api/v1/account/handoffs", credential, { purpose });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const result = await response.json() as { url: string; expiresAt: number };
  return { ...result, code: new URL(result.url).searchParams.get("code")! };
}

it("reports account plan, limits, combined usage and association without revealing external identity", async () => {
  expect((await send("PUT", `/admin/v1/accounts/${ACCOUNT}/external-owner`, SERVICE, { externalOwner: EXTERNAL })).status).toBe(200);
  for (const owner of [ACCOUNT, EXTERNAL]) {
    await env.DB.prepare("INSERT INTO docs (id, owner, title, created_at, updated_at) VALUES (?, ?, '', 0, 0)").bind(owner, owner).run();
    await env.DB.prepare("INSERT INTO push_quota (owner, day, pushes) VALUES (?, ?, 2)").bind(owner, new Date().toISOString().slice(0, 10)).run();
  }
  const response = await send("GET", "/api/v1/account", token);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accountId: ACCOUNT, plan: "free", limits: { documents: 3, pushesPerDay: 6, htmlBytes: 1048576 }, usage: { documents: 2, pushesToday: 4 }, externalLinked: true });
  const other = await (await send("GET", "/api/v1/account", otherToken)).json();
  expect(other).toMatchObject({ accountId: OTHER, usage: { documents: 0, pushesToday: 0 }, externalLinked: false });
});

it("preserves each purpose, consumes once, stores only hashes and returns linked identity to the service", async () => {
  await send("PUT", `/admin/v1/accounts/${ACCOUNT}/external-owner`, SERVICE, { externalOwner: EXTERNAL });
  for (const purpose of ["upgrade", "billing", "link"]) {
    const before = Date.now();
    const handoff = await mint(purpose);
    expect(handoff.expiresAt).toBeGreaterThanOrEqual(before + 600000);
    expect(handoff.expiresAt).toBeLessThanOrEqual(Date.now() + 600000);
    const stored = await env.DB.prepare("SELECT * FROM account_handoffs").all();
    expect(JSON.stringify(stored)).not.toContain(handoff.code);
    expect(JSON.stringify(stored)).not.toContain(token);
    const response = await consume(handoff.code);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ accountId: ACCOUNT, email: `${ACCOUNT}@example.test`, purpose, externalOwner: EXTERNAL });
    expect((await consume(handoff.code)).status).toBe(404);
  }
});

it("allows one concurrent consumption and at most five concurrent outstanding actions per account", async () => {
  const attempts = await Promise.all(Array.from({ length: 8 }, () => send("POST", "/api/v1/account/handoffs", token, { purpose: "link" })));
  expect(attempts.filter((r) => r.status === 200)).toHaveLength(5);
  expect(attempts.filter((r) => r.status === 429)).toHaveLength(3);
  const body = await attempts.find((r) => r.status === 200)!.json() as { url: string };
  const code = new URL(body.url).searchParams.get("code")!;
  expect((await Promise.all([consume(code), consume(code)])).map((r) => r.status).sort()).toEqual([200, 404]);
  expect(await count()).toBe(4);
  await mint("billing", otherToken);
  expect(await count()).toBe(5);
});

it("refuses expired and revoked originating credentials and clears only the owner's expired actions", async () => {
  const expired = await mint();
  await env.DB.prepare("UPDATE account_handoffs SET expires_at = 0").run();
  expect((await consume(expired.code)).status).toBe(404);
  await mint("link", otherToken);
  const revoked = await mint();
  expect(await count()).toBe(2);
  await env.DB.prepare("DELETE FROM tokens WHERE id = ?").bind(tokenId).run();
  expect((await consume(revoked.code)).status).toBe(404);
  expect((await send("POST", "/api/v1/account/handoffs", token, { purpose: "billing" })).status).toBe(401);
});

it("requires the service credential and does not consume proof on an unauthorized request", async () => {
  const handoff = await mint();
  for (const credential of [token, otherToken, "wrong"]) expect((await consume(handoff.code, credential)).status).toBe(401);
  expect(await count()).toBe(1);
  expect((await consume(handoff.code)).status).toBe(200);
});

it("rejects extra fields, forged purposes, oversized input and malformed codes", async () => {
  for (const body of [{ purpose: "delete" }, { purpose: "link", accountId: OTHER }, { purpose: 1 }, [], null, { purpose: "x".repeat(2000) }]) {
    expect((await send("POST", "/api/v1/account/handoffs", token, body)).status).toBe(400);
  }
  for (const body of [{ code: "x" }, { code: "a".repeat(64), purpose: "link" }, { code: 1 }]) {
    expect((await send("POST", "/admin/v1/handoffs/consume", SERVICE, body)).status).toBe(400);
  }
  expect(await count()).toBe(0);
});

it("fails closed before writing for unconfigured or unsafe action destinations", async () => {
  for (const [url, status] of [["", 404], ["http://evil.test/path", 500], ["https://user:pass@example.test", 500], ["https://example.test/#fragment", 500], ["javascript:alert(1)", 500]] as const) {
    expect((await send("POST", "/api/v1/account/handoffs", token, { purpose: "link" }, { ACCOUNT_ACTION_URL: url })).status).toBe(status);
  }
  expect(await count()).toBe(0);
  const local = await send("POST", "/api/v1/account/handoffs", token, { purpose: "link" }, { ACCOUNT_ACTION_URL: "http://localhost:3000/action" });
  expect(local.status).toBe(200);
});

it("requires OAuth credentials and confines service routes to the API host", async () => {
  const key = "license-test-key";
  await env.DB.prepare("INSERT INTO publishers (key_hash, owner, plan, validated_at) VALUES (?, ?, 'plus', ?)").bind(await sha256Hex(key), EXTERNAL, Date.now()).run();
  expect((await send("GET", "/api/v1/account", key)).status).toBe(401);
  expect((await send("POST", "/api/v1/account/handoffs", key, { purpose: "link" })).status).toBe(401);
  expect((await send("POST", "/admin/v1/handoffs/consume", SERVICE, { code: "a".repeat(64) }, { API_HOST: "other.test", SERVING_HOST: "api.local.test" })).status).toBe(404);
});

it("associates only through service authorization, repeats safely, rejects conflicting pairs", async () => {
  const path = `/admin/v1/accounts/${ACCOUNT}/external-owner`;
  expect((await send("PUT", path, token, { externalOwner: EXTERNAL })).status).toBe(401);
  for (let n = 0; n < 2; n++) expect((await send("PUT", path, SERVICE, { externalOwner: EXTERNAL })).status).toBe(200);
  expect((await send("PUT", path, SERVICE, { externalOwner: "other-external" })).status).toBe(409);
  expect((await send("PUT", `/admin/v1/accounts/${OTHER}/external-owner`, SERVICE, { externalOwner: EXTERNAL })).status).toBe(409);
  expect((await send("PUT", path, SERVICE, { externalOwner: ACCOUNT })).status).toBe(400);
  expect((await send("PUT", path, SERVICE, { externalOwner: EXTERNAL, plan: "pro" })).status).toBe(400);
});
