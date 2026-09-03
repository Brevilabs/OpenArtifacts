import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleApproval, normalizeUserCode } from "../src/approval/handler.js";
import type { OAuthClient, ProviderId } from "../src/approval/providers.js";
import {
  DEVICE_CODE_TTL_MS,
  DEVICE_POLL_INTERVAL_SECONDS,
  MAX_DEVICE_MINTS_PER_WINDOW,
} from "../src/config.js";
import { handleDevice, readDeviceLabel } from "../src/device.js";
import type { Env } from "../src/config.js";
import { confirmDeviceApproval, holdProvenIdentity } from "../src/db.js";
import { TOKEN_ID_PREFIX, TOKEN_PREFIX, USER_CODE_ALPHABET } from "../src/ids.js";
import worker from "../src/index.js";

/**
 * Local routing has no configured hosts, so the surfaces resolve by path
 * prefix. Nothing here is about which production domain carries them.
 */
const ORIGIN = "https://openartifacts.workers.dev";

/**
 * A fixed instant for everything driven through `handleDevice` directly, which
 * is how the cases about expiry and polling intervals control the clock. Cases
 * that go through `worker.fetch` have no seam for one and use real time.
 */
const NOW = 1_800_000_000_000;

const configured = (over: Partial<Env> = {}): Env =>
  ({
    ...env,
    SERVING_HOST: "",
    API_HOST: "",
    LEGACY_SERVING_HOST: "",
    RETIRED_API_HOST: "",
    OAUTH_GOOGLE_CLIENT_ID: "google-client",
    OAUTH_GOOGLE_CLIENT_SECRET: "google-secret",
    OAUTH_GITHUB_CLIENT_ID: "github-client",
    OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
    ...over,
  }) as Env;

