import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_TOKEN_PLAN, resolvePublisher } from "../src/auth.js";
import { TOKEN_LAST_USED_RESOLUTION_MS } from "../src/config.js";
import type { Env } from "../src/config.js";
import { sha256Hex } from "../src/hash.js";
import { newApiToken, newTokenId } from "../src/ids.js";
import worker from "../src/index.js";

/** Local routing has no configured hosts, so the surfaces resolve by path prefix. */
const ORIGIN = "https://openartifacts.workers.dev";

const NOW = 1_800_000_000_000;

const ACCOUNT_A = "oa_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT_B = "oa_bbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A license key, to prove both credentials reach the same routes unchanged. */
const LICENSE_KEY = "cplus_live_a1b2c3d4e5f60718";
const LICENSE_ACCOUNT = "e2b7a0c4-1f3d-4a6b-9c8e-2d5f7a1b3c9d";

const local = (over: Partial<Env> = {}): Env =>
  ({
    ...env,
    SERVING_HOST: "",
    API_HOST: "",
    LEGACY_SERVING_HOST: "",
    RETIRED_API_HOST: "",
    ...over,
  }) as Env;

/**
 * Put a token on an account without going through the device flow. These cases
 * are about what a token does once it exists; `test/device.test.ts` covers how
 * one comes to exist.
 */
async function issueToken(
  accountId: string,
  over: { label?: string | null; createdAt?: number; revokedAt?: number | null } = {},
): Promise<{ token: string; id: string }> {
  const token = newApiToken();
  const id = newTokenId();
  await env.DB.prepare(
    `INSERT INTO tokens (id, token_hash, account_id, label, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      await sha256Hex(token),
      accountId,
      over.label ?? null,
      over.createdAt ?? NOW,
      over.revokedAt ?? null,
    )
    .run();
  return { token, id };
}

/** A warm license-validation row, so no case here reaches a license server. */
async function seedLicense(): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO publishers (key_hash, plan, validated_at, owner)
     VALUES (?, 'believer', ?, ?)`,
  )
    .bind(await sha256Hex(LICENSE_KEY), Date.now(), LICENSE_ACCOUNT)
    .run();
}

const BODILESS = new Set([204, 205, 304]);

