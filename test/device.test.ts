import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleApproval, normalizeUserCode } from "../src/approval/handler.js";
import type { OAuthClient, ProviderId } from "../src/approval/providers.js";
import {
  DEVICE_CODE_TTL_MS,
  DEVICE_POLL_INTERVAL_SECONDS,
  MAX_TOKENS_PER_ACCOUNT,
} from "../src/config.js";
import { handleDevice, readDeviceLabel } from "../src/device.js";
import type { Env } from "../src/config.js";
import { collectDeviceToken, confirmDeviceApproval, holdProvenIdentity } from "../src/db.js";
import { sha256Hex } from "../src/hash.js";
import {
  newApiToken,
  TOKEN_ID_PREFIX,
  TOKEN_PREFIX,
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
} from "../src/ids.js";
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

/**
 * The limit declared on the binding in wrangler.jsonc. Not readable from the
 * binding itself, which reports a verdict and no numbers, so a change there has
 * to be made here too.
 */
const MINTS_PER_PERIOD = 5;

/**
 * A deployment with no limiter declared, which is the supported self-hosted
 * shape and the one almost every case here wants: the limiter's state lives in
 * the runtime rather than in storage, so it does *not* reset between tests, and
 * a suite that minted through it would start refusing itself. The cases that
 * are about the limit reach for `env.DEVICE_CODE_LIMITER` explicitly, each with
 * an address of its own.
 */
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
    DEVICE_CODE_LIMITER: undefined,
    APPROVAL_LOOKUP_LIMITER: undefined,
    DEVICE_POLL_LIMITER: undefined,
    DEVICE_POLL_CLIENT_LIMITER: undefined,
    ...over,
  }) as Env;

/** The same deployment with the limiter the hosted one declares. */
const limited = (): Env => configured({ DEVICE_CODE_LIMITER: env.DEVICE_CODE_LIMITER });