function request(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Straight at the handler, where the clock is injectable. */
function device(path: string, body?: unknown, now = NOW, headers: Record<string, string> = {}) {
  const url = new URL(`${ORIGIN}${path}`);
  return handleDevice(request(path, body, headers), url, configured(), { now: () => now });
}

/** Through the router, which is what proves the surface is reachable at all. */
async function routed(path: string, body?: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request(path, body), configured(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

interface Minted {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface Issued {
  access_token: string;
  token_type: string;
  token_id: string;
  label: string | null;
}

async function mint(body?: unknown, now = NOW): Promise<Minted> {
  const response = await device("/device/code", body, now);
  expect(response.status).toBe(200);
  return await response.json<Minted>();
}

const errorOf = async (response: Response): Promise<string> =>
  (await response.json<{ error: { code: string } }>()).error.code;

async function codeRow(userCode: string) {
  return await env.DB.prepare(
    `SELECT device_code_hash, label, approved_at, denied_at, last_polled_at, expires_at
       FROM device_codes WHERE user_code = ?`,
  )
    .bind(userCode)
    .first<{
      device_code_hash: string | null;
      label: string | null;
      approved_at: number | null;
      denied_at: number | null;
      last_polled_at: number | null;
      expires_at: number;
    }>();
}

/**
 * Approve a minted code the way the page does, through the two writes the
 * approval page performs. Driving the browser flow as well is one case below;
 * everything else only needs the code approved.
 */
async function approve(userCode: string, accountId = "oa_device_account"): Promise<void> {
  await env.DB.prepare(
    "UPDATE device_codes SET state = ?, verifier = ? WHERE user_code = ?",
  )
    .bind(`state-${userCode}`, "verifier", userCode)
    .run();
  await env.DB.prepare("INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)")
    .bind(accountId, `${accountId}@example.test`, NOW)
    .run();

  const held = await holdProvenIdentity(
    env.DB,
    `state-${userCode}`,
    accountId,
    `confirm-${userCode}`,
    NOW,
  );
  expect(held).toBe(true);
  expect(await confirmDeviceApproval(env.DB, `confirm-${userCode}`, NOW)).toBe(userCode);
}

describe("POST /device/code", () => {
  it("mints both codes, the two verification urls, the interval and the expiry", async () => {
    const minted = await mint({ label: "Claude Code on loganmac" });

    expect(minted.device_code).toMatch(/^[0-9a-z]{52}$/);
    expect(minted.verification_uri).toBe(`${ORIGIN}/approve`);
    expect(minted.verification_uri_complete).toBe(
      `${ORIGIN}/approve?user_code=${minted.user_code}`,
    );
    expect(minted.expires_in).toBe(DEVICE_CODE_TTL_MS / 1000);
    expect(minted.interval).toBe(DEVICE_POLL_INTERVAL_SECONDS);
  });

  it("draws a user code the approval page accepts, from the alphabet with no vowels or digits", async () => {
    const { user_code } = await mint();

    expect(user_code).toMatch(
      new RegExp(`^[${USER_CODE_ALPHABET}]{4}-[${USER_CODE_ALPHABET}]{4}$`),
    );
    expect(normalizeUserCode(user_code)).toBe(user_code);
  });

  it("stores the device code only as a hash, and the label beside it", async () => {
    const minted = await mint({ label: "Codex on ci-runner-3" });

    const row = await codeRow(minted.user_code);
    expect(row?.device_code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.device_code_hash).not.toBe(minted.device_code);
    expect(row?.label).toBe("Codex on ci-runner-3");
    expect(row?.expires_at).toBe(NOW + DEVICE_CODE_TTL_MS);
  });

  it("accepts a request with no body at all, since a label is optional", async () => {
    const response = await device("/device/code");
    expect(response.status).toBe(200);
    expect((await codeRow((await response.json<Minted>()).user_code))?.label).toBeNull();
  });

  it("refuses a label that is not a string, and junk that is not JSON", async () => {
    expect(await errorOf(await device("/device/code", { label: 7 }))).toBe("bad_request");

    const url = new URL(`${ORIGIN}/device/code`);
    const junk = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const response = await handleDevice(junk, url, configured(), { now: () => NOW });
    expect(await errorOf(response)).toBe("bad_request");
  });

  it("sweeps codes that have expired, so their user codes can be drawn again", async () => {
    await env.DB.prepare(
      "INSERT INTO device_codes (user_code, expires_at, created_at) VALUES (?, ?, ?)",
    )
      .bind("SWEEP-OLD", NOW - 1, NOW - DEVICE_CODE_TTL_MS)
      .run();

    await mint();

    expect(await codeRow("SWEEP-OLD")).toBeNull();
  });

  it("leaves a code that has not expired alone", async () => {
    const first = await mint();
    await mint();

    expect(await codeRow(first.user_code)).not.toBeNull();
  });

  it("refuses a client that has spent its window's worth of codes", async () => {
    for (let i = 0; i < MAX_DEVICE_MINTS_PER_WINDOW; i += 1) {
      expect((await device("/device/code")).status).toBe(200);
    }

    const refused = await device("/device/code");
    expect(refused.status).toBe(429);
    expect(await errorOf(refused)).toBe("quota_exceeded");
    expect(refused.headers.get("retry-after")).toMatch(/^[0-9]+$/);
  });

  it("counts each client address separately", async () => {
    for (let i = 0; i < MAX_DEVICE_MINTS_PER_WINDOW; i += 1) {
      await device("/device/code", undefined, NOW, { "cf-connecting-ip": "203.0.113.7" });
    }

    expect(
      (await device("/device/code", undefined, NOW, { "cf-connecting-ip": "203.0.113.8" })).status,
    ).toBe(200);
    expect(
      (await device("/device/code", undefined, NOW, { "cf-connecting-ip": "203.0.113.7" })).status,
    ).toBe(429);
  });

  it("is reachable through the router and answers 404 on any other device path or method", async () => {
    expect((await routed("/device/code")).status).toBe(200);
    expect((await routed("/device/nowhere")).status).toBe(404);

    const ctx = createExecutionContext();
    const get = await worker.fetch(
      new Request(`${ORIGIN}/device/code`),
      configured(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(get.status).toBe(404);
  });
});

describe("POST /device/token", () => {
  it("says the approval is pending while nobody has approved", async () => {
    const { device_code } = await mint();

    expect(await errorOf(await device("/device/token", { device_code }))).toBe(
      "authorization_pending",
    );
  });

  it("says slow down when the terminal polls faster than the interval it was given", async () => {
    const { device_code } = await mint();
    await device("/device/token", { device_code }, NOW);

    expect(await errorOf(await device("/device/token", { device_code }, NOW + 1_000))).toBe(
      "slow_down",
    );
    expect(
      await errorOf(
        await device(
          "/device/token",
          { device_code },
          NOW + DEVICE_POLL_INTERVAL_SECONDS * 1000,
        ),
      ),
    ).toBe("authorization_pending");
  });

  it("answers an unknown device code exactly as it answers an expired one", async () => {
    const { device_code } = await mint();
    const unknown = "zzzz".repeat(13);

    expect(await errorOf(await device("/device/token", { device_code: unknown }))).toBe(
      "expired_token",
    );
    expect(
      await errorOf(await device("/device/token", { device_code }, NOW + DEVICE_CODE_TTL_MS)),
    ).toBe("expired_token");
  });

  it("refuses a body with no device code", async () => {
    expect(await errorOf(await device("/device/token", {}))).toBe("bad_request");
    expect(await errorOf(await device("/device/token", { device_code: 42 }))).toBe("bad_request");
  });

  it("issues a token once the code is approved, and reports the label back", async () => {
    const minted = await mint({ label: "Claude Code on loganmac" });
    await approve(minted.user_code);

    const response = await device("/device/token", { device_code: minted.device_code });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const issued = await response.json<Issued>();
    expect(issued.access_token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(issued.token_type).toBe("Bearer");
    expect(issued.token_id.startsWith(TOKEN_ID_PREFIX)).toBe(true);
    expect(issued.label).toBe("Claude Code on loganmac");
  });

  it("stores only the token's hash, against the account that approved it", async () => {
    const minted = await mint();
    await approve(minted.user_code, "oa_holder");

    const issued = await (await device("/device/token", { device_code: minted.device_code }))
      .json<Issued>();

    const row = await env.DB.prepare(
      "SELECT token_hash, account_id, label, last_used_at, revoked_at FROM tokens WHERE id = ?",
    )
      .bind(issued.token_id)
      .first<{
        token_hash: string;
        account_id: string;
        label: string | null;
        last_used_at: number | null;
        revoked_at: number | null;
      }>();

    expect(row?.account_id).toBe("oa_holder");
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toContain(issued.access_token);
    expect(row?.last_used_at).toBeNull();
    expect(row?.revoked_at).toBeNull();
  });

  it("consumes the code, so replaying a collected device code gets nothing", async () => {
    const minted = await mint();
    await approve(minted.user_code);
    await device("/device/token", { device_code: minted.device_code });

    expect(await codeRow(minted.user_code)).toBeNull();
    expect(await errorOf(await device("/device/token", { device_code: minted.device_code }))).toBe(
      "expired_token",
    );
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens").first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it("issues one token when two polls collect the same approval at once", async () => {
    const minted = await mint();
    await approve(minted.user_code);

    const [first, second] = await Promise.all([
      device("/device/token", { device_code: minted.device_code }),
      device("/device/token", { device_code: minted.device_code }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 400]);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens").first<{ n: number }>())!;
    expect(n).toBe(1);
  });
});

describe("denying an approval", () => {
  it("tells the waiting terminal it was refused, and issues nothing", async () => {
    const minted = await mint({ label: "Somebody else's laptop" });
    await env.DB.prepare("UPDATE device_codes SET denied_at = ? WHERE user_code = ?")
      .bind(NOW, minted.user_code)
      .run();

    expect(await errorOf(await device("/device/token", { device_code: minted.device_code }))).toBe(
      "access_denied",
    );
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens").first<{ n: number }>())!;
    expect(n).toBe(0);
  });
});

describe("readDeviceLabel()", () => {
  it("keeps a plain label, and treats a missing one as none", () => {
    expect(readDeviceLabel("Codex on loganmac")).toBe("Codex on loganmac");
    expect(readDeviceLabel(undefined)).toBeNull();
    expect(readDeviceLabel(null)).toBeNull();
    expect(readDeviceLabel("   ")).toBeNull();
  });

  it("strips control characters, so a terminal cannot draw over the page it is named on", () => {
    expect(readDeviceLabel("Claude[31m Code\nrm -rf")).toBe("Claude [31m Code rm -rf");
  });

  it("cuts a label that would not fit on the approval page", () => {
    expect(readDeviceLabel("x".repeat(200))).toHaveLength(80);
  });

  it("rejects a label that is not a string", () => {
    expect(readDeviceLabel(7)).toBeUndefined();
    expect(readDeviceLabel({ label: "no" })).toBeUndefined();
  });
});

describe("the whole flow, from an empty terminal to a token", () => {
  /** The callback reaches Google in production, so its client is replaced. */
  const oauth: OAuthClient = {
    authorizationUrl(provider: ProviderId, redirectUri: string, state: string) {
      return new URL(`https://provider.test/${provider}?state=${state}&r=${redirectUri}`);
    },
    async verifiedIdentity() {
      return { subject: "sub-flow", email: "flow@example.test" };
    },
  };

  const approval = (path: string, init: RequestInit = {}) =>
    handleApproval(
      new Request(`${ORIGIN}${path}`, init),
      new URL(`${ORIGIN}${path}`),
      configured(),
      { now: () => NOW, oauth },
    );

  const form = (path: string, fields: Record<string, string>) =>
    approval(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });

  it("mints, approves in the browser, and hands the terminal a token that publishes", async () => {
    const minted = await mint({ label: "Claude Code on loganmac" });

    const chooser = await approval(`/approve?user_code=${minted.user_code}`);
    expect(chooser.status).toBe(200);
    expect(await chooser.text()).toContain(minted.user_code);

    expect((await form("/approve/start/google", { user_code: minted.user_code })).status).toBe(303);

    const state = (
      await env.DB.prepare("SELECT state FROM device_codes WHERE user_code = ?")
        .bind(minted.user_code)
        .first<{ state: string }>()
    )?.state;
    const confirmPage = await approval(`/approve/callback/google?state=${state}&code=auth-code`);
    const html = await confirmPage.text();
    // The machine's own name for itself is what tells the person whether the
    // terminal waiting on this code is theirs.
    expect(html).toContain("Claude Code on loganmac");
    expect(html).toContain("Deny");

    const confirmToken = /name="confirm_token" value="([^"]+)"/.exec(html)?.[1] ?? "";
    expect((await form("/approve/confirm", { confirm_token: confirmToken })).status).toBe(200);

    const issued = await (await device("/device/token", { device_code: minted.device_code }))
      .json<Issued>();

    const ctx = createExecutionContext();
    const published = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/docs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${issued.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "From the terminal",
          html: "<!doctype html><html><body><p>hi</p></body></html>",
        }),
      }),
      configured(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(published.status).toBe(201);
  });

  it("lets the person deny instead, which kills the code the terminal is waiting on", async () => {
    const minted = await mint({ label: "A terminal that is not mine" });
    await form("/approve/start/google", { user_code: minted.user_code });
    const state = (
      await env.DB.prepare("SELECT state FROM device_codes WHERE user_code = ?")
        .bind(minted.user_code)
        .first<{ state: string }>()
    )?.state;
    const html = await (
      await approval(`/approve/callback/google?state=${state}&code=auth-code`)
    ).text();
    const confirmToken = /name="confirm_token" value="([^"]+)"/.exec(html)?.[1] ?? "";

    const denied = await form("/approve/deny", { confirm_token: confirmToken });
    expect(denied.status).toBe(200);
    expect(await denied.text()).toContain("Denied");

    expect(await errorOf(await device("/device/token", { device_code: minted.device_code }))).toBe(
      "access_denied",
    );
    // The same press cannot then approve it: the confirm token is spent either way.
    expect((await form("/approve/confirm", { confirm_token: confirmToken })).status).toBe(400);
    expect((await codeRow(minted.user_code))?.approved_at).toBeNull();
  });
});
