import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocComments } from "../src/comments/object.js";
import { MAX_COMMENTS, MAX_THREADS } from "../src/comments/object.js";
import type { Env } from "../src/config.js";
import { readableAccounts } from "../src/db.js";
import { sha256Hex } from "../src/hash.js";
import { newAccountId, newApiToken, newTokenId, SHARE_TOKEN_PREFIX } from "../src/ids.js";
import worker from "../src/index.js";
import { linkExternalOwner } from "../src/owners.js";
import { signPayload } from "../src/session.js";
import { threadsObjectKey } from "../src/storage.js";

/**
 * The comment routes, through the real Worker: `/api/v1` as an agent (an account
 * token or a license key) and `/embed/api` as a person (the frame's per-document
 * token). Threads themselves live in the real Durable Object and the plans in
 * the real D1; the only doubles are the Email Service capture and, where a test
 * is about a refusal, a limiter that says no.
 */
const API = "https://api.openartifacts.ai";
const SECRET = "k".repeat(32);

type Mail = { to: string; subject: string; text: string; html: string };
const sent: Mail[] = [];

const HOSTS = {
  SERVING_HOST: "openartifacts.site",
  API_HOST: "api.openartifacts.ai",
  READER_SESSION_SECRET: SECRET,
  OAUTH_GITHUB_CLIENT_ID: "github-client",
  OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
  EMAIL: { send: async (message: Mail) => void sent.push(message) },
  EMAIL_FROM: "share@mail.openartifacts.ai",
} as Partial<Env>;

const BODILESS = new Set([204, 205, 304]);

async function send(
  method: string,
  path: string,
  credential: string | null,
  body?: unknown,
  overrides: Partial<Env> = {},
): Promise<Response> {
  const headers = new Headers();
  if (credential !== null) headers.set("authorization", `Bearer ${credential}`);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(path.startsWith("https://") ? path : `${API}${path}`, init),
    { ...env, ...HOSTS, ...overrides } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const buffered = await response.arrayBuffer();
  return new Response(BODILESS.has(response.status) ? null : buffered, {
    status: response.status,
    headers: response.headers,
  });
}

const page = (body: string) =>
  `<!doctype html><html><head><title>Q3 report</title></head><body>${body}</body></html>`;

const TEXT = '<p id="intro">The quick brown fox jumps over the lazy dog.</p><p>Revenue grew twelve percent.</p>';

/** Wait for the snapshots a write queued: they run after the write answers. */
async function drainSnapshots(docId: string): Promise<void> {
  await runInDurableObject(env.COMMENTS!.get(env.COMMENTS!.idFromName(docId)), async (instance: DocComments) => {
    await (instance as unknown as { snapshots: Promise<void> }).snapshots;
  });
}

interface Person {
  id: string;
  email: string;
  /** An account token: an agent acting for this person. */
  token: string;
}

