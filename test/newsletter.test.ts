import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { findOrCreateAccount } from "../src/db.js";
import { syncNewsletter } from "../src/newsletter.js";
import { accountPlan } from "../src/entitlement.js";

it("only stored opt-in is delivered, and later plan refresh retries without blocking access", async () => {
  const id = "oa_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  await findOrCreateAccount(env.DB, id, "person@example.test", 1000);
  const configured = { ...env, LICENSE_API_URL: "https://license.example.test", LICENSE_API_KEY: "service" };
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("offline"); });
  await syncNewsletter(configured, id, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  await env.DB.prepare("UPDATE accounts SET newsletter_opt_in = 1 WHERE id = ?").bind(id).run();
  await expect(syncNewsletter(configured, id, fetcher)).resolves.toBeUndefined();
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ json: { email: "person@example.test" } });
  expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer service");
  fetcher.mockImplementation(async (url) => String(url).endsWith("openArtifactsNewsletter")
    ? Response.json({ result: { data: { json: { ok: true } } } })
    : Response.json({ result: { data: { json: { plan: "default", expiresAt: null } } } }));
  expect(await accountPlan(configured, id, { forceAccountRefresh: true, fetch: fetcher })).toMatchObject({ plan: "free", status: "refreshed" });
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("openArtifactsNewsletter"))).toHaveLength(2);
  await env.DB.prepare("UPDATE accounts SET newsletter_opt_in = 0 WHERE id = ?").bind(id).run();
  fetcher.mockClear();
  await syncNewsletter(configured, id, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
});
