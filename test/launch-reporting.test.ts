import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import report from "../scripts/launch-report.sql?raw";
import { sha256Hex } from "../src/hash.js";
import { newApiToken, newTokenId, newDocId } from "../src/ids.js";
import worker from "../src/index.js";
import { linkExternalOwner } from "../src/owners.js";
const OWNER = "oa_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const DAY = Date.UTC(2026, 8, 9);

it("reports first persisted publications and immutable links with post-link cohort restatement", async () => {
  await env.DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (?, 'private@example.test', 0)").bind(OWNER).run();
  async function publication(owner: string, times: number[], deleted = false) {
    const id = newDocId();
    await env.DB.prepare("INSERT INTO docs (id, owner, title, created_at, updated_at, deleted_at) VALUES (?, ?, 'private title', 0, 0, ?)")
      .bind(id, owner, deleted ? DAY : null).run();
    for (const [i, at] of times.entries()) await env.DB.prepare("INSERT INTO versions (doc_id, n, size, created_at) VALUES (?, ?, 1, ?)")
      .bind(id, i + 1, at).run();
  }
  await publication(OWNER, [DAY + 200, DAY]); // Earliest time, not version number.
  await publication(OWNER, [DAY + 300]); // A second document is not a new publisher.
  await publication("external", [DAY - 1, DAY + 1]); // Returning publisher, outside cohort.
  await publication("withdrawn", [DAY + 1], true); // Withdrawal retains publication evidence.
  await publication("failed-empty", []);
  await publication("future", [DAY + 86400000]); // Exclusive end boundary.
  const run = async () => (await env.DB.prepare(report).all()).results;
  expect(await run()).toEqual([{ utc_day: "2026-09-09", metric: "first_persisted_publication", count: 2 }]);
  expect(await linkExternalOwner(env.DB, "external", OWNER, DAY + 1000)).toBe("linked");
  expect(await linkExternalOwner(env.DB, "external", OWNER, DAY + 2000)).toBe("linked");
  expect(await run()).toEqual([
    { utc_day: "2026-09-09", metric: "first_persisted_publication", count: 1 },
    { utc_day: "2026-09-09", metric: "immutable_account_link", count: 1 },
  ]);
});

it("emits only fixed enum fields for real plan refusals and leaves success and other failures uncounted", async () => {
  await env.DB.prepare("INSERT INTO accounts (id, email, created_at, plan) VALUES (?, 'private@example.test', 0, 'private-plan')").bind(OWNER).run();
  const token = newApiToken();
  await env.DB.prepare("INSERT INTO tokens (id, token_hash, account_id, created_at) VALUES (?, ?, ?, 0)")
    .bind(newTokenId(), await sha256Hex(token), OWNER).run();
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    async function push(id?: string, html = "<p>private</p>", credential = token) {
      const ctx = createExecutionContext();
      const result = await worker.fetch(new Request(`https://local.test/api/v1/docs${id ? `/${id}` : ""}`, {
        method: id ? "PUT" : "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "private title", html }),
      }), { ...env, SERVING_HOST: "", API_HOST: "", LEGACY_SERVING_HOST: "", RETIRED_API_HOST: "",
        PLAN_LIMITS: '{"private-plan":{"documents":1,"pushesPerDay":1,"htmlBytes":64}}',
        UPGRADE_URL: "https://private.example.test/upgrade",
      }, ctx);
      await waitOnExecutionContext(ctx);
      return result;
    }
    const created = await push(); expect(created.status).toBe(201);
    const { docId } = await created.json<{ docId: string }>();
    expect(log).not.toHaveBeenCalled();
    expect((await push()).status).toBe(402);
    expect((await push(docId, "x".repeat(65))).status).toBe(402);
    expect((await push(docId)).status).toBe(402);
    expect((await push(newDocId())).status).toBe(404);
    expect((await push(undefined, undefined, "oat_invalid")).status).toBe(401);
    await env.DB.prepare("INSERT INTO publisher_suspensions VALUES (?, 0)").bind(OWNER).run();
    expect((await push()).status).toBe(403);
    expect(log.mock.calls).toEqual([
      ["publishing_limit_reached", { limit: "documents", authKind: "account" }],
      ["publishing_limit_reached", { limit: "htmlBytes", authKind: "account" }],
      ["publishing_limit_reached", { limit: "pushesPerDay", authKind: "account" }],
    ]);
  } finally { log.mockRestore(); }
});