function request(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Straight at the handler, where the clock is injectable. */
function device(
  path: string,
  body?: unknown,
  now = NOW,
  headers: Record<string, string> = {},
  over: Env = configured(),
) {
  const url = new URL(`${ORIGIN}${path}`);
  return handleDevice(request(path, body, headers), url, over, { now: () => now });
}

/** A mint from one address through a deployment that declares the limiter. */
const mintFrom = (address: string) =>
  device("/device/code", undefined, NOW, { "cf-connecting-ip": address }, limited());

/**
 * A mint whose content type and body are whatever the caller says, which is how
 * a request a browser would send cross-site without a preflight is reproduced.
 */
function crossSiteMint(contentType: string, body: string, address: string): Promise<Response> {
  const url = new URL(`${ORIGIN}/device/code`);
  const raw = new Request(url, {
    method: "POST",
    headers: { "content-type": contentType, "cf-connecting-ip": address },
    body,
  });
  return handleDevice(raw, url, limited(), { now: () => NOW });
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

const tokenExists = async (id: string): Promise<boolean> =>
  (await env.DB.prepare("SELECT id FROM tokens WHERE id = ?").bind(id).first<{ id: string }>()) !==
  null;

async function codeRow(userCode: string) {
  return await env.DB.prepare(
    `SELECT device_code_hash, label, approved_at, denied_at, expires_at
       FROM device_codes WHERE user_code = ?`,
  )
    .bind(userCode)
    .first<{
      device_code_hash: string | null;
      label: string | null;
      approved_at: number | null;
      denied_at: number | null;
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
      new RegExp(`^[${USER_CODE_ALPHABET}]{5}-[${USER_CODE_ALPHABET}]{5}$`),
    );
    expect(normalizeUserCode(user_code)).toBe(user_code);
    // Ten characters of a twenty-letter alphabet, which is 2^43.2.
    expect(user_code.replace("-", "")).toHaveLength(USER_CODE_LENGTH);
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

  /**
   * A page anybody visits can fire a form-encoded or text/plain POST at an
   * unauthenticated endpoint without a preflight. If the limiter were charged
   * before the request was validated, that page would spend a visitor's next
   * sign-in for them (https://github.com/Brevilabs/OpenArtifacts/pull/62#discussion_r3927574066).
   */
  it("refuses a request a browser could send cross-site without spending its bucket", async () => {
    const address = "203.0.113.20";

    for (let i = 0; i < MINTS_PER_PERIOD + 3; i += 1) {
      const refused = await crossSiteMint(
        i % 2 === 0 ? "application/x-www-form-urlencoded" : "text/plain;charset=UTF-8",
        i % 2 === 0 ? "label=drive-by" : '{"label":"drive-by"}',
        address,
      );
      expect(refused.status).toBe(400);
      expect(await errorOf(refused)).toBe("bad_request");
    }

    // The bucket is untouched, so the visitor's own sign-in still works.
    expect((await mintFrom(address)).status).toBe(200);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM device_codes").first<{
      n: number;
    }>())!;
    expect(n).toBe(1);
  });

  it("refuses a malformed JSON body before charging the bucket too", async () => {
    const address = "203.0.113.21";

    for (let i = 0; i < MINTS_PER_PERIOD + 1; i += 1) {
      expect((await crossSiteMint("application/json", "not json", address)).status).toBe(400);
    }

    expect((await mintFrom(address)).status).toBe(200);
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

  it("refuses a client that has spent its period's worth of codes", async () => {
    for (let i = 0; i < MINTS_PER_PERIOD; i += 1) {
      expect((await mintFrom("203.0.113.7")).status).toBe(200);
    }

    const refused = await mintFrom("203.0.113.7");
    expect(refused.status).toBe(429);
    expect(await errorOf(refused)).toBe("quota_exceeded");
    expect(refused.headers.get("retry-after")).toBe("60");
  });

  /**
   * The published binding reference documents no ceiling on key length and the
   * runtime checks only that a key is a string, but a review raised a possible
   * 32-byte cap, and a key over one would fail every hosted mint
   * (https://github.com/Brevilabs/OpenArtifacts/pull/62#discussion_r3928334734).
   */
  it("hands the limiter a key well inside any length a binding could cap", async () => {
    const keys: string[] = [];
    const watching: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: true };
      },
    };

    const url = new URL(`${ORIGIN}/device/code`);
    await handleDevice(request("/device/code", undefined, { "cf-connecting-ip": "203.0.113.30" }), url, configured(), {
      now: () => NOW,
      mintLimiter: watching,
    });

    expect(keys).toHaveLength(1);
    expect(new TextEncoder().encode(keys[0]).byteLength).toBeLessThanOrEqual(32);
  });

  it("counts each client address separately", async () => {
    for (let i = 0; i < MINTS_PER_PERIOD; i += 1) await mintFrom("203.0.113.9");

    expect((await mintFrom("203.0.113.10")).status).toBe(200);
    expect((await mintFrom("203.0.113.9")).status).toBe(429);
  });

  /**
   * A self-hoster who declares no limiter gets no limit, deliberately. Failing
   * closed instead would mean a Worker that signs nobody in until an operator
   * has read a configuration reference.
   */
  it("mints freely on a deployment that declares no limiter", async () => {
    expect(configured().DEVICE_CODE_LIMITER).toBeUndefined();

    for (let i = 0; i < MINTS_PER_PERIOD + 2; i += 1) {
      expect((await device("/device/code")).status).toBe(200);
    }
  });

  it("writes nothing when the limiter refuses, so abuse costs no storage", async () => {
    for (let i = 0; i < MINTS_PER_PERIOD; i += 1) await mintFrom("203.0.113.11");
    const { n: before } = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM device_codes",
    ).first<{ n: number }>())!;

    expect((await mintFrom("203.0.113.11")).status).toBe(429);

    const { n: after } = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM device_codes",
    ).first<{ n: number }>())!;
    expect(after).toBe(before);
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

  it("says slow down when the polling limiter refuses the request", async () => {
    const { device_code } = await mint();
    const refusing: RateLimit = { limit: async () => ({ success: false }) };

    expect(
      await errorOf(
        await device(
          "/device/token",
          { device_code },
          NOW,
          {},
          configured({ DEVICE_POLL_LIMITER: refusing }),
        ),
      ),
    ).toBe("slow_down");
  });

  it("bounds random code misses in one client bucket before the per-code limit", async () => {
    const keys: string[] = [];
    const aggregate: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: keys.length === 1 };
      },
    };
    const deployment = configured({ DEVICE_POLL_CLIENT_LIMITER: aggregate });
    const headers = { "cf-connecting-ip": "198.51.100.72" };

    expect(
      await errorOf(
        await device("/device/token", { device_code: "random-a" }, NOW, headers, deployment),
      ),
    ).toBe("expired_token");
    expect(
      await errorOf(
        await device("/device/token", { device_code: "random-b" }, NOW, headers, deployment),
      ),
    ).toBe("slow_down");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("uses the hosted poll binding declared in wrangler.jsonc", async () => {
    const { device_code } = await mint();
    const deployment = configured({ DEVICE_POLL_LIMITER: env.DEVICE_POLL_LIMITER });

    expect(
      await errorOf(await device("/device/token", { device_code }, NOW, {}, deployment)),
    ).toBe("authorization_pending");
    expect(
      await errorOf(await device("/device/token", { device_code }, NOW, {}, deployment)),
    ).toBe("slow_down");
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
      "SELECT token_hash, account_id, label, last_used_at FROM tokens WHERE id = ?",
    )
      .bind(issued.token_id)
      .first<{
        token_hash: string;
        account_id: string;
        label: string | null;
        last_used_at: number | null;
      }>();

    expect(row?.account_id).toBe("oa_holder");
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toContain(issued.access_token);
    expect(row?.last_used_at).toBeNull();
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

  /**
   * Below the handler because the write has to be safe independently of the
   * best-effort polling limiter.
   */
  it("issues one token when two collections race for the same approval", async () => {
    const minted = await mint();
    await approve(minted.user_code);
    const hash = (await codeRow(minted.user_code))!.device_code_hash!;

    const [first, second] = await Promise.all([
      collectDeviceToken(
        env.DB,
        hash,
        { id: "tok_race000000000a", token_hash: "hash-a", created_at: NOW },
        MAX_TOKENS_PER_ACCOUNT,
      ),
      collectDeviceToken(
        env.DB,
        hash,
        { id: "tok_race000000000b", token_hash: "hash-b", created_at: NOW },
        MAX_TOKENS_PER_ACCOUNT,
      ),
    ]);

    expect([first, second].filter((outcome) => outcome !== null)).toHaveLength(1);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens").first<{ n: number }>())!;
    expect(n).toBe(1);
    expect(await codeRow(minted.user_code)).toBeNull();
  });
});

