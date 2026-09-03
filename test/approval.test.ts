import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config.js";
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

/** A form submission, as the chooser's and the confirm page's buttons make one. */
function post(path: string, fields: Record<string, string>, over: Partial<Env> = {}) {
  return send(path, { method: "POST", body: new URLSearchParams(fields) }, over);
}

/**
 * The callback reaches the network in production, so its client is replaced.
 * The subject defaults to one derived from the address, since most cases care
 * only that the two travel together; the reassigned-mailbox case sets it.
 */
function oauthAnswering(
  email: string | null,
  subject = `sub-${email}`,
): OAuthClient & { calls: number } {
  const client = {
    calls: 0,
    authorizationUrl(provider: ProviderId, redirectUri: string, state: string) {
      return new URL(`https://provider.test/${provider}?state=${state}&r=${redirectUri}`);
    },
    async verifiedIdentity() {
      client.calls += 1;
      return email === null ? null : { subject, email };
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

async function readCode(userCode = USER_CODE) {
  return await env.DB.prepare(
    "SELECT provider, state, verifier, account_id, approved_at FROM device_codes WHERE user_code = ?",
  )
    .bind(userCode)
    .first<{
      provider: string | null;
      state: string | null;
      verifier: string | null;
      account_id: string | null;
      approved_at: number | null;
    }>();
}

async function accountCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>();
  return row?.n ?? 0;
}

/** The `state` a started handshake left on the row, which is what a callback carries. */
async function startedState(userCode = USER_CODE): Promise<string> {
  return (await readCode(userCode))?.state ?? "";
}

/** Start a handshake the way the chooser's button does. */
function begin(provider: ProviderId = "google", userCode = USER_CODE): Promise<Response> {
  return post(`/approve/start/${provider}`, { user_code: userCode });
}

/**
 * The provider's redirect back, driven through the handler rather than the
 * router so the token exchange is stubbed instead of reaching Google.
 */
async function callback(
  options: {
    provider?: ProviderId;
    state?: string;
    query?: Record<string, string>;
    oauth?: OAuthClient;
    at?: number;
  } = {},
): Promise<Response> {
  const provider = options.provider ?? "google";
  const state = options.state ?? (await startedState());

  // An empty override drops the parameter, which is how the cancel case gets a
  // callback carrying `error` and no `code`.
  const query = new URLSearchParams({ state, code: "authorization-code" });
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === "") query.delete(key);
    else query.set(key, value);
  }

  const url = new URL(`${ORIGIN}/approve/callback/${provider}?${query}`);
  return await handleApproval(new Request(url), url, configured(), {
    now: () => options.at ?? NOW,
    oauth: options.oauth ?? oauthAnswering("ada@example.com"),
  });
}

/** The `state` the confirm form on a rendered callback page carries. */
function confirmState(html: string): string {
  return /name="state" value="([^"]+)"/.exec(html)?.[1] ?? "";
}