async function person(email: string, name: string | null, plan = "pro"): Promise<Person> {
  const id = newAccountId();
  await env.DB.prepare(
    "INSERT INTO accounts (id, email, created_at, plan, plan_checked_at, display_name) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, email, Date.now(), plan, Date.now(), name)
    .run();
  const token = newApiToken();
  await env.DB.prepare("INSERT INTO tokens (id, token_hash, account_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(newTokenId(), await sha256Hex(token), id, Date.now())
    .run();
  return { id, email, token };
}

/** The Share popover's token for `who` on `docId`: what the comments frame holds. */
const frame = async (who: Person, docId: string, exp = Date.now() + 60_000) =>
  SHARE_TOKEN_PREFIX + (await signPayload(SECRET, "share-token", { a: who.id, d: docId }, exp));

const invite = (docId: string, email: string, role: "view" | "comment") =>
  env.DB.prepare("INSERT INTO doc_invites (doc_id, email, role, created_at) VALUES (?, ?, ?, ?)")
    .bind(docId, email, role, Date.now())
    .run();

interface World {
  owner: Person;
  alice: Person; // invited, can comment
  bob: Person; // invited, can view
  carol: Person; // signed in, invited to nothing
  /** An invited-only document: Alice can comment, Bob can view. */
  priv: string;
  /** A public document with the same two people on its list. */
  pub: string;
}

async function publish(who: Person, title: string, html: string, mode: "anyone" | "invited"): Promise<string> {
  const created = await send("POST", "/api/v1/docs", who.token, { title, html: page(html) });
  expect(created.status).toBe(201);
  const { docId } = (await created.json()) as { docId: string };
  await env.DB.prepare("UPDATE docs SET link_access = ? WHERE id = ?").bind(mode, docId).run();
  return docId;
}

async function world(): Promise<World> {
  const owner = await person("logan@acme.com", "Logan");
  const alice = await person("alice@acme.com", "Alice");
  const bob = await person("bob@acme.com", "Bob");
  const carol = await person("carol@other.com", "Carol");
  const priv = await publish(owner, "Q3 client report", TEXT, "invited");
  const pub = await publish(owner, "Public notes", TEXT, "anyone");
  for (const docId of [priv, pub]) {
    await invite(docId, alice.email, "comment");
    await invite(docId, bob.email, "view");
  }
  sent.length = 0;
  return { owner, alice, bob, carol, priv, pub };
}

beforeEach(() => {
  sent.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fox = { exact: "brown fox", prefix: "The quick ", suffix: " jumps" };

/** `/embed/api` for the frame's token (a person), `/api/v1` for an agent's credential. */
const base = (credential: string | null) => (credential?.startsWith(SHARE_TOKEN_PREFIX) ? "/embed/api" : "/api/v1");

const thread = (docId: string, credential: string | null, anchor: unknown = fox, body = "Why brown?", extra = {}) =>
  send("POST", `${base(credential)}/docs/${docId}/threads`, credential, { anchor, body, ...extra });

const listThreads = (docId: string, credential: string | null, query = "") =>
  send("GET", `${base(credential)}/docs/${docId}/threads${query}`, credential);

interface ThreadJson {
  threadId: string;
  anchor: { exact: string };
  anchorStatus: string;
  matchedText: string | null;
  createdAtVersion: number;
  state: "open" | "resolved";
  resolution: null | { by: { name: string; kind: string }; atVersion: number };
  canResolve?: boolean;
  comments: Array<{ commentId: string; author: { name: string; kind: string }; body: string; mine?: boolean }>;
}
interface ThreadsJson {
  docId: string;
  title: string;
  version: number;
  latestVersion: number;
  threads: ThreadJson[];
  viewer?: { canComment: boolean; canManage: boolean; name: string | null };
}

const threadsOf = async (response: Response) => {
  expect(response.status).toBe(200);
  return (await response.json()) as ThreadsJson;
};

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; limit?: string } }).error;

async function created(response: Response) {
  expect(response.status).toBe(201);
  return (await response.json()) as { threadId: string; commentId: string; anchorStatus: string };
}

describe("the roles are the only control", () => {
  it("has no switch: the settings routes answer 404 like any unknown path, on both doors", async () => {
    const { owner, priv } = await world();
    for (const body of [{ comments: true }, { comments: false }, {}]) {
      const api = await send("PUT", `/api/v1/docs/${priv}/settings`, owner.token, body);
      expect(api.status).toBe(404);
      expect((await errorOf(api)).code).toBe("not_found");
      const embed = await send("PUT", `/embed/api/docs/${priv}/settings`, await frame(owner, priv), body);
      expect(embed.status).toBe(404);
    }
    expect(await errorOf(await send("PUT", `/api/v1/docs/${priv}/settings`, owner.token, { comments: true }))).toMatchObject({
      code: "not_found",
    });
  });

  it("carries roles in Access, the rungs the plan grants, and no comments field", async () => {
    const { owner, priv } = await world();
    const body = (await (await send("GET", `/api/v1/docs/${priv}/access`, owner.token)).json()) as Record<string, unknown>;
    expect(body.roles).toEqual(["view", "comment"]);
    expect(body).not.toHaveProperty("comments");
    expect(body).not.toHaveProperty("upgradeUrl");

    const free = await person("free@acme.com", "Frey", "free");
    const docId = await publish(free, "Mine", TEXT, "anyone");
    const freeBody = (await (await send("GET", `/api/v1/docs/${docId}/access`, free.token)).json()) as Record<string, unknown>;
    expect(freeBody.roles).toEqual([]);
    expect(freeBody).not.toHaveProperty("comments");
    // The upgrade link rides along only when the server has one.
    const noLink = (await (await send("GET", `/api/v1/docs/${docId}/access`, free.token, undefined, { UPGRADE_URL: "" })).json()) as Record<string, unknown>;
    expect(noLink.roles).toEqual([]);
    expect(noLink).not.toHaveProperty("upgradeUrl");
    expect(freeBody.upgradeUrl).toEqual(expect.stringMatching(/^https:\/\//));
    const withLink = (await (
      await send("GET", `/api/v1/docs/${docId}/access`, free.token, undefined, { UPGRADE_URL: "https://upgrade.test/plans?owner=x" })
    ).json()) as Record<string, unknown>;
    expect(withLink.roles).toEqual([]);
    expect(withLink.upgradeUrl).toBe("https://upgrade.test/plans");
  });

  it("leaves roles out where this deployment has no comments object", async () => {
    const { owner, priv } = await world();
    const body = (await (await send("GET", `/api/v1/docs/${priv}/access`, owner.token, undefined, { COMMENTS: undefined })).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("roles");
    expect(body).not.toHaveProperty("comments");
  });

  it("checks the plan flag of the role being granted, for a new person and for a change, and never for a removal", async () => {
    const free = await person("free@acme.com", "Frey", "free");
    const docId = await publish(free, "Mine", TEXT, "anyone");
    for (const body of [undefined, { role: "comment" }, { role: "view" }]) {
      const refused = await send("PUT", `/api/v1/docs/${docId}/access/people/dee%40acme.com`, free.token, body);
      expect(refused.status, JSON.stringify(body)).toBe(402);
      expect(await errorOf(refused)).toMatchObject({ code: "limit_reached", limit: "privateSharing" });
    }
    expect(((await (await send("GET", `/api/v1/docs/${docId}/access`, free.token)).json()) as { people: unknown[] }).people).toEqual([]);

    // A lapsed owner keeps the people already on the list, cannot promote or demote them, and can remove them.
    await invite(docId, "eve@acme.com", "view");
    const promote = await send("PUT", `/api/v1/docs/${docId}/access/people/eve%40acme.com`, free.token, { role: "comment" });
    expect(promote.status).toBe(402);
    const demote = await send("PUT", `/api/v1/docs/${docId}/access/people/eve%40acme.com`, free.token, { role: "view" });
    // Naming the role already held is a repeat, which answers on any plan.
    expect(demote.status).toBe(200);
    await invite(docId, "fay@acme.com", "comment");
    const lower = await send("PUT", `/api/v1/docs/${docId}/access/people/fay%40acme.com`, free.token, { role: "view" });
    expect(lower.status).toBe(402);
    const removed = await send("DELETE", `/api/v1/docs/${docId}/access/people/fay%40acme.com`, free.token);
    expect(removed.status).toBe(200);
  });

  it("refuses to add a person with the message that fits a commenter on a public page", async () => {
    const free = await person("free@acme.com", "Frey", "free");
    const docId = await publish(free, "Mine", TEXT, "anyone");
    const refused = await send("PUT", `/api/v1/docs/${docId}/access/people/dee%40acme.com`, free.token, { role: "comment" });
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("Adding people needs a paid plan.");
  });

  it("gives a license key the plan it has: Plus or Supporter can comment, a plan that may not publish cannot", async () => {
    const insertKey = async (key: string, owner: string, plan: string) =>
      env.DB.prepare("INSERT INTO publishers (key_hash, plan, validated_at, owner) VALUES (?, ?, ?, ?)")
        .bind(await sha256Hex(key), plan, Date.now(), owner)
        .run();
    const KEY = "cplus_live_a1b2c3d4e5f60718";
    const KEY_FREE = "cplus_live_0102030405060708";
    await insertKey(KEY, "lic-1", "believer");
    await insertKey(KEY_FREE, "lic-1", "free");
    const docId = ((await (await send("POST", "/api/v1/docs", KEY, { html: page(TEXT) })).json()) as { docId: string }).docId;

    const refused = await send("PUT", `/api/v1/docs/${docId}/access/people/dee%40acme.com`, KEY_FREE, { role: "comment" });
    expect(refused.status).toBe(402);
    expect(await errorOf(refused)).toMatchObject({ code: "limit_reached", limit: "privateSharing" });
    // A license key's plan is managed in Copilot, so its Access carries no checkout link.
    const keyAccess = (await (await send("GET", `/api/v1/docs/${docId}/access`, KEY_FREE)).json()) as Record<string, unknown>;
    expect(keyAccess.roles).toEqual([]);
    expect(keyAccess).not.toHaveProperty("upgradeUrl");
    const added = await send("PUT", `/api/v1/docs/${docId}/access/people/dee%40acme.com`, KEY, { role: "comment" });
    expect(added.status).toBe(200);
    expect(((await added.json()) as { roles: string[] }).roles).toEqual(["view", "comment"]);
  });

  it("adds people on private sharing alone where this deployment has no comments object", async () => {
    const { owner, priv } = await world();
    const sharing = {
      PLAN_LIMITS: JSON.stringify({ pro: { documents: 100, pushesPerDay: 100, htmlBytes: 1048576, privateSharing: true } }),
    };
    const path = `/api/v1/docs/${priv}/access/people/dee%40acme.com`;
    // With the object bound, a plan without the comments flag adds at the highest role it grants.
    const viewer = await send("PUT", path, owner.token, undefined, sharing);
    expect(viewer.status).toBe(200);
    const listed = (await viewer.json()) as { roles?: string[]; people: { email: string; role: string }[] };
    expect(listed.roles).toEqual(["view"]);
    expect(listed.people.find((person) => person.email === "dee@acme.com")?.role).toBe("view");
    // It still cannot grant a role its plan lacks, and the refusal names the flag it lacks.
    const refused = await send("PUT", path, owner.token, { role: "comment" }, sharing);
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { error: { limit: string } }).error.limit).toBe("comments");
    await send("DELETE", path, owner.token, undefined, sharing);
    // Without it no role is drawn, and adding is gated as before.
    const added = await send("PUT", path, owner.token, undefined, { ...sharing, COMMENTS: undefined });
    expect(added.status).toBe(200);
    expect(((await added.json()) as { roles?: string[] }).roles).toBeUndefined();
    // An explicit role is still checked against its flag, which this plan lacks.
    const named = await send("PUT", path.replace("dee", "eve"), owner.token, { role: "comment" }, { ...sharing, COMMENTS: undefined });
    expect(named.status).toBe(402);
    expect(((await named.json()) as { error: { limit: string } }).error.limit).toBe("comments");
    // Nobody saw a role, so the grant is `view`: binding comments later makes no one a commenter.
    const stored = await env.DB.prepare("SELECT role FROM doc_invites WHERE doc_id = ? AND email = 'dee@acme.com'").bind(priv).first<{ role: string }>();
    expect(stored?.role).toBe("view");
  });

  it("adds nobody on a plan with comments but not private sharing, and says private sharing is what it lacks", async () => {
    const { owner, priv } = await world();
    const commentsOnly = {
      PLAN_LIMITS: JSON.stringify({ pro: { documents: 100, pushesPerDay: 100, htmlBytes: 1048576, comments: true } }),
    };
    const path = `/api/v1/docs/${priv}/access/people/dee%40acme.com`;
    for (const body of [undefined, { role: "comment" }, { role: "view" }]) {
      const refused = await send("PUT", path, owner.token, body, commentsOnly);
      expect(refused.status).toBe(402);
      expect(((await refused.json()) as { error: { limit: string } }).error.limit).toBe("privateSharing");
    }
    const shown = (await (await send("GET", `/api/v1/docs/${priv}/access`, owner.token, undefined, commentsOnly)).json()) as { roles?: string[] };
    expect(shown.roles).toEqual([]);
  });

  it("rechecks a plan that grants no role when the owner opens Share, so an upgrade shows at once", async () => {
    const { owner, priv } = await world();
    const license = { LICENSE_API_URL: "https://license.test", LICENSE_API_KEY: "ours" };
    let calls = 0;
    let answer = "default";
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input instanceof Request ? input.url : input).startsWith("https://license.test/")) return real(input, init);
      calls += 1;
      return Response.json({ result: { data: { json: { plan: answer, expiresAt: null } } } });
    });
    const roles = async () =>
      ((await (await send("GET", `/embed/api/docs/${priv}/access`, await frame(owner, priv), undefined, license)).json()) as { roles: string[] }).roles;
    // Checked a minute ago, before the owner went to checkout.
    const setPlan = (plan: string, retryAfter: number | null = null) =>
      env.DB.prepare("UPDATE accounts SET plan = ?, plan_checked_at = ?, plan_retry_after = ? WHERE id = ?").bind(plan, Date.now() - 60_000, retryAfter, owner.id).run();

    // Still free: asked once, and an open straight after is not asked again.
    await setPlan("free");
    expect(await roles()).toEqual([]);
    expect(await roles()).toEqual([]);
    expect(calls).toBe(1);
    calls = 0;
    // Upgraded since: the open asks the license server, and Add people is back.
    await setPlan("free");
    answer = "plus";
    expect(await roles()).toEqual(["view", "comment"]);
    expect(calls).toBe(1);
    // A paid plan keeps its cache.
    expect(await roles()).toEqual(["view", "comment"]);
    expect(calls).toBe(1);
    // A license server backing off is not asked again.
    await setPlan("free", Date.now() + 60_000);
    expect(await roles()).toEqual([]);
    expect(calls).toBe(1);
    // The first write after an upgrade goes by the same recheck, not the hour-old cache.
    await setPlan("free");
    const added = await send("PUT", `/embed/api/docs/${priv}/access/people/dee%40acme.com`, await frame(owner, priv), undefined, license);
    expect(added.status).toBe(200);
    expect(calls).toBe(2);
    // A paid plan that has expired is shown as the write gate sees it: lapsed, with nothing to grant.
    await env.DB.prepare("UPDATE accounts SET plan = 'pro', plan_expires_at = ?, plan_checked_at = ? WHERE id = ?").bind(Date.now() - 1000, Date.now(), owner.id).run();
    answer = "default";
    expect(await roles()).toEqual([]);
  });

  it("answers 404 everywhere when this deployment has no comments object", async () => {
    const { alice, priv } = await world();
    const none = { COMMENTS: undefined };
    expect((await send("GET", `/api/v1/docs/${priv}/threads`, alice.token, undefined, none)).status).toBe(404);
    expect((await send("POST", `/api/v1/docs/${priv}/threads`, alice.token, { anchor: fox, body: "x" }, none)).status).toBe(404);
    const embedList = await send("GET", `/embed/api/docs/${priv}/threads`, await frame(alice, priv), undefined, none);
    expect(embedList.status).toBe(404);
  });

  it("answers 404 before looking at the body, query or credential when there is no comments object", async () => {
    const { owner, alice, priv } = await world();
    const none = { COMMENTS: undefined };
    const th = "th_0000000000000000";
    // A malformed body, a bad query and a missing credential would each be 400 or 401 on a deployment with comments.
    expect((await send("POST", `/api/v1/docs/${priv}/threads`, alice.token, "{not json", none)).status).toBe(404);
    expect((await send("POST", `/api/v1/docs/${priv}/threads`, alice.token, {}, none)).status).toBe(404);
    expect((await send("POST", `/api/v1/docs/${priv}/threads/${th}/comments`, alice.token, {}, none)).status).toBe(404);
    expect((await send("POST", `/api/v1/docs/${priv}/threads/${th}/resolve`, alice.token, { version: "x" }, none)).status).toBe(404);
    expect((await send("GET", `/api/v1/docs/${priv}/threads?state=bogus&since=x&v=0`, alice.token, undefined, none)).status).toBe(404);
    expect((await send("DELETE", `/api/v1/docs/${priv}/comments/cm_0000000000000000`, alice.token, undefined, none)).status).toBe(404);
    // The frame: no token, a bad body or a bad query, all 404 first.
    expect((await send("POST", `/embed/api/docs/${priv}/threads`, null, "{not json", none)).status).toBe(404);
    expect((await send("GET", `/embed/api/docs/${priv}/threads?state=bogus`, null, undefined, none)).status).toBe(404);
    // The display name exists only for comments.
    expect((await send("PUT", "/api/v1/account", owner.token, { displayName: "Nope" }, none)).status).toBe(404);
    expect((await send("PUT", "/embed/api/account", await frame(owner, priv), { displayName: "Nope" }, none)).status).toBe(404);
    expect((await send("PUT", "/api/v1/account", owner.token, { displayName: "Nope" }, { READER_SESSION_SECRET: "" })).status).toBe(404);
    expect(await env.DB.prepare("SELECT display_name FROM accounts WHERE id = ?").bind(owner.id).first()).toEqual({ display_name: "Logan" });
  });
});

