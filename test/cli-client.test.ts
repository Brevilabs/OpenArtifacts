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
