import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_TIMEOUT_MS,
  analyticsSink,
  documentAnalyticsKey,
  NO_ANALYTICS,
  type AnalyticsSink,
  type DocumentEvent,
} from "../src/analytics.js";
import { deleteDoc } from "../src/api/manage.js";
import { createDoc, updateDoc } from "../src/api/push.js";
import type { Publisher } from "../src/auth.js";
import type { Env } from "../src/config.js";
import { MAX_DOC_BYTES } from "../src/config.js";
import { sha256Hex } from "../src/hash.js";
import { DOC_ID_LENGTH } from "../src/ids.js";
import worker from "../src/index.js";

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
const PROPERTY_KEYS = ["$process_person_profile", "document_key", "environment", "service"];

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
    // `manual` rather than `error` because the runtime refuses `error`; the 3xx
    // comes back unfollowed and is handled as the failure it is.
    expect(delivery.redirect).toBe("manual");

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

  it("treats a redirect as a failure instead of chasing it", async () => {
    const warn = captureWarnings();
    const { deliveries } = captureDeliveries(
      async () =>
        new Response(null, { status: 307, headers: { location: "https://elsewhere.test/i/v0/e/" } }),
    );

    await record(publication("document_published"));

    // Exactly one request, to the host that was configured, and no second one
    // carrying the ingest key to wherever the `location` header pointed.
    expect(only(deliveries).url).toBe(`${HOST}/i/v0/e/`);
    expect(warn).toHaveBeenCalledWith("analytics delivery failed", {
      event: "document_published",
      status: 307,
    });
  });

  it("builds an init the runtime will actually accept", async () => {
    const { deliveries } = captureDeliveries();

    await record(publication("document_published"));

    // Every other test here stubs `fetch`, so the runtime never validates the
    // init the sender built — and an init workerd rejects fails in exactly the
    // shape of an intake being down: a `TypeError`, caught, logged as
    // `status: null`, no events delivered and nothing saying why. `redirect`
    // is the field that does this (`"error"` is refused at the edge), so the
    // guard is to hand the captured init to a real `Request` and let the
    // runtime object here rather than in production.
    const delivery = only(deliveries);
    expect(
      () =>
        new Request(delivery.url, {
          method: delivery.method,
          headers: delivery.headers,
          body: delivery.raw,
          redirect: delivery.redirect as RequestInit["redirect"],
        }),
    ).not.toThrow();
  });
});

/**
 * Everything below is about *which* outcomes record, which is a different
 * question from what the sender puts on the wire — that is settled once, above,
 * against a stubbed `fetch`.
 *
 * So these call the handlers directly and hand them a sink that keeps the typed
 * events. That is what the injected parameter is for: a handler test watching
 * `fetch` would be re-asserting the payload builder, and would pass just as
 * happily if a call site recorded the wrong outcome in the right shape. The last
 * two describes close the loop through the real router, so router → handler →
 * sender is covered too rather than only the fake.
 */

/** The API surface under local path-prefix routing. */
const ORIGIN = "https://openartifacts.workers.dev";
const API_URL = new URL(`${ORIGIN}/api/v1/docs`);

/**
 * A well-formed id that no push ever minted, derived from `DOC_ID_LENGTH` rather
 * than written out: a literal of the wrong length is refused on shape before D1
 * is consulted, which would quietly turn a "not found" test into a shape test.
 */
const UNKNOWN_DOC_ID = "0123456789abcdefghjkmnpqrstvwxyz".repeat(2).slice(0, DOC_ID_LENGTH);

const PAGE = "<!doctype html><html><body><p>hi</p></body></html>";

/** A license-key publisher: no plan, so the flat v0 ceilings apply. */
const PUBLISHER: Publisher = { owner: OWNER, plan: "believer" };

/** Someone else entirely, for the doc that is not the caller's. */
const OTHER_PUBLISHER: Publisher = { owner: "oa_somebody_else", plan: "believer" };

