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
    let documentAuthorization: string | null | undefined;
    const observedFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.startsWith("/d/")) {
        documentAuthorization = request.headers.get("authorization");
      }
      return localFetch(request);
    };
    const client = createClient({ host: ORIGIN, token: issued.token, fetcher: observedFetch });
    const created = await client.createDoc({ title: "CLI", html: "<!doctype html><p>one</p>" });
    const updated = await client.updateDoc(created.docId, { title: "CLI", html: "<!doctype html><p>two</p>" });
    expect(updated).toMatchObject({ docId: created.docId, version: 2, url: created.url });
    expect(await client.listDocs()).toContainEqual(expect.objectContaining({ docId: created.docId }));
    expect(await client.readDocument(created.url)).toContain("<p>two</p>");
    expect(documentAuthorization).toBeNull();
    expect(await client.listTokens()).toMatchObject({ tokens: [expect.objectContaining({ tokenId: issued.id })] });
    await client.unshare(created.docId);
    await expect(client.readDocument(created.url)).rejects.toMatchObject({ status: 410 });
    expect(await client.revoke(issued.id)).toEqual({ tokenId: issued.id, remaining: 0 });
  });
});
