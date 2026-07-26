import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticateRequest,
  INELIGIBLE_PLAN,
  mayPublish,
  parseBearerToken,
  publisherErrorResponse,
  resolvePublisher,
} from "../src/auth.js";
import { LICENSE_CACHE_TTL_MS, type Env } from "../src/config.js";
import type { PublisherRow, PublisherStore } from "../src/db.js";
import { DOC_ID_LENGTH } from "../src/ids.js";
import worker from "../src/index.js";

/** Shape-valid, never in the database. Derived so a length change cannot strand it. */
const VALID_DOC_ID = "0123456789abcdefghjkmnpqrstvwxyz".repeat(2).slice(0, DOC_ID_LENGTH);

/** A plausible Copilot Plus key. Distinctive so leak assertions mean something. */
const KEY = "cplus_live_9f4c1a77e0b24d3e";
/** Computed independently of the implementation. */
const KEY_HASH = createHash("sha256").update(KEY).digest("hex");

const NOW = 1_800_000_000_000;
const now = () => NOW;

const env = (over: Partial<Env> = {}): Env =>
  ({
    LICENSE_API_URL: "https://license.test",
    LICENSE_API_KEY: "server-side-secret",
    ...over,
  }) as Env;

interface MemoryStore extends PublisherStore {
  rows: Map<string, PublisherRow>;
}

function memoryStore(...seed: PublisherRow[]): MemoryStore {
  const rows = new Map(seed.map((row) => [row.key_hash, row]));
  return {
    rows,
    async read(keyHash) {
      return rows.get(keyHash) ?? null;
    },
    async save(row) {
      rows.set(row.key_hash, { ...row });
    },
  };
}

const validatedAt = (msAgo: number): PublisherRow => ({
  key_hash: KEY_HASH,
  plan: "believer",
  validated_at: NOW - msAgo,
});

interface LicenseStub {
  fetch: typeof fetch;
  calls: { url: string; init: RequestInit }[];
}

/** Records every call and answers with `reply`; never touches the network. */
function licenseServer(reply: () => Response | Promise<Response>): LicenseStub {
  const calls: LicenseStub["calls"] = [];
  const stub = async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    // `return await`, not `return`: a bare return hands the rejection back by
    // promise adoption, which leaves it momentarily unhandled — and workerd,
    // where these tests now run, reports that as an unhandled rejection even
    // though `validateLicense` catches it a tick later.
    return await reply();
  };
  return { fetch: stub as unknown as typeof fetch, calls };
}

/** The tRPC success envelope: `{result: {data: {json: ...}}}`. */
const answers = (json: Record<string, unknown>) => () =>
  Response.json({ result: { data: { json } } });

/**
 * The tRPC error envelope as the license server actually emits it: superjson
 * shape, and the HTTP status tRPC derives from the code — so a rejected key
 * really does arrive as a 404, not a 200.
 */
const trpcError = (code: string, httpStatus: number) => () =>
  Response.json(
    { error: { json: { message: `[license] ${code}`, code: -32004, data: { code, httpStatus } } } },
    { status: httpStatus },
  );

const validBeliever = answers({ isValid: true, plan: "believer", backendAccess: true });

const headerOf = (init: RequestInit, name: string) =>
  new Headers(init.headers as HeadersInit).get(name);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseBearerToken", () => {
  it("accepts the scheme in any case and with padded whitespace", () => {
    expect(parseBearerToken("Bearer abc")).toBe("abc");
    expect(parseBearerToken("bearer abc")).toBe("abc");
    expect(parseBearerToken("BEARER\tabc")).toBe("abc");
    expect(parseBearerToken("  Bearer   abc  ")).toBe("abc");
  });

  it("rejects anything that is not a single bearer token", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken("abc")).toBeNull();
    expect(parseBearerToken("Basic abc")).toBeNull();
    expect(parseBearerToken("Bearer")).toBeNull();
    expect(parseBearerToken("Bearer ")).toBeNull();
    expect(parseBearerToken("Bearer abc def")).toBeNull();
  });
});