/** The real bindings, with the host vars cleared so routing falls back to paths. */
function workerEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    SERVING_HOST: "",
    API_HOST: "",
    LEGACY_SERVING_HOST: "",
    RETIRED_API_HOST: "",
    ...overrides,
  } as Env;
}

/** Which env and which publisher a handler call runs as. */
interface Caller {
  env?: Env;
  publisher?: Publisher;
}

/**
 * A caller whose plan has one ceiling tightened to something a test can reach.
 *
 * `authKind: "account"` travels with it because that flag is what makes the
 * handlers consult plan limits at all; a license-key publisher never sees them.
 */
const PLAN = "test_plan";
function planned(limits: Record<string, number>): Caller {
  return {
    env: workerEnv({
      PLAN_LIMITS: JSON.stringify({
        [PLAN]: { documents: 50, pushesPerDay: 50, htmlBytes: MAX_DOC_BYTES, ...limits },
      }),
    }),
    publisher: { owner: OWNER, plan: PLAN, authKind: "account" },
  };
}

/** A sink that keeps what it was asked to record, and delivers nothing. */
function collectingSink(): { sink: AnalyticsSink; events: DocumentEvent[] } {
  const events: DocumentEvent[] = [];
  return {
    sink: {
      record(event) {
        events.push(event);
      },
    },
    events,
  };
}

