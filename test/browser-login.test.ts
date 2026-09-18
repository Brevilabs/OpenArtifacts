import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { handleAdmin } from "../src/admin.js";
import {
  BROWSER_USER_CODE_PREFIX,
  handleApproval,
  normalizeUserCode,
} from "../src/approval/handler.js";
import type { OAuthClient } from "../src/approval/providers.js";
import { startBrowserLogin, consumeBrowserLogin } from "../src/browser-login.js";
import type { Env } from "../src/config.js";
import { handleDevice } from "../src/device.js";
import { resolveAccountForIdentity } from "../src/db.js";
import { newAccountId } from "../src/ids.js";

const now = Date.now();
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
  verifiedIdentity: vi.fn(async () => ({
    subject: "google-subject",
    email: "person@example.com",
  })),
};
const deps = { now: () => now, oauth };

function json(path: string, value: object, token?: string) {
  return new Request(`https://api.openartifacts.ai${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(value),
  });
}

async function start(
  over: Record<string, unknown> = {},
  deployment: Env = configured,
) {
  return await startBrowserLogin(
    json("/admin/v1/browser-logins", {
      provider: "google",
      termsAccepted: true,
      ...over,
    }),
    deployment,
    deps,
  );
}

async function started() {
  const response = await start();
  expect(response.status).toBe(200);
  return await response.json<{ url: string; state: string }>();
}

function callbackUrl(state: string, params = "code=provider-code", provider = "google") {
  return new URL(
    `https://api.openartifacts.ai/approve/callback/${provider}?state=${state}&${params}`,
  );
}

async function callback(
  state: string,
  params = "code=provider-code",
  callbackOauth: OAuthClient = oauth,
) {
  const url = callbackUrl(state, params);
  return await handleApproval(new Request(url), url, configured, {
    now: () => now,
    oauth: callbackOauth,
  });
}

function consume(code: string, over: Record<string, unknown> = {}, at = now) {
  return consumeBrowserLogin(
    json("/admin/v1/browser-logins/consume", {
      code,
      termsAccepted: true,
      ...over,
    }),
    configured,
    { now: () => at },
  );
}

