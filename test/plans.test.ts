import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config.js";
import { MAX_DOC_BYTES } from "../src/config.js";
import { findOrCreateAccount, resolveAccountForIdentity } from "../src/db.js";
import { sha256Hex } from "../src/hash.js";
import { newApiToken, newTokenId } from "../src/ids.js";
import worker from "../src/index.js";
import { defaultPlan, planLimits } from "../src/plans.js";
import { utcDay } from "../src/quota.js";

const OWNER = "oa_plan_test";
const ADMIN = "test-service-secret";
let token: string;
const local = (overrides: Partial<Env> = {}): Env => ({
  ...env, SERVING_HOST: "", API_HOST: "", LEGACY_SERVING_HOST: "", RETIRED_API_HOST: "",
  ADMIN_API_KEY: ADMIN, ...overrides,
});
async function issue(owner = OWNER) {
  const value = newApiToken();
  await env.DB.prepare("INSERT INTO tokens (id, token_hash, account_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(newTokenId(), await sha256Hex(value), owner, Date.now()).run();
  return value;
}
async function send(method: string, path: string, body?: unknown, overrides: Partial<Env> = {}, credential = token, origin = "https://local.test") {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${origin}${path}`, {
    method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), local(overrides), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const create = (html = "<p>one</p>", overrides: Partial<Env> = {}, credential = token) => send("POST", "/api/v1/docs", { html }, overrides, credential);
const setPlan = (plan: string, owner = OWNER, overrides: Partial<Env> = {}, credential = ADMIN) => send("PUT", `/admin/v1/accounts/${owner}/plan`, { plan }, overrides, credential);
const usage = async () => (await env.DB.prepare("SELECT pushes FROM push_quota WHERE owner = ? AND day = ?").bind(OWNER, utcDay(Date.now())).first<{ pushes: number }>())?.pushes ?? 0;
const error = (response: Response) => response.json<{ error: { code: string; limit?: string; plan?: string; upgrade_url?: string } }>();
beforeEach(async () => {
  await findOrCreateAccount(env.DB, OWNER, "plans@example.test", Date.now());
  token = await issue();
});

describe("configured account plans", () => {
  it("migrates an existing account without changing its token, email or document", async () => {
    const doc = await (await create()).json<{ docId: string }>();
    const before = await env.DB.prepare("SELECT id, email, created_at FROM accounts WHERE id = ?").bind(OWNER).first();
    // Recreate the immediately preceding schema, then apply the actual committed migration.
    await env.DB.prepare("ALTER TABLE accounts DROP COLUMN plan").run();
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name === "0005_account_plans.sql")!;
    for (const query of migration.queries) await env.DB.prepare(query).run();
    expect(await env.DB.prepare("SELECT id, email, created_at FROM accounts WHERE id = ?").bind(OWNER).first()).toEqual(before);
    expect(await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(OWNER).first()).toEqual({ plan: "free" });
    expect((await send("PUT", `/api/v1/docs/${doc.docId}`, { html: "after migration" })).status).toBe(200);
  });

  it("loads the agreed hosted values from wrangler, not a separate test copy", () => {
    expect(planLimits(local(), "free")).toEqual({ documents: 3, pushesPerDay: 6, htmlBytes: 1048576 });
    expect(planLimits(local(), "pro")).toEqual({ documents: 500, pushesPerDay: 100, htmlBytes: 10485760 });
    for (const PLAN_LIMITS of [undefined, ""]) {
      expect(planLimits(local({ PLAN_LIMITS }), "free")).toEqual(planLimits(local(), "free"));
    }
  });

  it("assigns the configured default once and never resets a returning account", async () => {
    const config = local({ DEFAULT_PLAN: "pro" });
    const account = await resolveAccountForIdentity(env.DB, "google", "first", "new@example.test", "oa_new", Date.now(), defaultPlan(config));
    expect(await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(account!.id).first()).toEqual({ plan: "pro" });
    await resolveAccountForIdentity(env.DB, "google", "first", "new@example.test", "oa_unused", Date.now(), "free");
    expect(await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(account!.id).first()).toEqual({ plan: "pro" });
    expect(await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(OWNER).first()).toEqual({ plan: "free" });
  });

  it("shares six successful creates and updates across tokens, rolling over in UTC", async () => {
    const other = await issue();
    const doc = await (await create()).json<{ docId: string }>();
    for (let i = 0; i < 5; i++) expect((await send("PUT", `/api/v1/docs/${doc.docId}`, { html: "updated" }, {}, other)).status).toBe(200);
    const rejected = await create();
    expect(rejected.status).toBe(402);
    expect(await error(rejected)).toMatchObject({ error: { limit: "pushesPerDay", plan: "free" } });
    expect(await usage()).toBe(6);
    expect((await send("DELETE", `/api/v1/docs/${doc.docId}`)).status).toBe(204);
    expect((await create()).status).toBe(402);
    expect(await usage()).toBe(6);
    const tomorrow = Date.now() + 86400000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(tomorrow);
    try { expect((await create()).status).toBe(201); } finally { clock.mockRestore(); }
  });

  it("atomically awards the last daily push across two token updates", async () => {
    const doc = await (await create()).json<{ docId: string }>();
    await env.DB.prepare("UPDATE push_quota SET pushes = 5 WHERE owner = ?").bind(OWNER).run();
    const other = await issue();
    const responses = await Promise.all([token, other].map((key) => send("PUT", `/api/v1/docs/${doc.docId}`, { html: "updated" }, {}, key)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 402]);
    expect(await usage()).toBe(6);
  });

  it("checks UTF-8 HTML bytes on create and update without spending rejected attempts", async () => {
    const html = "é".repeat(524288);
    const doc = await (await create(html)).json<{ docId: string }>();
    for (const response of [await create(`${html}x`), await send("PUT", `/api/v1/docs/${doc.docId}`, { html: `${html}x` })]) {
      expect(response.status).toBe(402);
      expect(await error(response)).toMatchObject({ error: { limit: "htmlBytes" } });
    }
    expect((await create("")).status).toBe(400);
    expect((await send("PUT", "/api/v1/docs/0123456789abcdef", { html: "x" })).status).toBe(404);
    expect(await usage()).toBe(1);
  });

  it("upgrades existing tokens immediately and downgrades without removing or locking documents", async () => {
    const doc = await (await create()).json<{ docId: string }>();
    expect((await setPlan("pro")).status).toBe(200);
    let largeId = "";
    for (let i = 0; i < 3; i++) {
      const created = await create("x".repeat(1048577));
      expect(created.status).toBe(201);
      largeId = (await created.json<{ docId: string }>()).docId;
    }
    expect((await setPlan("free")).status).toBe(200);
    const large = await send("GET", `/d/${largeId}`);
    expect(large.status).toBe(200);
    expect((await large.text()).length).toBeGreaterThan(1048576);
    expect((await create()).status).toBe(402);
    expect((await send("GET", `/d/${doc.docId}`)).status).toBe(200);
    expect((await send("PUT", `/api/v1/docs/${doc.docId}`, { html: "small update" })).status).toBe(200);
    expect((await send("GET", "/api/v1/docs")).status).toBe(200);
    expect((await send("DELETE", `/api/v1/docs/${doc.docId}`)).status).toBe(204);
    expect((await create()).status).toBe(402); // Three live docs still fill the downgraded cap.
    expect(await usage()).toBe(5);
  });

  it("returns an optional checkout URL carrying only the authenticated owner", async () => {
    const response = await create("x".repeat(1048577), { UPGRADE_URL: "https://billing.test/upgrade?owner=forged&source=cli" });
    const details = (await error(response)).error;
    expect(details.upgrade_url).toBe(`https://billing.test/upgrade?owner=${OWNER}&source=cli`);
    expect(details).not.toHaveProperty("upgradeUrl");
    expect(JSON.stringify(details)).not.toContain(token);
    expect((await error(await create("x".repeat(1048577)))).error).not.toHaveProperty("upgrade_url");
  });

  it.each(["no json", "[]", "{}", '{"free":{"documents":3,"pushesPerDay":0,"htmlBytes":1}}', '{"free":{"documents":3,"pushesPerDay":6,"htmlBytes":10485761}}'])("fails closed on bad plan config %s without blocking management", async (PLAN_LIMITS) => {
    const doc = await (await create()).json<{ docId: string }>();
    expect((await create("x", { PLAN_LIMITS })).status).toBe(500);
    expect((await send("PUT", `/api/v1/docs/${doc.docId}`, { html: "x" }, { PLAN_LIMITS })).status).toBe(500);
    expect((await send("GET", "/api/v1/docs", undefined, { PLAN_LIMITS })).status).toBe(200);
    expect((await send("DELETE", `/api/v1/docs/${doc.docId}`, undefined, { PLAN_LIMITS })).status).toBe(204);
    expect(await usage()).toBe(1);
  });

  it("fails closed for a removed plan, while old tokens still list and unshare", async () => {
    const doc = await (await create()).json<{ docId: string }>();
    await env.DB.prepare("UPDATE accounts SET plan = 'removed' WHERE id = ?").bind(OWNER).run();
    expect((await create()).status).toBe(500);
    expect((await send("GET", "/api/v1/docs")).status).toBe(200);
    expect((await send("DELETE", `/api/v1/docs/${doc.docId}`)).status).toBe(204);
  });

  it("retains the absolute HTML safety ceiling for paid plans", async () => {
    await setPlan("pro");
    expect((await create("x".repeat(MAX_DOC_BYTES + 1))).status).toBe(413);
    expect(await usage()).toBe(0);
  });

  it("preserves existing partial-storage-failure semantics, including the reserved quota", async () => {
    const DOCS = new Proxy(env.DOCS, { get(target, key, receiver) {
      return key === "put" ? () => Promise.reject(new Error("R2 unavailable")) : Reflect.get(target, key, receiver);
    } });
    expect((await create("x", { DOCS })).status).toBe(500);
    expect(await usage()).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE owner = ?").bind(OWNER).first()).toEqual({ n: 1 });
  });
});