describe("limiting polls without database writes", () => {
  it("serves one poll of a concurrent burst and tells the rest to slow down", async () => {
    const minted = await mint();
    let first = true;
    const limiter: RateLimit = {
      limit: async () => {
        const success = first;
        first = false;
        return { success };
      },
    };
    const deployment = configured({ DEVICE_POLL_LIMITER: limiter });

    const burst = await Promise.all(
      Array.from({ length: 6 }, () =>
        device("/device/token", { device_code: minted.device_code }, NOW, {}, deployment),
      ),
    );

    const codes = await Promise.all(burst.map(errorOf));
    expect(codes.filter((code) => code !== "slow_down")).toEqual(["authorization_pending"]);
  });

  it("leaves the device row unchanged however many pending polls are served", async () => {
    const minted = await mint();
    const before = await codeRow(minted.user_code);
    const allowing: RateLimit = { limit: async () => ({ success: true }) };
    const deployment = configured({ DEVICE_POLL_LIMITER: allowing });

    const burst = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        device("/device/token", { device_code: minted.device_code }, NOW + i, {}, deployment),
      ),
    );

    expect(await Promise.all(burst.map(errorOf))).toEqual(Array(6).fill("authorization_pending"));
    expect(await codeRow(minted.user_code)).toEqual(before);
  });

  it("keys the limiter by a hash rather than the raw device code", async () => {
    const minted = await mint();
    const keys: string[] = [];
    const watching: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: true };
      },
    };

    await device(
      "/device/token",
      { device_code: minted.device_code },
      NOW,
      {},
      configured({ DEVICE_POLL_LIMITER: watching }),
    );

    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(minted.device_code);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("the rolling window of tokens an account holds", () => {
  const ACCOUNT = "oa_crowded_account";

  /** One seeded token, with the use history the eviction order reads. */
  async function seedToken(id: string, lastUsed: number | null, value?: string): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO tokens (id, token_hash, account_id, label, created_at, last_used_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
      .bind(id, value === undefined ? `hash-${id}` : await sha256Hex(value), ACCOUNT, NOW, lastUsed)
      .run();
  }

  /** Pad the account out to the window, all used more recently than the victim. */
  async function padTo(count: number, from: number): Promise<void> {
    await env.DB.batch(
      Array.from({ length: count - from }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO tokens (id, token_hash, account_id, label, created_at, last_used_at)
           VALUES (?, ?, ?, NULL, ?, ?)`,
        ).bind(
          `tok_pad${String(i + from).padStart(13, "0")}`,
          `hash-pad-${i + from}`,
          ACCOUNT,
          NOW,
          NOW + i + from,
        ),
      ),
    );
  }

  const liveTokens = async (): Promise<number> =>
    (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM tokens WHERE account_id = ?",
    )
      .bind(ACCOUNT)
      .first<{ n: number }>())!.n;

  /** Mint, approve and collect on this account, returning the new token. */
  async function signIn(): Promise<Issued> {
    const minted = await mint();
    await approve(minted.user_code, ACCOUNT);
    const response = await device("/device/token", { device_code: minted.device_code });
    expect(response.status).toBe(200);
    return await response.json<Issued>();
  }

  const asks = async (credential: string): Promise<number> => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/docs`, { headers: { authorization: `Bearer ${credential}` } }),
      configured(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response.status;
  };

  /**
   * Refusing at the ceiling would strand an owner who no longer holds any of
   * the hundred values: revoking needs one of them, so neither revoking nor
   * collecting would ever work again
   * (https://github.com/Brevilabs/OpenArtifacts/pull/62#discussion_r3928231361).
   */
  it("evicts the least recently used token and refuses it on its next request", async () => {
    const victim = newApiToken();
    await seedToken("tok_victim000000000", NOW - 5_000, victim);
    await seedToken("tok_keeper000000000", NOW - 4_000);
    await padTo(MAX_TOKENS_PER_ACCOUNT, 2);

    const issued = await signIn();

    expect(await liveTokens()).toBe(MAX_TOKENS_PER_ACCOUNT);
    expect(await tokenExists("tok_victim000000000")).toBe(false);
    expect(await tokenExists("tok_keeper000000000")).toBe(true);
    expect(await asks(victim)).toBe(401);
    expect(await asks(issued.access_token)).toBe(200);
  });

  it("drops a token that was never used before one that was used long ago", async () => {
    await seedToken("tok_neverused000000", null);
    await seedToken("tok_ancient00000000", 1);
    await padTo(MAX_TOKENS_PER_ACCOUNT, 2);

    await signIn();

    expect(await tokenExists("tok_neverused000000")).toBe(false);
    expect(await tokenExists("tok_ancient00000000")).toBe(true);
  });

  it("evicts nothing while the account is under the window", async () => {
    await seedToken("tok_lonely000000000", null);

    await signIn();

    expect(await tokenExists("tok_lonely000000000")).toBe(true);
    expect(await liveTokens()).toBe(2);
  });

  it("evicts nothing for a poll at a code nobody has approved", async () => {
    await seedToken("tok_untouched000000", null);
    await padTo(MAX_TOKENS_PER_ACCOUNT, 1);
    const minted = await mint();

    expect(await errorOf(await device("/device/token", { device_code: minted.device_code }))).toBe(
      "authorization_pending",
    );

    expect(await tokenExists("tok_untouched000000")).toBe(true);
    expect(await liveTokens()).toBe(MAX_TOKENS_PER_ACCOUNT);
  });

  it("evicts and issues nothing when an approved code expires before collection", async () => {
    await seedToken("tok_untouched000000", null);
    await padTo(MAX_TOKENS_PER_ACCOUNT, 1);
    const minted = await mint();
    await approve(minted.user_code, ACCOUNT);
    const hash = (await codeRow(minted.user_code))!.device_code_hash!;

    const issued = await collectDeviceToken(
      env.DB,
      hash,
      {
        id: "tok_expired00000000",
        token_hash: "hash-expired-collection",
        created_at: NOW + DEVICE_CODE_TTL_MS,
      },
      MAX_TOKENS_PER_ACCOUNT,
    );

    expect(issued).toBeNull();
    expect(await tokenExists("tok_untouched000000")).toBe(true);
    expect(await tokenExists("tok_expired00000000")).toBe(false);
    expect(await liveTokens()).toBe(MAX_TOKENS_PER_ACCOUNT);
  });

  it("issues one token when two collections race at the window", async () => {
    await seedToken("tok_victim000000000", NOW - 5_000);
    await padTo(MAX_TOKENS_PER_ACCOUNT, 1);
    const minted = await mint();
    await approve(minted.user_code, ACCOUNT);
    const hash = (await codeRow(minted.user_code))!.device_code_hash!;

    const [first, second] = await Promise.all([
      collectDeviceToken(
        env.DB,
        hash,
        { id: "tok_race000000000a", token_hash: "hash-a", created_at: NOW },
        MAX_TOKENS_PER_ACCOUNT,
      ),
      collectDeviceToken(
        env.DB,
        hash,
        { id: "tok_race000000000b", token_hash: "hash-b", created_at: NOW },
        MAX_TOKENS_PER_ACCOUNT,
      ),
    ]);

    expect([first, second].filter((outcome) => outcome !== null)).toHaveLength(1);
    expect(await liveTokens()).toBe(MAX_TOKENS_PER_ACCOUNT);
    expect(await codeRow(minted.user_code)).toBeNull();
  });

  it("returns every token an account holds, so none is invisible to revoke", async () => {
    await padTo(MAX_TOKENS_PER_ACCOUNT - 1, 0);
    const issued = await signIn();

    const ctx = createExecutionContext();
    const listed = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/tokens`, {
        headers: { authorization: `Bearer ${issued.access_token}` },
      }),
      configured(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const body = await listed.json<{ tokens: { tokenId: string }[] }>();
    expect(body.tokens).toHaveLength(MAX_TOKENS_PER_ACCOUNT);
    expect(body.tokens.map((row) => row.tokenId)).toContain(issued.token_id);
    expect(body.tokens.map((row) => row.tokenId)).toContain("tok_pad0000000000000");
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

  it("strips C0 and C1 controls, so a terminal cannot draw over the page it is named on", () => {
    expect(readDeviceLabel("Claude[31m Code\nrm -rf")).toBe("Claude [31m Code rm -rf");
    expect(readDeviceLabel("Claude\u009b31m Code")).toBe("Claude 31m Code");
  });

  it("strips bidi controls without stripping ordinary right-to-left text", () => {
    expect(readDeviceLabel("Trusted\u202Etxt.exe\u202C جهاز")).toBe("Trustedtxt.exe جهاز");
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
    // terminal waiting on this code is theirs. `bdi` keeps natural RTL labels
    // from changing the direction of the surrounding warning.
    expect(html).toContain("<b><bdi>Claude Code on loganmac</bdi></b>");
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
