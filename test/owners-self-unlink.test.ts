import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../src/config.js";
import { newApiToken, newTokenId } from "../src/ids.js";
import { sha256Hex } from "../src/hash.js";
import worker from "../src/index.js";
import { SELF_UNLINK_COOLDOWN_MS, unlinkExternalOwner } from "../src/owners.js";

// The account page (app-sites) calls `/self` with the account and license from
// the signed-in session, over the admin service credential.
const SERVICE = "owner-self-unlink-test-secret";
const LICENSE = "copilot-license-owner";
const WRONG = "oa_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const RIGHT = "oa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const STRANGER = "oa_cccccccccccccccccccccccccc";
const DAY = 24 * 60 * 60 * 1000;

async function send(method: string, path: string, body?: unknown, credential: string | null = SERVICE) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://api.local.test${path}`, {
      method,
      headers: {
        ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...env, ADMIN_API_KEY: SERVICE, SERVING_HOST: "", API_HOST: "", LEGACY_SERVING_HOST: "", RETIRED_API_HOST: "" } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
const selfUnlink = (accountId: string, externalOwner = LICENSE, credential: string | null = SERVICE) =>
  send("DELETE", `/admin/v1/accounts/${accountId}/external-owner/self`, { externalOwner }, credential);
const adminUnlink = (accountId: string, externalOwner = LICENSE) =>
  send("DELETE", `/admin/v1/accounts/${accountId}/external-owner`, { externalOwner });
const link = (accountId: string, externalOwner = LICENSE) =>
  send("PUT", `/admin/v1/accounts/${accountId}/external-owner`, { externalOwner });
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const linkOf = (accountId: string) =>
  env.DB.prepare("SELECT external_owner FROM owner_links WHERE account_id = ?").bind(accountId).first();
const audit = () =>
  env.DB.prepare(
    "SELECT external_owner, account_id, linked_at, unlinked_at, by_owner FROM owner_unlinks ORDER BY unlinked_at, rowid",
  ).all().then((r) => r.results);
const planState = (accountId: string) =>
  env.DB.prepare("SELECT plan, plan_expires_at, plan_checked_at, plan_retry_after FROM accounts WHERE id = ?")
    .bind(accountId).first();

async function accounts() {
  for (const id of [WRONG, RIGHT, STRANGER]) {
    await env.DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)")
      .bind(id, `${id}@example.com`).run();
  }
  // The license is linked to the wrong account, which holds the paid plan it brought.
  await env.DB.prepare("INSERT INTO owner_links (external_owner, account_id, created_at) VALUES (?, ?, 1234)")
    .bind(LICENSE, WRONG).run();
  await env.DB.prepare(
    "UPDATE accounts SET plan = 'pro', plan_expires_at = 9000000000000, plan_checked_at = 5, plan_retry_after = 6 WHERE id = ?",
  ).bind(WRONG).run();
}
async function tokenFor(accountId: string) {
  const token = newApiToken();
  await env.DB.prepare("INSERT INTO tokens (id, token_hash, account_id, created_at) VALUES (?, ?, ?, 0)")
    .bind(newTokenId(), await sha256Hex(token), accountId).run();
  return token;
}

it("lets the account holder unlink their own license, records it, ends the linked plan and allows a relink elsewhere", async () => {
  await accounts();
  const before = Date.now();
  const result = await selfUnlink(WRONG);
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual({ accountId: WRONG, externalOwner: LICENSE });
  expect(await linkOf(WRONG)).toBeNull();

  const rows = await audit();
  expect(rows).toEqual([
    { external_owner: LICENSE, account_id: WRONG, linked_at: 1234, unlinked_at: expect.any(Number), by_owner: 1 },
  ]);
  expect(rows[0]!.unlinked_at as number).toBeGreaterThanOrEqual(before);

  // The plan cache is cleared, so the paid plan that came through the link ends now.
  expect(await planState(WRONG)).toEqual({ plan: "pro", plan_expires_at: 0, plan_checked_at: null, plan_retry_after: null });
  const snapshot = await send("GET", "/api/v1/account", undefined, await tokenFor(WRONG));
  expect(await snapshot.json()).toMatchObject({ plan: "free", externalLinked: false });

  // The existing link flow now links the license to the right account.
  expect((await link(RIGHT)).status).toBe(200);
  expect(await linkOf(RIGHT)).toEqual({ external_owner: LICENSE });
});