/** The whole flow: start, prove, press. Returns the page the press produced. */
async function approve(
  provider: ProviderId = "google",
  userCode = USER_CODE,
  email = "ada@example.com",
  subject?: string,
): Promise<Response> {
  await begin(provider, userCode);
  const proven = await callback({
    provider,
    state: await startedState(userCode),
    oauth: oauthAnswering(email, subject ?? `sub-${provider}`),
  });
  return await post("/approve/confirm", { state: confirmState(await proven.text()) });
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

describe("GET /approve", () => {
  it("offers every configured provider for a code that is waiting", async () => {
    const response = await send(`/approve?user_code=${USER_CODE}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with GitHub");
    expect(html).toContain(`>${USER_CODE}</div>`);
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  /**
   * A link that starts a handshake carries a visitor already signed in to their
   * provider through it with no prompt, landing them on a confirmation they
   * never asked for. That is the first half of RFC 8628 §5.4's phishing case,
   * so the only way to start one is a form the person submits.
   */
  it("starts a handshake from a form, never from a link", async () => {
    const html = await (await send(`/approve?user_code=${USER_CODE}`)).text();

    expect(html).toContain('<form method="post" action="/approve/start/google">');
    expect(html).toContain(`name="user_code" value="${USER_CODE}"`);
    expect(html).not.toContain('href="/approve/start');
    expect((await send(`/approve/start/google?user_code=${USER_CODE}`)).status).toBe(404);
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

  it("escapes the code it echoes back rather than reflecting markup", async () => {
    // Shape-refused before it is echoed, which is the property that matters:
    // nothing that reaches the page can carry markup in the first place.
    const html = await (await send("/approve?user_code=%3Cimg%20src%3Dx%3E")).text();
    expect(html).not.toContain("<img src=x>");
  });
});

describe("POST /approve/start/{provider}", () => {
  it("sends the browser to Google with PKCE and records the handshake on the code", async () => {
    const response = await begin("google");

    expect(response.status).toBe(303);
    const target = new URL(response.headers.get("location") ?? "");
    expect(target.host).toBe("accounts.google.com");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("code_challenge")).toBeTruthy();
    expect(target.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/approve/callback/google`);
    expect(target.searchParams.get("scope")).toBe("openid email");

    const row = await readCode();
    expect(row?.provider).toBe("google");
    expect(row?.state).toBe(target.searchParams.get("state"));
    expect(row?.verifier).toBeTruthy();
    // Starting is not approving, and the row must not read as though it were.
    expect(row?.approved_at).toBeNull();
    expect(row?.account_id).toBeNull();
    // Nothing is remembered in the browser, on this response or any other.
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("sends the browser to GitHub asking only for its email scope", async () => {
    const target = new URL((await begin("github")).headers.get("location") ?? "");

    expect(target.host).toBe("github.com");
    expect(target.searchParams.get("scope")).toBe("user:email");
    expect(target.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/approve/callback/github`);
    expect((await readCode())?.provider).toBe("github");
  });

  it("mints a different state and verifier for every handshake", async () => {
    await begin();
    const first = await readCode();
    await begin();
    const second = await readCode();

    expect(second?.state).not.toBe(first?.state);
    expect(second?.verifier).not.toBe(first?.verifier);
  });

  it("has no route for a provider this deployment cannot use", async () => {
    expect((await post("/approve/start/gitlab", { user_code: USER_CODE })).status).toBe(404);
    expect(
      (
        await post("/approve/start/github", { user_code: USER_CODE }, { OAUTH_GITHUB_CLIENT_ID: "" })
      ).status,
    ).toBe(404);
  });

  it("starts nothing without a code, or with one that is no longer waiting", async () => {
    expect((await post("/approve/start/google", {})).status).toBe(400);

    await seedCode("EXPIRED-2", NOW - 1);
    expect((await post("/approve/start/google", { user_code: "EXPIRED-2" })).status).toBe(404);
  });
});

describe("GET /approve/callback/{provider}", () => {
  beforeEach(async () => {
    await begin();
  });

  /**
   * The whole of RFC 8628 §5.4: the provider's redirect is a `GET` a link can
   * cause, and a visitor already signed in is carried through it with no
   * prompt, so it must not be able to finish an approval on its own.
   */
  it("approves nothing on its own, however the redirect was caused", async () => {
    const response = await callback();

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Approve this code?");
    expect(html).toContain("ada@example.com");
    expect(html).toContain(`>${USER_CODE}</div>`);

    const row = await readCode();
    expect(row?.account_id?.startsWith(ACCOUNT_ID_PREFIX)).toBe(true);
    // The identity is proven and the code is not approved. #57 polls the second.
    expect(row?.approved_at).toBeNull();
  });

  it("creates the account for the address the provider verified", async () => {
    await callback();

    const account = await env.DB.prepare("SELECT email FROM accounts WHERE id = ?")
      .bind((await readCode())?.account_id)
      .first<{ email: string }>();
    expect(account?.email).toBe("ada@example.com");
  });

  it("spends the verifier, so a reloaded callback cannot repeat the exchange", async () => {
    const state = await startedState();
    await callback({ state });
    expect((await readCode())?.verifier).toBeNull();

    expect((await callback({ state })).status).toBe(400);
  });

  it("refuses an address the provider will not vouch for, creating nothing", async () => {
    const oauth = oauthAnswering(null);
    const response = await callback({ oauth });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("did not confirm");
    expect(oauth.calls).toBe(1);
    expect((await readCode())?.account_id).toBeNull();
    expect(await accountCount()).toBe(0);
  });

  it("refuses a state that names no pending handshake", async () => {
    const oauth = oauthAnswering("mallory@example.com");
    const response = await callback({ state: "not-a-state-we-issued", oauth });

    expect(response.status).toBe(400);
    // Refused before the authorization code is ever exchanged.
    expect(oauth.calls).toBe(0);
    expect((await readCode())?.account_id).toBeNull();
  });

  it("refuses a handshake replayed at the other provider's callback", async () => {
    const response = await callback({ provider: "github" });

    expect(response.status).toBe(400);
    expect((await readCode())?.account_id).toBeNull();
  });

  it("refuses a handshake whose code expired while the user was signing in", async () => {
    await env.DB.prepare("UPDATE device_codes SET expires_at = ? WHERE user_code = ?")
      .bind(NOW - 1, USER_CODE)
      .run();

    expect((await callback()).status).toBe(400);
  });

  it("says nothing was approved when the user cancelled at the provider", async () => {
    const oauth = oauthAnswering("ada@example.com");
    const response = await callback({ query: { code: "", error: "access_denied" }, oauth });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Nothing was approved.");
    expect(oauth.calls).toBe(0);
    expect((await readCode())?.account_id).toBeNull();
  });
});

describe("POST /approve/confirm", () => {
  it("is the step that actually approves the code", async () => {
    const response = await approve();

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Approved.");
    expect(html).toContain(`>${USER_CODE}</div>`);

    const row = await readCode();
    // Stamped by the Worker's own clock, which the router gives no seam for.
    expect(row?.approved_at).toBeGreaterThanOrEqual(NOW);
    expect(row?.account_id?.startsWith(ACCOUNT_ID_PREFIX)).toBe(true);
    // Cleared, so the press cannot be replayed and no state stays addressable.
    expect(row?.state).toBeNull();
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  /**
   * The hidden `state` is the only thing a cross-site form cannot supply, which
   * is what stops a page an attacker controls from pressing this button for a
   * victim who has just proved their identity.
   */
  it("refuses a press that cannot name the handshake it is confirming", async () => {
    await begin();
    await callback();

    expect((await post("/approve/confirm", {})).status).toBe(400);
    expect((await post("/approve/confirm", { state: "guessed" })).status).toBe(400);
    expect((await readCode())?.approved_at).toBeNull();
  });

  it("refuses a press for a handshake whose identity was never proved", async () => {
    await begin();

    const response = await post("/approve/confirm", { state: await startedState() });

    expect(response.status).toBe(400);
    expect((await readCode())?.approved_at).toBeNull();
  });

  it("cannot be pressed twice", async () => {
    await begin();
    const state = confirmState(await (await callback()).text());

    expect((await post("/approve/confirm", { state })).status).toBe(200);
    const approvedAt = (await readCode())?.approved_at;

    expect((await post("/approve/confirm", { state })).status).toBe(400);
    expect((await readCode())?.approved_at).toBe(approvedAt);
  });

  it("refuses a press for a code that expired while the page was open", async () => {
    await begin();
    const state = confirmState(await (await callback()).text());
    await env.DB.prepare("UPDATE device_codes SET expires_at = ? WHERE user_code = ?")
      .bind(NOW - 1, USER_CODE)
      .run();

    expect((await post("/approve/confirm", { state })).status).toBe(400);
    expect((await readCode())?.approved_at).toBeNull();
  });
});

describe("approving more than once", () => {
  it("resolves Google and GitHub on one verified address to a single account", async () => {
    await approve("google", USER_CODE, "ada@example.com");
    const first = (await readCode())?.account_id;

    await seedCode("SECOND-CODE");
    await approve("github", "SECOND-CODE", "Ada@Example.com");

    expect((await readCode("SECOND-CODE"))?.account_id).toBe(first);
    expect(await accountCount()).toBe(1);
  });

  /**
   * A mailbox handed to a new person must not hand over the previous holder's
   * documents. The address is the same and the provider subject is not, which
   * is the only difference that can be told apart here.
   */
  it("refuses a new subject on an address the same provider already signs in with", async () => {
    await approve("google", USER_CODE, "ada@corp.example", "sub-ada");
    const original = (await readCode())?.account_id;

    await seedCode("THIRD-CODE");
    await begin("google", "THIRD-CODE");
    const response = await callback({
      state: await startedState("THIRD-CODE"),
      oauth: oauthAnswering("ada@corp.example", "sub-successor"),
    });

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("already in use");
    expect((await readCode("THIRD-CODE"))?.account_id).toBeNull();
    expect(await accountCount()).toBe(1);
    expect(original).toBeTruthy();
  });

  it("returns a known subject to its account after the provider reports a new address", async () => {
    await approve("google", USER_CODE, "old@example.com", "sub-moved");
    const first = (await readCode())?.account_id;

    await seedCode("FOURTH-CODE");
    await approve("google", "FOURTH-CODE", "new@example.com", "sub-moved");

    expect((await readCode("FOURTH-CODE"))?.account_id).toBe(first);
    expect(await accountCount()).toBe(1);
  });

  it("cannot reuse a device code once it is approved", async () => {
    await approve();
    const owner = (await readCode())?.account_id;

    expect((await post("/approve/start/google", { user_code: USER_CODE })).status).toBe(404);
    expect((await send(`/approve?user_code=${USER_CODE}`)).status).toBe(404);
    expect((await readCode())?.account_id).toBe(owner);
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
  });

  it("answers each route on its own method and nothing else", async () => {
    expect((await post("/approve", { user_code: USER_CODE })).status).toBe(404);
    expect((await send("/approve/confirm")).status).toBe(404);
    expect((await post("/approve/callback/google", {})).status).toBe(404);
    expect((await send("/approve/start")).status).toBe(404);
    expect((await post("/approve/start/google/extra", {})).status).toBe(404);
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
   * Publishers' own scripts run on this origin, and they may only do so while
   * there is nothing on it for them to steal. `docs/http-api.md` promises it,
   * and approval keeps its handshake in the database rather than a cookie so
   * the promise stays an absolute rather than a per-host argument.
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
