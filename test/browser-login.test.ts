import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { startBrowserLogin, proveBrowserLogin, consumeBrowserLogin } from "../src/browser-login.js";
import { handleAdmin } from "../src/admin.js";
import { handleApproval } from "../src/approval/handler.js";
import { sha256Hex } from "../src/hash.js";
import type { Env } from "../src/config.js";
import type { OAuthClient } from "../src/approval/providers.js";

const state = "1".repeat(64),
  secret = "2".repeat(64),
  now = Date.now();
const configured = {
  ...env,
  ACCOUNT_ACTION_URL: "https://openartifacts.ai/account",
  ADMIN_API_KEY: "test-admin",
  OAUTH_GOOGLE_CLIENT_ID: "client",
  OAUTH_GOOGLE_CLIENT_SECRET: "secret",
} as Env;
const oauth: OAuthClient = {
  authorizationUrl: (_provider, redirect, state, verifier) =>
    new URL(
      `https://example.com/oauth?state=${state}&redirect=${encodeURIComponent(redirect)}&verifier=${verifier}`,
    ),
  verifiedIdentity: vi.fn(async () => ({ subject: "google-subject", email: "person@example.com" })),
};
const deps = { now: () => now, oauth };
function request(path: string, value: object, token?: string) {
  return new Request(`https://api.openartifacts.ai${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(value),
  });
}
async function start(over: Record<string, unknown> = {}) {
  return startBrowserLogin(
    request("/admin/v1/browser-logins", {
      state,
      challenge: await sha256Hex(secret),
      provider: "google",
      termsAccepted: true,
      ...over,
    }),
    configured,
    deps,
  );
}
function callback(params = "code=provider-code", provider = "google") {
  return new URL(
    `https://api.openartifacts.ai/approve/callback/${provider}?state=browser_${state}&${params}`,
  );
}
async function prove() {
  const response = await proveBrowserLogin(callback(), configured, "google", deps);
  expect(response.status).toBe(303);
  return new URL(response.headers.get("location")!).searchParams.get("code")!;
}
function consume(code: string, over: Record<string, unknown> = {}, clock = now) {
  return consumeBrowserLogin(
    request("/admin/v1/browser-logins/consume", { state, code, secret, ...over }),
    configured,
    { now: () => clock },
  );
}
async function count(table: string) {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

describe("browser account login", () => {
  it("uses existing callback, binds state and defers creation until one-use browser proof without publishing tokens", async () => {
    const response = await start();
    expect(response.status).toBe(200);
    const target = new URL((await response.json<{ url: string }>()).url);
    expect(target.searchParams.get("state")).toBe(`browser_${state}`);
    expect(target.searchParams.get("redirect")).toBe(
      "https://api.openartifacts.ai/approve/callback/google",
    );
    const code = await prove();
    expect(await count("accounts")).toBe(0);
    expect(await count("tokens")).toBe(0);
    for (const over of [
      { state: "3".repeat(64) },
      { secret: "4".repeat(64) },
      { code: "5".repeat(64) },
    ])
      expect((await consume(code, over)).status).toBe(400);
    const consumed = await consume(code);
    expect(consumed.status).toBe(200);
    expect(await consumed.json()).toMatchObject({
      email: "person@example.com",
      externalOwner: null,
    });
    expect(await count("accounts")).toBe(1);
    expect(await count("tokens")).toBe(0);
    expect((await consume(code)).status).toBe(400);
  });
  it("requires explicit Terms, configured provider, exact bounded input, and refuses duplicate state", async () => {
    for (const over of [
      { termsAccepted: false },
      { termsAccepted: "true" },
      { provider: "github" },
      { state: "invalid" },
      { extra: true },
    ])
      expect((await start(over)).status).toBe(400);
    expect((await start()).status).toBe(200);
    expect((await start()).status).toBe(429);
  });
  it("preserves a valid handshake on provider mismatch and refuses replay and concurrent callback claims", async () => {
    await start();
    expect(
      (await proveBrowserLogin(callback("code=x", "github"), configured, "github", deps)).status,
    ).toBe(400);
    const responses = await Promise.all([
      proveBrowserLogin(callback(), configured, "google", deps),
      proveBrowserLogin(callback(), configured, "google", deps),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([303, 400]);
  });
  it("rejects expired callbacks and expired proofs", async () => {
    await start();
    expect(
      (
        await proveBrowserLogin(callback(), configured, "google", {
          ...deps,
          now: () => now + 600000,
        })
      ).status,
    ).toBe(400);
    const code = await prove();
    expect((await consume(code, {}, now + 600000)).status).toBe(400);
    expect(await count("accounts")).toBe(0);
  });
  it("returns provider refusal to fixed account origin without proof or account", async () => {
    await start();
    const result = await proveBrowserLogin(
      callback("error=access_denied&redirect=https://evil.example"),
      configured,
      "google",
      deps,
    );
    const location = new URL(result.headers.get("location")!);
    expect(location.origin).toBe("https://openartifacts.ai");
    expect(location.pathname).toBe("/account/login/callback");
    expect(location.searchParams.get("error")).toBe("sign_in_failed");
    expect(location.searchParams.has("code")).toBe(false);
    expect(await count("accounts")).toBe(0);
  });
  it("refuses unverified identity without minting proof", async () => {
    await start();
    const result = await proveBrowserLogin(callback(), configured, "google", {
      ...deps,
      oauth: { ...oauth, verifiedIdentity: async () => null },
    });
    expect(result.headers.get("location")).toContain("error=sign_in_failed");
    expect(await count("accounts")).toBe(0);
  });
  it("routes browser state through the existing approval callback", async () => {
    await start();
    const url = callback();
    const response = await handleApproval(new Request(url), url, configured, deps);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/account/login/callback?state=");
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it("reuses provider identity and returns its linked external owner", async () => {
    await start();
    const proof = await (await consume(await prove())).json<{ accountId: string }>();
    await env.DB.prepare(
      "INSERT INTO owner_links (account_id, external_owner, created_at) VALUES (?, ?, ?)",
    )
      .bind(proof.accountId, "legacy-owner", now)
      .run();
    await start();
    const result = await (await consume(await prove())).json();
    expect(result).toMatchObject({ accountId: proof.accountId, externalOwner: "legacy-owner" });
    expect(await count("accounts")).toBe(1);
  });
  it("returns failed provider exchanges to the website", async () => {
    await start();
    const result = await proveBrowserLogin(callback(), configured, "google", {
      ...deps,
      oauth: {
        ...oauth,
        verifiedIdentity: async () => {
          throw new Error("provider unavailable");
        },
      },
    });
    expect(result.headers.get("location")).toContain("error=sign_in_failed");
    expect(await count("accounts")).toBe(0);
  });
  it("bounds pending rows and reclaims expired attempts", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
      INSERT INTO browser_logins (state_hash, challenge, provider, expires_at, terms_accepted_at)
      SELECT CAST(x AS TEXT), 'challenge', 'google', ?, ? FROM n`,
    )
      .bind(now + 600000, now)
      .run();
    expect((await start()).status).toBe(429);
    await env.DB.prepare("UPDATE browser_logins SET expires_at = ?").bind(now).run();
    expect((await start()).status).toBe(200);
    expect(await count("browser_logins")).toBe(1);
  });
  it("requires admin bearer for both browser endpoints", async () => {
    for (const path of ["/admin/v1/browser-logins", "/admin/v1/browser-logins/consume"]) {
      const req = request(path, {});
      expect((await handleAdmin(req, new URL(req.url), configured)).status).toBe(401);
    }
  });
});
