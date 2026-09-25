import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_TIMEOUT_MS,
  analyticsSink,
  documentAnalyticsKey,
  NO_ANALYTICS,
  type DocumentEvent,
} from "../src/analytics.js";
import type { Env } from "../src/config.js";

/**
 * Delivery is stubbed at `globalThis.fetch` rather than behind an injected
 * client, because what these tests are actually about is the bytes on the wire.
 * A seam the sender wrote would let the sender define what "the payload" is,
 * and the property allowlist is exactly the thing that must not be self-
 * certified: the assertions below name the complete set of keys, so a future
 * field added anywhere in `capturePayload` fails a test instead of quietly
 * reaching PostHog.
 */
const HOST = "https://posthog.test";
const KEY = "phc_test_ingest_key";

/**
 * Crockford base32 like a real doc id, and deliberately not hex — so
 * `not.toContain(DOC_ID)` over a digest is a real assertion rather than a
 * coincidence about which characters an id happens to use.
 */
const DOC_ID = "0zt3kq9w1m7v2x5n";
const OTHER_DOC_ID = "9wq4hs2j0kv6mt8r";
const OWNER = "oa_account_under_test";

/** A fixed instant, so the ISO-8601 in the payload is checkable by eye. */
const AT_MS = Date.UTC(2026, 8, 12, 17, 4, 5, 678);
const AT_ISO = "2026-09-12T17:04:05.678Z";

const PUBLICATION_EVENTS = ["document_published", "document_updated", "document_unshared"] as const;

/** Top-level fields the capture payload may carry, and no others. */
const PAYLOAD_KEYS = ["api_key", "distinct_id", "event", "properties", "timestamp", "uuid"];

/** The whole property allowlist. Adding a row here is a deliberate decision. */
const PROPERTY_KEYS = [
  "$geoip_disable",
  "$process_person_profile",
  "document_key",
  "environment",
  "service",
];

function analyticsEnv(overrides: Partial<Env> = {}): Env {
  return {
    POSTHOG_PROJECT_API_KEY: KEY,
    POSTHOG_HOST: HOST,
    ANALYTICS_ENVIRONMENT: "test",
    ...overrides,
  } as Env;
}

function publication(name: (typeof PUBLICATION_EVENTS)[number]): DocumentEvent {
  return { name, docId: DOC_ID, atMs: AT_MS, ownerId: OWNER };
}

const VIEW: DocumentEvent = { name: "document_viewed", docId: DOC_ID, atMs: AT_MS };

interface Delivery {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  redirect: string | undefined;
  signal: AbortSignal | undefined;
  raw: string;
  body: Record<string, unknown>;
}

/** Stand in for PostHog and keep every request it was sent. */
function captureDeliveries(respond: () => Promise<Response> = async () => new Response("1")) {
  const deliveries: Delivery[] = [];
  const stub = vi.fn(async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const raw = String(init.body);
    deliveries.push({
      url: String(input),
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      redirect: init.redirect,
      signal: init.signal ?? undefined,
      raw,
      body: JSON.parse(raw) as Record<string, unknown>,
    });
    return await respond();
  });
  vi.stubGlobal("fetch", stub);
  return { deliveries, stub };
}

/** Silence the warning under test and hand back everything it was asked to say. */
function captureWarnings() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

/**
 * Record one event and wait for the scheduled delivery to finish.
 *
 * `waitOnExecutionContext` is the whole reason this is not a bare call:
 * `record` returns before anything has been sent, so without it every
 * assertion below would race the `waitUntil` it is asserting about.
 */
async function record(event: DocumentEvent, env: Env = analyticsEnv()): Promise<void> {
  const ctx = createExecutionContext();
  analyticsSink(env, ctx).record(event);
  await waitOnExecutionContext(ctx);
}

