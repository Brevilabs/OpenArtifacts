import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config.js";
import { checkDomain, removeDomain, syncAll } from "../src/custom-domains.js";
import { newAccountId } from "../src/ids.js";
import worker from "../src/index.js";
import { signPayload } from "../src/session.js";

/**
 * Custom domains against real D1, with the DNS lookup and Cloudflare's custom
 * hostname API stood in for at `globalThis.fetch`, as the analytics tests do.
 */
const API = "https://api.openartifacts.ai";
const SECRET = "k".repeat(32);
const ON = {
  ...env,
  SERVING_HOST: "openartifacts.site",
  API_HOST: "api.openartifacts.ai",
  READER_SESSION_SECRET: SECRET,
  OAUTH_GITHUB_CLIENT_ID: "github-client",
  OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
  CF_SAAS_ZONE_ID: "zone",
  CF_SAAS_API_TOKEN: "token",
} as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Hostname {
  id: string;
  hostname: string;
  status: string;
  ssl: { status: string; method?: string; type?: string; settings?: unknown; validation_errors?: Array<{ message: string }> };
  verification_errors?: string[];
}

/** The DNS and Cloudflare stand-in, and every call made to it after the TXT lookup. */
function outside(state: { txt: string[] | "fail"; host: Hostname | null }) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com") {
      if (state.txt === "fail") return new Response("", { status: 502 });
      return Response.json({ Status: 0, Answer: state.txt.map((data) => ({ type: 16, data: `"${data}"` })) });
    }
    const body = request.method === "GET" ? null : await request.json().catch(() => null);
    calls.push({ method: request.method, path: url.pathname.replace("/client/v4/zones/zone/custom_hostnames", "") + url.search, body });
    if (request.method === "GET") return Response.json({ success: true, result: state.host ? [state.host] : [] });
    return Response.json({ success: true, result: {} });
  });
  return calls;
}