describe("who can comment", () => {
  it("lets the owner, an invited commenter and an agent post, and nobody else", async () => {
    const { owner, alice, bob, carol, priv, pub } = await world();

    // People, through the frame.
    expect((await thread(priv, await frame(owner, priv))).status).toBe(201);
    expect((await thread(priv, await frame(alice, priv))).status).toBe(201);
    // Can view reads but cannot write; a stranger cannot even read. Both `404`, never `403`.
    expect((await thread(priv, await frame(bob, priv))).status).toBe(404);
    expect((await thread(priv, await frame(carol, priv))).status).toBe(404);
    // A public page is the same: Link access plays no part. The person on the list at Can comment posts; a Can view
    // invitee and a signed-in stranger get the same `404` a stranger gets on a private page.
    expect((await thread(pub, await frame(alice, pub))).status).toBe(201);
    expect((await thread(pub, await frame(bob, pub))).status).toBe(404);
    expect((await thread(pub, await frame(carol, pub))).status).toBe(404);

    // Agents: an account token comments as its account.
    expect((await thread(priv, owner.token)).status).toBe(201);
    expect((await thread(priv, alice.token)).status).toBe(201);
    expect((await thread(priv, bob.token)).status).toBe(404);
    expect((await thread(priv, carol.token)).status).toBe(404);
    expect((await thread(pub, alice.token)).status).toBe(201);
    expect((await thread(pub, bob.token)).status).toBe(404);
    expect((await thread(pub, carol.token)).status).toBe(404);

    // No credential at all is `401`, as everywhere under /api/v1.
    expect((await thread(priv, null)).status).toBe(401);
  });

  it("lets a license key comment as its linked account, and says which document it is", async () => {
    const owner = await person("logan@acme.com", "Logan");
    const KEY = "cplus_live_a1b2c3d4e5f60718";
    await env.DB.prepare("INSERT INTO publishers (key_hash, plan, validated_at, owner) VALUES (?, 'believer', ?, 'lic-owner')")
      .bind(await sha256Hex(KEY), Date.now())
      .run();
    expect(await linkExternalOwner(env.DB, "lic-owner", owner.id, Date.now())).toBe("linked");
    const docId = await publish(owner, "Linked", TEXT, "invited");

    const made = await created(await thread(docId, KEY));
    const listed = await threadsOf(await listThreads(docId, owner.token));
    // The key and the account are one author: the thread is the owner's own.
    expect(listed.threads[0]!.comments[0]).toMatchObject({ author: { name: "Logan's agent", kind: "agent" }, mine: true });
    expect(listed.threads[0]!.threadId).toBe(made.threadId);
  });

  it("needs no switch: a document nobody can comment on still lists its threads, to whoever can read it", async () => {
    const owner = await person("logan@acme.com", "Logan");
    const carol = await person("carol@other.com", "Carol");
    const pub = await publish(owner, "Public notes", TEXT, "anyone");
    const priv = await publish(owner, "Private notes", TEXT, "invited");

    // A new page has no comments, and says so with a 200 and an empty list, never a 409.
    for (const who of [owner, carol]) expect((await threadsOf(await listThreads(pub, who.token))).threads, who.email).toEqual([]);
    expect((await listThreads(priv, owner.token)).status).toBe(200);
    expect((await listThreads(priv, carol.token)).status).toBe(404);
    // The owner's agent comments with nobody on the list; a signed-in reader of the public page reads it and cannot write.
    await created(await thread(pub, owner.token));
    expect((await threadsOf(await listThreads(pub, carol.token))).threads).toHaveLength(1);
    expect((await thread(pub, carol.token)).status).toBe(404);
    expect((await thread(pub, await frame(carol, pub))).status).toBe(404);
  });

  it("lets a person on the list at a role of at least comment write, and nobody below it", async () => {
    const { owner, alice, bob, priv, pub } = await world();
    for (const docId of [priv, pub]) {
      const asked = (who: Person) => thread(docId, who.token);
      expect((await asked(alice)).status).toBe(201);
      expect((await asked(bob)).status).toBe(404);
      expect((await asked(owner)).status).toBe(201);
    }
  });

  it("derives commentable from the list and the owner's plan, and answers the same to every viewer", async () => {
    const owner = await person("logan@acme.com", "Logan");
    const carol = await person("carol@other.com", "Carol");
    const docId = await publish(owner, "Public notes", TEXT, "anyone");
    const read = async (who: Person | null) => ((await (await listThreads(docId, who?.token ?? null)).json()) as { commentable: boolean }).commentable;

    expect(await read(carol)).toBe(false);
    await invite(docId, "viewer@acme.com", "view");
    expect(await read(carol)).toBe(false);
    await invite(docId, "writer@acme.com", "comment");
    expect(await read(carol)).toBe(true);
    expect(await read(owner)).toBe(true);
    expect((await (await send("GET", `/embed/api/docs/${docId}/threads`, null)).json() as { commentable: boolean }).commentable).toBe(true);

    // A lapsed owner's page is not commentable: nobody but the owner's agent could write, and they could not either.
    await env.DB.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(owner.id).run();
    expect(await read(carol)).toBe(false);
  });

  it("counts the owner for an invited-only page: commentable with nobody at Can comment, false once the plan lapses, and unchanged on a public page", async () => {
    const owner = await person("logan@acme.com", "Logan");
    const carol = await person("carol@other.com", "Carol");
    const priv = await publish(owner, "Private notes", TEXT, "invited");
    const pub = await publish(owner, "Public notes", TEXT, "anyone");
    await invite(priv, carol.email, "view");
    const read = async (docId: string, who: Person) => ((await (await listThreads(docId, who.token)).json()) as { commentable: boolean }).commentable;

    expect(await read(priv, owner)).toBe(true);
    expect(await read(priv, carol)).toBe(true);
    expect(await read(pub, owner)).toBe(false);

    await env.DB.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(owner.id).run();
    expect(await read(priv, owner)).toBe(false);
  });

  it("sets has_threads with the first thread, keeps it after the last is deleted, and never reads it from a switch", async () => {
    const { owner, alice, priv } = await world();
    const flag = async () =>
      ((await env.DB.prepare("SELECT has_threads FROM docs WHERE id = ?").bind(priv).first()) as { has_threads: number }).has_threads;
    expect(await flag()).toBe(0);
    const made = await created(await thread(priv, alice.token));
    expect(await flag()).toBe(1);
    await created(await thread(priv, owner.token));
    expect(await flag()).toBe(1);
    const listed = await threadsOf(await listThreads(priv, owner.token));
    for (const t of listed.threads) {
      expect((await send("DELETE", `/api/v1/docs/${priv}/comments/${t.comments[0]!.commentId}`, t.threadId === made.threadId ? alice.token : owner.token)).status).toBe(204);
    }
    expect((await threadsOf(await listThreads(priv, owner.token))).threads).toEqual([]);
    expect(await flag()).toBe(1);
  });

  it("writes no thread when has_threads cannot be set, so no thread hides behind the flag", async () => {
    const { alice, priv } = await world();
    const failing = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (sql.includes("SET has_threads")) throw new Error("D1 unavailable");
          return target.prepare(sql);
        };
      },
    });
    const refused = await send("POST", `${base(alice.token)}/docs/${priv}/threads`, alice.token, { anchor: fox, body: "Why brown?" }, { DB: failing });
    expect(refused.status).toBe(500);
    await created(await thread(priv, alice.token));
    expect((await threadsOf(await listThreads(priv, alice.token))).threads).toHaveLength(1);
  });

  it("emails an invitation by the role it grants: commenting at comment, sharing at view, and nothing on a role change", async () => {
    const { owner, priv } = await world();
    sent.length = 0;
    const add = (email: string, role?: string) =>
      send("PUT", `/api/v1/docs/${priv}/access/people/${encodeURIComponent(email)}`, owner.token, role === undefined ? undefined : { role });
    expect((await add("dee@acme.com")).status).toBe(200);
    expect((await add("eve@acme.com", "view")).status).toBe(200);
    const [dee, eve] = sent;
    expect(dee!.to).toBe("dee@acme.com");
    expect(dee!.subject).toContain("invited you to comment on");
    expect(dee!.text).toContain("to comment.");
    expect(eve!.to).toBe("eve@acme.com");
    expect(eve!.subject).toContain("was shared with you");
    expect(eve!.text).toContain("to open it.");

    sent.length = 0;
    expect((await add("dee@acme.com", "view")).status).toBe(200);
    expect((await add("eve@acme.com", "comment")).status).toBe(200);
    expect(sent).toEqual([]);
    const people = ((await (await send("GET", `/api/v1/docs/${priv}/access`, owner.token)).json()) as { people: Array<{ email: string; role: string }> }).people;
    expect(people.filter((p) => p.email.endsWith("@acme.com") && ["dee", "eve"].includes(p.email.split("@")[0]!)).map((p) => [p.email, p.role])).toEqual([
      ["dee@acme.com", "view"],
      ["eve@acme.com", "comment"],
    ]);
  });

  it("answers the threads resource from the row for a document with no threads, without touching the object", async () => {
    const owner = await person("logan@acme.com", "Logan");
    const docId = await publish(owner, "Public notes", TEXT, "anyone");
    await invite(docId, "writer@acme.com", "comment");
    const broken = { COMMENTS: { idFromName: () => { throw new Error("object reached"); }, get: () => { throw new Error("object reached"); } } } as unknown as Partial<Env>;
    const response = await send("GET", `https://openartifacts.site/d/${docId}/threads`, null, undefined, broken);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 1, commentable: true, threads: [] });
  });

  it("keeps a Can-comment invitee's comments when they become Can view, and stops their writes", async () => {
    const { owner, alice, priv } = await world();
    const made = await created(await thread(priv, alice.token));
    await env.DB.prepare("UPDATE doc_invites SET role = 'view' WHERE doc_id = ? AND email = ?").bind(priv, alice.email).run();

    const listed = await threadsOf(await listThreads(priv, owner.token));
    expect(listed.threads.map((t) => t.threadId)).toEqual([made.threadId]);
    expect((await thread(priv, alice.token)).status).toBe(404);
    const reply = await send("POST", `/api/v1/docs/${priv}/threads/${made.threadId}/comments`, alice.token, { body: "x" });
    expect(reply.status).toBe(404);
    // And she may still take back what she wrote.
    const first = listed.threads[0]!.comments[0]!.commentId;
    expect((await send("DELETE", `/api/v1/docs/${priv}/comments/${first}`, alice.token)).status).toBe(204);
  });

  it("refuses a Share token for another document, an expired one and a forged one", async () => {
    const { alice, priv, pub } = await world();
    const forA = await frame(alice, priv);
    // Right account, wrong document.
    expect((await thread(pub, forA)).status).toBe(401);
    expect((await send("GET", `/embed/api/docs/${pub}/threads`, forA)).status).toBe(401);
    expect((await thread(priv, await frame(alice, priv, Date.now() - 1))).status).toBe(401);
    const forged = SHARE_TOKEN_PREFIX + (await signPayload("z".repeat(32), "share-token", { a: alice.id, d: priv }, Date.now() + 60_000));
    expect((await send("POST", `/embed/api/docs/${priv}/threads`, forged, { anchor: fox, body: "x" })).status).toBe(401);

    // And the other way: /api/v1 does not take the popover's token at all.
    const viaApi = await send("POST", `/api/v1/docs/${priv}/threads`, forA, { anchor: fox, body: "x" });
    expect(viaApi.status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM publishers").first()).toEqual({ n: 0 });
  });
});