const redirect = (response: Response) => new URL(response.headers.get("location")!);
const proofCode = (response: Response) => redirect(response).searchParams.get("code")!;
async function count(table: string) {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

describe("browser account login", () => {
  it("stores an unpollable browser device row and returns the same provider state", async () => {
    const result = await started();
    const target = new URL(result.url);
    expect(target.searchParams.get("state")).toBe(result.state);
    expect(target.searchParams.get("redirect")).toBe(
      "https://api.openartifacts.ai/approve/callback/google",
    );
    const row = await env.DB.prepare(
      `SELECT user_code, device_code_hash, provider, state, verifier, label
       FROM device_codes WHERE state = ?`,
    )
      .bind(result.state)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      user_code: BROWSER_USER_CODE_PREFIX + result.state,
      device_code_hash: null,
      provider: "google",
      state: result.state,
      label: null,
    });
    expect(row?.verifier).toBeTruthy();
  });

  it("requires exact configured input and a valid account action destination", async () => {
    for (const over of [
      { provider: "github" },
      { provider: "missing" },
      { termsAccepted: false },
      { termsAccepted: undefined },
      { extra: true },
    ])
      expect((await start(over)).status).toBe(400);
    expect((await start({}, { ...configured, ACCOUNT_ACTION_URL: undefined })).status).toBe(503);
    expect((await start({}, { ...configured, ACCOUNT_ACTION_URL: "javascript:bad" })).status).toBe(
      503,
    );
  });

  it("consumes an existing identity once and returns its linked owner", async () => {
    const account = await resolveAccountForIdentity(
      env.DB,
      "google",
      "google-subject",
      "person@example.com",
      newAccountId(),
      now,
    );
    await env.DB.prepare(
      "INSERT INTO owner_links (account_id, external_owner, created_at) VALUES (?, ?, ?)",
    )
      .bind(account!.id, "copilot-owner", now)
      .run();
    const { state } = await started();
    const proved = await callback(state);
    expect(proved.status).toBe(303);
    expect(redirect(proved).origin).toBe("https://openartifacts.ai");
    const code = proofCode(proved);
    const result = await consume(code);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      accountId: account!.id,
      email: "person@example.com",
      externalOwner: "copilot-owner",
    });
    expect((await consume(code)).status).toBe(400);
    expect(await count("device_codes")).toBe(0);
  });

  it("creates a new identity with no newsletter choice and removes its row", async () => {
    const { state } = await started();
    const proved = await callback(state);
    expect(proved.status).toBe(303);
    const held = await env.DB.prepare(
      "SELECT pending_subject FROM device_codes WHERE state = ?",
    )
      .bind(state)
      .first<{ pending_subject: string }>();
    expect(held?.pending_subject).toBe("google-subject");
    const result = await consume(proofCode(proved));
    expect(result.status).toBe(200);
    const account = await env.DB.prepare(
      "SELECT newsletter_opt_in, newsletter_choice_at FROM accounts",
    ).first<{ newsletter_opt_in: number | null; newsletter_choice_at: number | null }>();
    expect(account).toEqual({ newsletter_opt_in: null, newsletter_choice_at: null });
    expect(await count("identities")).toBe(1);
    expect(await count("device_codes")).toBe(0);
  });

  it("returns a reassigned mailbox as an identity error without creating anything", async () => {
    await resolveAccountForIdentity(
      env.DB,
      "google",
      "first-subject",
      "person@example.com",
      newAccountId(),
      now,
    );
    const { state } = await started();
    const result = await callback(state);
    expect(redirect(result).searchParams.get("error")).toBe("identity");
    expect(redirect(result).searchParams.has("code")).toBe(false);
    expect(await count("accounts")).toBe(1);
    expect(await count("identities")).toBe(1);
  });

  it("redirects provider failures, missing codes, spent verifiers and refused exchanges", async () => {
    let current = await started();
    expect(redirect(await callback(current.state, "error=access_denied")).searchParams.get("error"))
      .toBe("sign_in_failed");
    expect((await callback(current.state)).status).toBe(400);

    current = await started();
    expect(redirect(await callback(current.state, "")).searchParams.get("error"))
      .toBe("sign_in_failed");
    expect((await callback(current.state)).status).toBe(400);

    current = await started();
    await env.DB.prepare("UPDATE device_codes SET verifier = NULL WHERE state = ?")
      .bind(current.state)
      .run();
    expect(redirect(await callback(current.state)).searchParams.get("error"))
      .toBe("sign_in_failed");
    expect((await callback(current.state)).status).toBe(400);

    current = await started();
    const refused = { ...oauth, verifiedIdentity: vi.fn(async () => null) };
    expect(redirect(await callback(current.state, undefined, refused)).searchParams.get("error"))
      .toBe("sign_in_failed");
    expect((await callback(current.state)).status).toBe(400);
  });

  it("rejects unknown, mismatched, expired, and replayed callbacks", async () => {
    expect((await callback("unknown")).status).toBe(400);
    const current = await started();
    const mismatch = callbackUrl(current.state, "code=x", "github");
    expect(
      (await handleApproval(new Request(mismatch), mismatch, configured, deps)).status,
    ).toBe(400);
    await env.DB.prepare("UPDATE device_codes SET expires_at = ? WHERE state = ?")
      .bind(now, current.state)
      .run();
    expect((await callback(current.state)).status).toBe(400);

    const fresh = await started();
    const code = proofCode(await callback(fresh.state));
    expect((await consume(code, {}, now + 600000)).status).toBe(400);
  });

  it("cannot enter the approval or publishing-token paths", async () => {
    const { state } = await started();
    for (const value of [`browser_${state}`, `BROWSER_${state.toUpperCase()}`])
      expect(normalizeUserCode(value)).toBeNull();

    const chooserUrl = new URL(
      `https://api.openartifacts.ai/approve?user_code=browser_${state}`,
    );
    expect(
      (await handleApproval(new Request(chooserUrl), chooserUrl, configured, deps)).status,
    ).toBe(400);
    const beginUrl = new URL("https://api.openartifacts.ai/approve/start/google");
    const begin = new Request(beginUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-dest": "document",
      },
      body: new URLSearchParams({ user_code: `browser_${state}` }),
    });
    expect((await handleApproval(begin, beginUrl, configured, deps)).status).toBe(400);

    const tokenUrl = new URL("https://api.openartifacts.ai/device/token");
    const polled = await handleDevice(
      json("/device/token", { device_code: state }),
      tokenUrl,
      configured,
      { now: () => now },
    );
    expect(await polled.json()).toMatchObject({ error: { code: "expired_token" } });
  });

  it("allows only one concurrent consume", async () => {
    const { state } = await started();
    const code = proofCode(await callback(state));
    const results = await Promise.all([consume(code), consume(code)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
  });

  it("requires the admin bearer for both endpoints", async () => {
    for (const path of ["/admin/v1/browser-logins", "/admin/v1/browser-logins/consume"]) {
      const request = json(path, {});
      expect((await handleAdmin(request, new URL(request.url), configured)).status).toBe(401);
    }
  });
});
