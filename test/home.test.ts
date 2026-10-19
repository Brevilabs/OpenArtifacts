import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import { scriptHashSource, sha256Hex } from "../src/hash.js";
import { newAccountId, newApiToken, newDocId, newTokenId } from "../src/ids.js";
import worker from "../src/index.js";
import { signPayload } from "../src/session.js";

/**
 * Home (`GET /home`) and its top-bar frame (`GET /embed/home`), through the real
 * Worker and real D1. The frame's privacy is the point of the second half: its
 * bytes and headers are the same for everyone.
 */
const API = "https://api.openartifacts.ai";
const SERVING = "https://openartifacts.site";
const SECRET = "k".repeat(32);

const HOSTS = {
  SERVING_HOST: "openartifacts.site",
  API_HOST: "api.openartifacts.ai",
  READER_SESSION_SECRET: SECRET,
  OAUTH_GITHUB_CLIENT_ID: "github-client",
  OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
} as Partial<Env>;

async function get(url: string, over: Partial<Env> = HOSTS, headers: Record<string, string> = {}, method = "GET"): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(url, { method, headers }), { ...env, ...over } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const session = async (accountId: string) =>
  ({ cookie: `__Host-oa_session=${await signPayload(SECRET, "session", { a: accountId }, Date.now() + 60_000)}` });