const pushRequest = (body: unknown) =>
  new Request(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const create = (sink: AnalyticsSink, body: unknown, caller: Caller = {}) =>
  createDoc(pushRequest(body), API_URL, caller.env ?? workerEnv(), caller.publisher ?? PUBLISHER, sink);

const update = (sink: AnalyticsSink, docId: string, body: unknown, caller: Caller = {}) =>
  updateDoc(
    pushRequest(body),
    API_URL,
    caller.env ?? workerEnv(),
    caller.publisher ?? PUBLISHER,
    docId,
    sink,
  );

const withdraw = (sink: AnalyticsSink, docId: string, caller: Caller = {}) =>
  deleteDoc(caller.env ?? workerEnv(), caller.publisher ?? PUBLISHER, docId, sink);

/** The id a create handed back, and the assertion that it handed one back at all. */
async function published(response: Response): Promise<string> {
  expect(response.status).toBe(201);
  return ((await response.json()) as { docId: string }).docId;
}

/** The three timestamps an event has to agree with. */
const docRow = (docId: string) =>
  env.DB.prepare("SELECT created_at, updated_at, deleted_at FROM docs WHERE id = ?")
    .bind(docId)
    .first<{ created_at: number; updated_at: number; deleted_at: number | null }>();

/**
 * When the bytes of one version landed. This, not `docs.updated_at`, is what an
 * update event has to agree with: `commitVersionMetadata` moves `updated_at`
 * only for the newest version, so the older of two pushes that store out of
 * order deliberately leaves it behind.
 */
const versionRow = (docId: string, n: number) =>
  env.DB.prepare("SELECT created_at FROM versions WHERE doc_id = ? AND n = ?")
    .bind(docId, n)
    .first<{ created_at: number }>();

const names = (events: DocumentEvent[]) => events.map((event) => event.name);

/** A push that will be accepted, so a test can be about the outcome instead. */
const VALID_PUSH = { title: "A note", html: PAGE };

describe("which outcomes record", () => {
  it("counts a create once, stamped with the instant its rows carry", async () => {
    const { sink, events } = collectingSink();

    const docId = await published(await create(sink, VALID_PUSH));

    expect(events).toEqual([
      { name: "document_published", docId, atMs: expect.any(Number), ownerId: OWNER },
    ]);
    // The handler's own `now`, never a second clock read. An event and the row
    // it describes have to fall inside the same reporting interval, and a fresh
    // `Date.now()` here is exactly how one of them ends up in the next one.
    expect(events[0]!.atMs).toBe((await docRow(docId))!.created_at);
  });

  it("counts an update under the key the create already used", async () => {
    const { sink, events } = collectingSink();
    const docId = await published(await create(sink, VALID_PUSH));

    const response = await update(sink, docId, { html: "<p>second draft</p>" });

    expect(response.status).toBe(200);
    expect(names(events)).toEqual(["document_published", "document_updated"]);
    // The key is what makes a document one page for its whole life, so this is
    // the assertion that an update attaches to the page it changed instead of
    // arriving as a second one.
    expect(await documentAnalyticsKey(events[1]!.docId)).toBe(await documentAnalyticsKey(docId));
    expect(events[1]).toEqual({
      name: "document_updated",
      docId,
      atMs: (await versionRow(docId, 2))!.created_at,
      ownerId: OWNER,
    });
    // With nothing else pushing, that instant is also the doc's `updated_at`.
    expect(events[1]!.atMs).toBe((await docRow(docId))!.updated_at);
  });

  it("counts a withdrawal under that same key, stamped with deleted_at", async () => {
    const { sink, events } = collectingSink();
    const docId = await published(await create(sink, VALID_PUSH));

    const response = await withdraw(sink, docId);

    expect(response.status).toBe(204);
    expect(names(events)).toEqual(["document_published", "document_unshared"]);
    // One clock read served the column and the event, so a withdrawal cannot be
    // reported a millisecond after the row that performed it.
    expect(events[1]).toEqual({
      name: "document_unshared",
      docId,
      atMs: (await docRow(docId))!.deleted_at,
      ownerId: OWNER,
    });
  });

  it("reports a document's whole life as three events under one key", async () => {
    const { sink, events } = collectingSink();

    const docId = await published(await create(sink, VALID_PUSH));
    expect((await update(sink, docId, { html: "<p>second</p>" })).status).toBe(200);
    expect((await withdraw(sink, docId)).status).toBe(204);

    // The epic's reconciliation requirement: a controlled create/update/withdraw
    // sequence has to read in PostHog as one page with three outcomes, and never
    // as two or three pages.
    expect(names(events)).toEqual([
      "document_published",
      "document_updated",
      "document_unshared",
    ]);
    const keys = new Set(
      await Promise.all(events.map((event) => documentAnalyticsKey(event.docId))),
    );
    expect(keys.size).toBe(1);
    // Every publication event is attributed to the account the credential
    // resolved to, and nothing in the request could have supplied another.
    expect(events.every((event) => "ownerId" in event && event.ownerId === OWNER)).toBe(true);
  });
});

/**
 * A D1 whose first `INSERT INTO versions` is followed, before anything else can
 * look, by the delete that beat it to the doc. It is the one interleaving a
 * client cannot be asked to produce on demand; `test/push.test.ts` pins what the
 * push does about it, and what matters here is that a push answering 404 counts
 * nothing — the url it would have described serves 410.
 */
function deleteRacingDb(): D1Database {
  let raced = false;
  return new Proxy(env.DB, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("INSERT INTO versions")) return statement;
        return new Proxy(statement, {
          get(st, stProp, stRec) {
            if (stProp !== "bind") return Reflect.get(st, stProp, stRec);
            return (...args: unknown[]) => {
              const bound = st.bind(...args);
              return new Proxy(bound, {
                get(bt, bProp, bRec) {
                  if (bProp !== "run") return Reflect.get(bt, bProp, bRec);
                  return async () => {
                    const result = await bt.run();
                    if (!raced) {
                      raced = true;
                      await env.DB.prepare("UPDATE docs SET deleted_at = ? WHERE id = ?")
                        .bind(Date.now(), String(args[0]))
                        .run();
                    }
                    return result;
                  };
                },
              });
            };
          },
        });
      };
    },
  }) as D1Database;
}