describe("threads", () => {
  it("posts, lists with authors as {name, kind} and no ids, replies, resolves, reopens", async () => {
    const { owner, alice, priv } = await world();
    const made = await created(await thread(priv, await frame(alice, priv), fox, "  Why brown?  "));
    expect(made.anchorStatus).toBe("anchored");
    expect(made.threadId).toMatch(/^th_/);
    expect(made.commentId).toMatch(/^cm_/);

    const reply = await send("POST", `/api/v1/docs/${priv}/threads/${made.threadId}/comments`, owner.token, {
      body: "Fixed in v2.",
    });
    expect(reply.status).toBe(201);
    expect(((await reply.json()) as { commentId: string }).commentId).toMatch(/^cm_/);

    const seen = await threadsOf(await listThreads(priv, owner.token));
    expect(seen).toMatchObject({ docId: priv, title: "Q3 client report", version: 1, latestVersion: 1 });
    expect(seen.viewer).toEqual({ canComment: true, canManage: true, name: "Logan" });
    const [t] = seen.threads;
    expect(t).toMatchObject({
      anchorStatus: "anchored",
      matchedText: "brown fox",
      createdAtVersion: 1,
      state: "open",
      resolution: null,
      canResolve: true,
    });
    expect(t!.comments.map((c) => [c.author, c.body, c.mine])).toEqual([
      [{ name: "Alice", kind: "human" }, "Why brown?", false],
      [{ name: "Logan's agent", kind: "agent" }, "Fixed in v2.", true],
    ]);
    // Neither an account id nor an address anywhere in the answer.
    const raw = JSON.stringify(seen);
    for (const secret of [alice.id, owner.id, alice.email, owner.email, "createdBy", "updatedAt"]) {
      expect(raw).not.toContain(secret);
    }

    const resolved = await send("POST", `/api/v1/docs/${priv}/threads/${made.threadId}/resolve`, owner.token, {});
    expect(resolved.status).toBe(200);
    expect(((await resolved.json()) as ThreadJson)).toMatchObject({
      threadId: made.threadId,
      state: "resolved",
      resolution: { by: { name: "Logan's agent", kind: "agent" }, atVersion: 1 },
    });
    // Idempotent: the same answer again, and still resolved by the first.
    const again = await send("POST", `/api/v1/docs/${priv}/threads/${made.threadId}/resolve`, owner.token);
    expect(again.status).toBe(200);
    expect(((await again.json()) as ThreadJson).state).toBe("resolved");

    expect(
      (await threadsOf(await listThreads(priv, owner.token, "?state=open"))).threads,
    ).toHaveLength(0);
    expect(
      (await threadsOf(await listThreads(priv, owner.token, "?state=resolved"))).threads,
    ).toHaveLength(1);

    const reopened = await send("POST", `/api/v1/docs/${priv}/threads/${made.threadId}/reopen`, owner.token);
    expect(((await reopened.json()) as ThreadJson)).toMatchObject({ state: "open", resolution: null });
  });

  it("limits resolve and reopen to the owner and the thread's author", async () => {
    const { owner, alice, priv } = await world();
    const erin = await person("erin@acme.com", "Erin");
    await invite(priv, erin.email, "comment");
    const bobsView = await person("view@acme.com", "Vi");
    await invite(priv, bobsView.email, "view");

    const made = await created(await thread(priv, alice.token));
    const path = (action: string) => `/api/v1/docs/${priv}/threads/${made.threadId}/${action}`;

    // A commenter who is neither the owner nor the author, and a viewer: `404`.
    expect((await send("POST", path("resolve"), erin.token)).status).toBe(404);
    expect((await send("POST", path("resolve"), bobsView.token)).status).toBe(404);
    expect(((await threadsOf(await listThreads(priv, erin.token))).threads[0] as ThreadJson).canResolve).toBe(false);

    // The author, through the frame as a person, resolves; the owner reopens.
    const resolved = await send("POST", `/embed/api/docs/${priv}/threads/${made.threadId}/resolve`, await frame(alice, priv), {});
    expect(resolved.status).toBe(200);
    expect((await send("POST", path("reopen"), erin.token)).status).toBe(404);
    expect((await send("POST", path("reopen"), owner.token)).status).toBe(200);
    // Unknown and malformed thread ids are `404` too.
    expect((await send("POST", `/api/v1/docs/${priv}/threads/th_unknown/resolve`, owner.token)).status).toBe(404);
    expect((await send("POST", `/api/v1/docs/${priv}/threads/nope/resolve`, owner.token)).status).toBe(404);
  });

  it("deletes a reply, and a first comment takes its thread and replies with it", async () => {
    const { owner, alice, priv } = await world();
    const made = await created(await thread(priv, alice.token));
    const reply = (await (await send("POST", `/api/v1/docs/${priv}/threads/${made.threadId}/comments`, owner.token, { body: "ok" })).json()) as {
      commentId: string;
    };
    const del = (commentId: string, who: string) => send("DELETE", `/api/v1/docs/${priv}/comments/${commentId}`, who);

    // Only the author: the owner's agent cannot remove Alice's, and cannot probe ids.
    expect((await del(made.commentId, owner.token)).status).toBe(404);
    expect((await del("cm_unknown", owner.token)).status).toBe(404);
    expect((await del("junk", owner.token)).status).toBe(404);
    expect((await del(reply.commentId, alice.token)).status).toBe(404);

    expect((await del(reply.commentId, owner.token)).status).toBe(204);
    expect((await threadsOf(await listThreads(priv, owner.token))).threads[0]!.comments).toHaveLength(1);

    const gone = await del(made.commentId, alice.token);
    expect(gone.status).toBe(204);
    expect(await gone.text()).toBe("");
    expect((await threadsOf(await listThreads(priv, owner.token))).threads).toEqual([]);
    expect((await del(made.commentId, alice.token)).status).toBe(404);
  });

  it("lets an author delete once her role is lowered or the owner's plan lapsed, and a stranger not at all", async () => {
    const { owner, alice, carol, priv } = await world();
    const made = await created(await thread(priv, alice.token));
    const second = await created(await thread(priv, alice.token, { exact: "twelve percent" }));

    await env.DB.prepare("UPDATE doc_invites SET role = 'view' WHERE doc_id = ? AND email = ?").bind(priv, alice.email).run();
    expect((await send("DELETE", `/api/v1/docs/${priv}/comments/${made.commentId}`, alice.token)).status).toBe(204);

    await env.DB.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(owner.id).run();
    expect((await send("DELETE", `/api/v1/docs/${priv}/comments/${second.commentId}`, alice.token)).status).toBe(204);
    // A stranger who cannot read the document learns nothing from the id.
    expect((await send("DELETE", `/api/v1/docs/${priv}/comments/${second.commentId}`, carol.token)).status).toBe(404);
  });

  it("keeps reads and refuses writes once the owner's plan lapses: 402 to the owner, 404 to the rest", async () => {
    const { owner, alice, priv } = await world();
    const made = await created(await thread(priv, alice.token));
    expect((await threadsOf(await listThreads(priv, owner.token))).threads[0]!.canResolve).toBe(true);
    await env.DB.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(owner.id).run();

    // Resolve answers 402 to the owner now, so the frame must not offer it.
    const lapsedOwner = await threadsOf(await listThreads(priv, owner.token));
    expect(lapsedOwner.viewer).toMatchObject({ canComment: false, canManage: true });
    expect(lapsedOwner.threads[0]!.canResolve).toBe(false);
    const read = await threadsOf(await listThreads(priv, alice.token));
    expect(read.threads).toHaveLength(1);
    expect(read.viewer).toMatchObject({ canComment: false });

    const ownerWrite = await thread(priv, owner.token);
    expect(ownerWrite.status).toBe(402);
    expect(await errorOf(ownerWrite)).toMatchObject({ code: "limit_reached", limit: "comments" });
    expect((await thread(priv, alice.token)).status).toBe(404);
    expect((await send("POST", `/api/v1/docs/${priv}/threads/${made.threadId}/comments`, alice.token, { body: "x" })).status).toBe(404);
    expect((await send("POST", `/api/v1/docs/${priv}/threads/${made.threadId}/resolve`, alice.token)).status).toBe(404);

    // An expired paid plan lapses the same way.
    await env.DB.prepare("UPDATE accounts SET plan = 'pro', plan_expires_at = ? WHERE id = ?").bind(Date.now() - 1000, owner.id).run();
    expect((await thread(priv, alice.token)).status).toBe(404);
    await env.DB.prepare("UPDATE accounts SET plan_expires_at = NULL WHERE id = ?").bind(owner.id).run();
    expect((await thread(priv, alice.token)).status).toBe(201);
  });

  it("filters by state and since, and rejects a malformed query", async () => {
    const { owner, alice, priv } = await world();
    const first = await created(await thread(priv, alice.token));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const cutoff = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await created(await thread(priv, alice.token, { exact: "twelve percent" }, "Check"));
    await send("POST", `/api/v1/docs/${priv}/threads/${first.threadId}/resolve`, owner.token);

    const ids = async (query: string) => (await threadsOf(await listThreads(priv, owner.token, query))).threads.map((t) => t.threadId);
    expect(await ids("")).toEqual([first.threadId, second.threadId]);
    expect(await ids("?state=open")).toEqual([second.threadId]);
    expect(await ids("?state=resolved")).toEqual([first.threadId]);
    // Activity after the cutoff: the second thread, and the first, which was resolved after it.
    expect(await ids(`?since=${encodeURIComponent(cutoff)}`)).toEqual([first.threadId, second.threadId]);
    expect(await ids(`?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).toEqual([]);

    for (const query of ["?state=bogus", "?since=yesterday", "?since=12345", "?v=0", "?v=01", "?v=abc"]) {
      const response = await listThreads(priv, owner.token, query);
      expect(response.status, query).toBe(400);
      expect((await errorOf(response)).code).toBe("bad_request");
    }
    // A version that never existed is no page.
    expect((await listThreads(priv, owner.token, "?v=9")).status).toBe(404);
  });

  it("answers anchors per version: a thread orphans where its text is gone and returns with it", async () => {
    const { owner, alice, priv } = await world();
    await created(await thread(priv, alice.token));
    expect((await send("PUT", `/api/v1/docs/${priv}`, owner.token, { html: page("<p>Nothing alike.</p>") })).status).toBe(200);
    expect((await send("PUT", `/api/v1/docs/${priv}`, owner.token, { html: page(TEXT) })).status).toBe(200);

    const at = async (v: number) => (await threadsOf(await listThreads(priv, owner.token, `?v=${v}`))).threads[0]!;
    expect(await at(1)).toMatchObject({ anchorStatus: "anchored", matchedText: "brown fox" });
    expect(await at(2)).toMatchObject({ anchorStatus: "orphaned", matchedText: null });
    expect(await at(3)).toMatchObject({ anchorStatus: "anchored" });
    expect((await threadsOf(await listThreads(priv, owner.token))).version).toBe(3);

    // A comment on a pinned page is anchored to that page's version, which can be older than the latest.
    const pinned = await created(await thread(priv, alice.token, { exact: "brown fox" }, "old", { version: 1 }));
    expect(pinned.anchorStatus).toBe("anchored");
    const gone = await thread(priv, alice.token, fox, "x", { version: 2 });
    expect(gone.status).toBe(400);
    expect((await errorOf(gone)).code).toBe("anchor_not_found");
    expect((await thread(priv, alice.token, fox, "x", { version: 99 })).status).toBe(404);
  });

  it("rejects a malformed post with 400 and a quote that is not on the page with anchor_not_found", async () => {
    const { alice, priv } = await world();
    const bad = async (response: Response, code: string) => {
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe(code);
    };
    await bad(await thread(priv, alice.token, { exact: "not in the page" }), "anchor_not_found");
    await bad(await thread(priv, alice.token, { exact: "" }), "bad_request");
    await bad(await thread(priv, alice.token, { exact: "x".repeat(1001) }), "bad_request");
    await bad(await thread(priv, alice.token, fox, ""), "bad_request");
    await bad(await thread(priv, alice.token, fox, "x".repeat(4001)), "bad_request");
    await bad(await thread(priv, alice.token, "not an object" as never), "bad_request");
    await bad(await thread(priv, alice.token, fox, "x", { author: "someone else" }), "bad_request");
    await bad(await thread(priv, alice.token, fox, "x", { version: "1" }), "bad_request");
    await bad(await send("POST", `/api/v1/docs/${priv}/threads`, alice.token, "{not json"), "bad_request");
    await bad(await send("POST", `/api/v1/docs/${priv}/threads`, alice.token, "x".repeat(40 * 1024)), "bad_request");
    // A body of exactly 4,000 characters is the largest allowed.
    expect((await thread(priv, alice.token, fox, "y".repeat(4000))).status).toBe(201);
  });

  it("caps a document at 500 threads and 2,000 comments with 402 limit_reached", async () => {
    const { alice, priv } = await world();
    const stub = env.COMMENTS!.get(env.COMMENTS!.idFromName(priv));
    await runInDurableObject(stub, async (instance: DocComments, state) => {
      (instance as unknown as { usable(): boolean }).usable(); // the schema is created on first use
      const sql = state.storage.sql;
      for (let i = 0; i < MAX_THREADS; i++) {
        sql.exec(`INSERT INTO threads (id, created_version, created_by, created_at, updated_at, anchor_exact) VALUES (?, 1, 'x', ?, ?, 'fox')`, `th_${i}`, i, i);
        sql.exec(`INSERT INTO comments (id, thread_id, author, author_kind, body, created_at, at_version) VALUES (?, ?, 'x', 'human', 'b', ?, 1)`, `cm_${i}`, `th_${i}`, i);
      }
    });
    const full = await thread(priv, alice.token);
    expect(full.status).toBe(402);
    expect(await errorOf(full)).toMatchObject({ code: "limit_reached", limit: "threads" });
    expect((await errorOf(await thread(priv, alice.token)) as { upgrade_url?: string }).upgrade_url).toBeUndefined();

    await runInDurableObject(stub, async (_i: DocComments, state) => {
      const sql = state.storage.sql;
      sql.exec(`DELETE FROM threads WHERE id <> 'th_0'`);
      sql.exec(`DELETE FROM comments`);
      for (let i = 0; i < MAX_COMMENTS; i++) {
        sql.exec(`INSERT INTO comments (id, thread_id, author, author_kind, body, created_at, at_version) VALUES (?, 'th_0', 'x', 'human', 'b', ?, 1)`, `cm_${i}`, i);
      }
    });
    const reply = await send("POST", `/api/v1/docs/${priv}/threads/th_0/comments`, alice.token, { body: "one more" });
    expect(reply.status).toBe(402);
    expect(await errorOf(reply)).toMatchObject({ code: "limit_reached", limit: "comments" });
  });

  it("refuses a write over the per-principal rate limit with 429 and Retry-After, and spends it only on writes that pass", async () => {
    const { alice, bob, priv } = await world();
    const keys: string[] = [];
    let allow = false;
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: allow };
      },
    } as unknown as RateLimit;
    const over = { COMMENT_WRITE_LIMITER: limiter };

    const refused = await send("POST", `/api/v1/docs/${priv}/threads`, alice.token, { anchor: fox, body: "x" }, over);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect((await errorOf(refused)).code).toBe("quota_exceeded");
    expect(await env.COMMENTS!.get(env.COMMENTS!.idFromName(priv)).list({ docId: priv, version: 1 })).toMatchObject({ threads: [] });

    // A write that was never allowed does not touch the limiter, and reads never do.
    keys.length = 0;
    await send("POST", `/api/v1/docs/${priv}/threads`, bob.token, { anchor: fox, body: "x" }, over);
    await send("GET", `/api/v1/docs/${priv}/threads`, alice.token, undefined, over);
    expect(keys).toEqual([]);

    allow = true;
    expect((await send("POST", `/api/v1/docs/${priv}/threads`, alice.token, { anchor: fox, body: "x" }, over)).status).toBe(201);
    // Keyed by principal, hashed: no id in the key.
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(keys[0]).not.toContain(alice.id);
  });
});

describe("display names", () => {
  it("names a person from their email before the @, without a +tag, on their first comment instead of asking, and keeps a chosen name", async () => {
    const { priv } = await world();
    const erin = await person("erin@acme.com", null);
    await invite(priv, erin.email, "comment");

    const first = await thread(priv, await frame(erin, priv));
    expect(first.status).toBe(201);
    expect(await env.DB.prepare("SELECT display_name FROM accounts WHERE id = ?").bind(erin.id).first()).toEqual({
      display_name: "erin",
    });

    // An agent acting for the same account is named after it.
    const agent = await created(await thread(priv, erin.token));
    expect(agent.anchorStatus).toBe("anchored");

    const named = await send("PUT", "/embed/api/account", await frame(erin, priv), { displayName: "  Erin E.  " });
    expect(named.status).toBe(200);
    expect(await named.json()).toEqual({ displayName: "Erin E." });
    expect((await thread(priv, await frame(erin, priv), { exact: "twelve percent" })).status).toBe(201);

    const names = (await threadsOf(await listThreads(priv, erin.token))).threads.flatMap((t) => t.comments.map((c) => c.author));
    expect(names).toEqual([
      { name: "Erin E.", kind: "human" },
      { name: "Erin E.'s agent", kind: "agent" },
      { name: "Erin E.", kind: "human" },
    ]);
  });

  it("names the account through every credential, and validates the name", async () => {
    const owner = await person("logan@acme.com", null);
    const KEY = "cplus_live_a1b2c3d4e5f60718";
    const KEY_UNLINKED = "cplus_live_0102030405060708";
    for (const [key, ext] of [[KEY, "lic-linked"], [KEY_UNLINKED, "lic-unlinked"]] as const) {
      await env.DB.prepare("INSERT INTO publishers (key_hash, plan, validated_at, owner) VALUES (?, 'believer', ?, ?)")
        .bind(await sha256Hex(key), Date.now(), ext)
        .run();
    }
    await linkExternalOwner(env.DB, "lic-linked", owner.id, Date.now());
    const name = (who: string | null, displayName: unknown) => send("PUT", "/api/v1/account", who, { displayName });
    const stored = () => env.DB.prepare("SELECT display_name FROM accounts WHERE id = ?").bind(owner.id).first();

    expect((await name(owner.token, "Logan Y")).status).toBe(200);
    expect(await stored()).toEqual({ display_name: "Logan Y" });
    // A license key whose owner is linked names that account; an unlinked one has none.
    expect(await (await name(KEY, "Via key")).json()).toEqual({ displayName: "Via key" });
    expect(await stored()).toEqual({ display_name: "Via key" });
    const unlinked = await name(KEY_UNLINKED, "Nobody");
    expect(unlinked.status).toBe(404);
    expect((await errorOf(unlinked)).code).toBe("not_found");
    expect((await name(null, "x")).status).toBe(401);

    for (const bad of ["", "   ", "x".repeat(65), "tab\there", "new\nline", 5, null]) {
      const response = await name(owner.token, bad);
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await name(owner.token, "x".repeat(64))).status).toBe(200);
    expect((await send("PUT", "/api/v1/account", owner.token, { displayName: "a", other: 1 })).status).toBe(400);
    // The frame's route takes a token for any document, and nothing else.
    expect((await send("PUT", "/embed/api/account", SHARE_TOKEN_PREFIX + "junk", { displayName: "x" })).status).toBe(401);
    expect((await send("GET", "/embed/api/account", await frame(owner, "0123456789abcdef"))).status).toBe(404);
  });

  it("labels an agent after the account it acts for, then the owner's agent, then any agent", async () => {
    const owner = await person("logan@acme.com", null);
    const stranger = await person("zed@other.com", null);
    const docId = await publish(owner, "Open", TEXT, "anyone");
    await invite(docId, stranger.email, "comment");

    await thread(docId, owner.token, fox, "from the owner's agent");
    await thread(docId, stranger.token, { exact: "twelve percent" }, "from someone else's agent");
    let names = (await threadsOf(await listThreads(docId, owner.token))).threads.map((t) => t.comments[0]!.author.name);
    expect(names).toEqual(["Owner's agent", "An agent"]);

    await env.DB.prepare("UPDATE accounts SET display_name = 'Logan' WHERE id = ?").bind(owner.id).run();
    names = (await threadsOf(await listThreads(docId, owner.token))).threads.map((t) => t.comments[0]!.author.name);
    expect(names).toEqual(["Logan's agent", "An agent"]);
  });
});

describe("the embed family", () => {
  it("lists a public document with no token and an invited one only with a reader's token", async () => {
    const { alice, bob, carol, priv, pub } = await world();
    await created(await thread(pub, alice.token));
    await created(await thread(priv, alice.token));

    const anonymous = await send("GET", `/embed/api/docs/${pub}/threads`, null);
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    expect(anonymous.headers.get("access-control-allow-origin")).toBeNull();
    const body = await threadsOf(anonymous);
    expect(body.threads).toHaveLength(1);
    // The unauthenticated shape carries nothing about a viewer.
    expect(body.viewer).toBeUndefined();
    expect(body.threads[0]!.canResolve).toBeUndefined();
    expect(body.threads[0]!.comments[0]!.mine).toBeUndefined();

    expect((await send("GET", `/embed/api/docs/${priv}/threads`, null)).status).toBe(404);
    expect((await send("GET", `/embed/api/docs/${priv}/threads`, await frame(carol, priv))).status).toBe(404);
    const reader = await threadsOf(await send("GET", `/embed/api/docs/${priv}/threads`, await frame(alice, priv)));
    expect(reader.viewer).toEqual({ canComment: true, canManage: false, name: "Alice" });
    expect(reader.threads[0]!.comments[0]!.mine).toBe(true);

    // A wrong token is never quietly anonymous.
    expect((await send("GET", `/embed/api/docs/${pub}/threads`, SHARE_TOKEN_PREFIX + "junk")).status).toBe(401);
    // Writing needs a token.
    expect((await send("POST", `/embed/api/docs/${pub}/threads`, null, { anchor: fox, body: "x" })).status).toBe(401);
    // A Can-view reader's viewer says so, so the frame hides its Comment button.
    expect((await threadsOf(await send("GET", `/embed/api/docs/${priv}/threads`, await frame(bob, priv)))).viewer).toMatchObject({ canComment: false });
  });

  it("is absent on a server with no reader sign-in", async () => {
    const { alice, priv } = await world();
    const token = await frame(alice, priv);
    const response = await send("GET", `/embed/api/docs/${priv}/threads`, token, undefined, { READER_SESSION_SECRET: "" });
    expect(response.status).toBe(404);
    const api = await send("GET", `/api/v1/docs/${priv}/threads`, alice.token, undefined, { READER_SESSION_SECRET: "" });
    expect(api.status).toBe(404);
  });
});

describe("what comments change elsewhere", () => {
  it("opens GET …/html to anyone who can read the document, and only to them", async () => {
    const { owner, alice, bob, carol, priv, pub } = await world();
    for (const who of [owner, alice, bob]) {
      const response = await send("GET", `/api/v1/docs/${priv}/html`, who.token);
      expect(response.status, who.email).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-security-policy")).toBe("sandbox");
      expect(await response.text()).toContain("The quick brown fox");
    }
    expect((await send("GET", `/api/v1/docs/${priv}/html`, carol.token)).status).toBe(404);
    expect((await send("GET", `/api/v1/docs/${priv}/html`, null)).status).toBe(401);
    expect((await send("GET", `/api/v1/docs/${pub}/html`, carol.token)).status).toBe(200);
  });

  it("answers 404 for a deleted document everywhere, and purges its threads and snapshot", async () => {
    const { owner, alice, priv } = await world();
    await created(await thread(priv, alice.token));
    await drainSnapshots(priv);
    expect(await env.DOCS.head(threadsObjectKey(priv))).not.toBeNull();

    expect((await send("DELETE", `/api/v1/docs/${priv}`, owner.token)).status).toBe(204);

    for (const who of [owner, alice]) {
      expect((await listThreads(priv, who.token)).status).toBe(404);
      expect((await thread(priv, who.token)).status).toBe(404);
      expect((await send("GET", `/api/v1/docs/${priv}/html`, who.token)).status).toBe(404);
    }
    expect((await send("GET", `/embed/api/docs/${priv}/threads`, await frame(alice, priv))).status).toBe(404);
    expect(await env.DOCS.head(threadsObjectKey(priv))).toBeNull();
    const stub = env.COMMENTS!.get(env.COMMENTS!.idFromName(priv));
    await runInDurableObject(stub, async (_i: DocComments, state) => {
      // Emptied, and left empty: no tables are recreated, only the tombstone remains.
      const tables = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('threads', 'comments', 'anchors')`)
        .one().n;
      expect(tables).toBe(0);
      expect(await state.storage.get("purged")).toBe(true);
    });
    // A write that gets through to the object after the delete is refused, and writes no snapshot.
    expect((await thread(priv, alice.token)).status).toBe(404);
    expect(await env.DOCS.head(threadsObjectKey(priv))).toBeNull();
    // The row stays, so the serving origin can say 410 (serve.test.ts).
    expect(await env.DB.prepare("SELECT deleted_at FROM docs WHERE id = ?").bind(priv).first()).toEqual({ deleted_at: expect.any(Number) });
  });

  it("deletes a document whose comments object is unavailable, and leaves the 204 alone when the purge throws", async () => {
    const { owner, alice, priv, pub } = await world();
    await created(await thread(priv, alice.token));
    expect((await send("DELETE", `/api/v1/docs/${pub}`, owner.token, undefined, { COMMENTS: undefined })).status).toBe(204);
    const broken = {
      idFromName: () => ({}),
      get: () => ({ purge: async () => { throw new Error("object unavailable"); } }),
    } as unknown as DurableObjectNamespace<DocComments>;
    expect((await send("DELETE", `/api/v1/docs/${priv}`, owner.token, undefined, { COMMENTS: broken })).status).toBe(204);
    // The sweep still ran after the purge failed.
    expect((await env.DOCS.list({ prefix: `docs/${priv}/` })).objects.map((o) => o.key)).toEqual([`docs/${priv}/manifest.json`]);
  });

  it("still refuses oas_ on /api/v1, with the unchanged message", async () => {
    const { alice, priv } = await world();
    const response = await send("GET", `/api/v1/docs/${priv}/threads`, await frame(alice, priv));
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      "That token works only in the Share popover.",
    );
  });
});