describe("resolvePublisher — a valid key", () => {
  it("resolves to the key's SHA-256 and caches the validation", async () => {
    const store = memoryStore();
    const license = licenseServer(validBeliever);

    const result = await resolvePublisher(KEY, env(), { store, now, fetch: license.fetch });

    expect(result).toEqual({ ok: true, publisher: { id: KEY_HASH, plan: "believer" } });
    expect(license.calls).toHaveLength(1);
    expect(store.rows.get(KEY_HASH)).toEqual({
      key_hash: KEY_HASH,
      plan: "believer",
      validated_at: NOW,
    });
  });

  it("asks the license server with our own credential, not the publisher's key", async () => {
    const license = licenseServer(validBeliever);

    await resolvePublisher(KEY, env(), { store: memoryStore(), now, fetch: license.fetch });

    const call = license.calls[0]!;
    expect(call.url).toBe("https://license.test/api/trpc/license.validateLicenseKey");
    expect(call.init.method).toBe("POST");
    expect(headerOf(call.init, "content-type")).toBe("application/json");
    expect(headerOf(call.init, "authorization")).toBe("Bearer server-side-secret");
    expect(JSON.parse(String(call.init.body))).toEqual({ json: { licenseKey: KEY } });
  });

  it("tolerates a trailing slash on LICENSE_API_URL", async () => {
    const license = licenseServer(validBeliever);

    await resolvePublisher(KEY, env({ LICENSE_API_URL: "https://license.test/" }), {
      store: memoryStore(),
      now,
      fetch: license.fetch,
    });

    expect(license.calls[0]!.url).toBe("https://license.test/api/trpc/license.validateLicenseKey");
  });

  it("never lets the raw key out of the module", async () => {
    const store = memoryStore();
    const result = await resolvePublisher(KEY, env(), {
      store,
      now,
      fetch: licenseServer(validBeliever).fetch,
    });

    expect(JSON.stringify([...store.rows.values()])).not.toContain(KEY);
    // Not even a prefix long enough to narrow a brute force.
    expect(JSON.stringify(result)).not.toContain(KEY.slice(0, 8));
  });

  it("folds the server's uppercase plan enum", async () => {
    const store = memoryStore();

    // The live server returns the DB enum: `PLUS`, `BELIEVER`.
    const result = await resolvePublisher(KEY, env(), {
      store,
      now,
      fetch: licenseServer(answers({ isValid: true, plan: "BELIEVER", backendAccess: true })).fetch,
    });

    expect(result).toEqual({ ok: true, publisher: { id: KEY_HASH, plan: "believer" } });
    expect(store.rows.get(KEY_HASH)?.plan).toBe("believer");
  });

  it("treats a missing backendAccess as granted, so a valid key still resolves", async () => {
    const result = await resolvePublisher(KEY, env(), {
      store: memoryStore(),
      now,
      fetch: licenseServer(answers({ isValid: true, plan: "believer" })).fetch,
    });

    expect(result.ok).toBe(true);
  });
});

describe("resolvePublisher — the one-hour cache", () => {
  it("makes no license-server call for a key validated within the hour", async () => {
    const store = memoryStore(validatedAt(59 * 60 * 1000));
    const license = licenseServer(validBeliever);

    const result = await resolvePublisher(KEY, env(), { store, now, fetch: license.fetch });

    expect(result).toEqual({ ok: true, publisher: { id: KEY_HASH, plan: "believer" } });
    expect(license.calls).toHaveLength(0);
  });

  it("revalidates once the row reaches the TTL, and refreshes the row", async () => {
    const store = memoryStore(validatedAt(LICENSE_CACHE_TTL_MS));
    const license = licenseServer(answers({ isValid: true, plan: "believer", backendAccess: true }));

    const result = await resolvePublisher(KEY, env(), { store, now, fetch: license.fetch });

    expect(license.calls).toHaveLength(1);
    expect(result).toEqual({ ok: true, publisher: { id: KEY_HASH, plan: "believer" } });
    expect(store.rows.get(KEY_HASH)).toEqual({
      key_hash: KEY_HASH,
      plan: "believer",
      validated_at: NOW,
    });
  });

  it("revalidates a key whose cached validation has long expired", async () => {
    const store = memoryStore(validatedAt(25 * 60 * 60 * 1000));
    const license = licenseServer(validBeliever);

    await resolvePublisher(KEY, env(), { store, now, fetch: license.fetch });

    expect(license.calls).toHaveLength(1);
    expect(store.rows.get(KEY_HASH)?.validated_at).toBe(NOW);
  });
});