async function send(
  method: string,
  path: string,
  credential: string | null,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers();
  if (credential !== null) headers.set("authorization", `Bearer ${credential}`);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }

  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init), local(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const page = (body: string) => `<!doctype html><html><body><p>${body}</p></body></html>`;

interface PushResponse {
  docId: string;
  url: string;
  version: number;
}

async function publish(credential: string, title: string): Promise<PushResponse> {
  const response = await send("POST", "/api/v1/docs", credential, { title, html: page(title) });
  expect(response.status).toBe(201);
  return await response.json<PushResponse>();
}

interface ListedToken {
  tokenId: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

const tokensOf = async (response: Response): Promise<ListedToken[]> =>
  (await response.json<{ tokens: ListedToken[] }>()).tokens;

const errorOf = async (response: Response): Promise<string> =>
  (await response.json<{ error: { code: string } }>()).error.code;

beforeEach(async () => {
  await seedLicense();
});

describe("Authorization: Bearer <token>", () => {
  it("publishes, lists, updates and unshares exactly as a license key does", async () => {
    const { token } = await issueToken(ACCOUNT_A);

    const created = await publish(token, "From a token");
    expect(created.url).toContain(`/d/${created.docId}`);

    const updated = await send("PUT", `/api/v1/docs/${created.docId}`, token, {
      html: page("second"),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json<PushResponse>()).version).toBe(2);

    const listed = await send("GET", "/api/v1/docs", token);
    expect(listed.status).toBe(200);
    expect(await listed.json<{ docs: { docId: string }[] }>()).toMatchObject({
      docs: [{ docId: created.docId }],
    });

    expect((await send("DELETE", `/api/v1/docs/${created.docId}`, token)).status).toBe(204);
  });

  it("files documents under the account rather than the token, so a second token sees them", async () => {
    const first = await issueToken(ACCOUNT_A);
    const second = await issueToken(ACCOUNT_A);

    const created = await publish(first.token, "Shared shelf");

    const listed = await tokensSeeDoc(second.token);
    expect(listed).toContain(created.docId);
  });

  it("refuses a token this deployment never issued, with the frozen code", async () => {
    const response = await send("GET", "/api/v1/docs", newApiToken());

    expect(response.status).toBe(401);
    expect(await errorOf(response)).toBe("unauthorized");
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("never sends a token to the license server", async () => {
    const { token } = await issueToken(ACCOUNT_A);
    let calls = 0;

    const resolved = await resolvePublisher(
      token,
      local({ LICENSE_API_URL: "https://license.test", LICENSE_API_KEY: "ours" }),
      {
        fetch: async () => {
          calls += 1;
          return Response.json({});
        },
      },
    );

    expect(calls).toBe(0);
    expect(resolved).toEqual({
      ok: true,
      publisher: { owner: ACCOUNT_A, plan: ACCOUNT_TOKEN_PLAN },
    });
  });

  it("lets a brand-new account publish, which a plan that may not would not", async () => {
    const { token } = await issueToken(ACCOUNT_B);

    const created = await publish(token, "First ever");
    expect((await send("PUT", `/api/v1/docs/${created.docId}`, token, { html: page("v2") })).status)
      .toBe(200);
  });

  it("answers 404 for another account's document, never 403", async () => {
    const mine = await issueToken(ACCOUNT_A);
    const theirs = await issueToken(ACCOUNT_B);
    const created = await publish(mine.token, "Mine");

    for (const attempt of [
      await send("PUT", `/api/v1/docs/${created.docId}`, theirs.token, { html: page("x") }),
      await send("DELETE", `/api/v1/docs/${created.docId}`, theirs.token),
    ]) {
      expect(attempt.status).toBe(404);
      expect(await errorOf(attempt)).toBe("not_found");
    }
    expect(await tokensSeeDoc(theirs.token)).not.toContain(created.docId);
  });

  it("keeps a license key's documents away from a token account, and the other way round", async () => {
    const { token } = await issueToken(ACCOUNT_A);
    const licensed = await publish(LICENSE_KEY, "Copilot doc");
    const fromToken = await publish(token, "Token doc");

    expect(await tokensSeeDoc(token)).toEqual([fromToken.docId]);
    expect(await tokensSeeDoc(LICENSE_KEY)).toEqual([licensed.docId]);
    expect((await send("DELETE", `/api/v1/docs/${licensed.docId}`, token)).status).toBe(404);
  });
});

async function tokensSeeDoc(credential: string): Promise<string[]> {
  const listed = await send("GET", "/api/v1/docs", credential);
  const body = await listed.json<{ docs: { docId: string }[] }>();
  return body.docs.map((doc) => doc.docId);
}

describe("recording when a token was last used", () => {
  const lastUsed = async (id: string): Promise<number | null> =>
    (
      await env.DB.prepare("SELECT last_used_at FROM tokens WHERE id = ?")
        .bind(id)
        .first<{ last_used_at: number | null }>()
    )?.last_used_at ?? null;

  it("records the first use immediately", async () => {
    const { token, id } = await issueToken(ACCOUNT_A);

    await resolvePublisher(token, local(), { now: () => NOW });

    expect(await lastUsed(id)).toBe(NOW);
  });

  it("leaves it alone for the rest of the hour, so a read is not a write", async () => {
    const { token, id } = await issueToken(ACCOUNT_A);
    await resolvePublisher(token, local(), { now: () => NOW });

    await resolvePublisher(token, local(), { now: () => NOW + 60_000 });

    expect(await lastUsed(id)).toBe(NOW);
  });

  it("moves it forward once the recorded use is older than the resolution", async () => {
    const { token, id } = await issueToken(ACCOUNT_A);
    await resolvePublisher(token, local(), { now: () => NOW });

    const later = NOW + TOKEN_LAST_USED_RESOLUTION_MS + 1;
    await resolvePublisher(token, local(), { now: () => later });

    expect(await lastUsed(id)).toBe(later);
  });
});

describe("GET /api/v1/tokens", () => {
  it("lists this account's live tokens, newest first, and never a value", async () => {
    const older = await issueToken(ACCOUNT_A, { label: "Codex on ci", createdAt: NOW - 1000 });
    const newer = await issueToken(ACCOUNT_A, { label: null, createdAt: NOW });

    const listed = await tokensOf(await send("GET", "/api/v1/tokens", older.token));

    expect(listed.map((row) => row.tokenId)).toEqual([newer.id, older.id]);
    expect(listed[1]).toMatchObject({ label: "Codex on ci", createdAt: NOW - 1000 });
    expect(listed[0]?.label).toBeNull();
    expect(JSON.stringify(listed)).not.toContain(older.token);
    expect(JSON.stringify(listed)).not.toContain(newer.token);
  });

  it("reports the use it recorded, once there is one", async () => {
    const { token, id } = await issueToken(ACCOUNT_A);
    await send("GET", "/api/v1/docs", token);

    const listed = await tokensOf(await send("GET", "/api/v1/tokens", token));

    expect(listed.find((row) => row.tokenId === id)?.lastUsedAt).toBeGreaterThan(0);
  });

  it("hides revoked tokens and every other account's", async () => {
    const mine = await issueToken(ACCOUNT_A);
    await issueToken(ACCOUNT_A, { revokedAt: NOW });
    await issueToken(ACCOUNT_B);

    const listed = await tokensOf(await send("GET", "/api/v1/tokens", mine.token));

    expect(listed.map((row) => row.tokenId)).toEqual([mine.id]);
  });

  it("gives a license key an empty list rather than a refusal", async () => {
    await issueToken(ACCOUNT_A);

    const response = await send("GET", "/api/v1/tokens", LICENSE_KEY);

    expect(response.status).toBe(200);
    expect(await tokensOf(response)).toEqual([]);
  });
});

describe("DELETE /api/v1/tokens/{tokenId}", () => {
  it("revokes the token and says how many the account has left", async () => {
    const keeping = await issueToken(ACCOUNT_A);
    const going = await issueToken(ACCOUNT_A);

    const response = await send("DELETE", `/api/v1/tokens/${going.id}`, keeping.token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tokenId: going.id, remaining: 1 });
  });

  it("stops the revoked token on its very next request", async () => {
    const keeping = await issueToken(ACCOUNT_A);
    const going = await issueToken(ACCOUNT_A);
    expect((await send("GET", "/api/v1/docs", going.token)).status).toBe(200);

    await send("DELETE", `/api/v1/tokens/${going.id}`, keeping.token);

    const after = await send("GET", "/api/v1/docs", going.token);
    expect(after.status).toBe(401);
    expect(await errorOf(after)).toBe("unauthorized");
  });

  it("allows revoking the only token, and says nothing is left", async () => {
    const only = await issueToken(ACCOUNT_A);

    const response = await send("DELETE", `/api/v1/tokens/${only.id}`, only.token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tokenId: only.id, remaining: 0 });
    expect((await send("GET", "/api/v1/tokens", only.token)).status).toBe(401);
  });

  it("answers 404 for another account's token, a revoked one, and a malformed id alike", async () => {
    const mine = await issueToken(ACCOUNT_A);
    const theirs = await issueToken(ACCOUNT_B);
    const already = await issueToken(ACCOUNT_A, { revokedAt: NOW });

    for (const id of [theirs.id, already.id, newTokenId(), "not-a-token-id"]) {
      const response = await send("DELETE", `/api/v1/tokens/${id}`, mine.token);
      expect(response.status).toBe(404);
      expect(await errorOf(response)).toBe("not_found");
    }
    // Refusing another account's revoke must not have revoked it either.
    expect((await send("GET", "/api/v1/docs", theirs.token)).status).toBe(200);
  });

  it("has no route for any other method or shape", async () => {
    const { token, id } = await issueToken(ACCOUNT_A);

    expect((await send("DELETE", "/api/v1/tokens", token)).status).toBe(404);
    expect((await send("POST", "/api/v1/tokens", token)).status).toBe(404);
    expect((await send("GET", `/api/v1/tokens/${id}`, token)).status).toBe(404);
    expect((await send("DELETE", `/api/v1/tokens/${id}/extra`, token)).status).toBe(404);
  });

  it("needs a credential, like every other route under /api/v1", async () => {
    const { id } = await issueToken(ACCOUNT_A);

    expect((await send("GET", "/api/v1/tokens", null)).status).toBe(401);
    expect((await send("DELETE", `/api/v1/tokens/${id}`, null)).status).toBe(401);
  });
});
