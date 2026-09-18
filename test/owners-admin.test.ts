import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../src/config.js";
import { newApiToken, newTokenId } from "../src/ids.js";
import { sha256Hex } from "../src/hash.js";
import worker from "../src/index.js";

const SERVICE = "owner-admin-test-secret";
const input = { email: " Person@Example.com ", externalOwner: "external-owner" };
async function send(method: string, path: string, body?: unknown, credential = SERVICE) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://api.local.test${path}`, {
      method,
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      ...env,
      ADMIN_API_KEY: SERVICE,
      SERVING_HOST: "",
      API_HOST: "",
      LEGACY_SERVING_HOST: "",
      RETIRED_API_HOST: "",
    } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
const create = (body: unknown = input) => send("POST", "/admin/v1/accounts", body);
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
async function account() {
  const result = await create();
  expect(result.status).toBe(201);
  return result.json<{ accountId: string; email: string }>();
}
async function tokenFor(accountId: string) {
  const token = newApiToken();
  await env.DB.prepare(
    "INSERT INTO tokens (id, token_hash, account_id, created_at) VALUES (?, ?, ?, 0)",
  )
    .bind(newTokenId(), await sha256Hex(token), accountId)
    .run();
  return token;
}

it("creates and looks up a linked account with no newsletter choice and immediate entitlement refresh", async () => {
  const created = await account();
  expect(created.email).toBe("person@example.com");
  const result = await send("GET", "/admin/v1/external-owners/external-owner");
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual(created);
  const stored = await env.DB.prepare(
    "SELECT newsletter_opt_in, plan_checked_at FROM accounts WHERE id = ?",
  )
    .bind(created.accountId)
    .first();
  expect(stored).toEqual({ newsletter_opt_in: null, plan_checked_at: null });
  const snapshot = await send(
    "GET",
    "/api/v1/account",
    undefined,
    await tokenFor(created.accountId),
  );
  expect(await snapshot.json()).toMatchObject({
    externalLinked: true,
    refresh: { checkedAt: null },
  });
});

it("returns explicit missing and invalid owner errors and requires admin authentication", async () => {
  expect((await send("GET", "/admin/v1/external-owners/missing")).status).toBe(404);
  for (const owner of ["oa_reserved", "%20owner", "owner%20", "owner%00", "%FF", "x".repeat(257)]) {
    const response = await send("GET", `/admin/v1/external-owners/${owner}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
  }
  for (const [method, path, body] of [
    ["GET", "/admin/v1/external-owners/missing", undefined],
    ["POST", "/admin/v1/accounts", input],
  ] as const) {
    const response = await send(method, path, body, "wrong");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  }
});

it("rejects malformed account bodies without inserting anything", async () => {
  for (const body of [
    null,
    [],
    {},
    { ...input, extra: true },
    { ...input, email: "invalid" },
    { ...input, email: "x".repeat(2000) },
    { ...input, externalOwner: "oa_reserved" },
    { ...input, externalOwner: "x y" },
  ]) {
    const response = await create(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
  }
  expect(await count("accounts")).toBe(0);
  expect(await count("owner_links")).toBe(0);
});

it("refuses duplicate or taken owners without new accounts", async () => {
  const original = await account();
  for (const body of [input, { ...input, email: "different@example.com" }]) {
    const result = await create(body);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: { code: "conflict" } });
  }
  expect(await count("accounts")).toBe(1);
  expect(await count("owner_links")).toBe(1);
  expect(await (await send("GET", "/admin/v1/external-owners/external-owner")).json()).toEqual(
    original,
  );
});

it("refuses an existing email without associating its account", async () => {
  await env.DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)")
    .bind("oa_aaaaaaaaaaaaaaaaaaaaaaaaaa", "person@example.com")
    .run();
  const response = await create();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "email_taken" } });
  expect(await count("accounts")).toBe(1);
  expect(await count("owner_links")).toBe(0);
});

it("concurrent identical creation produces one account and one link", async () => {
  const responses = await Promise.all([create(), create()]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(await responses.find((r) => r.status === 409)!.json()).toMatchObject({
    error: { code: "conflict" },
  });
  expect(await count("accounts")).toBe(1);
  expect(await count("owner_links")).toBe(1);
});

it("concurrent requests sharing an owner or email leave no orphan accounts", async () => {
  const ownerRace = await Promise.all([create(), create({ ...input, email: "other@example.com" })]);
  expect(ownerRace.map((r) => r.status).sort()).toEqual([201, 409]);
  const email = (await ownerRace.find((r) => r.status === 201)!.json<{ email: string }>()).email;
  const emailRace = await create({ email, externalOwner: "another-owner" });
  expect(await emailRace.json()).toMatchObject({ error: { code: "email_taken" } });
  expect(await count("accounts")).toBe(1);
  expect(await count("owner_links")).toBe(1);
});

it("rolls back account creation if the association insert fails", async () => {
  await env.DB.prepare(
    `CREATE TRIGGER test_owner_failure BEFORE INSERT ON owner_links
    BEGIN SELECT RAISE(ABORT, 'forced owner insert failure'); END`,
  ).run();
  const response = await create();
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: "internal" } });
  expect(await count("accounts")).toBe(0);
  expect(await count("owner_links")).toBe(0);
});

it("has no Copilot proof API", async () => {
  const created = await account();
  const result = await send("POST", "/api/v1/copilot/prove", {}, await tokenFor(created.accountId));
  expect(result.status).toBe(404);
  expect(await result.json()).toMatchObject({ error: { code: "not_found" } });
});