describe("which outcomes record nothing", () => {
  it("records nothing for a body that is not a push", async () => {
    const { sink, events } = collectingSink();

    for (const body of ["not json", [], { html: "" }, { html: PAGE, title: 7 }]) {
      expect((await create(sink, body)).status).toBe(400);
    }

    expect(events).toEqual([]);
  });

  it("records nothing for html over the published ceiling", async () => {
    const { sink, events } = collectingSink();
    const docId = await published(await create(sink, VALID_PUSH));
    const oversized = "a".repeat(MAX_DOC_BYTES + 1);

    expect((await create(sink, { html: oversized })).status).toBe(413);
    expect((await update(sink, docId, { html: oversized })).status).toBe(413);

    expect(names(events)).toEqual(["document_published"]);
  });

  it("records nothing when the document ceiling is full", async () => {
    const { sink, events } = collectingSink();
    const caller = planned({ documents: 1 });

    await published(await create(sink, VALID_PUSH, caller));
    const refused = await create(sink, { title: "second", html: PAGE }, caller);

    // A doc row is never inserted, so there is no reservation to mistake for a
    // page — but a create that answers 402 must not count one either way.
    expect(refused.status).toBe(402);
    expect(names(events)).toEqual(["document_published"]);
  });

  it("records nothing when today's pushes are spent", async () => {
    const { sink, events } = collectingSink();
    const caller = planned({ pushesPerDay: 1 });

    const docId = await published(await create(sink, VALID_PUSH, caller));
    const refusedUpdate = await update(sink, docId, { html: "<p>again</p>" }, caller);
    const refusedCreate = await create(sink, { title: "second", html: PAGE }, caller);

    expect([refusedUpdate.status, refusedCreate.status]).toEqual([402, 402]);
    expect(names(events)).toEqual(["document_published"]);
  });

  it("records nothing when the storage allowance refuses the first version", async () => {
    const { sink, events } = collectingSink();
    // Less room than one page, so the create is refused before any bytes land
    // and its doc row is rolled back. Nothing was ever published.
    const refused = await create(sink, VALID_PUSH, planned({ storageBytes: 1 }));

    expect(refused.status).toBe(402);
    expect(events).toEqual([]);
  });

  it("records nothing when the storage allowance refuses a later version", async () => {
    const { sink, events } = collectingSink();
    // Exactly one page of room: the create fits and the version after it cannot,
    // so the refusal lands on a document that has already been counted once.
    const caller = planned({ storageBytes: PAGE.length });

    const docId = await published(await create(sink, VALID_PUSH, caller));
    const refused = await update(sink, docId, { html: PAGE }, caller);

    expect(refused.status).toBe(402);
    expect(names(events)).toEqual(["document_published"]);
  });

  it("records nothing for a push or a withdrawal against someone else's doc", async () => {
    const { sink, events } = collectingSink();
    const docId = await published(await create(sink, VALID_PUSH));
    const intruder: Caller = { publisher: OTHER_PUBLISHER };

    // 404, never 403: another publisher's doc has to be indistinguishable from
    // one that never existed, and neither of them is an outcome.
    expect((await update(sink, docId, { html: PAGE }, intruder)).status).toBe(404);
    expect((await withdraw(sink, docId, intruder)).status).toBe(404);

    expect(names(events)).toEqual(["document_published"]);
  });

  it("records nothing against a doc that never existed", async () => {
    const { sink, events } = collectingSink();

    expect((await update(sink, UNKNOWN_DOC_ID, { html: PAGE })).status).toBe(404);
    expect((await withdraw(sink, UNKNOWN_DOC_ID)).status).toBe(404);

    expect(events).toEqual([]);
  });

  it("does not count a second withdrawal of an already-withdrawn doc", async () => {
    const { sink, events } = collectingSink();
    const docId = await published(await create(sink, VALID_PUSH));

    expect((await withdraw(sink, docId)).status).toBe(204);
    const again = await withdraw(sink, docId);

    // Repeated no-op withdrawals are not new outcomes. The page left the
    // internet once; counting a client's retry would report churn that is really
    // a timeout somebody worked around.
    expect(again.status).toBe(404);
    expect(names(events)).toEqual(["document_published", "document_unshared"]);
  });

  it("records nothing for a create that loses the race against a delete", async () => {
    const { sink, events } = collectingSink();

    const response = await create(sink, VALID_PUSH, { env: workerEnv({ DB: deleteRacingDb() }) });

    // The doc row survives, but its id was never returned to anyone, so nothing
    // will ever reconcile against it. Counting it would put a page in the totals
    // that no reader could have been given.
    expect(response.status).toBe(404);
    expect(events).toEqual([]);
  });

  it("records nothing for an update that loses the race against a delete", async () => {
    const { sink, events } = collectingSink();
    const docId = await published(await create(sink, VALID_PUSH));

    const response = await update(sink, docId, { html: "<p>second</p>" }, {
      env: workerEnv({ DB: deleteRacingDb() }),
    });

    expect(response.status).toBe(404);
    expect(names(events)).toEqual(["document_published"]);
  });
});