/** The one delivery a test expects, or a failure that names how many there were. */
function only(deliveries: Delivery[]): Delivery {
  expect(deliveries).toHaveLength(1);
  return deliveries[0]!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the capture payload", () => {
  it.each(PUBLICATION_EVENTS)("carries only the allowlisted fields for %s", async (name) => {
    const { deliveries } = captureDeliveries();

    await record(publication(name));

    const delivery = only(deliveries);
    expect(delivery.url).toBe(`${HOST}/i/v0/e/`);
    expect(delivery.method).toBe("POST");
    expect(delivery.headers["content-type"]).toBe("application/json");
    // The body carries the ingest key, so a redirect must never be followed.
    expect(delivery.redirect).toBe("error");

    expect(Object.keys(delivery.body).sort()).toEqual(PAYLOAD_KEYS);
    expect(delivery.body.api_key).toBe(KEY);
    expect(delivery.body.event).toBe(name);
    expect(delivery.body.distinct_id).toBe(OWNER);
    expect(delivery.body.timestamp).toBe(AT_ISO);

    const properties = delivery.body.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(PROPERTY_KEYS);
    expect(properties.service).toBe("openartifacts");
    expect(properties.environment).toBe("test");
    expect(properties.document_key).toBe(await documentAnalyticsKey(DOC_ID));
    // The actor is an account we already resolved, so "distinct publishers" is
    // a question worth being able to ask.
    expect(properties.$process_person_profile).toBe(true);
    // The capture comes from the Worker, so its address locates nobody.
    expect(properties.$geoip_disable).toBe(true);
  });

  it("carries only the allowlisted fields for document_viewed", async () => {
    const { deliveries } = captureDeliveries();

    await record(VIEW);

    const delivery = only(deliveries);
    expect(Object.keys(delivery.body).sort()).toEqual(PAYLOAD_KEYS);
    expect(delivery.body.event).toBe("document_viewed");
    expect(delivery.body.timestamp).toBe(AT_ISO);

    const documentKey = await documentAnalyticsKey(DOC_ID);
    // Keyed by the document, never by anything derived from the reader.
    expect(delivery.body.distinct_id).toBe(documentKey);

    const properties = delivery.body.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(PROPERTY_KEYS);
    expect(properties.document_key).toBe(documentKey);
    // A reader must never become a person in PostHog.
    expect(properties.$process_person_profile).toBe(false);
  });

  it("puts distinct_id at the top level, never inside properties", async () => {
    const { deliveries } = captureDeliveries();

    for (const name of PUBLICATION_EVENTS) await record(publication(name));
    await record(VIEW);

    expect(deliveries).toHaveLength(4);
    for (const delivery of deliveries) {
      // `/i/v0/e/` requires `distinct_id` as a top-level field. Nesting it is
      // the `/batch/` spelling, and this is not that endpoint — so an edit that
      // moves it down into `properties` has to fail here rather than at an
      // ingestion no test can see.
      expect(typeof delivery.body.distinct_id).toBe("string");
      expect(delivery.body.distinct_id).not.toBe("");
      expect(delivery.body.properties).not.toHaveProperty("distinct_id");
    }
  });

  it("never sends a raw doc id, and never names the owner on a view", async () => {
    const { deliveries } = captureDeliveries();

    for (const name of PUBLICATION_EVENTS) await record(publication(name));
    await record(VIEW);

    expect(deliveries).toHaveLength(4);
    for (const delivery of deliveries) expect(delivery.raw).not.toContain(DOC_ID);
    expect(deliveries[3]!.raw).not.toContain(OWNER);
  });

  it("mints one uuid per record call", async () => {
    const { deliveries } = captureDeliveries();
    const uuids = vi.spyOn(crypto, "randomUUID");

    await record(publication("document_published"));
    await record(publication("document_updated"));

    // One identity per event, so a retry added later resends that event rather
    // than counting a second one — and two events never share an identity.
    expect(uuids).toHaveBeenCalledTimes(2);
    expect(deliveries[0]!.body.uuid).toBe(uuids.mock.results[0]?.value);
    expect(deliveries[1]!.body.uuid).toBe(uuids.mock.results[1]?.value);
    expect(deliveries[0]!.body.uuid).not.toBe(deliveries[1]!.body.uuid);
  });
});