describe("resolvePublisher — a key the license server rejects", () => {
  const denied = (reply: () => Response) => async () => {
    const store = memoryStore();
    const result = await resolvePublisher(KEY, env(), {
      store,
      now,
      fetch: licenseServer(reply).fetch,
    });

    expect(result).toMatchObject({ ok: false, reason: "invalid_license" });
    // Nothing is written, so an unauthorized key never gets a publishers row a
    // later doc insert could hang a foreign key off.
    expect(store.rows.size).toBe(0);
  };

  // How the real server reports a key it has no row for, or one flagged deleted:
  // a thrown TRPCError, which tRPC serialises as a 404. It has no other way to
  // say no — every success path it takes returns `isValid: true`.
  it("denies a key the server does not know (tRPC NOT_FOUND)", denied(trpcError("NOT_FOUND", 404)));

  it("denies an invalid key", denied(answers({ isValid: false, plan: "free" })));

  it(
    "denies a valid key without backend access",
    denied(answers({ isValid: true, plan: "free", backendAccess: false })),
  );

  it(
    "denies an invalid key even if backendAccess is true",
    denied(answers({ isValid: false, backendAccess: true })),
  );

  it("leaves an existing row untouched when the key has since lapsed", async () => {
    const stale = validatedAt(2 * 60 * 60 * 1000);
    const store = memoryStore(stale);

    const result = await resolvePublisher(KEY, env(), {
      store,
      now,
      fetch: licenseServer(answers({ isValid: false })).fetch,
    });

    expect(result).toMatchObject({ ok: false, reason: "invalid_license" });
    // The row stays: docs.publisher references it. It simply stops resolving.
    expect(store.rows.get(KEY_HASH)).toEqual(stale);
  });

  it("locks out a revoked key that still has a cached validation", async () => {
    const store = memoryStore(validatedAt(3 * 60 * 60 * 1000));

    const result = await resolvePublisher(KEY, env(), {
      store,
      now,
      fetch: licenseServer(trpcError("NOT_FOUND", 404)).fetch,
    });

    // The outage fallback must never cover a key the server actively refused.
    // If it did, revocation would never take effect: each request would fail to
    // revalidate and be waved through on the stale row, forever.
    expect(result).toMatchObject({ ok: false, reason: "invalid_license" });
  });
});

describe("a plan that may not publish", () => {
  const validPlus = answers({ isValid: true, plan: "plus", backendAccess: true });

  it("still authenticates — entitlement is not authentication", async () => {
    const store = memoryStore();

    const result = await resolvePublisher(KEY, env(), {
      store,
      now,
      fetch: licenseServer(validPlus).fetch,
    });

    // The key is real, so it resolves to a publisher and gets a row like any
    // other. What it cannot do is publish, and that is the router's call.
    expect(result).toEqual({ ok: true, publisher: { id: KEY_HASH, plan: "plus" } });
    expect(store.rows.get(KEY_HASH)?.plan).toBe("plus");
  });

  it("carries a plan it cannot read as one that may not publish", async () => {
    const result = await resolvePublisher(KEY, env(), {
      store: memoryStore(),
      now,
      // `isValid` is readable, `plan` is not.
      fetch: licenseServer(answers({ isValid: true, backendAccess: true })).fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mayPublish(result.publisher.plan)).toBe(false);
  });

  it("writes a downgrade back through the ordinary valid path", async () => {
    const store = memoryStore(validatedAt(LICENSE_CACHE_TTL_MS));

    await resolvePublisher(KEY, env(), { store, now, fetch: licenseServer(validPlus).fetch });

    // No special case needed: a downgraded publisher authenticates, so the row
    // is refreshed like anyone else's and the stale `believer` is gone.
    expect(store.rows.get(KEY_HASH)).toEqual({
      key_hash: KEY_HASH,
      plan: "plus",
      validated_at: NOW,
    });
  });

  it("refuses with the frozen code, and says why without naming the DB enum", async () => {
    const response = publisherErrorResponse(INELIGIBLE_PLAN);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: INELIGIBLE_PLAN.message },
    });
    expect(INELIGIBLE_PLAN.message).toContain("lifetime");
    expect(INELIGIBLE_PLAN.message).not.toContain("not valid");
    // `BELIEVER` is the license server's DB enum and the plan is *sold* as
    // Supporter, so neither word means anything to the person reading this.
    expect(INELIGIBLE_PLAN.message).not.toMatch(/believer/i);
  });
});

