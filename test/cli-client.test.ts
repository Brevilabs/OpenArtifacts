import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createClient, APIError } from "../packages/openartifacts/src/client.js";
import type { Env } from "../src/config.js";
import { sha256Hex } from "../src/hash.js";
import { newApiToken, newTokenId } from "../src/ids.js";
import worker from "../src/index.js";

const ORIGIN = "https://openartifacts.workers.dev";
const local = (): Env => ({
  ...env,
  SERVING_HOST: "",
  API_HOST: "",
  LEGACY_SERVING_HOST: "",
  RETIRED_API_HOST: "",
  DEVICE_CODE_LIMITER: undefined,
  DEVICE_POLL_LIMITER: undefined,
  DEVICE_POLL_CLIENT_LIMITER: undefined,
}) as Env;

async function issueToken(): Promise<{ token: string; id: string }> {
  await env.DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)")
    .bind("oa_cli_test_account000000000", "cli@example.test", Date.now()).run();
  const token = newApiToken();
  const id = newTokenId();
  await env.DB.prepare(
    "INSERT INTO tokens (id, token_hash, account_id, label, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, await sha256Hex(token), "oa_cli_test_account000000000", "CLI test", Date.now()).run();
  return { token, id };
}

const localFetch: typeof fetch = async (input, init) => {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(input, init), local(), context);
  await waitOnExecutionContext(context);
  return response;
};

describe("the CLI client against the local Worker", () => {
  it("covers login, publish, update, list, get, unshare, tokens and revoke", async () => {
    const anonymous = createClient({ host: ORIGIN, fetcher: localFetch });
    const code = await anonymous.deviceCode("CLI test");
    expect(code.verification_uri_complete).toContain(code.user_code);
    await expect(anonymous.deviceToken(code.device_code)).rejects.toMatchObject({
      code: "authorization_pending",
    } satisfies Partial<APIError>);

    const issued = await issueToken();
    const client = createClient({ host: ORIGIN, token: issued.token, fetcher: localFetch });
    const created = await client.createDoc({ title: "CLI", html: "<!doctype html><p>one</p>" });
    const updated = await client.updateDoc(created.docId, { title: "CLI", html: "<!doctype html><p>two</p>" });
    expect(updated).toMatchObject({ docId: created.docId, version: 2, url: created.url });
    expect(await client.listDocs()).toContainEqual(expect.objectContaining({ docId: created.docId }));
    expect(await client.getHtml(created.docId)).toContain("<p>two</p>");
    expect(await client.listTokens()).toMatchObject({ tokens: [expect.objectContaining({ tokenId: issued.id })] });
    await client.unshare(created.docId);
    await expect(client.getHtml(created.docId)).rejects.toMatchObject({ status: 404 });
    expect(await client.revoke(issued.id)).toEqual({ tokenId: issued.id, remaining: 0 });
  });

  it("reaches a server without reader sign-in as a 404 that creates nothing", async () => {
    const issued = await issueToken();
    const client = createClient({ host: ORIGIN, token: issued.token, fetcher: localFetch });
    await expect(client.createPrivateDoc({ title: "Private", html: "<p>x</p>" })).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    } satisfies Partial<APIError>);
    expect(await client.listDocs()).toEqual([]);
  });
});

