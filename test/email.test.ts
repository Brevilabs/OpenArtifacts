import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { analyticsSink, documentAnalyticsKey } from "../src/analytics.js";
import type { Env } from "../src/config.js";
import { emailRecipientHash, sendEmail, type EmailType } from "../src/email.js";
import { handleReader } from "../src/reader.js";

const SECRET = "test-reader-secret-for-email-hashing";
const DOC = "0123456789abcdef";
const message = () => ({ subject: "Private title", text: "Private content", html: "<p>Private content</p>" });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keys recipient hashes and uses the same address normalization as accounts", async () => {
  const hash = await emailRecipientHash(SECRET, " Alice+review@Example.COM ");
  expect(hash).toMatch(/^email_v1_[a-f0-9]{64}$/);
  expect(hash).toBe(await emailRecipientHash(SECRET, "alice+review@example.com"));
  expect(hash).not.toBe(await emailRecipientHash("another-secret", "alice+review@example.com"));
  expect(hash).not.toBe(await emailRecipientHash(SECRET, "alice@example.com"));
});

it("records one safe log and one product event per accepted email, including sign-in without a document", async () => {
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  const captures: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    captures.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  }));
  const sent = vi.fn(async () => {});
  const configured = { ...env, READER_SESSION_SECRET: SECRET, EMAIL: { send: sent }, EMAIL_FROM: "share@mail.example.com", POSTHOG_PROJECT_API_KEY: "test-project-key" } as Env;
  const ctx = createExecutionContext();
  const sink = analyticsSink(configured, ctx);
  const types: EmailType[] = ["invite", "access_request", "signin_code", "comment_thread", "comment_reply", "comment_resolved"];
  for (const type of types) {
    expect(await sendEmail(configured, sink, { type, docId: type === "signin_code" ? null : DOC, to: "alice@example.com" }, message)).toBe("sent");
  }
  await waitOnExecutionContext(ctx);
  expect(sent).toHaveBeenCalledTimes(types.length);
  expect(logs).toHaveBeenCalledTimes(types.length);
  expect(captures).toHaveLength(types.length);
  const hash = await emailRecipientHash(SECRET, "alice@example.com");
  for (const type of types) {
    const capture = captures.find((c) => c.properties.email_type === type)!;
    expect(capture.event).toBe("email_delivery");
    expect(capture.properties).toMatchObject({ recipient_hash: hash, outcome: "sent", reason: "accepted", $process_person_profile: false, document_key: type === "signin_code" ? "no_document" : await documentAnalyticsKey(DOC) });
    expect(logs.mock.calls.filter(([, fields]) => fields.email_type === type)).toHaveLength(1);
  }
  const serialized = JSON.stringify([logs.mock.calls, captures]);
  for (const privateValue of ["alice@example.com", DOC, "Private title", "Private content", SECRET]) expect(serialized).not.toContain(privateValue);
});

it("tracks sign-in codes and their limits against the Share document, without logging the code", async () => {
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  const sent = vi.fn(async () => {});
  const events: unknown[] = [];
  const configured = { ...env, READER_SESSION_SECRET: SECRET, EMAIL_FROM: "share@mail.example.com", EMAIL: { send: sent }, SIGNIN_EMAIL_LIMITER: undefined, SIGNIN_EMAIL_CLIENT_LIMITER: undefined } as Env;
  const ask = async (over = configured) => {
    const url = new URL("https://api.openartifacts.ai/signin/email");
    return handleReader(new Request(url, { method: "POST", body: new URLSearchParams({ email: "alice@example.com", next: `/share/${DOC}?signin` }) }), url, over, undefined, { record: (event) => { events.push(event); } });
  };
  expect((await ask()).status).toBe(200);
  expect((await ask({ ...configured, SIGNIN_EMAIL_CLIENT_LIMITER: { limit: async () => ({ success: false }) } })).status).toBe(429);
  expect(sent).toHaveBeenCalledTimes(1);
  expect(events).toMatchObject([
    { name: "email_delivery", docId: DOC, emailType: "signin_code", outcome: "sent" },
    { name: "email_delivery", docId: DOC, emailType: "signin_code", outcome: "skipped_limit" },
  ]);
  expect(logs).toHaveBeenCalledTimes(2);
  expect(logs.mock.calls[0]![1]).toMatchObject({ document_key: await documentAnalyticsKey(DOC) });
  expect(JSON.stringify(logs.mock.calls)).not.toContain("alice@example.com");
  expect(JSON.stringify(logs.mock.calls)).not.toContain("subject");
});

it("records failed and skipped sends without mailing or exposing sender errors", async () => {
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  const events: unknown[] = [];
  const sink = { record: (event: unknown) => { events.push(event); } };
  const configured = { ...env, READER_SESSION_SECRET: SECRET, EMAIL_FROM: "share@mail.example.com", EMAIL: { send: async () => { throw new Error("alice@example.com secret body"); } } } as Env;
  const context = { type: "invite" as const, docId: DOC, to: "alice@example.com" };
  expect(await sendEmail(configured, sink, context, message)).toBe("failed");
  expect(await sendEmail(configured, sink, context, message, async () => false)).toBe("skipped_limit");
  expect(await sendEmail(configured, sink, { ...context, type: "access_request", to: null }, message)).toBe("skipped_no_owner_email");
  expect(events).toMatchObject([
    { outcome: "failed", reason: "send_failed" },
    { outcome: "skipped_limit", reason: "sending_limit" },
    { outcome: "skipped_no_owner_email", reason: "no_owner_email", recipientHash: null },
  ]);
  expect(logs).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(logs.mock.calls)).not.toContain("alice@example.com");
  expect(JSON.stringify(logs.mock.calls)).not.toContain("secret body");
});