describe("notifications", () => {
  const mailTo = (to: string) => sent.filter((mail) => mail.to === to);

  it("emails the owner a new thread with the quote, the text and the link, and nobody else", async () => {
    const { owner, alice, priv } = await world();
    await created(await thread(priv, await frame(alice, priv), fox, "This <b>overstates</b> the risk."));

    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail!.to).toBe(owner.email);
    expect(mail!.subject).toBe('Alice commented on "Q3 client report"');
    expect(mail!.text).toContain("brown fox");
    expect(mail!.text).toContain("This <b>overstates</b> the risk.");
    expect(mail!.text).toContain(`https://openartifacts.site/d/${priv}`);
    // Escaped in the HTML part, and nobody's address appears in either.
    expect(mail!.html).toContain("This &lt;b&gt;overstates&lt;/b&gt; the risk.");
    expect(mail!.html).not.toContain("<b>overstates");
    for (const part of [mail!.text, mail!.html, mail!.subject]) {
      expect(part).not.toContain(alice.email);
      expect(part).not.toContain("@");
    }
  });

  it("sends no email for the owner's own thread, and a reply or resolve goes to the other writers only", async () => {
    const { owner, alice, priv } = await world();
    const own = await created(await thread(priv, await frame(owner, priv), { exact: "twelve percent" }, "Mine"));
    expect(sent).toEqual([]);

    // Alice replies to the owner's thread: the owner, who wrote in it, is told; Alice is not.
    await send("POST", `/embed/api/docs/${priv}/threads/${own.threadId}/comments`, await frame(alice, priv), { body: "Agreed" });
    expect(sent.map((m) => m.to)).toEqual([owner.email]);
    expect(sent[0]!.subject).toBe('Alice replied on "Q3 client report"');

    // The owner's agent resolves it: it acts for the owner, who is excluded; Alice, who wrote in it, is told.
    sent.length = 0;
    await send("POST", `/api/v1/docs/${priv}/threads/${own.threadId}/resolve`, owner.token);
    expect(sent.map((m) => m.to)).toEqual([alice.email]);
    expect(sent[0]!.subject).toBe('Logan\'s agent resolved a comment on "Q3 client report" in version 1');
    // Idempotent: a repeat resolve mails nobody, and reopen mails nobody.
    sent.length = 0;
    await send("POST", `/api/v1/docs/${priv}/threads/${own.threadId}/resolve`, owner.token);
    await send("POST", `/api/v1/docs/${priv}/threads/${own.threadId}/reopen`, owner.token);
    expect(sent).toEqual([]);
  });

  it("routes an agent's comments to the account it acts for, and mails an unlinked license owner nobody", async () => {
    const { owner, alice, priv } = await world();
    const made = await created(await thread(priv, owner.token, fox, "from the agent"));
    expect(sent).toEqual([]); // the agent acts for the owner, who is the recipient
    await send("POST", `/api/v1/docs/${priv}/threads/${made.threadId}/comments`, alice.token, { body: "thanks" });
    expect(mailTo(owner.email)).toHaveLength(1);
    expect(mailTo(owner.email)[0]!.text).toContain("thanks");
  });

  it("mails nobody for an unlinked license key's comments: it has no account, so no mailbox", async () => {
    const { alice } = await world();
    const KEY = "cplus_live_a1b2c3d4e5f60718";
    await env.DB.prepare("INSERT INTO publishers (key_hash, plan, validated_at, owner) VALUES (?, 'believer', ?, 'lic-nomail')")
      .bind(await sha256Hex(KEY), Date.now())
      .run();
    // The key owns this document and has no account, so there is no mailbox for it or its threads.
    const own = ((await (await send("POST", "/api/v1/docs", KEY, { html: page(TEXT) })).json()) as { docId: string }).docId;
    await invite(own, alice.email, "comment");
    const made = await created(await thread(own, KEY, fox, "from a key with no account"));
    expect(sent).toEqual([]);

    // Alice replies: the thread's only other writer is the key, which cannot be mailed, and nothing throws.
    await send("POST", `/api/v1/docs/${own}/threads/${made.threadId}/comments`, alice.token, { body: "reply" });
    expect(sent).toEqual([]);
    // The key resolves: Alice, who has an account, is told.
    await send("POST", `/api/v1/docs/${own}/threads/${made.threadId}/resolve`, KEY);
    expect(sent.map((m) => m.to)).toEqual([alice.email]);
  });

  it("mails only people who can read the document now, however they once took part", async () => {
    const { owner, alice, priv, pub } = await world();
    const mine = await created(await thread(priv, alice.token));
    sent.length = 0;
    await send("POST", `/api/v1/docs/${priv}/threads/${mine.threadId}/comments`, owner.token, { body: "before removal" });
    expect(sent.map((m) => m.to)).toEqual([alice.email]);

    // Her invite is removed: she gets 404 everywhere and must get no more of the thread.
    await env.DB.prepare("DELETE FROM doc_invites WHERE doc_id = ? AND email = ?").bind(priv, alice.email).run();
    expect((await listThreads(priv, alice.token)).status).toBe(404);
    sent.length = 0;
    await send("POST", `/api/v1/docs/${priv}/threads/${mine.threadId}/comments`, owner.token, { body: "SECRET after removal" });
    await send("POST", `/api/v1/docs/${priv}/threads/${mine.threadId}/resolve`, owner.token);
    expect(sent).toEqual([]);

    // A public page turned invited-only drops a commenter whose invite was removed while it was public.
    const open = await created(await thread(pub, alice.token));
    sent.length = 0;
    await send("POST", `/api/v1/docs/${pub}/threads/${open.threadId}/comments`, owner.token, { body: "still public" });
    expect(sent.map((m) => m.to)).toEqual([alice.email]);
    await env.DB.prepare("DELETE FROM doc_invites WHERE doc_id = ? AND email = ?").bind(pub, alice.email).run();
    await env.DB.prepare("UPDATE docs SET link_access = 'invited' WHERE id = ?").bind(pub).run();
    sent.length = 0;
    await send("POST", `/api/v1/docs/${pub}/threads/${open.threadId}/comments`, owner.token, { body: "SECRET now private" });
    expect(sent).toEqual([]);
  });

  it("counts nobody a reader of a deleted document, so mail sent after a delete reaches no one", async () => {
    const { owner, alice, carol, priv, pub } = await world();
    expect(await readableAccounts(env.DB, priv, [owner.id, alice.id])).toEqual(new Set([owner.id, alice.id]));
    expect(await readableAccounts(env.DB, pub, [carol.id])).toEqual(new Set([carol.id]));
    // Notifications run after the response, so the delete can land first.
    await env.DB.prepare("UPDATE docs SET deleted_at = ? WHERE id IN (?, ?)").bind(Date.now(), priv, pub).run();
    expect(await readableAccounts(env.DB, priv, [owner.id, alice.id])).toEqual(new Set());
    expect(await readableAccounts(env.DB, pub, [carol.id])).toEqual(new Set());
  });

  it("sends after the response, on the request's execution context", async () => {
    const { owner, alice, priv } = await world();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = { send: async (message: Mail) => { await gate; sent.push(message); } };
    const ctx = createExecutionContext();
    // If the route awaited the mail, this fetch would wait on the gate forever.
    const response = await worker.fetch(
      new Request(`${API}/api/v1/docs/${priv}/threads`, {
        method: "POST",
        headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" },
        body: JSON.stringify({ anchor: fox, body: "slow mail" }),
      }),
      { ...env, ...HOSTS, EMAIL: slow } as unknown as Env,
      ctx,
    );
    expect(response.status).toBe(201);
    expect(sent).toEqual([]);
    release();
    await waitOnExecutionContext(ctx);
    expect(sent.map((m) => m.to)).toEqual([owner.email]);
  });

  it("sends nothing when mail is unconfigured, and survives a limiter that says no and a sender that throws", async () => {
    const { alice, priv } = await world();
    await created(await send("POST", `/api/v1/docs/${priv}/threads`, alice.token, { anchor: fox, body: "a" }, { EMAIL: undefined }));
    expect(sent).toEqual([]);

    const refusing = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    await created(await send("POST", `/api/v1/docs/${priv}/threads`, alice.token, { anchor: fox, body: "b" }, { COMMENT_EMAIL_LIMITER: refusing }));
    expect(sent).toEqual([]);

    let attempts = 0;
    const throwing = { send: async () => { attempts++; throw new Error("mail down"); } };
    const posted = await send("POST", `/api/v1/docs/${priv}/threads`, alice.token, { anchor: fox, body: "c" }, { EMAIL: throwing } as Partial<Env>);
    expect(posted.status).toBe(201);
    expect(attempts).toBe(1); // it was tried, to the owner, and its failure changed nothing
    expect(sent).toEqual([]);
  });
});


