import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config.js";
import { DOC_ID_LENGTH } from "../src/ids.js";
import worker from "../src/index.js";

const API_ORIGIN = "https://symposium.workers.dev";
const KEY = "cplus_live_analytics1234";
const ANALYTICS_ENV: Partial<Env> = {
  POSTHOG_PROJECT_API_KEY: "phc_test",
  POSTHOG_HOST: "https://us.i.posthog.com",
  ENVIRONMENT: "test",
};
const UNKNOWN_DOC_ID = "0123456789abcdefghjkmnpqrstvwxyz".repeat(2).slice(0, DOC_ID_LENGTH);

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${KEY}` });
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }

  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${API_ORIGIN}${path}`, init),
    { ...env, ...ANALYTICS_ENV },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const page = (text: string) =>
  `<!doctype html><html><head><title>Analytics test</title></head><body>${text}</body></html>`;

interface CapturePayload {
  api_key: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}

describe("PostHog publishing analytics", () => {
  let owner = "";

  beforeEach(async () => {
    owner = `account-${(await sha256Hex(KEY)).slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO publishers (key_hash, plan, validated_at, owner)
       VALUES (?, 'plus', ?, ?)`,
    )
      .bind(await sha256Hex(KEY), Date.now(), owner)
      .run();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("captures one allowlisted event after each successful create, update, and unshare", async () => {
    const captures: Array<{ url: string; payload: CapturePayload }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      captures.push({
        url: String(input),
        payload: JSON.parse(String(init?.body)) as CapturePayload,
      });
      return new Response(null, { status: 200 });
    });

    const createdResponse = await send("POST", "/api/v1/docs", {
      title: "Private title",
      html: page("private contents"),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { docId: string };

    expect(
      (
        await send("PUT", `/api/v1/docs/${created.docId}`, {
          title: "Changed private title",
          html: page("changed private contents"),
        })
      ).status,
    ).toBe(200);
    expect((await send("DELETE", `/api/v1/docs/${created.docId}`)).status).toBe(204);

    expect(captures).toEqual([
      {
        url: "https://us.i.posthog.com/i/v0/e/",
        payload: {
          api_key: "phc_test",
          event: "symposium_publish",
          distinct_id: owner,
          properties: {
            service: "symposium",
            environment: "test",
            $process_person_profile: false,
            operation: "create",
          },
        },
      },
      {
        url: "https://us.i.posthog.com/i/v0/e/",
        payload: {
          api_key: "phc_test",
          event: "symposium_publish",
          distinct_id: owner,
          properties: {
            service: "symposium",
            environment: "test",
            $process_person_profile: false,
            operation: "update",
          },
        },
      },
      {
        url: "https://us.i.posthog.com/i/v0/e/",
        payload: {
          api_key: "phc_test",
          event: "symposium_unshare",
          distinct_id: owner,
          properties: {
            service: "symposium",
            environment: "test",
            $process_person_profile: false,
          },
        },
      },
    ]);
  });

  it("does not capture failed create, update, or unshare operations", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    expect((await send("POST", "/api/v1/docs", { title: "missing html" })).status).toBe(400);
    expect(
      (
        await send("PUT", `/api/v1/docs/${UNKNOWN_DOC_ID}`, {
          html: page("not published"),
        })
      ).status,
    ).toBe(404);
    expect((await send("DELETE", `/api/v1/docs/${UNKNOWN_DOC_ID}`)).status).toBe(404);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a successful API response when PostHog delivery fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async () => {
      throw new Error("analytics offline");
    });

    const response = await send("POST", "/api/v1/docs", {
      title: "Still published",
      html: page("still stored"),
    });

    expect(response.status).toBe(201);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith("PostHog capture failed", expect.any(Error));
  });
});
