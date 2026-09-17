import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  documentAnalyticsKey,
  NO_ANALYTICS,
  type AnalyticsSink,
  type DocumentEvent,
} from "../src/analytics.js";
import { deleteDoc } from "../src/api/manage.js";
import { createDoc } from "../src/api/push.js";
import type { Publisher } from "../src/auth.js";
import type { Env } from "../src/config.js";
import { DOC_ID_LENGTH } from "../src/ids.js";
import { handleServing } from "../src/serve.js";
import { versionObjectKey } from "../src/storage.js";
import worker from "../src/index.js";

/**
 * Reads.
 *
 * Its own file rather than another section of `analytics.test.ts`, for the
 * reason the code is split the same way: publication is a handful of outcomes a
 * publisher asks for, and reading is a surface that answers anything the
 * internet sends it. What matters here is mostly how much this surface
 * *declines* to count, so most of what follows asserts an empty array — and
 * each of those is a decision written down, a `HEAD`, a miss, a withdrawal, a
 * probe, rather than a shape nobody thought about.
 */
const HOST = "https://posthog.test";
const KEY = "phc_test_ingest_key";

/** The serving surface under local path-prefix routing. */
const ORIGIN = "https://openartifacts.workers.dev";

/**
 * A well-formed id that no push ever minted, derived from `DOC_ID_LENGTH` rather
 * than written out: a literal of the wrong length is refused on shape before D1
 * is consulted, which would quietly turn a "not found" test into a shape test.
 */
const UNKNOWN_DOC_ID = "0123456789abcdefghjkmnpqrstvwxyz".repeat(2).slice(0, DOC_ID_LENGTH);

const PAGE = "<!doctype html><html><body><p>hi</p></body></html>";
const TITLE = "A note";
const VALID_PUSH = { title: TITLE, html: PAGE };

/** A license-key publisher: no plan, so the flat v0 ceilings apply. */
const PUBLISHER: Publisher = { owner: "oa_account_under_test", plan: "believer" };

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

interface Delivery {
  raw: string;
  body: Record<string, unknown>;
}

/** Stand in for PostHog and keep every request it was sent. */
function captureDeliveries(respond: () => Promise<Response> = async () => new Response("1")) {
  const deliveries: Delivery[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init: RequestInit = {}): Promise<Response> => {
      const raw = String(init.body);
      deliveries.push({ raw, body: JSON.parse(raw) as Record<string, unknown> });
      return await respond();
    }),
  );
  return { deliveries };
}

/** Silence the warning under test. */
function captureWarnings() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

/** The one delivery a test expects, or a failure that names how many there were. */
function only(deliveries: Delivery[]): Delivery {
  expect(deliveries).toHaveLength(1);
  return deliveries[0]!;
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

const names = (events: DocumentEvent[]) => events.map((event) => event.name);

/**
 * A served response with its body already in memory.
 *
 * R2 hands a document back as a stream, and `serveObject` passes that stream
 * straight through — so a test that asserts on the status and walks away leaves
 * the bucket read open. The pool's isolated storage tears the R2 store down
 * between tests and trips over the open handle, which surfaces as a failure with
 * no connection to the test that caused it. Buffering here means no assertion
 * below has to remember to drain anything.
 */
async function buffered(response: Response): Promise<Response> {
  if (response.body === null) return response;
  return new Response(await response.arrayBuffer(), response);
}

const read = async (
  sink: AnalyticsSink,
  path: string,
  init: RequestInit = {},
  callerEnv: Env = workerEnv(),
) => {
  const url = new URL(`${ORIGIN}${path}`);
  return await buffered(await handleServing(new Request(url, init), url, callerEnv, sink));
};

/** A published doc, by the same route a publisher would take to make one. */
async function readableDoc(): Promise<string> {
  const url = new URL(`${ORIGIN}/api/v1/docs`);
  const response = await createDoc(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_PUSH),
    }),
    url,
    workerEnv(),
    PUBLISHER,
    NO_ANALYTICS,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { docId: string }).docId;
}

