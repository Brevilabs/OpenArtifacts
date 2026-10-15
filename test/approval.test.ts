import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import { handleApproval, normalizeUserCode } from "../src/approval/handler.js";
import type { OAuthClient, ProviderId } from "../src/approval/providers.js";
import { findOrCreateAccount } from "../src/db.js";
import { ACCOUNT_ID_PREFIX, newAccountId } from "../src/ids.js";
import { clientBucket } from "../src/limits.js";
import { versionObjectKey } from "../src/storage.js";
import { macHex, signPayload } from "../src/session.js";
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
    // No limiter unless a case asks for one. The limiter's state lives in the
    // runtime rather than in storage, so it does not reset between tests, and a
    // suite that looked codes up through it would start refusing itself. The
    // cases about the limit reach for `env.APPROVAL_LOOKUP_LIMITER` themselves.
    APPROVAL_LOOKUP_LIMITER: undefined,
    ...over,
  }) as Env;

async function send(path: string, init: RequestInit = {}, over: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(path.startsWith("https://") ? path : `${ORIGIN}${path}`, { redirect: "manual", ...init }),
    configured(over),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** The allowance declared on `APPROVAL_LOOKUP_LIMITER` in wrangler.jsonc. */
const LOOKUPS_PER_PERIOD = 20;

/** A lookup from one address on a deployment that declares the limiter. */
function lookupFrom(
  address: string,
  userCode = USER_CODE,
  headers: Record<string, string> = {},
): Promise<Response> {
  return send(
    `/approve?user_code=${userCode}`,
    { headers: { "cf-connecting-ip": address, ...headers } },
    { APPROVAL_LOOKUP_LIMITER: env.APPROVAL_LOOKUP_LIMITER },
  );
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
    `SELECT provider, state, verifier, confirm_token, account_id, approved_at
       FROM device_codes WHERE user_code = ?`,
  )
    .bind(userCode)
    .first<{
      provider: string | null;
      state: string | null;
      verifier: string | null;
      confirm_token: string | null;
      account_id: string | null;
      approved_at: number | null;
    }>();
}

async function accountCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

/** The `state` a started handshake left on the row, which is what a callback carries. */
async function startedState(userCode = USER_CODE): Promise<string> {
  return (await readCode(userCode))?.state ?? "";
}