describe("review fixes", () => {
  const KEY = "cplus_live_a1b2c3d4e5f60718";
  const insertKey = async (ext: string) =>
    env.DB.prepare("INSERT INTO publishers (key_hash, plan, validated_at, owner) VALUES (?, 'believer', ?, ?)")
      .bind(await sha256Hex(KEY), Date.now(), ext)
      .run();

  it("keeps a license key's comments its own after the key is linked to an account", async () => {
    await insertKey("lic-writer");
    const pub = ((await (await send("POST", "/api/v1/docs", KEY, { html: page(TEXT) })).json()) as { docId: string }).docId;
    const first = await created(await thread(pub, KEY, fox, "from the key"));
    const second = await created(await thread(pub, KEY, { exact: "twelve percent" }, "also from the key"));
    const mineBefore = await threadsOf(await listThreads(pub, KEY));
    expect(mineBefore.threads.map((t) => [t.comments[0]!.mine, t.canResolve])).toEqual([[true, true], [true, true]]);

    const dave = await person("dave@acme.com", "Dave");
    expect(await linkExternalOwner(env.DB, "lic-writer", dave.id, Date.now())).toBe("linked");

    // Both credentials of the one author still see them as theirs...
    for (const credential of [KEY, dave.token]) {
      const listed = await threadsOf(await listThreads(pub, credential));
      expect(listed.threads.map((t) => [t.comments[0]!.mine, t.canResolve]), credential).toEqual([[true, true], [true, true]]);
    }
    // ...and can resolve, reopen and delete them.
    expect((await send("POST", `/api/v1/docs/${pub}/threads/${first.threadId}/resolve`, dave.token)).status).toBe(200);
    expect((await send("POST", `/api/v1/docs/${pub}/threads/${first.threadId}/reopen`, KEY)).status).toBe(200);
    expect((await send("DELETE", `/api/v1/docs/${pub}/comments/${second.commentId}`, dave.token)).status).toBe(204);
    expect((await send("DELETE", `/api/v1/docs/${pub}/comments/${first.commentId}`, KEY)).status).toBe(204);
    expect((await threadsOf(await listThreads(pub, dave.token))).threads).toEqual([]);

    // Someone else's account is still a stranger to them.
    const eve = await person("eve@acme.com", "Eve");
    const other = await created(await thread(pub, KEY, fox, "again"));
    expect((await send("DELETE", `/api/v1/docs/${pub}/comments/${other.commentId}`, eve.token)).status).toBe(404);
    expect((await send("POST", `/api/v1/docs/${pub}/threads/${other.threadId}/resolve`, eve.token)).status).toBe(404);
  });

  it("refuses a write that reaches the object after the document was purged, as a 404 with no snapshot", async () => {
    const { alice, priv } = await world();
    const made = await created(await thread(priv, alice.token));
    await drainSnapshots(priv);
    // The delete's purge ran, but this request had already passed the Worker's check against D1.
    await env.DOCS.delete(threadsObjectKey(priv));
    await env.COMMENTS!.get(env.COMMENTS!.idFromName(priv)).purge();

    expect((await thread(priv, alice.token)).status).toBe(404);
    expect((await send("POST", `/api/v1/docs/${priv}/threads/${made.threadId}/comments`, alice.token, { body: "late" })).status).toBe(404);
    expect((await send("POST", `/api/v1/docs/${priv}/threads/${made.threadId}/resolve`, alice.token)).status).toBe(404);
    expect((await send("DELETE", `/api/v1/docs/${priv}/comments/${made.commentId}`, alice.token)).status).toBe(404);
    expect((await listThreads(priv, alice.token)).status).toBe(404);
    expect(await env.DOCS.head(threadsObjectKey(priv))).toBeNull();
  });

  it("returns the thread from a write, so a reply or a new thread mails with its quote and needs no second object call", async () => {
    const { owner, alice, priv } = await world();
    const made = await created(await thread(priv, alice.token));
    expect(sent[0]!.text).toContain("brown fox");
    sent.length = 0;
    await send("POST", `/api/v1/docs/${priv}/threads/${made.threadId}/comments`, owner.token, { body: "reply" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("brown fox");
    expect(sent[0]!.text).toContain("reply");
  });
});