describe("the comments client against the local Worker", () => {
  // Comments ride on the private-sharing family, so the server needs reader sign-in configured.
  const COMMENTS_HOST = "https://api.openartifacts.ai";
  const withReaders = (): Env => ({
    ...env,
    SERVING_HOST: "openartifacts.site",
    API_HOST: "api.openartifacts.ai",
    LEGACY_SERVING_HOST: "",
    RETIRED_API_HOST: "",
    READER_SESSION_SECRET: "k".repeat(32),
    OAUTH_GITHUB_CLIENT_ID: "github-client",
    OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
  }) as Env;
  const readerFetch: typeof fetch = async (input, init) => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request(input, init), withReaders(), context);
    await waitOnExecutionContext(context);
    return response;
  };

  // A paid account: comments are a plan feature, and turning them on is checked against the owner's plan.
  async function paidToken(): Promise<string> {
    const issued = await issueToken();
    await env.DB.prepare("UPDATE accounts SET plan = 'pro', plan_checked_at = ? WHERE id = ?")
      .bind(Date.now(), "oa_cli_test_account000000000").run();
    return issued.token;
  }

  it("turns comments on, then adds, lists, replies, resolves, reopens and deletes", async () => {
    const client = createClient({ host: COMMENTS_HOST, token: await paidToken(), fetcher: readerFetch });
    const doc = await client.createDoc({
      title: "Review",
      html: "<!doctype html><html><head><title>Review</title></head><body><p>The quick brown fox jumps.</p></body></html>",
    });

    // Off by default: the owner is told so, rather than given a 404.
    await expect(client.listThreads(doc.docId)).rejects.toMatchObject({
      status: 409,
      code: "comments_off",
    } satisfies Partial<APIError>);
    expect(await client.setComments(doc.docId, true)).toEqual({ docId: doc.docId, comments: true });
    expect(await client.setDisplayName("Cli Tester")).toEqual({ displayName: "Cli Tester" });

    const added = await client.addThread(doc.docId, { anchor: { exact: "quick brown fox" }, body: "Which fox?" });
    expect(added).toMatchObject({ anchorStatus: "anchored" });

    const listed = await client.listThreads(doc.docId, { state: "open" });
    expect(listed).toMatchObject({ docId: doc.docId, version: 1, latestVersion: 1 });
    expect(listed.threads).toHaveLength(1);
    expect(listed.threads[0]).toMatchObject({
      threadId: added.threadId,
      state: "open",
      anchor: { exact: "quick brown fox" },
      comments: [{ commentId: added.commentId, body: "Which fox?", author: { name: "Cli Tester's agent", kind: "agent" } }],
    });

    const replied = await client.replyToThread(doc.docId, added.threadId, "The red one.");
    expect(replied.commentId).toMatch(/^cm_/);

    const resolved = await client.resolveThread(doc.docId, added.threadId, 1);
    expect(resolved).toMatchObject({ threadId: added.threadId, state: "resolved", resolution: { atVersion: 1 } });
    expect((await client.listThreads(doc.docId, { state: "open" })).threads).toEqual([]);
    expect((await client.listThreads(doc.docId, { state: "resolved" })).threads).toHaveLength(1);

    expect(await client.reopenThread(doc.docId, added.threadId)).toMatchObject({ state: "open", resolution: null });

    // The reply goes first; the first comment takes the whole thread with it.
    await client.deleteComment(doc.docId, replied.commentId);
    expect((await client.listThreads(doc.docId)).threads[0].comments).toHaveLength(1);
    await client.deleteComment(doc.docId, added.commentId);
    expect((await client.listThreads(doc.docId)).threads).toEqual([]);

    // Switching off keeps the owner's own answer on later reads.
    expect(await client.setComments(doc.docId, false)).toEqual({ docId: doc.docId, comments: false });
    await expect(client.addThread(doc.docId, { anchor: { exact: "quick" }, body: "x" })).rejects.toMatchObject({
      status: 409,
      code: "comments_off",
    } satisfies Partial<APIError>);
  });

  it("reports a quote the version does not contain as anchor_not_found", async () => {
    const client = createClient({ host: COMMENTS_HOST, token: await paidToken(), fetcher: readerFetch });
    const doc = await client.createDoc({ title: "Review", html: "<!doctype html><body><p>Hello world</p></body>" });
    await client.setComments(doc.docId, true);
    await client.setDisplayName("Cli Tester");
    await expect(client.addThread(doc.docId, { anchor: { exact: "absent text" }, body: "x" })).rejects.toMatchObject({
      status: 400,
      code: "anchor_not_found",
    } satisfies Partial<APIError>);
  });
});

describe("get against a Worker that predates private sharing", () => {
  const olderWorker = () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && /^\/api\/v1\/docs\/[^/]+\/html$/.test(path)) {
        return Response.json({ error: { code: "not_found", message: `No API route for ${path}` } }, { status: 404 });
      }
      const response = await localFetch(request);
      if (request.method === "GET" && path === "/api/v1/docs") {
        const body = (await response.json()) as { docs: Record<string, unknown>[] };
        return Response.json({ ...body, docs: body.docs.map(({ linkAccess: _, ...item }) => item) });
      }
      return response;
    };
    return { requests, fetcher };
  };

  it("reads a document from a Worker that predates .../html through its public url, without sending the token there", async () => {
    const issued = await issueToken();
    const { requests, fetcher } = olderWorker();
    const client = createClient({ host: ORIGIN, token: issued.token, fetcher });
    const created = await client.createDoc({ title: "Old", html: "<!doctype html><p>one</p>" });
    await client.updateDoc(created.docId, { title: "Old", html: "<!doctype html><p>two</p>" });
    expect(await client.getHtml(created.docId)).toContain("<p>two</p>");
    const last = requests[requests.length - 1]!;
    expect(last.url).toBe(`${ORIGIN}/d/${created.docId}`);
    expect(last.headers.get("authorization")).toBeNull();
    await expect(client.getHtml("0000000000000000")).rejects.toMatchObject({ status: 404 });
  });

  it("trusts the 404 of a current Worker, whose list carries linkAccess, and never reads /d/", async () => {
    const issued = await issueToken();
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return localFetch(request);
    };
    const client = createClient({ host: ORIGIN, token: issued.token, fetcher });
    const created = await client.createDoc({ title: "New", html: "<!doctype html><p>one</p>" });
    await client.unshare(created.docId);
    requests.length = 0;
    await expect(client.getHtml(created.docId)).rejects.toMatchObject({ status: 404 });
    expect(requests.some((request) => new URL(request.url).pathname.startsWith("/d/"))).toBe(false);
  });
});
