import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import { APPROVAL_STATE_TTL_MS } from "../src/config.js";
import {
  clearApprovalCookie,
  openApprovalCookie,
  sealApprovalCookie,
} from "../src/approval/cookie.js";
import { handleApproval, normalizeUserCode } from "../src/approval/handler.js";
import type { OAuthClient, ProviderId } from "../src/approval/providers.js";
import { ACCOUNT_ID_PREFIX } from "../src/ids.js";
import { versionObjectKey } from "../src/storage.js";
import worker from "../src/index.js";

/**
 * Real time, not a fixed instant. Half these cases go through `worker.fetch`,
 * which has no seam for a clock, so a device code's expiry has to be relative
 * to the same "now" the Worker reads. Cases that call the handler directly are
 * pinned to this value so the two halves agree.
 */
const NOW = Date.now();

/**
 * Local routing has no configured hosts, so the surfaces resolve by path
 * prefix — the approval page included. Nothing here is about which production
 * domain carries it.
 */
const ORIGIN = "https://openartifacts.workers.dev";

const SECRET = "cookie-signing-key-for-tests";
const USER_CODE = "WDJB-MJHT";

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
    APPROVAL_COOKIE_SECRET: SECRET,
    ...over,
  }) as Env;

async function send(path: string, init: RequestInit = {}, over: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }),
    configured(over),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** The callback reaches the network in production, so its client is replaced. */
function oauthAnswering(email: string | null): OAuthClient & { calls: number } {
  const client = {
    calls: 0,
    authorizationUrl(provider: ProviderId, redirectUri: string, state: string) {
      return new URL(`https://provider.test/${provider}?state=${state}&r=${redirectUri}`);
    },
    async verifiedEmail() {
      client.calls += 1;
      return email;
    },
  };
  return client;
}

async function seedCode(userCode = USER_CODE, expiresAt = NOW + 60_000): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO device_codes (user_code, expires_at, created_at) VALUES (?, ?, ?)",
  )
    .bind(userCode, expiresAt, NOW)
    .run();
}

async function boundAccount(userCode = USER_CODE): Promise<string | null> {
  const row = await env.DB.prepare("SELECT account_id FROM device_codes WHERE user_code = ?")
    .bind(userCode)
    .first<{ account_id: string | null }>();
  return row?.account_id ?? null;
}

/** A callback request carrying a handshake this test started. */
async function callback(
  options: {
    provider?: ProviderId;
    cookieProvider?: ProviderId;
    userCode?: string;
    query?: Record<string, string>;
    cookie?: string | null;
    startedAt?: number;
    oauth?: OAuthClient;
    at?: number;
  } = {},
): Promise<Response> {
  const provider = options.provider ?? "google";
  const state = "state-token";
  const cookie =
    options.cookie === undefined
      ? (
          await sealApprovalCookie(
            {
              provider: options.cookieProvider ?? provider,
              state,
              verifier: "verifier-token",
              userCode: options.userCode ?? USER_CODE,
            },
            SECRET,
            options.startedAt ?? NOW,
          )
        ).split(";")[0] ?? ""
      : options.cookie;

  // An empty override drops the parameter, which is how the cancel case gets a
  // callback carrying `error` and no `code`.
  const query = new URLSearchParams({ state, code: "authorization-code" });
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === "") query.delete(key);
    else query.set(key, value);
  }
  const url = new URL(`${ORIGIN}/approve/callback/${provider}?${query}`);
  const request = new Request(url, {
    headers: cookie === null ? {} : { cookie },
  });

  return await handleApproval(request, url, configured(), {
    now: () => options.at ?? NOW,
    oauth: options.oauth ?? oauthAnswering("ada@example.com"),
  });
}

beforeEach(async () => {
  await seedCode();
});

describe("normalizeUserCode", () => {
  it("folds case and space so a code can be typed by hand", () => {
    expect(normalizeUserCode(" wdjb-mjht ")).toBe("WDJB-MJHT");
  });

  it("refuses a value that cannot be a device code", () => {
    expect(normalizeUserCode(null)).toBeNull();
    expect(normalizeUserCode("")).toBeNull();
    expect(normalizeUserCode("-LEADING")).toBeNull();
    expect(normalizeUserCode("has space")).toBeNull();
    expect(normalizeUserCode("<script>")).toBeNull();
    expect(normalizeUserCode("A".repeat(65))).toBeNull();
  });
});