it("refuses another self-serve unlink of the same license or account for 24 hours", async () => {
  await accounts();
  expect((await selfUnlink(WRONG)).status).toBe(200);
  const first = ((await audit())[0] as { unlinked_at: number }).unlinked_at;
  expect((await link(RIGHT)).status).toBe(200);

  // The limit is 24 hours: enough to stop a license hopping between accounts.
  expect(SELF_UNLINK_COOLDOWN_MS).toBe(DAY);
  // Same license, other account: refused, with the time it is next allowed.
  const refused = await selfUnlink(RIGHT);
  expect(refused.status).toBe(429);
  expect(refused.headers.get("cache-control")).toBe("no-store");
  const body = await refused.json<{ error: { code: string; message: string; retry_at: number } }>();
  expect(body.error).toMatchObject({ code: "quota_exceeded", retry_at: first + SELF_UNLINK_COOLDOWN_MS });
  expect(body.error.message).toContain(new Date(first + SELF_UNLINK_COOLDOWN_MS).toISOString());
  expect(body.error.message).toContain("support");
  expect(body.error.message).not.toMatch(/30 days/);
  expect(await linkOf(RIGHT)).toEqual({ external_owner: LICENSE });

  // Same account, another license: refused too.
  expect((await link(WRONG, "second-license")).status).toBe(200);
  expect((await selfUnlink(WRONG, "second-license")).status).toBe(429);
  expect(await linkOf(WRONG)).toEqual({ external_owner: "second-license" });
  expect(await count("owner_unlinks")).toBe(1);

  // Support can still unlink; the admin route ignores the cooldown and is recorded as admin.
  expect((await adminUnlink(RIGHT)).status).toBe(200);
  expect((await audit()).map((r) => r.by_owner)).toEqual([1, 0]);
});

it("allows a self-serve unlink once the cooldown has passed, and does not count admin unlinks", async () => {
  await accounts();
  const now = 100 * DAY;
  // An admin unlink a minute ago does not start a cooldown.
  await env.DB.prepare("INSERT INTO owner_unlinks VALUES (?, ?, 0, ?, 0)").bind(LICENSE, STRANGER, now - 60_000).run();
  // A self-serve unlink exactly at the edge of the window still blocks; one just past it does not.
  await env.DB.prepare("INSERT INTO owner_unlinks VALUES (?, ?, 0, ?, 1)").bind(LICENSE, STRANGER, now - SELF_UNLINK_COOLDOWN_MS + 1).run();
  expect(await unlinkExternalOwner(env.DB, LICENSE, WRONG, { byOwner: true, now }))
    .toEqual({ result: "cooldown", retryAt: now + 1 });
  expect(await unlinkExternalOwner(env.DB, LICENSE, WRONG, { byOwner: true, now: now + 1 }))
    .toEqual({ result: "unlinked" });
});

it("rejects a pair that is not the account's own link, and unauthenticated callers, without writing", async () => {
  await accounts();
  const before = await planState(WRONG);
  // Another account naming this license, or this account naming another license.
  for (const [accountId, owner] of [[STRANGER, LICENSE], [WRONG, "someone-else"], [RIGHT, LICENSE]] as const) {
    const response = await selfUnlink(accountId, owner);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  }
  for (const credential of [null, "wrong", await tokenFor(WRONG)]) {
    const response = await selfUnlink(WRONG, LICENSE, credential);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  }
  expect((await selfUnlink(WRONG, "oa_reserved")).status).toBe(400);
  expect((await send("DELETE", `/admin/v1/accounts/${WRONG}/external-owner/self`, {})).status).toBe(400);
  expect(await linkOf(WRONG)).toEqual({ external_owner: LICENSE });
  expect(await planState(WRONG)).toEqual(before);
  expect(await count("owner_unlinks")).toBe(0);
});

it("writes nothing when the last statement of the unlink fails", async () => {
  await accounts();
  const before = await planState(WRONG);
  await env.DB.prepare(
    `CREATE TRIGGER test_plan_failure BEFORE UPDATE ON accounts
    BEGIN SELECT RAISE(ABORT, 'forced plan failure'); END`,
  ).run();
  expect((await selfUnlink(WRONG)).status).toBe(500);
  expect(await linkOf(WRONG)).toEqual({ external_owner: LICENSE });
  expect(await count("owner_unlinks")).toBe(0);
  expect(await planState(WRONG)).toEqual(before);
});