/** Start a handshake the way the chooser's button does. */
function begin(provider: ProviderId = "google", userCode = USER_CODE): Promise<Response> {
  return post(`/approve/start/${provider}`, {
    user_code: userCode,
    terms: "yes",
  });
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

/**
 * The confirm token out of a rendered callback page.
 *
 * Read from the HTML rather than from the row on purpose: what the tests are
 * asserting is that the only way to obtain this value is to have received the
 * page, which is exactly what the initiator of a handshake never does.
 */
function confirmToken(html: string): string {
  return /name="confirm_token" value="([^"]+)"/.exec(html)?.[1] ?? "";
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
  return await post("/approve/confirm", {
    terms: "yes",
    confirm_token: confirmToken(await proven.text()),
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

describe("GET /approve", () => {
  it("offers every configured provider for a code that is waiting", async () => {
    const response = await send(`/approve?user_code=${USER_CODE}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Sign in with Google");
    expect(html).toContain("Sign in with GitHub");
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

    expect(html).toContain('<form class="signup" method="post" action="/approve/start/google">');
    expect(html).toContain(`name="user_code" value="${USER_CODE}"`);
    expect(html).not.toContain('href="/approve/start');
    expect((await send(`/approve/start/google?user_code=${USER_CODE}`)).status).toBe(404);
  });

  it("offers only the provider a half-configured deployment can actually finish", async () => {
    const html = await (
      await send(`/approve?user_code=${USER_CODE}`, {}, { OAUTH_GITHUB_CLIENT_SECRET: "" })
    ).text();

    expect(html).toContain("Sign in with Google");
    expect(html).not.toContain("Sign in with GitHub");
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

  /**
   * The mint returns a bare `verification_uri` for someone reading the address
   * off a terminal and typing it into a phone, so that address has to lead to
   * somewhere the code can be entered rather than to a page telling them to go
   * back for the whole link.
   */
  it("offers a form to type the code into when the url carries none", async () => {
    const response = await send("/approve");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<form method="get" action="/approve">');
    expect(html).toContain('name="user_code"');
    // A GET, because submitting it only navigates. The two presses that change
    // what a code is worth stay POSTs.
    expect(html).not.toContain('<form method="post" action="/approve">');
  });

  it("reaches the provider page when that form is submitted with a waiting code", async () => {
    const response = await send(`/approve?user_code=${USER_CODE.toLowerCase()}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign in with Google");
  });

  it("asks again rather than dead-ending when the code is malformed", async () => {
    const response = await send("/approve?user_code=not%20a%20code");
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain('<form method="get" action="/approve">');
    expect(html).toContain("does not look like a code");
  });

  it("treats a blank submission as no code at all", async () => {
    const response = await send("/approve?user_code=%20");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<form method="get" action="/approve">');
  });

  it("still says a well-formed code is gone rather than offering the form again", async () => {
    const response = await send("/approve?user_code=NOSUCHCODE");

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('<form method="get"');
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
    // Nor escaped: what was submitted is not put back in the field at all.
    expect(html).not.toContain("&lt;img");
  });
});

/**
 * A user code is short enough to read aloud, so the page that takes one says
 * whether it is live. Without a limit that is an enumeration oracle, and a hit
 * is worth having: whoever finds a pending code can approve it with their own
 * provider account, and the terminal waiting on it then collects a token for
 * *their* account (https://github.com/Brevilabs/OpenArtifacts/pull/62#discussion_r3928334751).
 */
describe("guessing a user code", () => {
  it("stops a client working through the code space, and says only that the code is gone", async () => {
    const address = "198.51.100.5";
    for (let i = 0; i < LOOKUPS_PER_PERIOD; i += 1) {
      expect((await lookupFrom(address, "ZZZZZ-ZZZZZ")).status).toBe(404);
    }

    // A live code from the same address now answers exactly like a miss, so the
    // limit tells the guesser nothing it did not already have.
    const refused = await lookupFrom(address);
    expect(refused.status).toBe(404);
    expect(await refused.text()).toContain("no longer waiting");
  });

  it("reads no row once the client is over its allowance", async () => {
    const address = "198.51.100.6";
    for (let i = 0; i < LOOKUPS_PER_PERIOD; i += 1) await lookupFrom(address, "ZZZZZ-ZZZZZ");

    // The seeded code is live, so a lookup that reached the database would say
    // so. Being refused before that read is what makes the limit a real bound.
    expect((await lookupFrom(address)).status).toBe(404);
    expect((await readCode())?.state).toBeNull();
  });

  it("leaves another client's allowance alone", async () => {
    for (let i = 0; i < LOOKUPS_PER_PERIOD; i += 1) await lookupFrom("198.51.100.7", "ZZZZZ-ZZZZZ");

    const other = await lookupFrom("198.51.100.8");
    expect(other.status).toBe(200);
    expect(await other.text()).toContain("Sign in with Google");
  });

  it("counts starting a handshake too, since that also says whether a code is live", async () => {
    const address = "198.51.100.9";
    for (let i = 0; i < LOOKUPS_PER_PERIOD; i += 1) await lookupFrom(address, "ZZZZZ-ZZZZZ");

    const refused = await send(
      "/approve/start/google",
      {
        method: "POST",
        headers: { "cf-connecting-ip": address },
        body: new URLSearchParams({ user_code: USER_CODE, terms: "yes" }),
      },
      { APPROVAL_LOOKUP_LIMITER: env.APPROVAL_LOOKUP_LIMITER },
    );

    expect(refused.status).toBe(404);
    // No handshake was written, so nothing can be completed against it.
    expect((await readCode())?.state).toBeNull();
  });
});

/**
 * A `GET` needs no preflight, so a hostile page can make any visitor's browser
 * fetch this route from their address with an `<img>` or an iframe. If those
 * were counted, twenty of them would spend that visitor's allowance and their
 * own approval would come back as an expired code
 * (https://github.com/Brevilabs/OpenArtifacts/pull/62#discussion_r3928455536).
 */
describe("a lookup a page made rather than a person", () => {
  it("refuses a subresource fetch and charges its client nothing", async () => {
    const address = "198.51.100.20";

    for (let i = 0; i < LOOKUPS_PER_PERIOD + 4; i += 1) {
      const refused = await lookupFrom(address, USER_CODE, {
        "sec-fetch-dest": i % 2 === 0 ? "image" : "iframe",
        "sec-fetch-site": "cross-site",
      });
      // The code is live, so a request that got as far as the lookup would say
      // so. It is refused before that, and told nothing a miss would not tell.
      expect(refused.status).toBe(404);
    }

    // The visitor's own approval still works, which is what proves the bucket
    // was never charged on their behalf.
    const mine = await lookupFrom(address);
    expect(mine.status).toBe(200);
    expect(await mine.text()).toContain("Sign in with Google");
  });

  it("lets a person opening the link through, and counts that", async () => {
    const address = "198.51.100.21";

    const opened = await lookupFrom(address, USER_CODE, {
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
    });
    expect(opened.status).toBe(200);

    // Charged: the rest of the allowance is what is left after that one.
    for (let i = 0; i < LOOKUPS_PER_PERIOD - 1; i += 1) await lookupFrom(address, "ZZZZZ-ZZZZZ");
    expect((await lookupFrom(address)).status).toBe(404);
  });

  it("lets a client that sends no fetch metadata through, and counts it", async () => {
    const address = "198.51.100.22";

    expect((await lookupFrom(address)).status).toBe(200);

    for (let i = 0; i < LOOKUPS_PER_PERIOD - 1; i += 1) await lookupFrom(address, "ZZZZZ-ZZZZZ");
    expect((await lookupFrom(address)).status).toBe(404);
  });

  it("refuses a handshake a page tried to start, and writes nothing", async () => {
    const refused = await send(
      "/approve/start/google",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "198.51.100.23",
          "sec-fetch-dest": "iframe",
        },
        body: new URLSearchParams({ user_code: USER_CODE, terms: "yes" }),
      },
      { APPROVAL_LOOKUP_LIMITER: env.APPROVAL_LOOKUP_LIMITER },
    );

    expect(refused.status).toBe(404);
    expect((await readCode())?.state).toBeNull();
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
    expect(
      (
        await post("/approve/start/gitlab", {
          user_code: USER_CODE,
          terms: "yes",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(
          "/approve/start/github",
          { user_code: USER_CODE, terms: "yes" },
          { OAUTH_GITHUB_CLIENT_ID: "" },
        )
      ).status,
    ).toBe(404);
  });

  it("starts nothing without a code, or with one that is no longer waiting", async () => {
    expect((await post("/approve/start/google", {})).status).toBe(400);

    await seedCode("EXPIRED-2", NOW - 1);
    expect(
      (
        await post("/approve/start/google", {
          user_code: "EXPIRED-2",
          terms: "yes",
        })
      ).status,
    ).toBe(404);
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
    expect(html).toContain("Create your free account.");
    expect(html).toContain("ada@example.com");
    expect(html).toContain(`>${USER_CODE}</div>`);

    const row = await readCode();
    expect(row?.account_id).toBeNull();
    expect(await accountCount()).toBe(0);
    // The identity is proven and the code is not approved. #57 polls the second.
    expect(row?.approved_at).toBeNull();
    // The token that can approve it exists only here and in the page above.
    expect(confirmToken(html)).toBe(row?.confirm_token);
    expect(row?.confirm_token).not.toBe(row?.state);
  });

  /**
   * Two people can complete one authorization url, and both callbacks read the
   * verifier before either exchange finishes. Only one may record an identity,
   * or a confirmation page already rendered for one of them would approve the
   * other.
   */
  it("lets only the first of two overlapping callbacks record an identity", async () => {
    const state = await startedState();

    const [first, second] = await Promise.all([
      callback({ state, oauth: oauthAnswering("ada@example.com", "sub-ada") }),
      callback({
        state,
        oauth: oauthAnswering("mallory@example.com", "sub-mallory"),
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 400]);
    const row = await readCode();
    const won = first.status === 200 ? first : second;
    expect(confirmToken(await won.text())).toBe(row?.confirm_token);
  });

  it("creates the account for the verified address only after Terms and approval", async () => {
    const html = await (await callback()).text();
    expect(await accountCount()).toBe(0);
    await post("/approve/confirm", {
      terms: "yes",
      confirm_token: confirmToken(html),
    });

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
    const response = await callback({
      query: { code: "", error: "access_denied" },
      oauth,
    });

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
   * The confirm token is the only thing a cross-site form cannot supply, which
   * is what stops a page an attacker controls from pressing this button for a
   * victim who has just proved their identity.
   */
  it("refuses a press that cannot name the handshake it is confirming", async () => {
    await begin();
    await callback();

    expect((await post("/approve/confirm", {})).status).toBe(400);
    expect(
      (
        await post("/approve/confirm", {
          terms: "yes",
          confirm_token: "guessed",
        })
      ).status,
    ).toBe(400);
    expect((await readCode())?.approved_at).toBeNull();
  });

  /**
   * The attack this token exists for. An attacker starts a handshake on their
   * own code, reads the `state` out of the redirect they are handed, and sends
   * the provider's url to a victim already signed in to that provider. The
   * victim's callback records their account on the attacker's row — and the
   * attacker must not then be able to approve it with the value they already
   * have.
   */
  it("refuses the handshake's state, which whoever started it already knows", async () => {
    const started = await begin();
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    await callback({ state });

    // The initiator has the state and nothing else.
    expect((await post("/approve/confirm", { terms: "yes", confirm_token: state })).status).toBe(
      400,
    );
    expect((await post("/approve/confirm", { state })).status).toBe(400);
    expect((await readCode())?.approved_at).toBeNull();
  });

  it("refuses a press for a handshake whose identity was never proved", async () => {
    await begin();

    const response = await post("/approve/confirm", {
      terms: "yes",
      confirm_token: await startedState(),
    });

    expect(response.status).toBe(400);
    expect((await readCode())?.approved_at).toBeNull();
  });

  it("cannot be pressed twice", async () => {
    await begin();
    const token = confirmToken(await (await callback()).text());

    expect((await post("/approve/confirm", { terms: "yes", confirm_token: token })).status).toBe(
      200,
    );
    const approvedAt = (await readCode())?.approved_at;

    expect((await post("/approve/confirm", { terms: "yes", confirm_token: token })).status).toBe(
      400,
    );
    expect((await readCode())?.approved_at).toBe(approvedAt);
  });

  it("refuses to restart after rendering confirmation and keeps that page usable", async () => {
    await begin();
    const confirmation = confirmToken(await (await callback()).text());

    expect((await begin("github")).status).toBe(404);
    expect(
      (
        await post("/approve/confirm", {
          terms: "yes",
          confirm_token: confirmation,
        })
      ).status,
    ).toBe(200);
    expect((await readCode())?.approved_at).toBeGreaterThanOrEqual(NOW);
  });

  it("refuses a press for a code that expired while the page was open", async () => {
    await begin();
    const token = confirmToken(await (await callback()).text());
    await env.DB.prepare("UPDATE device_codes SET expires_at = ? WHERE user_code = ?")
      .bind(NOW - 1, USER_CODE)
      .run();

    expect((await post("/approve/confirm", { terms: "yes", confirm_token: token })).status).toBe(
      400,
    );
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

    expect(
      (
        await post("/approve/start/google", {
          user_code: USER_CODE,
          terms: "yes",
        })
      ).status,
    ).toBe(404);
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
    const response = await send(
      `/approve?user_code=${USER_CODE}`,
      {},
      {
        SERVING_HOST: "openartifacts.workers.dev",
        API_HOST: "api.openartifacts.ai",
      },
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("This document isn’t available.");
  });

  /**
   * Both `POST` routes are unauthenticated, and reading a body buffers it
   * before the one short field it carries can be looked at.
   */
  it("refuses an oversized form rather than holding it", async () => {
    const response = await send("/approve/start/google", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `user_code=${USER_CODE}&padding=${"x".repeat(2048)}`,
    });

    expect(response.status).toBe(404);
    // Nothing was started, so no handshake exists to complete.
    expect((await readCode())?.state).toBeNull();
  });

  it("refuses an encoding this page's own buttons never send", async () => {
    const response = await send("/approve/start/google", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: new URLSearchParams({ user_code: USER_CODE, terms: "yes" }),
    });

    expect(response.status).toBe(404);
    expect((await readCode())?.state).toBeNull();
  });

  /**
   * The case a `Content-Length` check could never catch: a chunked body
   * declares no size, so the only honest bound is on bytes actually read.
   */
  it("gives up on a streamed body that passes the cap mid-read", async () => {
    await begin();
    const token = confirmToken(await (await callback()).text());

    const chunked = new Request(`${ORIGIN}/approve/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`confirm_token=${token}&padding=`));
          controller.enqueue(encoder.encode("x".repeat(4096)));
          controller.close();
        },
      }),
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(chunked, configured(), ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
    expect((await readCode())?.approved_at).toBeNull();
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
    const serving = {
      SERVING_HOST: "openartifacts.workers.dev",
      API_HOST: "api.openartifacts.ai",
    };
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

    const gone = await send(
      `/d/${DOC_ID}`,
      {},
      {
        SERVING_HOST: "openartifacts.workers.dev",
        API_HOST: "api.openartifacts.ai",
      },
    );
    expect(gone.status).toBe(410);
    expect(gone.headers.has("set-cookie")).toBe(false);

    const redirected = await send(
      `/d/${DOC_ID}`,
      {},
      {
        SERVING_HOST: "openartifacts.site",
        LEGACY_SERVING_HOST: "openartifacts.workers.dev",
      },
    );
    expect(redirected.status).toBe(307);
    expect(redirected.headers.has("set-cookie")).toBe(false);
  });
});

describe("new-account signup", () => {
  async function preference() {
    return env.DB.prepare(
      "SELECT newsletter_opt_in, newsletter_choice_at FROM accounts WHERE email = ?",
    )
      .bind("ada@example.com")
      .first<{
        newsletter_opt_in: number | null;
        newsletter_choice_at: number | null;
      }>();
  }
  async function newSignup() {
    await begin();
    return await (await callback()).text();
  }
  it("starts with enabled providers and no account agreements", async () => {
    const html = await (await send(`/approve?user_code=${USER_CODE}`)).text();
    expect(html).toContain("Sign in to OpenArtifacts.");
    expect(html).not.toContain('name="terms"');
    expect(html).not.toContain('name="newsletter"');
    expect(html).not.toContain(" disabled>");
  });
  it("asks a new user for unchecked Terms and optional checked newsletter after OAuth", async () => {
    const html = await newSignup();
    expect(html).toContain("Three published documents are free.");
    expect(html).toContain('name="terms" value="yes" required');
    expect(html).not.toContain('name="terms" value="yes" checked');
    expect(html).toContain('name="newsletter" value="yes" checked');
    expect(html).toContain("disabled>Create account and approve device");
    expect(await accountCount()).toBe(0);
  });
  it.each([undefined, "no"])(
    "cannot create an account without explicit Terms (%s)",
    async (terms) => {
      const token = confirmToken(await newSignup());
      expect(
        (
          await post("/approve/confirm", {
            confirm_token: token,
            ...(terms ? { terms } : {}),
          })
        ).status,
      ).toBe(400);
      expect(await accountCount()).toBe(0);
      expect((await readCode())?.approved_at).toBeNull();
    },
  );
  it.each([true, false])(
    "records newsletter=%s only when creating the account",
    async (checked) => {
      const token = confirmToken(await newSignup());
      expect(await preference()).toBeNull();
      expect(
        (
          await post("/approve/confirm", {
            confirm_token: token,
            terms: "yes",
            ...(checked ? { newsletter: "yes" } : {}),
          })
        ).status,
      ).toBe(200);
      const saved = await preference();
      expect(saved?.newsletter_opt_in).toBe(checked ? 1 : 0);
      expect(saved?.newsletter_choice_at).toBeTypeOf("number");
      expect((await post("/approve/confirm", { confirm_token: token, terms: "yes" })).status).toBe(
        400,
      );
      await seedCode();
      const html = await newSignup();
      expect(html).not.toContain('name="terms"');
      expect(html).not.toContain('name="newsletter"');
      expect(
        (
          await post("/approve/confirm", {
            confirm_token: confirmToken(html),
            newsletter: checked ? "no" : "yes",
          })
        ).status,
      ).toBe(200);
      expect(await preference()).toEqual(saved);
    },
  );
  it("skips agreements for an existing account even without a newsletter preference", async () => {
    await approve("google", USER_CODE, "ada@example.com", "sub-ada@example.com");
    await env.DB.prepare(
      "UPDATE accounts SET newsletter_opt_in = NULL, newsletter_choice_at = NULL",
    ).run();
    await seedCode();
    const html = await newSignup();
    expect(html).not.toContain('name="terms"');
    expect(html).not.toContain('name="newsletter"');
    expect(
      (
        await post("/approve/confirm", {
          confirm_token: confirmToken(html),
          newsletter: "yes",
        })
      ).status,
    ).toBe(200);
    expect(await preference()).toEqual({
      newsletter_opt_in: null,
      newsletter_choice_at: null,
    });
  });
  it.each(["deny", "expire"])("creates nothing after %s", async (outcome) => {
    const token = confirmToken(await newSignup());
    if (outcome === "deny") await post("/approve/deny", { confirm_token: token });
    else await env.DB.prepare("UPDATE device_codes SET expires_at = 0").run();
    expect(
      (
        await post("/approve/confirm", {
          confirm_token: token,
          terms: "yes",
          newsletter: "yes",
        })
      ).status,
    ).toBe(400);
    expect(await accountCount()).toBe(0);
  });
  it("rolls back account creation if approval fails", async () => {
    const token = confirmToken(await newSignup());
    await env.DB.prepare(
      "CREATE TRIGGER fail_approval BEFORE UPDATE OF approved_at ON device_codes BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    ).run();
    expect(
      (
        await post("/approve/confirm", {
          confirm_token: token,
          terms: "yes",
          newsletter: "yes",
        })
      ).status,
    ).toBe(500);
    expect(await accountCount()).toBe(0);
    expect((await readCode())?.approved_at).toBeNull();
  });
  it.each([true, false])(
    "safely resolves overlapping new signups with sameSubject=%s",
    async (sameSubject) => {
      await seedCode("SECOND-CODE");
      await begin("google", USER_CODE);
      const first = confirmToken(
        await (
          await callback({
            oauth: oauthAnswering("ada@example.com", "subject-first"),
          })
        ).text(),
      );
      await begin("google", "SECOND-CODE");
      const second = confirmToken(
        await (
          await callback({
            state: await startedState("SECOND-CODE"),
            oauth: oauthAnswering(
              sameSubject ? "other@example.com" : "ada@example.com",
              sameSubject ? "subject-first" : "subject-second",
            ),
          })
        ).text(),
      );
      const results = await Promise.all([
        post("/approve/confirm", {
          confirm_token: first,
          terms: "yes",
          newsletter: "yes",
        }),
        post("/approve/confirm", { confirm_token: second, terms: "yes" }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(sameSubject ? [200, 200] : [200, 400]);
      expect(await accountCount()).toBe(1);
      const ids = [
        (await readCode())?.account_id,
        (await readCode("SECOND-CODE"))?.account_id,
      ].filter(Boolean);
      expect(new Set(ids).size).toBe(1);
    },
  );
});

describe("reader sign-in", () => {
  const API = "https://api.openartifacts.ai";
  const SERVING = "https://openartifacts.site";
  const DOC_ID = "0123456789abcdef";
  const NEXT = `/open/${DOC_ID}`;
  const SECRET = "k".repeat(32);
  const hosts = {
    SERVING_HOST: "openartifacts.site",
    API_HOST: "api.openartifacts.ai",
    READER_SESSION_SECRET: SECRET,
  } satisfies Partial<Env>;

  const asBrowser = (path: string, cookie: string, over: Partial<Env> = hosts) =>
    send(path, { headers: { cookie } }, over);

  /** An address the Email Service would deliver to; the messages are kept for the test to read. */
  function mailbox() {
    const sent: Array<{ to: string; subject: string }> = [];
    const over = {
      ...hosts,
      EMAIL: { send: async (message: { to: string; subject: string }) => void sent.push(message) },
      EMAIL_FROM: "share@mail.openartifacts.ai",
      // The limiters keep their state across tests; the cases about them ("mails
      // a code at most ..." below) reach for the bindings themselves.
      SIGNIN_EMAIL_LIMITER: undefined,
      SIGNIN_EMAIL_CLIENT_LIMITER: undefined,
    } as Partial<Env>;
    const code = () => /(\d{6}) is your/.exec(sent.at(-1)?.subject ?? "")?.[1] ?? "";
    return { sent, over, code };
  }

  /** Start a Google handshake as a browser would, returning its login cookie and state. */
  async function startGoogle(next = NEXT) {
    const started = await post(`${API}/signin/start/google`, { next }, hosts);
    expect(started.status).toBe(303);
    return {
      started,
      login: started.headers.get("set-cookie")!.split(";")[0]!,
      state: new URL(started.headers.get("location")!).searchParams.get("state")!,
    };
  }

  /** The provider's redirect back, with the login cookie of the browser that started it (or none). */
  function callbackTo(state: string, cookie: string | undefined, email: string, subject?: string) {
    const url = new URL(`${API}/approve/callback/google?state=${state}&code=authorization-code`);
    return handleApproval(new Request(url, cookie ? { headers: { cookie } } : {}), url, configured(hosts), {
      now: () => NOW,
      oauth: oauthAnswering(email, subject),
    });
  }

  /** Every `Set-Cookie` of a response, one entry each. */
  const cookiesOf = (response: Response) => (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie();

  const LOGIN_CLEARED = /^__Host-oa_login=; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=0$/;

  it("sets a session only on the API host, only for the browser that started it, and /api/v1 ignores it", async () => {
    await findOrCreateAccount(env.DB, newAccountId(), "alice@acme.com", NOW);

    const { started, login, state } = await startGoogle();
    expect(started.headers.get("set-cookie")).toMatch(
      /^__Host-oa_login=.+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/,
    );

    // A callback link forwarded to somebody who never started the handshake: they
    // hold no login cookie, or one from a handshake of their own.
    const theirs = await startGoogle();
    for (const cookie of [undefined, theirs.login]) {
      const forwarded = await callbackTo(state, cookie, "alice@acme.com");
      expect(forwarded.status).toBe(400);
      expect(forwarded.headers.get("set-cookie")).toBeNull();
    }

    const signedIn = await callbackTo(state, login, "alice@acme.com");
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe(NEXT);
    // The session, and the login cookie it has made useless, cleared in the same response.
    const [session, cleared, ...others] = cookiesOf(signedIn);
    expect(session).toMatch(/^__Host-oa_session=.+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    expect(cleared).toMatch(LOGIN_CLEARED);
    expect(others).toEqual([]);
    const cookie = session!.split(";")[0]!;

    // The session is recognised where it is meant to be: /open names the signed-in address.
    const opened = await asBrowser(`${API}${NEXT}`, cookie);
    expect(opened.status).toBe(404);
    expect(await opened.text()).toContain("alice@acme.com");
    // And nowhere else: the bearer API refuses it, and the document host neither reads nor sets one.
    expect((await asBrowser(`${API}/api/v1/docs`, cookie)).status).toBe(401);
    const document = await asBrowser(`${SERVING}/d/${DOC_ID}`, cookie);
    expect(document.status).toBe(404);
    expect(document.headers.get("set-cookie")).toBeNull();
  });

  it("clears the login cookie on every exit once the browser is proved, and says nothing a terminal would", async () => {
    // Cancelled at the provider: no `code`.
    const cancelled = await startGoogle();
    const url = new URL(`${API}/approve/callback/google?state=${cancelled.state}&error=access_denied`);
    const refused = await handleApproval(
      new Request(url, { headers: { cookie: cancelled.login } }),
      url,
      configured(hosts),
      { now: () => NOW, oauth: oauthAnswering("x@acme.com") },
    );
    expect(refused.status).toBe(400);
    expect(cookiesOf(refused)).toHaveLength(1);
    expect(cookiesOf(refused)[0]).toMatch(LOGIN_CLEARED);
    const refusedHtml = await refused.text();
    expect(refusedHtml).toContain(`href="${NEXT}"`);
    expect(refusedHtml).toContain("Try again");

    // A new address: the Terms page, in the reader's words, with the login cookie already spent.
    const fresh = await startGoogle(`/share/${DOC_ID}`);
    const terms = await callbackTo(fresh.state, fresh.login, "new@acme.com");
    expect(terms.status).toBe(200);
    expect(cookiesOf(terms)).toHaveLength(1);
    expect(cookiesOf(terms)[0]).toMatch(LOGIN_CLEARED);
    const html = await terms.text();
    expect(html).toContain("to manage this document");
    expect(html).toContain('href="https://openartifacts.ai/privacy"');
    expect(html).toContain('href="https://openartifacts.ai/terms"');
    expect(html).not.toContain('name="newsletter"');
    expect(html).not.toContain("terminal");

    // The address another sign-in with this provider already holds: the reader refusal, not the device page.
    const alice = await findOrCreateAccount(env.DB, newAccountId(), "alice@acme.com", NOW);
    await env.DB.prepare("INSERT INTO identities (provider, subject, account_id, created_at) VALUES ('google', 'sub-old', ?, ?)")
      .bind(alice.id, NOW)
      .run();
    const claimed = await startGoogle();
    const other = await callbackTo(claimed.state, claimed.login, "alice@acme.com", "sub-new");
    expect(other.status).toBe(409);
    expect(cookiesOf(other)[0]).toMatch(LOGIN_CLEARED);
    const claimedHtml = await other.text();
    expect(claimedHtml).toContain("That address already belongs to another Google sign-in. Try your other provider.");
    expect(claimedHtml).not.toContain("Approve with your other provider");
  });

  it("answers an expired callback in the reader's words when the browser holds a login cookie, and the terminal's otherwise", async () => {
    const { login } = await startGoogle();
    const gone = await callbackTo("a-state-nobody-started", login, "alice@acme.com");
    expect(gone.status).toBe(400);
    const html = await gone.text();
    expect(html).toContain(`href="${NEXT}"`);
    expect(html).not.toContain("terminal");
    // Nothing of ours in the request: the page a terminal's user would see.
    expect(await (await callbackTo("a-state-nobody-started", undefined, "alice@acme.com")).text()).toContain("terminal");
  });

  it("takes a new provider account through the Terms and signs it in, and keeps its token out of the device approval", async () => {
    const { login, state } = await startGoogle();
    const terms = await callbackTo(state, login, "carol@acme.com");
    const token = confirmToken(await terms.text());
    expect(token).not.toBe("");

    // The device approval's presses only take a device's token.
    for (const path of ["/approve/confirm", "/approve/deny"]) {
      const refused = await post(path, { confirm_token: token, terms: "yes" });
      expect(refused.status).toBe(400);
    }
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE email = 'carol@acme.com'").first()).toBeNull();

    // Its own press, without the Terms and then with them.
    const declined = await post(`${API}/signin/confirm`, { confirm_token: token, next: NEXT }, hosts);
    expect(declined.headers.get("set-cookie")).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE email = 'carol@acme.com'").first()).toBeNull();
    // The Terms page comes back for the same handshake, not a failure, and its token still works.
    expect(declined.status).toBe(200);
    const again = await declined.text();
    expect(again).toContain("carol@acme.com");
    expect(confirmToken(again)).toBe(token);
    expect((await post(`${API}/signin/confirm`, { confirm_token: token, terms: "yes", next: NEXT }, hosts)).status).toBe(303);
  });

  it("completes a new provider account's sign-in when the Terms are accepted", async () => {
    const { login, state } = await startGoogle();
    const token = confirmToken(await (await callbackTo(state, login, "carol@acme.com")).text());
    const accepted = await post(`${API}/signin/confirm`, { confirm_token: token, terms: "yes", next: NEXT }, hosts);
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe(NEXT);
    expect(accepted.headers.get("set-cookie")).toContain("__Host-oa_session=");
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE email = 'carol@acme.com'").first()).not.toBeNull();
  });

  it("offers only the configured methods and names no address on the first screen", async () => {
    const { over } = mailbox();
    const both = await (await send(`${API}${NEXT}`, {}, over)).text();
    expect(both).toContain("Sign in or create an account to open this document");
    expect(both).toContain(
      "The owner shared it with specific people. Sign in with the address they invited. New here? Signing in creates a free account.",
    );
    expect(both).toContain("Sign in with Google");
    expect(both).toContain("Sign in with GitHub");
    expect(both).toContain("Email me a code");
    expect(both).toContain(">or</p>");
    expect(both).not.toContain("@");

    // Only a method that exists is offered, and the divider needs two.
    // (The test pool declares an Email binding, so "no email" is said outright.)
    const providersOnly = await (await send(`${API}${NEXT}`, {}, { ...hosts, EMAIL: undefined })).text();
    expect(providersOnly).toContain("Sign in with Google");
    expect(providersOnly).not.toContain("Email me a code");
    expect(providersOnly).not.toContain(">or</p>");
    const emailOnly = await (await send(`${API}${NEXT}`, {}, { ...over, OAUTH_GOOGLE_CLIENT_ID: "", OAUTH_GOOGLE_CLIENT_SECRET: "", OAUTH_GITHUB_CLIENT_ID: "", OAUTH_GITHUB_CLIENT_SECRET: "" })).text();
    expect(emailOnly).toContain("Email me a code");
    expect(emailOnly).not.toContain("Sign in with Google");
    expect(emailOnly).not.toContain("Sign in with GitHub");
    expect(emailOnly).not.toContain(">or</p>");
  });

  it("lays the sign-in page out with even spacing and wraps long values inside the card", async () => {
    const { over } = mailbox();
    const html = await (await send(`${API}${NEXT}`, {}, over)).text();
    // The divider is a class, not inline margins, and the email form that follows it adds no gap of its own.
    expect(html).toContain('<p class="terms divider">or</p>');
    expect(html).toContain(".divider + .signup .actions { margin-top: 1rem; }");
    // A stacked field takes no margin of its own: the column's gap spaces it, as it does the buttons.
    expect(html).toContain(".signup .actions input { margin-top: 0; }");
    // A long address or title in a heading or message wraps instead of overflowing the card.
    expect(html).toMatch(/h1 \{[^}]*overflow-wrap: anywhere/);
    expect(html).toMatch(/\n {2}p \{[^}]*overflow-wrap: anywhere/);
    // An address inside a heading sits on its own line at half the heading's size, so a typical one fits the card.
    expect(html).toContain("h1 bdi { display: block;");
  });

  it("sends a code to any address and gives the same page for each, telling whoever typed it nothing", async () => {
    const { sent, over } = mailbox();
    await findOrCreateAccount(env.DB, newAccountId(), "linked@acme.com", NOW);
    const backed = await findOrCreateAccount(env.DB, newAccountId(), "google@acme.com", NOW);
    await env.DB.prepare("INSERT INTO identities (provider, subject, account_id, created_at) VALUES ('google', 'sub-g', ?, ?)")
      .bind(backed.id, NOW)
      .run();

    const pages: string[] = [];
    for (const address of ["new@acme.com", "linked@acme.com", "google@acme.com"]) {
      const asked = await post(`${API}/signin/email`, { email: address, next: NEXT }, over);
      expect(asked.status).toBe(200);
      pages.push((await asked.text()).replaceAll(address, "ADDRESS"));
    }
    expect(sent.map((message) => message.to)).toEqual(["new@acme.com", "linked@acme.com", "google@acme.com"]);
    expect(new Set(pages).size).toBe(1);
    expect(pages[0]).toContain("We sent a 6-digit code");
    expect(pages[0]).not.toContain('name="terms"');
    expect(pages[0]).not.toContain("Google");
  });

  it("stores the code under a keyed hash, so reading the table does not reveal it", async () => {
    const { over, code } = mailbox();
    await post(`${API}/signin/email`, { email: "bob@acme.com", next: NEXT }, over);
    const stored = (await env.DB.prepare("SELECT code_hash FROM email_codes WHERE email = 'bob@acme.com'").first<{ code_hash: string }>())!.code_hash;

    const bytes = new TextEncoder().encode(`bob@acme.com:${code()}`);
    const plain = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(stored).not.toBe(plain);
    expect(stored).toBe(await macHex(SECRET, "email-code", `bob@acme.com:${code()}`));
  });

  it("refuses a correct code for an address that signs in with Google, after the code is checked and spent", async () => {
    const { sent, over, code } = mailbox();
    const alice = await findOrCreateAccount(env.DB, newAccountId(), "alice@acme.com", NOW);
    await env.DB.prepare("INSERT INTO identities (provider, subject, account_id, created_at) VALUES ('google', 'sub-alice', ?, ?)")
      .bind(alice.id, NOW)
      .run();

    await post(`${API}/signin/email`, { email: "alice@acme.com", next: NEXT }, over);
    expect(sent).toHaveLength(1);

    // A wrong code is just a wrong code, whatever the address is.
    const wrong = await post(`${API}/signin/code`, { email: "alice@acme.com", code: "000000", next: NEXT }, over);
    expect(await wrong.text()).toContain("That code didn’t match.");

    const refused = await post(`${API}/signin/code`, { email: "alice@acme.com", code: code(), next: NEXT }, over);
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(await refused.text()).toContain("That address signs in with Google or GitHub. Use that instead.");
    // The code is spent: it cannot be tried again for anything.
    expect(await env.DB.prepare("SELECT 1 FROM email_codes WHERE email = 'alice@acme.com'").first()).toBeNull();
  });

  it("allows five wrong guesses per code, and asking again neither resets the count nor replaces a used-up code", async () => {
    const { sent, over, code } = mailbox();
    const guess = (value: string) => post(`${API}/signin/code`, { email: "guess@acme.com", code: value, next: NEXT }, over);
    const attempts = async () =>
      (await env.DB.prepare("SELECT attempts FROM email_codes WHERE email = 'guess@acme.com'").first<{ attempts: number }>())?.attempts;

    await post(`${API}/signin/email`, { email: "guess@acme.com", next: NEXT }, over);
    await guess("000000");
    await guess("000000");
    expect(await attempts()).toBe(2);

    // Asking again sends a fresh code, but the two wrong guesses still count.
    await post(`${API}/signin/email`, { email: "guess@acme.com", next: NEXT }, over);
    expect(sent).toHaveLength(2);
    expect(await attempts()).toBe(2);

    const current = code();
    const wrong = current === "000001" ? "000002" : "000001";
    for (let n = 0; n < 3; n += 1) {
      expect(await (await guess(wrong)).text()).toContain("That code didn’t match.");
    }

    // The right code after five wrong guesses is refused, and nothing is created.
    const late = await guess(current);
    expect(late.headers.get("set-cookie")).toBeNull();
    expect(await late.text()).toContain("That code has expired or been used up");
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE email = 'guess@acme.com'").first()).toBeNull();

    // A used-up code cannot be replaced until it expires: no mail, and the count stays.
    const again = await post(`${API}/signin/email`, { email: "guess@acme.com", next: NEXT }, over);
    expect(again.status).toBe(429);
    expect(sent).toHaveLength(2);
    expect(await attempts()).toBe(5);
  });

  it("mails a code to an address at most three times a minute, and to one client at most as often as its limiter allows", async () => {
    const { sent, over } = mailbox();
    const perAddress = { ...over, SIGNIN_EMAIL_LIMITER: env.SIGNIN_EMAIL_LIMITER };
    const ask = (email: string, headers: Record<string, string>, extra: Partial<Env>) =>
      send(
        `${API}/signin/email`,
        { method: "POST", body: new URLSearchParams({ email, next: NEXT }), headers },
        extra,
      );

    // The real per-address binding from wrangler.jsonc: three, then the page that says to wait.
    for (let n = 0; n < 3; n += 1) {
      expect((await ask("limited@acme.com", {}, perAddress)).status).toBe(200);
    }
    const fourth = await ask("limited@acme.com", {}, perAddress);
    expect(fourth.status).toBe(429);
    expect(sent).toHaveLength(3);
    // Another address is not held back by it.
    expect((await ask("other-limited@acme.com", {}, perAddress)).status).toBe(200);

    // The per-client limiter is keyed on the caller, never on the address typed,
    // and a refusal stores and sends nothing.
    const keys: string[] = [];
    const refusing = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } as RateLimit;
    const before = sent.length;
    const refused = await ask("client-limited@acme.com", { "cf-connecting-ip": "203.0.113.9" }, { ...over, SIGNIN_EMAIL_CLIENT_LIMITER: refusing });
    expect(refused.status).toBe(429);
    expect(sent).toHaveLength(before);
    expect(await env.DB.prepare("SELECT 1 FROM email_codes WHERE email = 'client-limited@acme.com'").first()).toBeNull();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(await clientBucket(new Request(API, { headers: { "cf-connecting-ip": "203.0.113.9" } })));

    // A client already refused does not spend the address's allowance: the real
    // owner of the address still gets their code after the abuser's attempts.
    const abuser = { ...perAddress, SIGNIN_EMAIL_CLIENT_LIMITER: refusing };
    for (let n = 0; n < 4; n += 1) expect((await ask("victim@acme.com", {}, abuser)).status).toBe(429);
    expect((await ask("victim@acme.com", {}, perAddress)).status).toBe(200);
  });

  it("signs in an address whose account has no provider, such as one Copilot linking created", async () => {
    const { over, code } = mailbox();
    const linked = await findOrCreateAccount(env.DB, newAccountId(), "linked@acme.com", NOW);
    await post(`${API}/signin/email`, { email: "linked@acme.com", next: NEXT }, over);

    const signedIn = await post(`${API}/signin/code`, { email: "linked@acme.com", code: code(), next: NEXT }, over);
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe(NEXT);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    // The session is the existing account's: /open names its address.
    expect(await (await asBrowser(`${API}${NEXT}`, cookie, over)).text()).toContain("linked@acme.com");
    expect(linked.id).toBeTruthy();
  });

  it("takes an address with no account through the Terms once the code is right, and only then creates it", async () => {
    const { over, code } = mailbox();
    await post(`${API}/signin/email`, { email: "new@acme.com", next: `/share/${DOC_ID}` }, over);

    // The page that asked for the code carried no Terms, and a wrong code creates nothing.
    await post(`${API}/signin/code`, { email: "new@acme.com", code: "000000", next: `/share/${DOC_ID}` }, over);
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE email = 'new@acme.com'").first()).toBeNull();

    const checked = await post(`${API}/signin/code`, { email: "new@acme.com", code: code(), next: `/share/${DOC_ID}` }, over);
    expect(checked.status).toBe(200);
    expect(checked.headers.get("set-cookie")).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE email = 'new@acme.com'").first()).toBeNull();
    const html = await checked.text();
    expect(html).toContain("to manage this document");
    expect(html).toContain('href="https://openartifacts.ai/privacy"');
    expect(html).toContain('action="/signin/confirm-email"');
    expect(html).not.toContain('name="newsletter"');
    const token = /name="signup_token" value="([^"]+)"/.exec(html)![1]!;

    // Pressing without the Terms creates nothing; a forged token is refused.
    const without = await post(`${API}/signin/confirm-email`, { signup_token: token, next: `/share/${DOC_ID}` }, over);
    expect(without.status).toBe(200);
    expect(without.headers.get("set-cookie")).toBeNull();
    expect((await post(`${API}/signin/confirm-email`, { signup_token: `${token}x`, terms: "yes", next: `/share/${DOC_ID}` }, over)).status).toBe(400);
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE email = 'new@acme.com'").first()).toBeNull();

    const accepted = await post(`${API}/signin/confirm-email`, { signup_token: token, terms: "yes", next: `/share/${DOC_ID}` }, over);
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe(`/share/${DOC_ID}`);
    expect(accepted.headers.get("set-cookie")).toContain("__Host-oa_session=");
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE email = 'new@acme.com'").first()).not.toBeNull();
  });

  it("will not turn a code-earned token into a session for an address a provider took in the meantime", async () => {
    const { over } = mailbox();
    const token = await signPayload(SECRET, "signup", { e: "race@acme.com" }, Date.now() + 60_000);
    const taken = await findOrCreateAccount(env.DB, newAccountId(), "race@acme.com", NOW);
    await env.DB.prepare("INSERT INTO identities (provider, subject, account_id, created_at) VALUES ('github', 'sub-r', ?, ?)")
      .bind(taken.id, NOW)
      .run();

    const raced = await post(`${API}/signin/confirm-email`, { signup_token: token, terms: "yes", next: NEXT }, over);
    expect(raced.headers.get("set-cookie")).toBeNull();
    expect(await raced.text()).toContain("signs in with Google or GitHub");
    // A token minted for another purpose is not a signup token.
    const session = await signPayload(SECRET, "session", { e: "race@acme.com" }, Date.now() + 60_000);
    expect((await post(`${API}/signin/confirm-email`, { signup_token: session, terms: "yes", next: NEXT }, over)).status).toBe(400);
  });

  it("offers Try again at the share page's sign-in page, not its visitor view, after a failed sign-in", async () => {
    // With no session /share/{id} shows a public document's visitor view, which has
    // no provider buttons: a retry that led there would look as though nothing happened.
    const share = `/share/${DOC_ID}`;
    const tryAgain = (html: string) => /<a href="([^"]*)">Try again<\/a>/.exec(html)?.[1];

    // The provider sent Cancel.
    const cancelled = await startGoogle(share);
    const cancelUrl = new URL(`${API}/approve/callback/google?state=${cancelled.state}&error=access_denied`);
    const refused = await handleApproval(new Request(cancelUrl, { headers: { cookie: cancelled.login } }), cancelUrl, configured(hosts), {
      now: () => NOW,
      oauth: oauthAnswering("x@acme.com"),
    });
    expect(tryAgain(await refused.text())).toBe(`${share}?signin`);

    // The handshake expired while the person was at the provider.
    const { login } = await startGoogle(share);
    const expired = await callbackTo("a-state-nobody-started", login, "alice@acme.com");
    expect(expired.status).toBe(400);
    expect(tryAgain(await expired.text())).toBe(`${share}?signin`);

    // The address another sign-in with this provider already holds.
    const alice = await findOrCreateAccount(env.DB, newAccountId(), "alice@acme.com", NOW);
    await env.DB.prepare("INSERT INTO identities (provider, subject, account_id, created_at) VALUES ('google', 'sub-old', ?, ?)")
      .bind(alice.id, NOW)
      .run();
    const claimed = await startGoogle(share);
    const other = await callbackTo(claimed.state, claimed.login, "alice@acme.com", "sub-new");
    expect(other.status).toBe(409);
    expect(tryAgain(await other.text())).toBe(`${share}?signin`);

    // A path that already asks for the sign-in page, and the other return paths, are kept as they are.
    const picked = await startGoogle(`${share}?signin`);
    const again = await callbackTo("a-state-nobody-started", picked.login, "alice@acme.com");
    expect(tryAgain(await again.text())).toBe(`${share}?signin`);
    const opened = await startGoogle(`/open/${DOC_ID}`);
    expect(tryAgain(await (await callbackTo("a-state-nobody-started", opened.login, "alice@acme.com")).text())).toBe(`/open/${DOC_ID}`);
  });

  it("returns only to an /open, /share or popup path, and to nothing else", async () => {
    const out = (next: string, init: Record<string, string> = {}) =>
      send(`${API}/signin/out`, { method: "POST", body: new URLSearchParams({ next }), headers: init }, hosts);

    for (const next of [`/open/${DOC_ID}`, `/open/${DOC_ID}/v2`, `/share/${DOC_ID}`, `/share/${DOC_ID}/`]) {
      const response = await out(next);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(next.replace(/\/$/, ""));
      expect(response.headers.get("set-cookie")).toMatch(/^__Host-oa_session=; .*Max-Age=0$/);
    }
    // A share path may carry a bare ?signin, which picks the sign-in page; nothing else rides along.
    expect((await out(`/share/${DOC_ID}?signin`)).headers.get("location")).toBe(`/share/${DOC_ID}?signin`);
    // The Share popover's popup returns to itself, with its nonce hash and nothing else.
    const H = "ab".repeat(32);
    const popup = `/embed/sign-in?doc=${DOC_ID}&h=${H}`;
    expect((await out(popup)).headers.get("location")).toBe(popup);
    expect((await out(`${popup}&switch=1`)).headers.get("location")).toBe(popup);
    expect((await out(`/embed/sign-in?h=${H}&doc=${DOC_ID}&x=1`)).headers.get("location")).toBe(popup);
    for (const next of [
      `/embed/sign-in?doc=${DOC_ID}&h=${H.slice(1)}`,
      `/embed/sign-in?doc=${DOC_ID}&h=${H.toUpperCase()}`,
      `/embed/sign-in?h=${H}`,
      `/embed/sign-in?doc=${DOC_ID}`,
      `/embed/sign-in?doc=nope&h=${H}`,
      `/embed/sign-in/x?doc=${DOC_ID}&h=${H}`,
      `/embed/sign-in?doc=${DOC_ID}&h=${H}#frag`,
      `//evil.example/embed/sign-in?doc=${DOC_ID}&h=${H}`,
      `https://evil.example/embed/sign-in?doc=${DOC_ID}&h=${H}`,
      `/embed/share?doc=${DOC_ID}&h=${H}`,
      `/embed/sign-in`,
    ]) {
      const response = await out(next);
      expect(response.status, next).toBe(404);
      expect(response.headers.get("location")).toBeNull();
    }
    for (const next of [
      `/open/${DOC_ID}/request`,
      `/share/${DOC_ID}/v1`,
      `/share/${DOC_ID}/extra`,
      `/share/${DOC_ID}?x=1`,
      `/share/${DOC_ID}?signin&x=1`,
      `/share/${DOC_ID}?signin=1`,
      `/share/${DOC_ID}/v1?signin`,
      `/open/${DOC_ID}?signin`,
      `/share/${DOC_ID}?signin#frag`,
      `/share/${DOC_ID}#frag`,
      "/share",
      "//evil.example/share/" + DOC_ID,
      `https://evil.example/open/${DOC_ID}`,
      "/api/v1/docs",
      "",
    ]) {
      const response = await out(next);
      expect(response.status, next).toBe(404);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("refuses a sign-in form posted from another site, and holds a browser with no Fetch Metadata to its Origin", async () => {
    const { over, sent } = mailbox();
    const asked = (headers: Record<string, string>) =>
      send(`${API}/signin/email`, { method: "POST", body: new URLSearchParams({ email: "bob@acme.com", next: NEXT }), headers }, over);

    const foreign: Array<Record<string, string>> = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "https://evil.example" },
      { origin: "null" },
    ];
    for (const headers of foreign) {
      expect((await asked(headers)).status).toBe(404);
    }
    expect(sent).toHaveLength(0);

    const ours: Array<Record<string, string>> = [{ "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }, { origin: API }, {}];
    for (const headers of ours) {
      expect((await asked(headers)).status).toBe(200);
    }
    // `Origin: null` above is what a form posted from a no-referrer page sends, so
    // these pages must not be no-referrer: they keep their real Origin.
    expect((await asked({})).headers.get("referrer-policy")).toBe("same-origin");
  });
});