/**
 * The router's own path, end to end: a real request, the real sink, and PostHog
 * stood in for at `globalThis.fetch`.
 *
 * The fake sink above proves which outcomes record. These prove the wire is
 * actually attached to them — that the sink `handleApi` builds reaches the three
 * handlers, and that an analytics failure is invisible from outside.
 */
describe("through the router", () => {
  const LICENSE_KEY = "cplus_live_a1b2c3d4e5f60718";
  const CONFIGURED: Partial<Env> = {
    POSTHOG_PROJECT_API_KEY: KEY,
    POSTHOG_HOST: HOST,
    ANALYTICS_ENVIRONMENT: "test",
  };
  let owner = "";

  beforeEach(async () => {
    // What auth leaves behind after a successful validation. A row younger than
    // the TTL means no license server is reached, which matters here because
    // `fetch` is stubbed: these tests are about analytics, not authentication.
    const keyHash = await sha256Hex(LICENSE_KEY);
    owner = `account-${keyHash.slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO publishers (key_hash, plan, validated_at, owner)
       VALUES (?, 'believer', ?, ?)`,
    )
      .bind(keyHash, Date.now(), owner)
      .run();
  });

  async function api(method: string, path: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${LICENSE_KEY}` });
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }

    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv(CONFIGURED), ctx);
    // Deliveries are scheduled on `waitUntil`, so without this every assertion
    // about them would race the request that scheduled them.
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("puts one publication event on the wire per outcome, under one document key", async () => {
    const { deliveries } = captureDeliveries();

    const created = await api("POST", "/api/v1/docs", VALID_PUSH);
    const docId = await published(created);
    expect((await api("PUT", `/api/v1/docs/${docId}`, { html: "<p>second</p>" })).status).toBe(200);
    expect((await api("DELETE", `/api/v1/docs/${docId}`)).status).toBe(204);

    expect(deliveries.map((delivery) => delivery.body.event)).toEqual([
      "document_published",
      "document_updated",
      "document_unshared",
    ]);

    const documentKey = await documentAnalyticsKey(docId);
    for (const delivery of deliveries) {
      expect(delivery.body.distinct_id).toBe(owner);
      expect((delivery.body.properties as Record<string, unknown>).document_key).toBe(documentKey);
      // Nothing that could name the page: not its id, not its url, not its title.
      expect(delivery.raw).not.toContain(docId);
      expect(delivery.raw).not.toContain("A note");
      expect(delivery.raw).not.toContain("/d/");
    }
  });

  const FAILURES: Array<[string, () => Promise<Response>]> = [
    [
      "a network that rejects",
      async () => {
        throw new Error("no route to posthog.test");
      },
    ],
    ["a refusal from PostHog", async () => new Response("nope", { status: 500 })],
  ];

  it.each(FAILURES)("answers create, update and delete identically through %s", async (_label, respond) => {
    captureWarnings();
    captureDeliveries(respond);

    const created = await api("POST", "/api/v1/docs", VALID_PUSH);
    expect(created.status).toBe(201);
    const body = (await created.json()) as { docId: string };
    const { docId } = body;
    // `docs/http-api.md` is frozen, and a publisher must not be able to tell
    // from any response whether analytics succeeded, failed, or is configured.
    expect(body).toEqual({ docId, url: `${ORIGIN}/d/${docId}`, version: 1 });

    const updated = await api("PUT", `/api/v1/docs/${docId}`, { html: "<p>second</p>" });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ docId, url: `${ORIGIN}/d/${docId}`, version: 2 });

    const withdrawn = await api("DELETE", `/api/v1/docs/${docId}`);
    expect(withdrawn.status).toBe(204);
    expect(await withdrawn.text()).toBe("");
  });
});

/**
 * The authoritative aggregate `docs/analytics.md` hands an operator, pinned in
 * the suite rather than left in a doc nobody runs.
 *
 * Events cannot answer "how many pages exist right now". Delivery is best
 * effort, so an event-derived inventory is a floor, and deriving one by
 * subtracting withdrawals from publications compounds both streams' losses
 * instead of cancelling them. D1 knows exactly, so D1 is asked.
 *
 * What makes these queries worth a test is that the property they lean on is
 * invisible from the code that could take it away: a withdrawal marks the `docs`
 * row and destroys the bytes, but leaves the `versions` rows behind, which is
 * the only reason "ever published" is recoverable at all. A future delete that
 * swept those rows would empty the historical baseline while every other test in
 * the repo still passed.
 */
describe("the D1 publication aggregate", () => {
  const CURRENTLY_PUBLISHED = `SELECT COUNT(*) AS pages
  FROM docs d
 WHERE d.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM versions v WHERE v.doc_id = d.id)`;

  const EVER_PUBLISHED = `SELECT COUNT(*) AS pages
  FROM docs d
 WHERE EXISTS (SELECT 1 FROM versions v WHERE v.doc_id = d.id)`;

  const pages = async (sql: string) =>
    (await env.DB.prepare(sql).first<{ pages: number }>())!.pages;

  it("counts published pages, skips failed reservations, and remembers withdrawals", async () => {
    const { sink } = collectingSink();
    const kept = await published(await create(sink, VALID_PUSH));
    const withdrawn = await published(await create(sink, { title: "Second", html: PAGE }));

    // A `docs` row with no `versions` row: a create whose first push died before
    // writing bytes. Its id was never returned to anyone, so it is not a page.
    await env.DB.prepare(
      `INSERT INTO docs (id, owner, title, latest_version, created_at, updated_at)
       VALUES (?, ?, 'never stored', 1, ?, ?)`,
    )
      .bind(UNKNOWN_DOC_ID, OWNER, Date.now(), Date.now())
      .run();

    expect(await pages(CURRENTLY_PUBLISHED)).toBe(2);
    expect(await pages(EVER_PUBLISHED)).toBe(2);

    expect((await withdraw(sink, withdrawn)).status).toBe(204);

    expect(await pages(CURRENTLY_PUBLISHED)).toBe(1);
    // The withdrawn doc is still a page that was once published, and D1 can
    // still say so — this is the assertion the historical baseline rests on.
    expect(await pages(EVER_PUBLISHED)).toBe(2);

    // The bytes are gone and the allowance is released; the row that records the
    // publication is not, and neither is the row that records the doc.
    expect(
      (await env.DB.prepare("SELECT n FROM versions WHERE doc_id = ?").bind(withdrawn).all()).results,
    ).toEqual([{ n: 1 }]);
    expect(
      (await env.DB.prepare("SELECT n FROM storage_usage WHERE doc_id = ?").bind(withdrawn).all())
        .results,
    ).toEqual([]);
    expect((await env.DOCS.list({ prefix: `docs/${withdrawn}/` })).objects).toEqual([]);
    expect(await env.DOCS.list({ prefix: `docs/${kept}/` })).toMatchObject({
      objects: [expect.anything()],
    });
  });

  it("dates each page by the instant its first version landed", async () => {
    const { sink } = collectingSink();
    const docId = await published(await create(sink, VALID_PUSH));
    expect((await update(sink, docId, { html: "<p>second</p>" })).status).toBe(200);

    const first = await env.DB.prepare(
      `SELECT d.id, MIN(v.created_at) AS first_published
         FROM docs d JOIN versions v ON v.doc_id = d.id
        GROUP BY d.id`,
    ).first<{ id: string; first_published: number }>();

    // An update never moves a page's publication date, which is what keeps "new
    // pages published" a count of pages rather than of pushes.
    expect(first).toEqual({ id: docId, first_published: (await docRow(docId))!.created_at });
  });
});