/** Withdraw one, so a read of it can be asserted against the 410 that follows. */
const withdraw = (docId: string) => deleteDoc(workerEnv(), PUBLISHER, docId, NO_ANALYTICS);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("which reads record", () => {
  it("counts a read of the shared link", async () => {
    const docId = await readableDoc();
    const { sink, events } = collectingSink();

    const before = Date.now();
    const response = await read(sink, `/d/${docId}`);
    expect(response.status).toBe(200);

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event!.name).toBe("document_viewed");
    expect(event!.docId).toBe(docId);
    // Dated by the request rather than by the moment R2 answered, so a read
    // behind a slow bucket still lands in the interval it arrived in.
    expect(event!.atMs).toBeGreaterThanOrEqual(before);
    expect(event!.atMs).toBeLessThanOrEqual(Date.now());
    // A view has no owner to name, and the type has no field to put one in.
    expect(event).not.toHaveProperty("ownerId");
  });

  it("counts a read of a pinned version", async () => {
    const docId = await readableDoc();
    const { sink, events } = collectingSink();

    expect((await read(sink, `/d/${docId}/v1`)).status).toBe(200);
    expect(names(events)).toEqual(["document_viewed"]);
    expect(events[0]!.docId).toBe(docId);
  });

  it("counts a conditional read that answers 304", async () => {
    const docId = await readableDoc();
    const etag = (await read(NO_ANALYTICS, `/d/${docId}`)).headers.get("etag")!;
    expect(etag).not.toBeNull();

    const { sink, events } = collectingSink();
    const response = await read(sink, `/d/${docId}`, { headers: { "if-none-match": etag } });

    // The half of the rule worth pinning: a reader who already holds this
    // document and was told to use what they have has read it. Counting 200
    // alone would quietly redefine the metric as reads by people whose cache
    // had gone cold, and a daily reader would appear once and seem to stop.
    expect(response.status).toBe(304);
    expect(names(events)).toEqual(["document_viewed"]);
  });

  it("counts each read separately, under one document key", async () => {
    const docId = await readableDoc();
    const { sink, events } = collectingSink();

    for (let i = 0; i < 3; i += 1) {
      expect((await read(sink, `/d/${docId}`)).status).toBe(200);
    }

    expect(names(events)).toEqual(["document_viewed", "document_viewed", "document_viewed"]);
    expect(new Set(events.map((event) => event.docId))).toEqual(new Set([docId]));
  });

  it("gives two documents two different keys", async () => {
    const [first, second] = [await readableDoc(), await readableDoc()];
    const { sink, events } = collectingSink();

    await read(sink, `/d/${first}`);
    await read(sink, `/d/${second}`);

    const keys = await Promise.all(events.map((event) => documentAnalyticsKey(event.docId)));
    expect(new Set(keys).size).toBe(2);
    // The distinct-page count is only as good as this: two documents sharing a
    // key would silently report as one page.
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("which reads record nothing", () => {
  it("records nothing for HEAD, whether it answers 200 or 304", async () => {
    const docId = await readableDoc();
    const etag = (await read(NO_ANALYTICS, `/d/${docId}`)).headers.get("etag")!;
    const { sink, events } = collectingSink();

    // HEAD is GET without the body, and what sends one is a cache revalidating
    // or a link checker — not somebody reading.
    expect((await read(sink, `/d/${docId}`, { method: "HEAD" })).status).toBe(200);
    const conditional = await read(sink, `/d/${docId}`, {
      method: "HEAD",
      headers: { "if-none-match": etag },
    });
    expect(conditional.status).toBe(304);

    expect(events).toEqual([]);
  });

  it("records nothing for a method no reader sends", async () => {
    const docId = await readableDoc();
    const { sink, events } = collectingSink();

    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect((await read(sink, `/d/${docId}`, { method })).status).toBe(404);
    }
    expect(events).toEqual([]);
  });

  it("records nothing for a document that never existed", async () => {
    const { sink, events } = collectingSink();

    expect((await read(sink, `/d/${UNKNOWN_DOC_ID}`)).status).toBe(404);
    expect(events).toEqual([]);
  });

  it("records nothing for a path that is not a document url", async () => {
    const { sink, events } = collectingSink();

    for (const path of ["/d", "/d/", "/d/not-an-id", `/d/${UNKNOWN_DOC_ID}/v0`, `/dx${UNKNOWN_DOC_ID}`]) {
      expect((await read(sink, path)).status).toBe(404);
    }
    expect(events).toEqual([]);
  });

  it("records nothing for a withdrawn document", async () => {
    const docId = await readableDoc();
    expect((await withdraw(docId)).status).toBe(204);
    const { sink, events } = collectingSink();

    // 410 is a reply about a document, not a delivery of one.
    expect((await read(sink, `/d/${docId}`)).status).toBe(410);
    expect(events).toEqual([]);
  });

  it("records nothing when D1 promises an object R2 does not have", async () => {
    const docId = await readableDoc();
    await env.DOCS.delete(versionObjectKey(docId, 1));
    const { sink, events } = collectingSink();

    // The pointer row still says version 1 exists. R2 is the system of record,
    // so this answers 404 — and a read nobody received is not a view. This is
    // the case that decides where the call sits: anything recorded above the
    // bucket would have counted it.
    expect((await read(sink, `/d/${docId}`)).status).toBe(404);
    expect(events).toEqual([]);
  });

  it("records nothing when the read fails outright", async () => {
    const docId = await readableDoc();
    const brokenDocs = {
      get: () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket;
    const { sink, events } = collectingSink();

    await expect(read(sink, `/d/${docId}`, {}, workerEnv({ DOCS: brokenDocs }))).rejects.toThrow();
    // The router turns this into a serving 500. Nothing was served, so nothing
    // is counted — and the throw carries past the call rather than around it.
    expect(events).toEqual([]);
  });
});

/**
 * Reads through the router, with PostHog stood in for at `globalThis.fetch`.
 *
 * The fake sink above proves which reads record. These prove the wire is
 * attached to them, that nothing about the reader reaches the payload, and that
 * a reader cannot tell analytics exists at all — which is the part that has to
 * hold on the one surface in this repo the whole internet can reach.
 */
describe("reads through the router", () => {
  const CONFIGURED: Partial<Env> = {
    POSTHOG_PROJECT_API_KEY: KEY,
    POSTHOG_HOST: HOST,
    ANALYTICS_ENVIRONMENT: "test",
  };

  async function serve(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}${path}`, init),
      workerEnv({ ...CONFIGURED, ...overrides }),
      ctx,
    );
    // Deliveries are scheduled on `waitUntil`, so without this every assertion
    // about them would race the request that scheduled them.
    await waitOnExecutionContext(ctx);
    return await buffered(response);
  }

  it("puts one view event on the wire per read, under one document key", async () => {
    const docId = await readableDoc();
    const { deliveries } = captureDeliveries();

    expect((await serve(`/d/${docId}`)).status).toBe(200);
    expect((await serve(`/d/${docId}`)).status).toBe(200);
    expect((await serve(`/d/${docId}/v1`)).status).toBe(200);

    expect(deliveries.map((delivery) => delivery.body.event)).toEqual([
      "document_viewed",
      "document_viewed",
      "document_viewed",
    ]);

    const documentKey = await documentAnalyticsKey(docId);
    for (const delivery of deliveries) {
      const properties = delivery.body.properties as Record<string, unknown>;
      expect(properties.document_key).toBe(documentKey);
      // The document is the subject, never the reader. PostHog is told not to
      // materialise a person behind this event at all.
      expect(delivery.body.distinct_id).toBe(documentKey);
      expect(properties.$process_person_profile).toBe(false);
    }

    // Repeated reads are separate events with separate identities, so a retry
    // could be deduplicated without collapsing two genuine reads into one.
    expect(new Set(deliveries.map((delivery) => delivery.body.uuid)).size).toBe(3);
  });

  it("sends nothing about the reader", async () => {
    const docId = await readableDoc();
    const { deliveries } = captureDeliveries();

    const response = await serve(`/d/${docId}`, {
      headers: {
        "user-agent": "Mozilla/5.0 (DistinctiveReaderAgent/9.9)",
        referer: "https://referring-site.example/distinctive-path",
        cookie: "distinctive_cookie=distinctive_value",
        "cf-connecting-ip": "203.0.113.199",
      },
    });
    expect(response.status).toBe(200);

    const { raw } = only(deliveries);
    for (const reader of [
      "DistinctiveReaderAgent",
      "referring-site.example",
      "distinctive_cookie",
      "distinctive_value",
      "203.0.113.199",
    ]) {
      expect(raw).not.toContain(reader);
    }
    // Nor anything that could name the page itself.
    expect(raw).not.toContain(docId);
    expect(raw).not.toContain("A note");
    expect(raw).not.toContain("/d/");
  });

  it("records nothing for the legacy host's redirect", async () => {
    const docId = await readableDoc();
    const { deliveries } = captureDeliveries();

    const response = await serve(`/d/${docId}`, {}, {
      SERVING_HOST: "openartifacts.site",
      LEGACY_SERVING_HOST: "openartifacts.workers.dev",
    });

    // The reader's follow-up GET on the canonical host is the view. Counting
    // the redirect as well would count one read twice.
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`https://openartifacts.site/d/${docId}`);
    expect(deliveries).toEqual([]);
  });

  it("records no view for anything on the API surface", async () => {
    const docId = await readableDoc();
    const { deliveries } = captureDeliveries();

    // Unauthenticated, so both API calls stop at the credential rather than at
    // a route — which is the point: nothing on this surface is a document read,
    // whatever it asks for and however far it gets.
    expect((await serve("/health")).status).toBe(200);
    expect((await serve(`/api/v1/docs/${docId}`)).status).toBe(401);
    expect((await serve("/api/v1/docs")).status).toBe(401);

    expect(deliveries.map((delivery) => delivery.body.event)).toEqual([]);
  });

  const FAILING_INTAKE: Array<[string, () => Promise<Response>]> = [
    [
      "a network that rejects",
      async () => {
        throw new Error("no route to posthog.test");
      },
    ],
    ["a refusal from PostHog", async () => new Response("nope", { status: 500 })],
  ];

  it.each(FAILING_INTAKE)("serves a document identically through %s", async (_label, respond) => {
    const docId = await readableDoc();

    // What a reader gets with analytics switched off entirely, which is the
    // only baseline worth comparing against.
    const expected = await serve(`/d/${docId}`, {}, { POSTHOG_PROJECT_API_KEY: "" });
    const expectedBody = await expected.text();

    captureWarnings();
    captureDeliveries(respond);
    const actual = await serve(`/d/${docId}`);

    expect(actual.status).toBe(expected.status);
    expect(await actual.text()).toBe(expectedBody);
    // The whole header set, not a sample: the serving surface's security policy
    // and its caching are both properties a reader must not be able to see
    // analytics through.
    expect(Object.fromEntries(actual.headers.entries())).toEqual(
      Object.fromEntries(expected.headers.entries()),
    );
    for (const header of ["etag", "cache-control", "content-security-policy", "x-robots-tag"]) {
      expect(actual.headers.get(header)).not.toBeNull();
    }
    expect(actual.headers.get("set-cookie")).toBeNull();
  });
});

/**
 * The epic's reconciliation, in executable form.
 *
 * Two pages, one read repeatedly, reads on more than one day. What it exists to
 * pin is the counting rule that is easiest to get wrong in a dashboard and
 * impossible to spot afterwards: **distinct pages must be recomputed over the
 * interval, never summed across days.** Summing per-day distinct counts counts a
 * page read on two days as two pages, and the number it produces looks entirely
 * plausible.
 */
describe("counting reads over an interval", () => {
  /** Distinct document keys, which is what PostHog counts for "pages viewed". */
  async function distinctPages(events: DocumentEvent[]): Promise<number> {
    const keys = await Promise.all(events.map((event) => documentAnalyticsKey(event.docId)));
    return new Set(keys).size;
  }

  it("recomputes distinct pages per interval instead of summing days", async () => {
    const [first, second] = [await readableDoc(), await readableDoc()];
    const { sink, events } = collectingSink();

    // Monday: the first page twice, the second once.
    await read(sink, `/d/${first}`);
    await read(sink, `/d/${first}`);
    await read(sink, `/d/${second}`);
    const monday = [...events];

    // Tuesday: the first page again, and nothing else.
    events.length = 0;
    await read(sink, `/d/${first}/v1`);
    const tuesday = [...events];

    const week = [...monday, ...tuesday];

    // Total views is a sum, and summing days is the right way to get it.
    expect(week).toHaveLength(4);
    expect(monday.length + tuesday.length).toBe(week.length);

    // Distinct pages is not. Two pages were read all week; adding Monday's two
    // to Tuesday's one gives three, which is more pages than exist.
    expect(await distinctPages(week)).toBe(2);
    expect((await distinctPages(monday)) + (await distinctPages(tuesday))).toBe(3);
    expect(await distinctPages(week)).not.toBe(
      (await distinctPages(monday)) + (await distinctPages(tuesday)),
    );
  });
});