describe("the approval state cookie", () => {
  it("round-trips a handshake it signed itself", async () => {
    const header = await sealApprovalCookie(
      { provider: "github", state: "s", verifier: "v", userCode: USER_CODE },
      SECRET,
      NOW,
    );
    const value = header.split(";")[0] ?? "";

    expect(await openApprovalCookie(value, SECRET, NOW)).toEqual({
      provider: "github",
      state: "s",
      verifier: "v",
      userCode: USER_CODE,
      expiresAt: NOW + APPROVAL_STATE_TTL_MS,
    });
  });

  it("carries the attributes that keep it off the serving origin and out of scripts", async () => {
    const header = await sealApprovalCookie(
      { provider: "google", state: "s", verifier: "v", userCode: USER_CODE },
      SECRET,
      NOW,
    );

    expect(header).toContain("Path=/approve");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    // Lax, never Strict: the provider's redirect back is a cross-site
    // navigation, and Strict would strip the cookie the callback needs.
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain(`Max-Age=${APPROVAL_STATE_TTL_MS / 1000}`);
  });

  it("refuses a handshake past its own expiry even when the browser kept it", async () => {
    const header = await sealApprovalCookie(
      { provider: "google", state: "s", verifier: "v", userCode: USER_CODE },
      SECRET,
      NOW,
    );
    const value = header.split(";")[0] ?? "";

    expect(await openApprovalCookie(value, SECRET, NOW + APPROVAL_STATE_TTL_MS)).toBeNull();
  });

  it("refuses a forged or tampered cookie", async () => {
    const header = await sealApprovalCookie(
      { provider: "google", state: "s", verifier: "v", userCode: USER_CODE },
      SECRET,
      NOW,
    );
    const value = header.split(";")[0] ?? "";
    const [name, sealed = ""] = value.split("=");
    const [body = "", signature = ""] = sealed.split(".");

    // Another deployment's key, an unsigned payload, and a payload edited to
    // name a different device code, all with the signature left alone.
    expect(await openApprovalCookie(value, "another-secret", NOW)).toBeNull();
    expect(await openApprovalCookie(`${name}=${body}`, SECRET, NOW)).toBeNull();
    const forged = btoa(JSON.stringify({ p: "google", s: "s", v: "v", u: "OTHER", e: NOW + 1 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await openApprovalCookie(`${name}=${forged}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it("has nothing to open when the request carries other cookies or none", async () => {
    expect(await openApprovalCookie(null, SECRET, NOW)).toBeNull();
    expect(await openApprovalCookie("other=1; unrelated=2", SECRET, NOW)).toBeNull();
    expect(await openApprovalCookie("oa_approval=junk", SECRET, NOW)).toBeNull();
  });

  it("clears with the same attributes it was set with, so the browser drops it", () => {
    const header = clearApprovalCookie();
    expect(header).toContain("Path=/approve");
    expect(header).toContain("Max-Age=0");
  });
});

describe("GET /approve", () => {
  it("offers every configured provider for a code that is waiting", async () => {
    const response = await send(`/approve?user_code=${USER_CODE}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with GitHub");
    expect(html).toContain(`>${USER_CODE}</div>`);
    expect(html).toContain(`/approve/start/google?user_code=${USER_CODE}`);
    // Nothing is decided yet, so nothing is remembered yet.
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("offers only the provider a half-configured deployment can actually finish", async () => {
    const html = await (
      await send(`/approve?user_code=${USER_CODE}`, {}, { OAUTH_GITHUB_CLIENT_SECRET: "" })
    ).text();

    expect(html).toContain("Continue with Google");
    expect(html).not.toContain("Continue with GitHub");
  });

  it("accepts the code in the case the terminal printed it or the user typed it", async () => {
    const html = await (await send("/approve?user_code=wdjb-mjht")).text();
    expect(html).toContain(`>${USER_CODE}</div>`);
  });

  it("says the code is gone rather than sending someone through a provider first", async () => {
    await seedCode("EXPIRED-1", NOW - 1);

    expect((await send("/approve?user_code=EXPIRED-1")).status).toBe(404);
    expect((await send("/approve?user_code=NOSUCHCODE")).status).toBe(404);
  });

  it("asks for the whole link when the code is missing or malformed", async () => {
    expect((await send("/approve")).status).toBe(400);
    expect((await send("/approve?user_code=not%20a%20code")).status).toBe(400);
  });

  it("says so plainly on a deployment with no provider configured", async () => {
    const response = await send(
      `/approve?user_code=${USER_CODE}`,
      {},
      { OAUTH_GOOGLE_CLIENT_ID: "", OAUTH_GITHUB_CLIENT_ID: "" },
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("no sign-in provider configured");
  });

  it("is unavailable when there is no key to sign the handshake with", async () => {
    const response = await send(`/approve?user_code=${USER_CODE}`, {}, { APPROVAL_COOKIE_SECRET: "" });
    expect(response.status).toBe(503);
  });

  it("escapes the code it echoes back rather than reflecting markup", async () => {
    // Shape-refused before it is echoed, which is the property that matters:
    // nothing that reaches the page can carry markup in the first place.
    const html = await (await send("/approve?user_code=%3Cimg%20src%3Dx%3E")).text();
    expect(html).not.toContain("<img src=x>");
  });
});

describe("GET /approve/start/{provider}", () => {
  it("sends the browser to Google with PKCE and remembers the handshake", async () => {
    const response = await send(`/approve/start/google?user_code=${USER_CODE}`);

    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location") ?? "");
    expect(target.host).toBe("accounts.google.com");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("code_challenge")).toBeTruthy();
    expect(target.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/approve/callback/google`);
    expect(target.searchParams.get("scope")).toBe("openid email");

    const cookie = response.headers.get("set-cookie") ?? "";
    const handshake = await openApprovalCookie(cookie.split(";")[0] ?? "", SECRET, NOW);
    expect(handshake?.provider).toBe("google");
    expect(handshake?.userCode).toBe(USER_CODE);
    expect(handshake?.state).toBe(target.searchParams.get("state"));
  });

  it("sends the browser to GitHub asking only for its email scope", async () => {
    const response = await send(`/approve/start/github?user_code=${USER_CODE}`);
    const target = new URL(response.headers.get("location") ?? "");

    expect(target.host).toBe("github.com");
    expect(target.searchParams.get("scope")).toBe("user:email");
    expect(target.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/approve/callback/github`);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("mints a different state and verifier for every handshake", async () => {
    const first = await send(`/approve/start/google?user_code=${USER_CODE}`);
    const second = await send(`/approve/start/google?user_code=${USER_CODE}`);

    expect(first.headers.get("set-cookie")).not.toBe(second.headers.get("set-cookie"));
  });

  it("has no page for a provider this deployment cannot use", async () => {
    expect((await send(`/approve/start/gitlab?user_code=${USER_CODE}`)).status).toBe(404);
    expect(
      (
        await send(`/approve/start/github?user_code=${USER_CODE}`, {}, { OAUTH_GITHUB_CLIENT_ID: "" })
      ).status,
    ).toBe(404);
  });

  it("starts nothing without a code to approve", async () => {
    const response = await send("/approve/start/google");
    expect(response.status).toBe(400);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
});

describe("GET /approve/callback/{provider}", () => {
  it("creates the account, binds the code, and keeps no session", async () => {
    const response = await callback();

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You’re signed in.");
    // The only cookie this flow ever sets is the one it now removes.
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");

    const owner = await boundAccount();
    expect(owner?.startsWith(ACCOUNT_ID_PREFIX)).toBe(true);

    const account = await env.DB.prepare("SELECT email FROM accounts WHERE id = ?")
      .bind(owner)
      .first<{ email: string }>();
    expect(account?.email).toBe("ada@example.com");
  });

  it("resolves Google and GitHub on one verified address to a single account", async () => {
    await callback({ provider: "google" });
    const first = await boundAccount();

    await seedCode("SECOND-CODE");
    await callback({
      provider: "github",
      userCode: "SECOND-CODE",
      oauth: oauthAnswering("Ada@Example.com"),
    });

    expect(await boundAccount("SECOND-CODE")).toBe(first);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("refuses an address the provider will not vouch for, creating nothing", async () => {
    const oauth = oauthAnswering(null);
    const response = await callback({ oauth });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("did not confirm");
    expect(oauth.calls).toBe(1);
    expect(await boundAccount()).toBeNull();
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("refuses a callback whose state does not match the handshake it claims", async () => {
    const oauth = oauthAnswering("ada@example.com");
    const response = await callback({ query: { state: "someone-elses-state" }, oauth });

    expect(response.status).toBe(400);
    // Refused before the code is ever exchanged.
    expect(oauth.calls).toBe(0);
    expect(await boundAccount()).toBeNull();
  });

  it("refuses a callback with no handshake cookie at all", async () => {
    const response = await callback({ cookie: null });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("That took too long.");
    expect(await boundAccount()).toBeNull();
  });

  it("refuses a handshake replayed at another provider's callback", async () => {
    const response = await callback({ provider: "github", cookieProvider: "google" });

    expect(response.status).toBe(400);
    expect(await boundAccount()).toBeNull();
  });

  it("refuses a handshake that sat past the state cookie's lifetime", async () => {
    const response = await callback({ at: NOW + APPROVAL_STATE_TTL_MS + 1 });

    expect(response.status).toBe(400);
    expect(await boundAccount()).toBeNull();
  });

  it("says nothing was approved when the user cancelled at the provider", async () => {
    const oauth = oauthAnswering("ada@example.com");
    const response = await callback({
      query: { code: "", error: "access_denied" },
      oauth,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Nothing was approved.");
    expect(oauth.calls).toBe(0);
    expect(await boundAccount()).toBeNull();
  });

  it("tells the user the code lapsed while they were signing in", async () => {
    await seedCode(USER_CODE, NOW - 1);
    const response = await callback();

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("no longer waiting");
    // The account is kept: it is the one their next approval will find.
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("cannot approve a second time with the same device code", async () => {
    await callback();
    const owner = await boundAccount();

    const again = await callback({ oauth: oauthAnswering("mallory@example.com") });

    expect(again.status).toBe(404);
    expect(await boundAccount()).toBe(owner);
  });
});

describe("the approval surface inside the router", () => {
  it("needs no credential, unlike everything else on the API host", async () => {
    const response = await send(`/approve?user_code=${USER_CODE}`);

    expect(response.status).toBe(200);
    expect(response.headers.has("www-authenticate")).toBe(false);
  });

  it("answers the API's JSON contract everywhere it did before", async () => {
    const response = await send("/api/v1/docs");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });

  it("has no approval page on the serving host", async () => {
    const response = await send(`/approve?user_code=${USER_CODE}`, {}, {
      SERVING_HOST: "openartifacts.workers.dev",
      API_HOST: "api.openartifacts.ai",
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("This document isn’t available.");
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("has no page for another method or a path under the prefix that no route claims", async () => {
    expect((await send(`/approve?user_code=${USER_CODE}`, { method: "POST" })).status).toBe(404);
    expect((await send("/approve/start")).status).toBe(404);
    expect((await send("/approve/start/google/extra")).status).toBe(404);
  });
});

describe("the serving origin", () => {
  const DOC_ID = "9f2k4mvq7t0xbz3n";

  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO docs (id, owner, title, latest_version, created_at, updated_at)
       VALUES (?, 'oa_owner', 'Notes', 1, ?, ?)`,
    )
      .bind(DOC_ID, NOW, NOW)
      .run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO versions (doc_id, n, size, title, created_at) VALUES (?, 1, 10, 'Notes', ?)",
    )
      .bind(DOC_ID, NOW)
      .run();
    await env.DOCS.put(
      versionObjectKey(DOC_ID, 1),
      "<!doctype html><html><body><p>hi</p></body></html>",
    );
  });

  /**
   * The property the approval cookie is confined for: publishers' own scripts
   * run on this origin, and they may only do so while there is nothing on it
   * for them to steal. `docs/http-api.md` promises it, so it is asserted rather
   * than assumed now that this Worker sets a cookie anywhere at all.
   */
  it("sets no cookie on any response it gives a reader", async () => {
    const serving = { SERVING_HOST: "openartifacts.workers.dev", API_HOST: "api.openartifacts.ai" };
    const paths = [
      `/d/${DOC_ID}`,
      `/d/${DOC_ID}/v1`,
      `/d/${DOC_ID}/v99`,
      "/d/0000000000000000",
      "/d/not-a-doc-id",
      "/approve",
      "/",
      "/health",
    ];

    for (const path of paths) {
      const response = await send(path, {}, serving);
      expect(response.headers.has("set-cookie"), `${path} set a cookie`).toBe(false);
      const head = await send(path, { method: "HEAD" }, serving);
      expect(head.headers.has("set-cookie"), `HEAD ${path} set a cookie`).toBe(false);
    }
  });

  it("sets no cookie on a deleted doc or on the legacy host's redirect", async () => {
    await env.DB.prepare("UPDATE docs SET deleted_at = ? WHERE id = ?").bind(NOW, DOC_ID).run();

    const gone = await send(`/d/${DOC_ID}`, {}, {
      SERVING_HOST: "openartifacts.workers.dev",
      API_HOST: "api.openartifacts.ai",
    });
    expect(gone.status).toBe(410);
    expect(gone.headers.has("set-cookie")).toBe(false);

    const redirected = await send(`/d/${DOC_ID}`, {}, {
      SERVING_HOST: "openartifacts.site",
      LEGACY_SERVING_HOST: "openartifacts.workers.dev",
    });
    expect(redirected.status).toBe(307);
    expect(redirected.headers.has("set-cookie")).toBe(false);
  });
});