describe("service-only plan changes", () => {
  it("is disabled without a secret and refuses publisher tokens or wrong secrets", async () => {
    expect((await setPlan("pro", OWNER, { ADMIN_API_KEY: undefined })).status).toBe(404);
    expect((await setPlan("pro", OWNER, {}, token)).status).toBe(401);
    expect((await setPlan("pro", OWNER, {}, "wrong")).status).toBe(401);
    expect((await send("POST", "/admin/v1/tokens", {}, {}, ADMIN)).status).toBe(404);
  });
  it("idempotently changes only a real account to a configured plan", async () => {
    for (let i = 0; i < 2; i++) {
      const response = await setPlan("pro");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ owner: OWNER, plan: "pro" });
    }
    expect((await setPlan("not-configured")).status).toBe(400);
    expect((await setPlan("pro", "license-owner")).status).toBe(404);
    expect((await setPlan("pro", "%broken")).status).toBe(404);
    expect((await send("PUT", `/admin/v1/accounts/${OWNER}/plan`, { plan: "free", owner: "other" }, {}, ADMIN)).status).toBe(400);
  });
  it("never exposes admin writes on serving, retired or unknown hosts", async () => {
    const hosts = { API_HOST: "api.test", SERVING_HOST: "docs.test", RETIRED_API_HOST: "retired.test" };
    for (const [host, status] of [["docs.test", 404], ["retired.test", 410], ["unknown.test", 404]] as const) {
      expect((await send("PUT", `/admin/v1/accounts/${OWNER}/plan`, { plan: "pro" }, hosts, ADMIN, `https://${host}`)).status).toBe(status);
    }
    expect(await env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(OWNER).first()).toEqual({ plan: "free" });
    expect((await send("PUT", `/admin/v1/accounts/${OWNER}/plan`, { plan: "pro" }, hosts, ADMIN, "https://api.test")).status).toBe(200);
  });
});