let counter = 0;
async function account(): Promise<{ id: string; email: string; token: string }> {
  const id = newAccountId();
  const email = `home${counter++}@acme.com`;
  await env.DB.prepare("INSERT INTO accounts (id, email, created_at, plan, plan_checked_at) VALUES (?, ?, ?, 'pro', ?)")
    .bind(id, email, Date.now(), Date.now())
    .run();
  const token = newApiToken();
  await env.DB.prepare("INSERT INTO tokens (id, token_hash, account_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(newTokenId(), await sha256Hex(token), id, Date.now())
    .run();
  return { id, email, token };
}

/** A live doc row and its first version, written directly: Home reads D1 and nothing else. `landed: false` is a first push that died before its version. */
async function doc(owner: string, title: string, at: number, linkAccess: "anyone" | "invited" = "anyone", landed = true): Promise<string> {
  const id = newDocId();
  await env.DB.prepare(
    "INSERT INTO docs (id, owner, title, latest_version, created_at, updated_at, link_access) VALUES (?, ?, ?, 1, ?, ?, ?)",
  )
    .bind(id, owner, title, at, at, linkAccess)
    .run();
  if (landed) {
    await env.DB.prepare("INSERT INTO versions (doc_id, n, size, title, created_at) VALUES (?, 1, 1, ?, ?)").bind(id, title, at).run();
  }
  return id;
}

const invite = (docId: string, email: string) =>
  env.DB.prepare("INSERT INTO doc_invites (doc_id, email, role, created_at) VALUES (?, ?, 'view', ?)").bind(docId, email, Date.now()).run();

describe("GET /home", () => {
  it("sends a signed-out visitor to sign-in, returning to /home", async () => {
    const response = await get(`${API}/home`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Sign in to see your pages");
    expect(html).toContain('name="next" value="/home"');
    expect(html).not.toContain("Your pages</h1>");
  });

  it("lists exactly the account's live pages, linked keys included, with their access", async () => {
    const me = await account();
    const other = await account();
    const base = 1_700_000_000_000;
    const pub = await doc(me.id, "Public one MiXeD 100% Literal", base);
    const solo = await doc(me.id, "Solo <script>alert(1)</script>", base + 1000, "invited");
    const shared = await doc(me.id, "Shared two MiXeD 100% Literal", base + 2000, "invited");
    await invite(shared, "a@acme.com");
    await invite(shared, "b@acme.com");
    const one = await doc(me.id, "Shared one", base + 3000, "invited");
    await invite(one, "a@acme.com");
    const linked = await doc("cplus_owner_linked", "From my key MiXeD 100% Literal", base + 4000);
    await env.DB.prepare("INSERT INTO owner_links (external_owner, account_id, created_at) VALUES (?, ?, ?)")
      .bind("cplus_owner_linked", me.id, Date.now())
      .run();
    const gone = await doc(me.id, "Deleted one", base + 5000);
    await env.DB.prepare("UPDATE docs SET deleted_at = ? WHERE id = ?").bind(Date.now(), gone).run();
    const theirs = await doc(other.id, "Someone else", base + 6000);
    const failed = await doc(me.id, "Never landed", base + 7000, "anyone", false);

    const response = await get(`${API}/home`, HOSTS, await session(me.id));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = response.headers.get("content-security-policy")!;
    const html = await response.text();
    const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(csp).toContain(`script-src ${await scriptHashSource(inlineScript)}`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(html).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&amp;family=IBM+Plex+Mono:wght@400;500&amp;display=swap" referrerpolicy="no-referrer">');
    expect(csp).toContain("style-src 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("font-src https://fonts.gstatic.com");

    expect(html).toContain("Your pages");
    for (const id of [pub, solo, shared, one, linked]) expect(html).toContain(`href="${SERVING}/d/${id}"`);
    for (const id of [gone, theirs, failed]) expect(html).not.toContain(id);
    expect(html).not.toContain("Deleted one");
    expect(html).not.toContain("Someone else");
    // Newest first.
    expect(html.indexOf("From my key")).toBeLessThan(html.indexOf("Shared one"));
    expect(html.indexOf("Shared one")).toBeLessThan(html.indexOf("Public one"));
    expect(html).toContain('<span class="a">Public</span><span class="d">Nov 14, 2023</span>');
    expect(html).toContain('<span class="a">Only you</span>');
    expect(html).toContain('<span class="a">Private · 2 people</span>');
    expect(html).toContain('<span class="a">Private · 1 person</span>');
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)");

    const search = await get(`${API}/home?q=${encodeURIComponent("mIxEd 100%")}`, HOSTS, await session(me.id));
    expect(search.status).toBe(200);
    const results = (await search.json() as { pages: Array<{ id: string; url: string }> }).pages;
    expect(results.map((row) => row.id)).toEqual([linked, shared, pub]);
    expect(results.map((row) => row.url)).toEqual([linked, shared, pub].map((id) => `${SERVING}/d/${id}`));
    expect(results.some((row) => row.id === gone || row.id === theirs || row.id === failed)).toBe(false);
    expect(search.headers.get("cache-control")).toBe("no-store");
    expect(search.headers.get("referrer-policy")).toBe("no-referrer");
    expect(search.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("says so in one line when nothing is published", async () => {
    const me = await account();
    const html = await (await get(`${API}/home`, HOSTS, await session(me.id))).text();
    expect(html).toContain("Nothing published yet. Ask your agent to publish a page.");
    expect(html).not.toContain('<ul class="pages">');
  });

  it("pages by 50 and follows the cursor to the rest; a bad cursor starts over", async () => {
    const me = await account();
    for (let i = 0; i < 51; i++) await doc(me.id, `Page ${String(i).padStart(2, "0")}`, 1_000 + i);
    const headers = await session(me.id);

    const first = await (await get(`${API}/home`, HOSTS, headers)).text();
    expect(first.match(/<li>/g)).toHaveLength(50);
    expect(first).toContain("Page 50");
    expect(first).not.toContain("Page 00<");
    const more = /href="(\/home\?cursor=[^"]+)"/.exec(first);
    expect(more).not.toBeNull();

    const second = await (await get(`${API}${more![1]!}`, HOSTS, headers)).text();
    expect(second.match(/<li>/g)).toHaveLength(1);
    expect(second).toContain("Page 00");
    expect(second).not.toContain("Show more");

    const searchOld = await get(`${API}/home?q=Page%2000`, HOSTS, headers);
    const oldResults = (await searchOld.json() as { pages: Array<{ id: string }> }).pages;
    expect(oldResults).toHaveLength(1);
    const oldId = oldResults[0]!.id;
    expect((await env.DB.prepare("SELECT title FROM docs WHERE id = ?").bind(oldId).first<{ title: string }>())?.title).toBe("Page 00");
    const idMatch = await get(`${API}/home?q=${encodeURIComponent(`/d/${oldId}`)}`, HOSTS, headers);
    expect((await idMatch.json() as { pages: Array<{ id: string }> }).pages[0]!.id).toBe(oldId);
    const broad = await get(`${API}/home?q=Page`, HOSTS, headers);
    expect((await broad.json() as { pages: Array<{ title: string }> }).pages.map(row => row.title)).toEqual(Array.from({ length: 8 }, (_, i) => `Page ${String(50 - i).padStart(2, "0")}`));

    const bad = await get(`${API}/home?cursor=nonsense`, HOSTS, headers);
    expect(bad.status).toBe(200);
    expect((await bad.text()).match(/<li>/g)).toHaveLength(50);
  });

  it("search is session-only and empty queries return no suggestions", async () => {
    const signedOut = await get(`${API}/home?q=Page`);
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("content-type")).toContain("application/json");
    expect(signedOut.headers.get("cache-control")).toBe("no-store");
    expect(await signedOut.json()).toEqual({ error: "sign_in_required" });
    const me = await account();
    const empty = await get(`${API}/home?q=%20%20%20`, HOSTS, await session(me.id));
    expect(empty.status).toBe(200);
    expect(empty.headers.get("content-type")).toContain("application/json");
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(await empty.json()).toEqual({ pages: [] });
  });

  it("has an Account button only when ACCOUNT_ACTION_URL is set", async () => {
    const me = await account();
    const headers = await session(me.id);
    const hosted = await (await get(`${API}/home`, { ...HOSTS, ACCOUNT_ACTION_URL: "https://openartifacts.ai/account" }, headers)).text();
    expect(hosted).toMatch(/<a class="account" href="https:\/\/openartifacts.ai\/account" target="_blank" rel="noopener noreferrer" aria-label="Account">h<\/a>/);
    const selfHosted = await (await get(`${API}/home`, { ...HOSTS, ACCOUNT_ACTION_URL: "" }, headers)).text();
    expect(selfHosted).not.toContain('aria-label="Account"');
    // A destination the operator got wrong costs the button, not the page.
    const broken = await get(`${API}/home`, { ...HOSTS, ACCOUNT_ACTION_URL: "http://evil.test/" }, headers);
    expect(broken.status).toBe(200);
    expect(await broken.text()).not.toContain('aria-label="Account"');
  });

  it("is the API host's alone, GET only, and absent without reader sign-in", async () => {
    const me = await account();
    const headers = await session(me.id);
    for (const path of ["/home", "/home?q=Page", "/embed/home"]) {
      const served = await get(`${SERVING}${path}`, HOSTS, headers);
      expect(served.status).toBe(404);
      expect(await served.text()).not.toContain("Your pages");
    }
    expect((await get(`${API}/home`, HOSTS, headers, "POST")).status).toBe(404);
    expect(await (await get(`${API}/home/`, HOSTS, headers)).text()).not.toContain("Your pages");
    const bare = { ...HOSTS, READER_SESSION_SECRET: undefined } as Partial<Env>;
    expect((await get(`${API}/home`, bare, headers)).status).toBe(404);
    expect((await get(`${API}/embed/home`, bare)).status).toBe(404);
  });
});

describe("GET /embed/home", () => {
  it("is one static, cacheable, cookieless document for everyone, framable only by the serving hosts", async () => {
    const me = await account();
    const anonymous = await get(`${API}/embed/home`);
    const signedIn = await get(`${API}/embed/home`, HOSTS, await session(me.id));

    expect(anonymous.status).toBe(200);
    expect(await signedIn.text()).toBe(await anonymous.clone().text());
    expect(anonymous.headers.get("set-cookie")).toBeNull();
    expect(anonymous.headers.get("cache-control")).toBe("public, max-age=300");
    expect(anonymous.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = anonymous.headers.get("content-security-policy")!;
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors https://openartifacts.site https://*.openartifacts.site");
    expect(csp).not.toContain("connect-src");

    const html = await anonymous.text();
    expect(html).toContain('data-home="https://api.openartifacts.ai/home"');
    // It never reports to the page around it.
    expect(html).not.toMatch(/postMessage|focus\(|ResizeObserver|autofocus/);
  });

  it("answers a revalidation with 304 and HEAD with no body", async () => {
    const etag = (await get(`${API}/embed/home`)).headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await get(`${API}/embed/home`, HOSTS, { "if-none-match": etag });
    expect(again.status).toBe(304);
    const head = await get(`${API}/embed/home`, HOSTS, {}, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await get(`${API}/embed/home`, HOSTS, {}, "POST")).status).toBe(404);
  });
});

describe("the Home frame in a served page's top bar", () => {
  it("has its slot in every page's bar, and the bar's bytes do not vary by cookie", async () => {
    const me = await account();
    const id = await doc(me.id, "A page", Date.now());
    await env.DOCS.put(`docs/${id}/v1.html`, "<!doctype html><html><head><title>A</title></head><body><p>hi</p></body></html>");

    const plain = await get(`${SERVING}/d/${id}`);
    const cookied = await get(`${SERVING}/d/${id}`, HOSTS, await session(me.id));
    const html = await plain.text();
    expect(html).toContain('<span class="openartifacts-home" data-openartifacts-home');
    expect(await cookied.text()).toBe(html);

    // A server with no reader sign-in renders no bar, so no page script to fill the slot.
    const bare = await (await get(`${SERVING}/d/${id}`, { ...HOSTS, READER_SESSION_SECRET: undefined })).text();
    expect(bare).not.toContain("data-openartifacts-home");
  });
});
