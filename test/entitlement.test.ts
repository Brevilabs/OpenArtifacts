import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { accountPlan } from "../src/entitlement.js";
import { findOrCreateAccount } from "../src/db.js";
import { linkExternalOwner } from "../src/owners.js";
import { sha256Hex } from "../src/hash.js";
import { newApiToken, newTokenId } from "../src/ids.js";
import worker from "../src/index.js";
const OWNER = "oa_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "oa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const NOW = 10_000_000;
const remote = () => ({ ...env, LICENSE_API_URL: "https://license.example.test", LICENSE_API_KEY: "service-only" });
const answer = (plan: "default" | "plus", expiresAt: number | null) => Response.json({ result: { data: { json: { plan, expiresAt } } } });
const stored = () => env.DB.prepare("SELECT plan, plan_expires_at AS expiresAt, plan_checked_at AS checkedAt FROM accounts WHERE id = ?").bind(OWNER).first();
const seed = (plan: string, expiry: number | null, checked: number | null) => env.DB.prepare("UPDATE accounts SET plan = ?, plan_expires_at = ?, plan_checked_at = ? WHERE id = ?").bind(plan, expiry, checked, OWNER).run();
let token: string;
beforeEach(async () => {
  await findOrCreateAccount(env.DB, OWNER, "owner@example.test", NOW);
  token = newApiToken();
  await env.DB.prepare("INSERT INTO tokens (id, token_hash, account_id, created_at) VALUES (?, ?, ?, ?)").bind(newTokenId(), await sha256Hex(token), OWNER, NOW).run();
});
async function request(method: string, path: string, body?: unknown, credential = token) {
  const ctx = createExecutionContext();
  const result = await worker.fetch(new Request(`https://local.test${path}`, {
    method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { ...remote(), ADMIN_API_KEY: "admin", SERVING_HOST: "", API_HOST: "", LEGACY_SERVING_HOST: "", RETIRED_API_HOST: "" }, ctx);
  await waitOnExecutionContext(ctx); return result;
}

it("new free accounts publish without a remote request; stale cache pulls only Worker identity", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(_url).toBe("https://license.example.test/api/trpc/license.openArtifactsEntitlement");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer service-only");
    expect(JSON.parse(init!.body as string)).toEqual({ json: { accountId: OWNER } });
    return answer("plus", NOW + 9_000_000);
  });
  expect(await accountPlan(remote(), OWNER, { now: () => NOW, fetch: fetcher })).toEqual({ plan: "free", status: "cached" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await accountPlan(remote(), OWNER, { now: () => NOW + 3_600_000, fetch: fetcher })).toEqual({ plan: "pro", status: "refreshed" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await stored()).toEqual({ plan: "pro", expiresAt: NOW + 9_000_000, checkedAt: NOW + 3_600_000 });
});

it("forced account refresh reports success/outage and management never calls remote", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer("plus", NOW + 1000));
  try {
    expect((await request("POST", "/api/v1/docs", { html: "<p>free</p>" })).status).toBe(201);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await (await request("GET", "/api/v1/account")).json()).toMatchObject({ plan: "pro", refresh: { status: "refreshed", expiresAt: NOW + 1000 } });
    fetcher.mockRejectedValue(new Error("outage"));
    expect(await (await request("GET", "/api/v1/account")).json()).toMatchObject({ plan: "pro", refresh: { status: "unavailable" } });
    clock.mockReturnValue(NOW + 2000);
    expect(await (await request("GET", "/api/v1/account")).json()).toMatchObject({ plan: "free", refresh: { status: "unavailable" } });
    fetcher.mockClear();
    const list = await request("GET", "/api/v1/docs");
    const body = await list.json<{ docs: { docId: string }[] }>();
    expect((await request("DELETE", `/api/v1/docs/${body.docs[0]!.docId}`)).status).toBe(204);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await request("POST", "/api/v1/docs", { html: "<p>still free during outage</p>" })).status).toBe(201);
  } finally { fetcher.mockRestore(); clock.mockRestore(); }
});