describe("the gate is on publishing, not on the publisher", () => {
  const ctx = {} as ExecutionContext;

  /** A warm row, so auth resolves off the cache and never touches the network. */
  const seeded = (plan: string) => {
    const db = fakeD1();
    db.rows.set(KEY_HASH, { key_hash: KEY_HASH, plan, validated_at: Date.now() });
    return db;
  };

  const call = (method: string, path: string, db: D1Database) =>
    worker.fetch(
      new Request(`https://symposium.workers.dev/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: method === "POST" || method === "PUT" ? JSON.stringify({ html: "<p>x</p>" }) : null,
      }),
      env({ DB: db, SERVING_HOST: "", API_HOST: "" }),
      ctx,
    );

  it("401s POST and PUT for a plan that may not publish", async () => {
    for (const [method, path] of [
      ["POST", "/docs"],
      ["PUT", `/docs/${VALID_DOC_ID}`],
    ] as const) {
      const res = await call(method, path, seeded("plus"));

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({
        error: { code: "unauthorized", message: INELIGIBLE_PLAN.message },
      });
    }
  });

  // Unshare is the half of this that matters most, and it is covered in
  // test/manage.test.ts against real D1 and R2: a doc published while entitled,
  // deleted after the downgrade, its objects gone and its url answering 410.
  // Asserting it here would mean teaching `fakeD1` what a soft delete returns,
  // which is a claim about D1 rather than about the gate.

  it("leaves the doc list working for a plan that may not publish", async () => {
    const res = await call("GET", "/docs", seeded("plus"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ docs: [] });
  });

  it("lets an entitled plan past the gate", async () => {
    const res = await call("GET", "/docs", seeded("believer"));

    expect(res.status).toBe(200);
  });
});

describe("resolvePublisher — the license server is down", () => {
  const unreachable = [
    ["the connection fails", () => Promise.reject(new Error("connect ECONNREFUSED"))],
    ["it returns 500", () => new Response("boom", { status: 500 })],
    ["it faults internally", trpcError("INTERNAL_SERVER_ERROR", 500)],
    // Our own LICENSE_API_KEY is wrong or missing. Nothing to do with the
    // publisher, so it must never surface as a bad license key.
    ["it rejects our own credential", trpcError("UNAUTHORIZED", 401)],
    ["it returns a bare 401 with no envelope", () => new Response("nope", { status: 401 })],
    ["it returns an error envelope with no code", () => Response.json({ error: { json: {} } })],
    ["it returns an unparseable body", () => new Response("<html>502</html>")],
    ["it returns a body with no verdict", () => Response.json({ result: { data: { json: {} } } })],
  ] as const;

  for (const [label, reply] of unreachable) {
    it(`allows a previously validated publisher when ${label}`, async () => {
      const store = memoryStore(validatedAt(3 * 60 * 60 * 1000));

      const result = await resolvePublisher(KEY, env(), {
        store,
        now,
        fetch: licenseServer(reply as () => Response).fetch,
      });

      expect(result).toEqual({ ok: true, publisher: { id: KEY_HASH, plan: "believer" } });
    });

    it(`refuses an unknown key when ${label}`, async () => {
      const store = memoryStore();

      const result = await resolvePublisher(KEY, env(), {
        store,
        now,
        fetch: licenseServer(reply as () => Response).fetch,
      });

      // Not `invalid_license`: an outage must never be reported as a bad key.
      expect(result).toMatchObject({ ok: false, reason: "license_unavailable" });
      expect(store.rows.size).toBe(0);
    });
  }

  it("does not refresh the cached validation while the server is down", async () => {
    const stale = validatedAt(3 * 60 * 60 * 1000);
    const store = memoryStore(stale);

    await resolvePublisher(KEY, env(), {
      store,
      now,
      fetch: licenseServer(() => Promise.reject(new Error("down"))).fetch,
    });

    // Otherwise an outage would silently extend the TTL of an unverified key.
    expect(store.rows.get(KEY_HASH)).toEqual(stale);
  });
});

describe("resolvePublisher — license env not configured", () => {
  it("never calls out and refuses an unknown key", async () => {
    const license = licenseServer(validBeliever);

    const result = await resolvePublisher(KEY, env({ LICENSE_API_KEY: "" }), {
      store: memoryStore(),
      now,
      fetch: license.fetch,
    });

    expect(license.calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, reason: "license_unavailable" });
  });

  it("still honours a cached validation", async () => {
    const result = await resolvePublisher(KEY, env({ LICENSE_API_URL: "" }), {
      store: memoryStore(validatedAt(0)),
      now,
      fetch: licenseServer(validBeliever).fetch,
    });

    expect(result.ok).toBe(true);
  });
});

describe("authenticateRequest", () => {
  const request = (authorization?: string) =>
    new Request("https://symposium.test/api/v1/docs", {
      headers: authorization === undefined ? {} : { authorization },
    });

  it("reads the token out of the Authorization header", async () => {
    const result = await authenticateRequest(request(`Bearer ${KEY}`), env(), {
      store: memoryStore(),
      now,
      fetch: licenseServer(validBeliever).fetch,
    });

    expect(result).toEqual({ ok: true, publisher: { id: KEY_HASH, plan: "believer" } });
  });

  it("fails on a missing or malformed header without consulting anything", async () => {
    const license = licenseServer(validBeliever);
    // A store that would throw if it were read: the header check must come first.
    const store = {
      read: () => Promise.reject(new Error("must not be read")),
      save: () => Promise.reject(new Error("must not be written")),
    } satisfies PublisherStore;

    for (const header of [undefined, "", "Basic hunter2", "Bearer", `Token ${KEY}`]) {
      const result = await authenticateRequest(request(header), env(), {
        store,
        now,
        fetch: license.fetch,
      });
      expect(result).toMatchObject({ ok: false, reason: "missing_credentials" });
    }
    expect(license.calls).toHaveLength(0);
  });
});

/**
 * Just enough D1 to run the real `d1PublisherStore` statements, so the worker
 * wiring is exercised end to end rather than through an injected store.
 */
function fakeD1(): D1Database & { rows: Map<string, PublisherRow> } {
  const rows = new Map<string, PublisherRow>();
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const statement = {
      bind(...bound: unknown[]) {
        args = bound;
        return statement;
      },
      async first() {
        if (!/^\s*SELECT/i.test(sql)) throw new Error(`first() on non-select: ${sql}`);
        return rows.get(String(args[0])) ?? null;
      },
      async run() {
        if (!/^\s*INSERT/i.test(sql)) throw new Error(`run() on non-insert: ${sql}`);
        rows.set(String(args[0]), {
          key_hash: String(args[0]),
          plan: String(args[1]),
          validated_at: Number(args[2]),
        });
        return { success: true };
      },
      // Reached only once a request is past the gate: `GET /api/v1/docs` is the
      // first handler on the other side of it, and all it wants to know is that
      // this publisher holds no docs. Auth is what these tests are about.
      async all() {
        if (!/^\s*SELECT/i.test(sql)) throw new Error(`all() on non-select: ${sql}`);
        return { results: [] };
      },
    };
    return statement;
  };
  return { prepare, rows } as unknown as D1Database & { rows: Map<string, PublisherRow> };
}

describe("/api/v1 is gated on a publisher", () => {
  const ctx = {} as ExecutionContext;
  const call = (authorization?: string, db: D1Database = fakeD1()) =>
    worker.fetch(
      new Request("https://symposium.workers.dev/api/v1/docs", {
        headers: authorization === undefined ? {} : { authorization },
      }),
      env({ DB: db, SERVING_HOST: "", API_HOST: "" }),
      ctx,
    );

  it("401s a request with no usable Authorization header", async () => {
    for (const header of [undefined, "", "Basic hunter2", "Bearer", `Token ${KEY}`]) {
      const res = await call(header);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      await expect(res.json()).resolves.toEqual({
        error: { code: "unauthorized", message: expect.any(String) },
      });
    }
  });

  it("401s a key the license server rejects, before any handler runs", async () => {
    // The real rejection shape: a 404 carrying a tRPC NOT_FOUND envelope.
    vi.stubGlobal("fetch", licenseServer(trpcError("NOT_FOUND", 404)).fetch);

    const res = await call(`Bearer ${KEY}`);

    // This path answers 200 with a doc list once a key gets through, so a 401
    // proves the gate answered before the handler ran.
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });

  it("lets a valid key through to the handlers and records the publisher", async () => {
    vi.stubGlobal("fetch", licenseServer(validBeliever).fetch);
    const db = fakeD1();

    const res = await call(`Bearer ${KEY}`, db);

    // Auth passed and dispatch continued: this is the list handler's own answer
    // for a publisher holding nothing.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ docs: [] });
    // The row every doc insert hangs its foreign key off.
    expect(db.rows.get(KEY_HASH)?.plan).toBe("believer");
  });

  it("does not 401 a known publisher when the license server is down", async () => {
    vi.stubGlobal(
      "fetch",
      licenseServer(() => Promise.reject(new Error("down"))).fetch,
    );
    const db = fakeD1();
    // Real wall clock here: the worker path uses the real `Date.now`.
    db.rows.set(KEY_HASH, {
      key_hash: KEY_HASH,
      plan: "believer",
      validated_at: Date.now() - 5 * 60 * 60 * 1000,
    });

    const res = await call(`Bearer ${KEY}`, db);

    expect(res.status).toBe(200);
  });

  it("fails a cold key during an outage as a server problem, not a bad key", async () => {
    vi.stubGlobal(
      "fetch",
      licenseServer(() => Promise.reject(new Error("down"))).fetch,
    );

    const res = await call(`Bearer ${KEY}`);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: { code: "internal", message: expect.stringContaining("temporarily unavailable") },
    });
  });
});