async function account(plan = "pro"): Promise<string> {
  const id = newAccountId();
  await env.DB.prepare("INSERT INTO accounts (id, email, created_at, plan, plan_checked_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, `${id}@acme.com`, Date.now(), plan, Date.now())
    .run();
  return id;
}

async function domain(accountId: string, fields: { proved_at?: number | null; active_at?: number | null } = {}): Promise<void> {
  await env.DB.prepare("INSERT INTO publisher_hosts (account_id, hostname, token, proved_at, active_at, created_at) VALUES (?, 'docs.acme.com', ?, ?, ?, 1)")
    .bind(accountId, `openartifacts-verify=${accountId}`, fields.proved_at ?? null, fields.active_at ?? null)
    .run();
}

const row = (accountId: string) =>
  env.DB.prepare("SELECT hostname, proved_at, active_at FROM publisher_hosts WHERE account_id = ?").bind(accountId).first<{ hostname: string; proved_at: number | null; active_at: number | null }>();

const active = (ssl: Partial<Hostname["ssl"]> = {}): Hostname => ({
  id: "h1",
  hostname: "docs.acme.com",
  status: "active",
  ssl: { status: "active", method: "http", type: "dv", ...ssl },
});

async function post(accountId: string, form: Record<string, string>): Promise<Response> {
  const ctx = createExecutionContext();
  const session = await signPayload(SECRET, "session", { a: accountId }, Date.now() + 60_000);
  const response = await worker.fetch(new Request(`${API}/home/domain`, {
    method: "POST",
    headers: { cookie: `__Host-oa_session=${session}`, "content-type": "application/x-www-form-urlencoded", origin: API, "sec-fetch-site": "same-origin" },
    body: new URLSearchParams(form),
  }), ON, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("Add domain", () => {
  it("adds a subdomain for a paid plan, and refuses a free plan and a host under our domains", async () => {
    const free = await account("free");
    expect(await (await post(free, { op: "add", domain: "docs.acme.com" })).text()).toContain("Custom domains need a paid plan.");
    expect(await row(free)).toBeNull();

    const paid = await account();
    expect(await (await post(paid, { op: "add", domain: "docs.openartifacts.ai" })).text()).toContain("Enter a subdomain you own");
    expect(await row(paid)).toBeNull();
    expect((await post(paid, { op: "add", domain: "Docs.Acme.com" })).status).toBe(303);
    expect(await row(paid)).toEqual({ hostname: "docs.acme.com", proved_at: null, active_at: null });
  });
});

describe("Check now", () => {
  it("stays pending on a wrong TXT value with no Cloudflare call, and never reads a failed lookup as not found", async () => {
    const me = await account();
    await domain(me);
    const calls = outside({ txt: ["openartifacts-verify=someone-else"], host: active() });
    expect(await checkDomain(ON, me, 5)).toBe("no_txt");
    expect(calls).toEqual([]);
    outside({ txt: "fail", host: active() });
    expect(await checkDomain(ON, me, 5)).toBe("unavailable");
    expect(await row(me)).toMatchObject({ proved_at: null, active_at: null });
  });

  it("creates the hostname after the TXT proof, then goes live on active and removes another account's live row", async () => {
    const me = await account();
    const before = await account();
    await domain(me);
    await domain(before, { proved_at: 1, active_at: 1 });
    const state: { txt: string[]; host: Hostname | null } = { txt: [`openartifacts-verify=${me}`], host: null };
    const calls = outside(state);

    expect(await checkDomain(ON, me, 5)).toBe("certificate");
    expect(calls.at(-1)).toEqual({ method: "POST", path: "", body: { hostname: "docs.acme.com", ssl: { method: "http", type: "dv" } } });
    expect(await row(me)).toMatchObject({ proved_at: 5, active_at: null });

    state.host = active();
    expect(await checkDomain(ON, me, 6)).toBe("live");
    expect(await row(me)).toMatchObject({ proved_at: 5, active_at: 6 });
    expect(await row(before)).toBeNull();
  });

  it("restarts an expired or timed-out certificate with a PATCH that echoes the current ssl", async () => {
    const me = await account();
    await domain(me);
    for (const status of ["expired", "pending_validation_timed_out"]) {
      const calls = outside({ txt: [`openartifacts-verify=${me}`], host: active({ status, settings: { min_tls_version: "1.2" } }) });
      expect(await checkDomain(ON, me, 5)).toBe("certificate");
      expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/h1", body: { ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } } });
    }
    expect((await row(me))!.active_at).toBeNull();
  });
});

describe("Remove domain", () => {
  it("deletes the Cloudflare hostname only for a proved row while no other account is live on it", async () => {
    const proved = await account();
    await domain(proved, { proved_at: 1 });
    let calls = outside({ txt: [], host: active() });
    await removeDomain(ON, proved);
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
    expect(await row(proved)).toBeNull();

    const unproved = await account();
    await domain(unproved);
    calls = outside({ txt: [], host: active() });
    await removeDomain(ON, unproved);
    expect(calls).toEqual([]);

    const pending = await account();
    const live = await account();
    await domain(pending, { proved_at: 1 });
    await domain(live, { proved_at: 1, active_at: 1 });
    calls = outside({ txt: [], host: active() });
    await removeDomain(ON, pending);
    expect(calls).toEqual([]);
    expect(await row(live)).not.toBeNull();
  });
});

describe("the daily sync", () => {
  it("clears a moved hostname and an expired certificate, keeps a pending one, and never sets a domain live", async () => {
    const results: Record<string, number | null> = {};
    for (const [label, host] of [
      ["moved", { ...active(), status: "moved" }],
      ["expired", active({ status: "expired" })],
      ["renewing", active({ status: "pending_validation" })],
    ] as const) {
      const id = await account();
      await domain(id, { proved_at: 1, active_at: 7 });
      const pending = await account();
      await env.DB.prepare("UPDATE publisher_hosts SET hostname = ? WHERE account_id = ?").bind(`${label}.acme.com`, id).run();
      await domain(pending, { proved_at: 1 });
      outside({ txt: [], host: { ...host, hostname: `${label}.acme.com` } });
      await syncAll(ON);
      results[label] = (await row(id))!.active_at;
      expect((await row(pending))!.active_at).toBeNull();
      await env.DB.prepare("DELETE FROM publisher_hosts").run();
    }
    expect(results).toEqual({ moved: null, expired: null, renewing: 7 });
  });
});