it("paid expiry forces refresh even within TTL; lifetime refreshes by TTL and outages retain only unexpired access", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => answer("plus", NOW + 5000));
  await seed("pro", NOW, NOW - 1);
  expect((await accountPlan(remote(), OWNER, { now: () => NOW, fetch: fetcher })).plan).toBe("pro");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await seed("pro", null, NOW - 3_600_000);
  fetcher.mockRejectedValue(new Error("outage"));
  expect(await accountPlan(remote(), OWNER, { now: () => NOW, fetch: fetcher })).toEqual({ plan: "pro", status: "unavailable" });
  await seed("pro", NOW - 1, NOW - 1);
  expect((await accountPlan(remote(), OWNER, { now: () => NOW, fetch: fetcher })).plan).toBe("free");
  expect(await stored()).toEqual({ plan: "pro", expiresAt: NOW - 1, checkedAt: NOW - 1 });
});

it("newer concurrent refresh wins, including the result returned by the older request", async () => {
  await seed("free", null, null);
  let release!: (r: Response) => void, started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const first = accountPlan(remote(), OWNER, { now: () => NOW, forceAccountRefresh: true, fetch: async () => { started(); return await new Promise<Response>(r => { release = r; }); } });
  await ready;
  expect(await accountPlan(remote(), OWNER, { now: () => NOW + 1, fetch: async () => answer("default", null) })).toEqual({ plan: "free", status: "refreshed" });
  release(answer("plus", null));
  expect(await first).toEqual({ plan: "free", status: "cached" });
  expect(await stored()).toEqual({ plan: "free", expiresAt: null, checkedAt: NOW + 1 });
});

it("manual assignment and a new link each invalidate an older in-flight response", async () => {
  for (const linking of [false, true]) {
    await seed("free", null, NOW);
    let release!: (r: Response) => void, started!: () => void;
    const ready = new Promise<void>(r => { started = r; });
    const first = accountPlan(remote(), OWNER, { now: () => NOW, forceAccountRefresh: true, fetch: async () => { started(); return await new Promise<Response>(r => { release = r; }); } });
    await ready;
    if (linking) {
      expect(await linkExternalOwner(env.DB, "external", OWNER, NOW)).toBe("linked");
    } else {
      const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
      try { expect((await request("PUT", `/admin/v1/accounts/${OWNER}/plan`, { plan: "free" }, "admin")).status).toBe(200); }
      finally { clock.mockRestore(); }
    }
    release(answer("plus", null));
    expect(await first).toEqual({ plan: "free", status: "cached" });
  }
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(JSON.parse(init!.body as string)).toEqual({ json: { accountId: OWNER, externalOwner: "external" } });
    return answer("plus", null);
  });
  expect((await accountPlan(remote(), OWNER, { now: () => NOW + 1, fetch: fetcher })).plan).toBe("pro");
  expect(await stored()).toEqual({ plan: "pro", expiresAt: null, checkedAt: NOW + 1 });
});

it("unavailable or malformed responses preserve snapshots and self-hosted default configuration", async () => {
  for (const json of [null, {}, { plan: "unknown", expiresAt: null }, { plan: "plus", expiresAt: -1 }, { plan: "plus", expiresAt: "tomorrow" }, { plan: "plus" }]) {
    expect(await accountPlan(remote(), OWNER, { now: () => NOW, forceAccountRefresh: true, fetch: async () => Response.json({ result: { data: { json } } }) })).toEqual({ plan: "free", status: "unavailable" });
  }
  const custom = { ...env, DEFAULT_PLAN: "trial", PLAN_LIMITS: '{"trial":{"documents":2,"pushesPerDay":3,"htmlBytes":1024}}' };
  await seed("trial", null, NOW);
  expect(await accountPlan(custom, OWNER, { forceAccountRefresh: true })).toEqual({ plan: "trial", status: "unavailable" });
  expect(await stored()).toEqual({ plan: "trial", expiresAt: null, checkedAt: NOW });
  const columns = (await env.DB.prepare("PRAGMA table_info(accounts)").all<{ name: string }>()).results.map(r => r.name);
  expect(columns).toContain("plan_checked_at"); expect(columns).not.toContain("plan_revision");
  const handoff = (await env.DB.prepare("PRAGMA table_info(account_handoffs)").all<{ name: string }>()).results.map(r => r.name);
  expect(handoff).not.toContain("purpose");
  await findOrCreateAccount(env.DB, OTHER, "other@example.test", NOW);
  expect(await linkExternalOwner(env.DB, "external", OTHER, NOW)).toBe("linked");
  expect((await env.DB.prepare("SELECT plan_checked_at FROM accounts WHERE id = ?").bind(OTHER).first())).toEqual({ plan_checked_at: null });
});
