import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  confirmCopilotLogin,
  consumeBrowserLogin,
  proveBrowserLogin,
  proveCopilotLogin,
  startBrowserLogin,
} from "../src/browser-login.js";
import { findOrCreateAccount } from "../src/db.js";
import { sha256Hex } from "../src/hash.js";
import { newAccountId } from "../src/ids.js";
import { linkExternalOwner } from "../src/owners.js";
import type { Env } from "../src/config.js";
import worker from "../src/index.js";

const state = "1".repeat(64),
  secret = "2".repeat(64),
  now = Date.now();
const configured = {
  ...env,
  API_HOST: "api.openartifacts.ai",
  SERVING_HOST: "openartifacts.site",
  ACCOUNT_ACTION_URL: "https://openartifacts.ai/account",
  ADMIN_API_KEY: "admin",
  COPILOT_SSO_SECRET: "copilot-proof-only",
} as Env;
const deps = { now: () => now };
function request(path: string, value: object, token = configured.COPILOT_SSO_SECRET) {
  return new Request(`https://api.openartifacts.ai${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(value),
  });
}
async function start(nextState = state, config = configured) {
  return startBrowserLogin(
    request("/admin/v1/browser-logins", {
      state: nextState,
      challenge: await sha256Hex(secret),
      provider: "copilot",
      termsAccepted: true,
    }),
    config,
    deps,
  );
}
async function prove(over: Record<string, unknown> = {}) {
  return proveCopilotLogin(
    request("/api/v1/copilot/prove", {
      state,
      subject: "copilot-user",
      email: "person@example.com",
      ...over,
    }),
    configured,
    deps,
  );
}
async function pending(over: Record<string, unknown> = {}) {
  expect((await start()).status).toBe(200);
  const response = await prove(over);
  expect(response.status).toBe(200);
  const url = new URL((await response.json<{ url: string }>()).url);
  expect(url.origin).toBe("https://openartifacts.ai");
  return url.searchParams.get("code")!;
}
function consume(code: string, over: Record<string, unknown> = {}, at = now) {
  return consumeBrowserLogin(
    request("/admin/v1/browser-logins/consume", { state, code, secret, ...over }),
    configured,
    { now: () => at },
  );
}
function confirm(code: string, over: Record<string, unknown> = {}, at = now) {
  return confirmCopilotLogin(
    request("/admin/v1/browser-logins/copilot/confirm", {
      state,
      code,
      secret,
      confirmPermanent: true,
      ...over,
    }),
    configured,
    { now: () => at },
  );
}
async function count(table: string) {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

describe("Copilot browser identity", () => {
  it("uses the fixed Copilot sign-in origin and fails closed without the narrow secret", async () => {
    expect((await start(state, { ...configured, COPILOT_SSO_SECRET: undefined })).status).toBe(503);
    expect(await count("browser_logins")).toBe(0);
    const url = new URL((await (await start()).json<{ url: string }>()).url);
    expect(url.origin).toBe("https://obsidiancopilot.com");
    expect(url.pathname).toBe("/openartifacts/authorize");
    expect(url.searchParams.get("state")).toBe(state);
  });
  it("requires the narrow credential, not admin, and refuses unknown or expired states", async () => {
    await start();
    const payload = { state, subject: "copilot-user", email: "person@example.com" };
    expect(
      (
        await proveCopilotLogin(
          request("/api/v1/copilot/prove", payload, "admin"),
          configured,
          deps,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await proveCopilotLogin(
          request("/api/v1/copilot/prove", payload),
          { ...configured, COPILOT_SSO_SECRET: undefined },
          deps,
        )
      ).status,
    ).toBe(404);
    expect((await prove({ state: "3".repeat(64) })).status).toBe(400);
    expect(
      (
        await proveCopilotLogin(request("/api/v1/copilot/prove", payload), configured, {
          now: () => now + 600000,
        })
      ).status,
    ).toBe(400);
    expect((await prove()).status).toBe(200);
    expect((await prove()).status).toBe(400);
  });
  it("does not allow provider callbacks to impersonate Copilot", async () => {
    await start();
    const url = new URL(
      `https://api.openartifacts.ai/approve/callback/copilot?state=browser_${state}&code=x`,
    );
    expect((await proveBrowserLogin(url, configured, "copilot", deps)).status).toBe(400);
    expect((await prove()).status).toBe(200);
  });
  it("holds an unlinked identity until explicit confirmation and never creates publishing credentials", async () => {
    const code = await pending();
    expect(await (await consume(code)).json()).toEqual({
      needsLink: true,
      email: "person@example.com",
    });
    expect(await count("accounts")).toBe(0);
    for (const over of [
      { secret: "3".repeat(64) },
      { state: "4".repeat(64) },
      { code: "5".repeat(64) },
      { confirmPermanent: false },
      { extra: true },
    ])
      expect((await confirm(code, over)).status).toBe(400);
    expect((await confirm(code, {}, now + 600000)).status).toBe(400);
    const response = await confirm(code);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      email: "person@example.com",
      externalOwner: "copilot-user",
    });
    expect(await count("accounts")).toBe(1);
    expect(await count("owner_links")).toBe(1);
    expect(await count("tokens")).toBe(0);
    expect(await count("identities")).toBe(0);
    expect((await confirm(code)).status).toBe(400);
  });
  it("returns an already-linked account by immutable Copilot subject despite email changes", async () => {
    const account = await findOrCreateAccount(env.DB, newAccountId(), "old@example.com", now);
    await linkExternalOwner(env.DB, "copilot-user", account.id, now);
    const code = await pending({ email: "new@example.com" });
    expect(await (await consume(code)).json()).toEqual({
      accountId: account.id,
      email: "old@example.com",
      externalOwner: "copilot-user",
    });
    expect((await consume(code)).status).toBe(400);
  });
  it("does not merge by email, but explicit dual-account confirmation can link a different email", async () => {
    await findOrCreateAccount(env.DB, newAccountId(), "person@example.com", now);
    const target = await findOrCreateAccount(env.DB, newAccountId(), "different@example.com", now);
    const code = await pending();
    expect(await (await confirm(code)).json()).toEqual({
      needsAccountSignIn: true,
      email: "person@example.com",
    });
    expect(await count("owner_links")).toBe(0);
    expect(await count("accounts")).toBe(2);
    expect(await (await confirm(code, { accountId: target.id })).json()).toEqual({
      accountId: target.id,
      email: "different@example.com",
      externalOwner: "copilot-user",
    });
  });
  it("refuses occupied targets and owner conflicts without creating or altering accounts", async () => {
    const occupied = await findOrCreateAccount(env.DB, newAccountId(), "other@example.com", now);
    await linkExternalOwner(env.DB, "other-copilot", occupied.id, now);
    const code = await pending();
    expect((await confirm(code, { accountId: occupied.id })).status).toBe(409);
    expect(await count("accounts")).toBe(1);
    expect(await count("owner_links")).toBe(1);
    const own = await findOrCreateAccount(env.DB, newAccountId(), "mine@example.com", now);
    await linkExternalOwner(env.DB, "copilot-user", own.id, now);
    expect((await confirm(code, { accountId: occupied.id })).status).toBe(409);
    expect(await (await consume(code)).json()).toMatchObject({ accountId: own.id });
  });
  it("concurrent confirmations create exactly one linked account and consume once", async () => {
    const code = await pending();
    const responses = await Promise.all([confirm(code), confirm(code)]);
    const results = await Promise.all(
      responses.map(async (response) =>
        response.status === 200 ? response.json<Record<string, unknown>>() : {},
      ),
    );
    expect(results.filter((result) => "accountId" in result)).toHaveLength(1);
    expect(await count("accounts")).toBe(1);
    expect(await count("owner_links")).toBe(1);
    expect(await count("browser_logins")).toBe(0);
  });
  it("wrong or expired browser proof cannot access an already linked account", async () => {
    const account = await findOrCreateAccount(env.DB, newAccountId(), "old@example.com", now);
    await linkExternalOwner(env.DB, "copilot-user", account.id, now);
    const code = await pending();
    for (const over of [
      { state: "3".repeat(64) },
      { secret: "4".repeat(64) },
      { code: "5".repeat(64) },
    ])
      expect((await consume(code, over)).status).toBe(400);
    expect((await consume(code, {}, now + 600000)).status).toBe(400);
    expect(await (await consume(code)).json()).toMatchObject({ accountId: account.id });
  });
  it("concurrent identity proofs cannot replace the first proven Copilot user", async () => {
    await start();
    const responses = await Promise.all([
      prove({ subject: "first-user" }),
      prove({ subject: "second-user" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(await count("accounts")).toBe(0);
    expect(await count("browser_logins")).toBe(1);
  });
  it("routes proof only on API host and the narrow credential cannot invoke admin confirmation", async () => {
    await start();
    const ctx = createExecutionContext();
    const req = request("/api/v1/copilot/prove", {
      state,
      subject: "copilot-user",
      email: "person@example.com",
    });
    expect((await worker.fetch(req, configured, ctx)).status).toBe(200);
    const admin = request("/admin/v1/browser-logins/copilot/confirm", {});
    expect((await worker.fetch(admin, configured, ctx)).status).toBe(401);
    const serving = new Request("https://openartifacts.site/api/v1/copilot/prove", {
      method: "POST",
    });
    expect((await worker.fetch(serving, configured, ctx)).status).toBe(404);
    await waitOnExecutionContext(ctx);
  });
});