describe("the document analytics key", () => {
  it("is stable for one doc id", async () => {
    await expect(documentAnalyticsKey(DOC_ID)).resolves.toBe(await documentAnalyticsKey(DOC_ID));
  });

  it("differs across doc ids", async () => {
    await expect(documentAnalyticsKey(DOC_ID)).resolves.not.toBe(
      await documentAnalyticsKey(OTHER_DOC_ID),
    );
  });

  it("is neither the doc id nor anything containing it", async () => {
    const key = await documentAnalyticsKey(DOC_ID);
    expect(key).not.toBe(DOC_ID);
    expect(key).not.toContain(DOC_ID);
    expect(key).toMatch(/^doc_[0-9a-f]{32}$/);
  });
});

describe("configuration", () => {
  it.each([undefined, "", "   "])("sends nothing when the ingest key is %p", async (apiKey) => {
    const { stub } = captureDeliveries();

    await record(publication("document_published"), analyticsEnv({ POSTHOG_PROJECT_API_KEY: apiKey }));

    expect(stub).not.toHaveBeenCalled();
  });

  it("labels an event development when no environment is configured", async () => {
    const { deliveries } = captureDeliveries();

    await record(VIEW, analyticsEnv({ ANALYTICS_ENVIRONMENT: undefined }));

    const properties = only(deliveries).body.properties as Record<string, unknown>;
    // Every business query filters on production, so an unlabelled deployment
    // stays out of the totals rather than joining them.
    expect(properties.environment).toBe("development");
  });

  it("falls back to PostHog's US ingest host when none is configured", async () => {
    const { deliveries } = captureDeliveries();

    await record(VIEW, analyticsEnv({ POSTHOG_HOST: undefined }));

    expect(only(deliveries).url).toBe("https://us.i.posthog.com/i/v0/e/");
  });

  it("records nothing through NO_ANALYTICS", async () => {
    const { stub } = captureDeliveries();

    NO_ANALYTICS.record(publication("document_published"));
    NO_ANALYTICS.record(VIEW);

    expect(stub).not.toHaveBeenCalled();
  });
});

describe("delivery failures", () => {
  it("abandons an intake that never answers", async () => {
    const warn = captureWarnings();
    // Never resolves on its own: only the sender's own timeout can end this
    // delivery, so a test that finishes at all is the proof the signal is wired.
    const { deliveries } = captureDeliveries(
      () =>
        new Promise<Response>((_resolve, reject) => {
          const { signal } = deliveries[deliveries.length - 1]!;
          signal?.addEventListener("abort", () => {
            reject(signal.reason);
          });
        }),
    );

    await record(publication("document_published"));

    const { signal } = only(deliveries);
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as Error | undefined)?.name).toBe("TimeoutError");
    expect(warn).toHaveBeenCalledWith("analytics delivery failed", {
      event: "document_published",
      status: null,
    });
    // This test waits out the sender's real timeout, so its own budget is
    // derived from that number rather than left to vitest's default.
  }, ANALYTICS_TIMEOUT_MS + 3000);

  it("contains a network rejection", async () => {
    const warn = captureWarnings();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`no route to ${OWNER}`);
      }),
    );

    // Resolving at all is the assertion: `record` must not reject, and the
    // request that scheduled it has already answered.
    await record(publication("document_unshared"));

    expect(warn).toHaveBeenCalledWith("analytics delivery failed", {
      event: "document_unshared",
      status: null,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(OWNER);
  });

  it("contains a refusal from PostHog and repeats none of it", async () => {
    const warn = captureWarnings();
    // Third-party text, which is exactly why the response body is never logged.
    captureDeliveries(async () => new Response("quota exceeded, see dashboard", { status: 429 }));

    await record(publication("document_published"));

    expect(warn).toHaveBeenCalledWith("analytics delivery failed", {
      event: "document_published",
      status: 429,
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(OWNER);
    expect(logged).not.toContain(DOC_ID);
    expect(logged).not.toContain(await documentAnalyticsKey(DOC_ID));
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("quota exceeded");
  });
});
