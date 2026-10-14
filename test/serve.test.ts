import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import { DOC_ID_LENGTH, newAccountId } from "../src/ids.js";
import { linkExternalOwner } from "../src/owners.js";
import { grantUrl, originLabel, PRIVATE_LABEL } from "../src/private.js";
import { readerSignInConfigured } from "../src/reader-config.js";
import { signPayload } from "../src/session.js";
import { FAVICON_LINK, NOINDEX_META, OPENARTIFACTS_FOOTER, OPENARTIFACTS_HEADER, OPENARTIFACTS_MARK_SVG } from "../src/render.js";
import { versionObjectKey } from "../src/storage.js";
import worker from "../src/index.js";

/**
 * The served page is no longer the stored object: `renderServedHtml` adds the
 * robots meta and the bylines on the way out. What survives is that the
 * owner's document is carried through untouched, which is what these
 * assertions are actually about.
 */
async function expectServes(response: Response, docId: string, version: number) {
  const html = await response.text();
  const document = await stored(docId, version);
  expect(document).not.toContain(NOINDEX_META);
  expect(html).toContain(NOINDEX_META);
  expect(html).toContain(OPENARTIFACTS_FOOTER);
  // Everything inside the body the owner sent, in order, still there.
  const inner = document.slice(document.indexOf("<body>") + 6, document.indexOf("</body>"));
  expect(html).toContain(inner.trim());
  return html;
}

async function expectStatusPage(
  response: Response,
  status: number,
  title: string,
  heading: string,
  message: string,
) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");

  const html = await response.text();
  expect(html).toContain(`<title>${title} · OpenArtifacts</title>`);
  expect(html).toContain(">OpenArtifacts</div>");
  expect(html).toContain('<a href="https://openartifacts.ai">About OpenArtifacts</a>');
  expect(html).toContain(`<h1 id="page-title">${heading}</h1>`);
  expect(html).toContain(message);
  expect(html).toContain(NOINDEX_META);
  // The page carries the same cube mark as the tab icon; the retired Symposium
  // mark must not come back through this template.
  expect(html).toContain(FAVICON_LINK);
  expect(html).toContain(`<span class="mark" aria-hidden="true">${OPENARTIFACTS_MARK_SVG}</span>`);
  expect(html).not.toContain("#46d17f");
}

/**
 * Local routing has no configured hosts, so it falls back to path prefixes.
 * Deliberately not a real deployment host: these tests are about the surfaces,
 * not about which production domain carries them.
 */
const ORIGIN = "https://openartifacts.workers.dev";

const KEY = "cplus_live_a1b2c3d4e5f60718";

/**
 * A well-formed id that is not in the database. Derived from DOC_ID_LENGTH, not
 * written out: a literal of the wrong length is rejected by `isDocId` on shape
 * before D1 is consulted, which silently turns every "not found" test into a
 * test of the shape check.
 */
const UNKNOWN_DOC_ID = "0123456789abcdefghjkmnpqrstvwxyz".repeat(2).slice(0, DOC_ID_LENGTH);

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A publisher row with a fresh validation, which is what a real request leaves
 * behind after auth. Reading is unauthenticated, so this exists only so the
 * pushes that set up each test can run without a license server.
 */
let owner = "";

beforeEach(async () => {
  const keyHash = await sha256Hex(KEY);
  owner = `account-${keyHash.slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO publishers (key_hash, plan, validated_at, owner)
     VALUES (?, 'believer', ?, ?)`,
  )
    .bind(keyHash, Date.now(), owner)
    .run();
});

/** Statuses whose responses may not carry a body, per the Response constructor. */
const BODILESS = new Set([204, 205, 304]);

async function send(
  method: string,
  path: string,
  init: RequestInit = {},
  overrides: Partial<Env> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(path.startsWith("https://") ? path : `${ORIGIN}${path}`, { method, ...init }),
    {
      ...env,
      SERVING_HOST: "",
      API_HOST: "",
      LEGACY_SERVING_HOST: "",
      RETIRED_API_HOST: "",
      ...overrides,
    },
    ctx,
  );
  await waitOnExecutionContext(ctx);

  // A served page is an R2 stream, and a test that only looks at the headers
  // would leave it open past its own end — which the pool's per-test storage
  // isolation fails on. Buffering here lets every test read the body, or not,
  // without each one having to remember to drain it.
  const body = await response.arrayBuffer();
  return new Response(BODILESS.has(response.status) ? null : body, {
    status: response.status,
    headers: response.headers,
  });
}

const get = (path: string, init?: RequestInit, overrides?: Partial<Env>) =>
  send("GET", path, init, overrides);

const page = (body: string) =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>A note</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

/**
 * Publish through the real push handler rather than seeding R2 by hand: the
 * claim under test is that a reader gets the bytes a push produced, so the
 * pushes have to be real ones.
 */
async function push(body: unknown, docId?: string): Promise<string> {
  const response = await send(
    docId === undefined ? "POST" : "PUT",
    docId === undefined ? "/api/v1/docs" : `/api/v1/docs/${docId}`,
    {
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  expect(response.status).toBe(docId === undefined ? 201 : 200);
  return ((await response.json()) as { docId: string }).docId;
}

/** The exact bytes push stored, which every served response is compared to. */
async function stored(docId: string, n: number): Promise<string> {
  const object = await env.DOCS.get(versionObjectKey(docId, n));
  expect(object).not.toBeNull();
  return object!.text();
}

const softDelete = (docId: string) =>
  env.DB.prepare("UPDATE docs SET deleted_at = ? WHERE id = ?").bind(Date.now(), docId).run();

/** A doc at version 2, so latest and pinned can never be confused. */
async function twoVersionDoc(): Promise<string> {
  const docId = await push({ title: "A note", html: page("<p>first draft</p>") });
  await push({ html: page("<p>second draft</p>") }, docId);
  return docId;
}

describe("GET /d/{docId}", () => {
  it("serves the latest version's stored bytes with a 60s TTL and no cookie", async () => {
    const docId = await twoVersionDoc();

    const response = await get(`/d/${docId}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");

    // Not byte-for-byte any more: the stored object is the owner's document,
    // and the additions go in on the way out. The reader gets both, the bucket
    // holds neither, which is what lets a byline change reach this document
    // without a re-push.
    const html = await response.text();
    const object = await stored(docId, 2);
    expect(html).toContain("<p>second draft</p>");
    expect(html).not.toContain("<p>first draft</p>");
    expect(html).toContain(NOINDEX_META);
    expect(html).toContain(OPENARTIFACTS_FOOTER);
    expect(object).not.toContain(NOINDEX_META);
    expect(object).not.toContain(OPENARTIFACTS_FOOTER);
  });

  // End to end, because "injected once" is asserted against the renderer in
  // isolation elsewhere, and the question a owner actually asks is about a
  // document they pushed. Documents stored before injection moved carry their
  // own baked copy and would show two footers until re-pushed; nothing pushed
  // through this path can, because nothing is ever baked into the bytes.
  it("adds exactly one of each to a freshly pushed Copilot document", async () => {
    const docId = await push({ title: "A note", html: page("<p>hello</p>").replace("</head>", '<style id="openartifacts-obsidian-publish-baseline"></style></head>') });

    const html = await (await get(`/d/${docId}`)).text();

    for (const addition of [NOINDEX_META, OPENARTIFACTS_HEADER, OPENARTIFACTS_FOOTER]) {
      expect(html.split(addition).length - 1).toBe(1);
    }
    // The bylines' own markers, so a future restyle that changes the constants
    // cannot make the count above pass by matching nothing.
    expect(html.split("openartifacts-header").length - 1).toBe(1);
    expect(html.split("openartifacts-footer").length - 1).toBe(1);
  });

  it("serves version 1 at the same url before there is a version 2", async () => {
    const docId = await push({ title: "A note", html: page("<p>only draft</p>") });

    const response = await get(`/d/${docId}`);

    expect(response.status).toBe(200);
    // The TTL follows the url, not the version number: this url will change
    // what it serves the moment the author pushes again.
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    await expectServes(response, docId, 1);
  });

  it("serves the newest version that has bytes, not the burned reservation", async () => {
    const docId = await twoVersionDoc();
    // What a push that dies between reserving a version and writing its object
    // leaves behind (see `docs.latest_version`). Serving the counter would 404
    // a perfectly healthy doc.
    await env.DB.prepare("UPDATE docs SET latest_version = 7 WHERE id = ?").bind(docId).run();

    const response = await get(`/d/${docId}`);

    expect(response.status).toBe(200);
    await expectServes(response, docId, 2);
  });

  it("serves the same page with a trailing slash", async () => {
    const docId = await twoVersionDoc();

    const response = await get(`/d/${docId}/`);

    expect(response.status).toBe(200);
    await expectServes(response, docId, 2);
  });
});

describe("GET /d/{docId}/v{n}", () => {
  it("still serves version 1 immutably after version 2 lands", async () => {
    const docId = await twoVersionDoc();

    const response = await get(`/d/${docId}/v1`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("set-cookie")).toBeNull();

    const html = await response.text();
    expect(html).toContain(NOINDEX_META);
    expect(html).toContain("<p>first draft</p>");
    expect(html).not.toContain("<p>second draft</p>");
  });

  it("serves the newest version at its own pinned url too", async () => {
    const docId = await twoVersionDoc();

    const response = await get(`/d/${docId}/v2`);

    expect(response.status).toBe(200);
    // Immutable because the url names a version, not because the version is
    // old: /v2 will never mean anything else, even once /v3 exists.
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    await expectServes(response, docId, 2);
  });

  it("404s a version above the ones that exist", async () => {
    const docId = await twoVersionDoc();

    for (const n of [3, 4, 99]) {
      const response = await get(`/d/${docId}/v${n}`);
      expect({ n, status: response.status }).toEqual({ n, status: 404 });
      expect(await response.text()).toContain("This document isn’t available.");
    }
  });

  it("404s a version that was reserved but never written", async () => {
    const docId = await twoVersionDoc();
    await env.DB.prepare("UPDATE docs SET latest_version = 7 WHERE id = ?").bind(docId).run();

    // Below the counter, but there are no bytes: a 500 or an empty page would
    // be the alternative to checking `versions` rather than `latest_version`.
    expect((await get(`/d/${docId}/v3`)).status).toBe(404);
  });

  it("404s a version segment that is not one canonical number", async () => {
    const docId = await twoVersionDoc();

    // One version, one url. Leading zeros and signs would each be a second
    // spelling of /v1, and an immutably cached page should have exactly one.
    for (const segment of ["v0", "v01", "v+1", "v1.0", "v-1", "v", "1", "version1", "V1", "v1x"]) {
      const response = await get(`/d/${docId}/${segment}`);
      expect({ segment, status: response.status }).toEqual({ segment, status: 404 });
    }
  });
});

describe("the headers on every served page", () => {
  /** Latest, pinned, a miss and a deleted doc — every reply this surface makes. */
  async function everyServingResponse(): Promise<Response[]> {
    const live = await twoVersionDoc();
    const deleted = await push({ title: "Gone", html: page("<p>x</p>") });
    await softDelete(deleted);

    return Promise.all([
      get(`/d/${live}`),
      get(`/d/${live}/v1`),
      send("HEAD", `/d/${live}`),
      get(`/d/${UNKNOWN_DOC_ID}`),
      get("/d/not-a-doc-id"),
      get(`/d/${deleted}`),
    ]);
  }

  it("asks every crawler not to index or follow (D9)", async () => {
    for (const response of await everyServingResponse()) {
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });

  it("never sets a cookie, which is what makes running uploaded scripts safe", async () => {
    for (const response of await everyServingResponse()) {
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("blocks form submission and framing on every response", async () => {
    for (const response of await everyServingResponse()) {
      const csp = response.headers.get("content-security-policy") ?? "";
      const directives = csp.split(";").map((directive) => directive.trim());

      // The two directives the whole D6 trade rests on: a doc may run scripts,
      // but it may not post a form anywhere, and it may not be framed.
      expect(directives).toContain("form-action 'none'");
      expect(directives).toContain("frame-ancestors 'none'");
      // And nothing may re-point the document's relative urls.
      expect(directives).toContain("base-uri 'none'");
      expect(directives).toContain("object-src 'none'");
    }
  });

  it("still lets an uploaded doc run its scripts and load its assets (D6)", async () => {
    const csp = (await get(`/d/${await twoVersionDoc()}`)).headers.get("content-security-policy");
    const directive = (name: string) =>
      (csp ?? "")
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${name} `)) ?? "";

    // Interactive figures and embedded simulations are the reason the client
    // uploads HTML at all; a policy that broke them would be the wrong trade.
    for (const name of ["script-src", "style-src"]) {
      expect(directive(name)).toContain("'unsafe-inline'");
      expect(directive(name)).toContain("https:");
    }
    expect(directive("script-src")).toContain("'unsafe-eval'");
    for (const name of ["img-src", "font-src"]) {
      expect(directive(name)).toContain("https:");
      expect(directive(name)).toContain("data:");
    }
  });

  it("keeps the whole policy on a failure no handler expected", async () => {
    // R2 down mid-read, which is the one serving response that is not written
    // by hand in serve.ts. A crawler that catches an outage on a doc url must
    // still be told not to index it, so the 500 has to be a *serving* 500.
    const brokenDocs = {
      get: () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket;

    const docId = await twoVersionDoc();
    const response = await get(`/d/${docId}`, undefined, { DOCS: brokenDocs });

    await expectStatusPage(
      response,
      500,
      "Document temporarily unavailable",
      "We can’t open this document right now.",
      "Something went wrong on our end. Please try again in a moment.",
    );
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("keeps the doc url out of the Referer of everything the page touches", async () => {
    // The id is the only access control there is, so leaking it in a header to
    // every linked site would hand the doc away.
    const response = await get(`/d/${await twoVersionDoc()}`);

    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("a deleted doc", () => {
  it("returns 410 gone rather than 404", async () => {
    const docId = await twoVersionDoc();
    await softDelete(docId);

    const response = await get(`/d/${docId}`);

    await expectStatusPage(
      response,
      410,
      "Document deleted",
      "This document is gone.",
      "The author deleted this document.",
    );
    // A reader who bookmarked the link deserves to know it was withdrawn, not
    // to wonder whether they mistyped it.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 410 for its pinned versions too, without leaking which existed", async () => {
    const docId = await twoVersionDoc();
    await softDelete(docId);

    for (const path of [`/d/${docId}/v1`, `/d/${docId}/v2`, `/d/${docId}/v99`]) {
      const response = await get(path);
      expect({ path, status: response.status }).toEqual({ path, status: 410 });
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await response.text()).toContain("The author deleted this document.");
    }
  });

  it("returns 410 once the bytes are gone as well", async () => {
    const docId = await twoVersionDoc();
    await softDelete(docId);
    // Phase 5's delete drops the R2 objects. The answer must not change to 404
    // when it does.
    await env.DOCS.delete([versionObjectKey(docId, 1), versionObjectKey(docId, 2)]);

    expect((await get(`/d/${docId}`)).status).toBe(410);
  });
});

describe("a doc that is not there", () => {
  it("404s an id no push ever minted", async () => {
    const response = await get(`/d/${UNKNOWN_DOC_ID}`);

    await expectStatusPage(
      response,
      404,
      "Document unavailable",
      "This document isn’t available.",
      "The link may be incorrect, or the author may have deleted the document.",
    );
  });

  it("404s a doc row with no version yet", async () => {
    // The other half of a push that died mid-write: a `docs` row whose id was
    // never returned to anyone, so nothing points at it and nothing has bytes.
    await env.DB.prepare(
      `INSERT INTO docs (id, owner, title, latest_version, created_at, updated_at)
       VALUES (?, ?, 'stranded', 1, ?, ?)`,
    )
      .bind(UNKNOWN_DOC_ID, owner, Date.now(), Date.now())
      .run();

    const response = await get(`/d/${UNKNOWN_DOC_ID}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("This document isn’t available.");
  });

  it("404s an object D1 promises but R2 does not have", async () => {
    const docId = await twoVersionDoc();
    await env.DOCS.delete(versionObjectKey(docId, 2));

    // R2 is the system of record, so its answer wins over the pointer index's
    // — a missing object is a miss, not a 500.
    const missing = await get(`/d/${docId}`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("This document isn’t available.");
    expect((await get(`/d/${docId}/v1`)).status).toBe(200);
  });

  it("404s ids that could never be doc ids, without touching D1", async () => {
    // A binding that fails on contact, so reaching D1 at all is a 500 rather
    // than a passing test: junk and crawler noise must cost a regex, not a read.
    const noDb = {
      prepare: () => {
        throw new Error("D1 must not be touched for a malformed id");
      },
    } as unknown as D1Database;

    const impossible = [
      "/d",
      "/d/",
      "/d/not-a-doc-id",
      "/d/0123456789abcdefghjkmnpqrsTOOLONG",
      "/d/ilou00000000000000000000000",
      "/d/0123456789ABCDEFGHJKMNPQRS",
      `/d/${UNKNOWN_DOC_ID}/v1/extra`,
      `/d${UNKNOWN_DOC_ID}`,
      `/dx/${UNKNOWN_DOC_ID}`,
    ];

    // Configured so that *every* path on this host is the serving surface,
    // which is what the sacrificial domain looks like (D3). It is the only
    // arrangement in which the prefix lookalikes below reach this handler at
    // all — on workers.dev the router answers them as unknown paths — and it is
    // the arrangement where mistaking `/dx{docId}` for a doc url would matter.
    const servingHost = { SERVING_HOST: "openartifacts.workers.dev", DB: noDb };

    for (const path of impossible) {
      const response = await get(path, undefined, servingHost);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await response.text()).toContain("This document isn’t available.");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });

  it("404s methods the serving surface does not have", async () => {
    const docId = await twoVersionDoc();

    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await send(method, `/d/${docId}`);
      expect({ method, status: response.status }).toEqual({ method, status: 404 });
      expect(await response.text()).toContain("This document isn’t available.");
    }
    // And the doc is untouched by the attempt.
    expect((await get(`/d/${docId}`)).status).toBe(200);
  });
});

describe("HEAD and conditional requests", () => {
  it("answers HEAD with the page's headers and no body", async () => {
    const docId = await twoVersionDoc();

    const response = await send("HEAD", `/d/${docId}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'none'");
  });

  // The stored length stopped being the served length when the additions moved
  // to serve time, and the served one cannot be known without running the
  // transform — which would fetch the body HEAD promises not to send. Omitting
  // it is legal; stating the stored number would be stating a wrong one.
  it("omits content-length on HEAD rather than reporting the stored size", async () => {
    const docId = await twoVersionDoc();
    const stale = new TextEncoder().encode(await stored(docId, 2)).byteLength;

    const response = await send("HEAD", `/d/${docId}`);

    expect(response.headers.get("content-length")).toBeNull();

    // And the number it would have reported really is wrong now.
    const served = new TextEncoder().encode(await (await get(`/d/${docId}`)).text()).byteLength;
    expect(served).toBeGreaterThan(stale);
  });

  it("404s HEAD for a doc that is not there", async () => {
    const response = await send("HEAD", `/d/${UNKNOWN_DOC_ID}`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("410s HEAD for a deleted doc", async () => {
    const docId = await twoVersionDoc();
    await softDelete(docId);

    const response = await send("HEAD", `/d/${docId}`);

    expect(response.status).toBe(410);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("500s HEAD with the temporary page headers and no body", async () => {
    const docId = await twoVersionDoc();
    const brokenDocs = {
      head: () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket;

    const response = await send("HEAD", `/d/${docId}`, {}, { DOCS: brokenDocs });

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("answers a matching If-None-Match with 304 and no body", async () => {
    const docId = await twoVersionDoc();

    const first = await get(`/d/${docId}`);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    await first.text();

    const second = await get(`/d/${docId}`, { headers: { "if-none-match": etag! } });

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    // A 304 still has to carry the policy: it refreshes what the browser holds.
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe("public, max-age=60");
    expect(second.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("answers HEAD the same way GET does when the validator matches", async () => {
    const docId = await twoVersionDoc();

    const etag = (await send("HEAD", `/d/${docId}`)).headers.get("etag");
    expect(etag).not.toBeNull();

    const revalidated = await send("HEAD", `/d/${docId}`, {
      headers: { "if-none-match": etag! },
    });

    // A validator cannot mean one thing to GET and another to HEAD: a cache
    // revalidating with HEAD would otherwise be told the doc changed when it
    // did not, and re-fetch every time.
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
    expect(revalidated.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const viaGet = await get(`/d/${docId}`, { headers: { "if-none-match": etag! } });
    expect(viaGet.status).toBe(304);
  });

  it("serves HEAD in full when the client holds another version's etag", async () => {
    const docId = await twoVersionDoc();

    const stale = (await send("HEAD", `/d/${docId}/v1`)).headers.get("etag");
    const response = await send("HEAD", `/d/${docId}`, {
      headers: { "if-none-match": stale! },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("treats If-None-Match: * on HEAD as a match", async () => {
    const docId = await twoVersionDoc();

    const response = await send("HEAD", `/d/${docId}`, { headers: { "if-none-match": "*" } });

    expect(response.status).toBe(304);
  });

  it("serves the body when the client holds a different version's etag", async () => {
    const docId = await twoVersionDoc();

    const stale = (await get(`/d/${docId}/v1`)).headers.get("etag");
    const response = await get(`/d/${docId}`, { headers: { "if-none-match": stale! } });

    expect(response.status).toBe(200);
    await expectServes(response, docId, 2);
  });

  it("gives each version its own etag", async () => {
    const docId = await twoVersionDoc();

    const v1 = (await get(`/d/${docId}/v1`)).headers.get("etag");
    const v2 = (await get(`/d/${docId}/v2`)).headers.get("etag");
    const latest = (await get(`/d/${docId}`)).headers.get("etag");

    expect(v1).not.toBe(v2);
    // The shared link's etag has to move with the version, or a 60s-stale
    // reader would revalidate into the old page forever.
    expect(latest).toBe(v2);
  });

  // The bytes a reader gets are the object plus a rendering, and only one of
  // those two is what R2's etag identifies.
  it("names the rendering in the etag, not only the stored object", async () => {
    const docId = await twoVersionDoc();

    const etag = (await get(`/d/${docId}`)).headers.get("etag");

    expect(etag).toMatch(/^W\/".+\.r\d+"$/);
    // Not R2's own validator, which a byline edit cannot move: it identifies
    // the stored object, and a byline edit leaves that alone.
    const object = await env.DOCS.head(versionObjectKey(docId, 2));
    expect(etag).not.toBe(object!.httpEtag);
    expect(etag).toContain(object!.etag);
  });

  // The failure this exists to stop: without the revision in the validator, a
  // reader holding a page rendered by an older deploy revalidates, is told 304,
  // and keeps it — and each revalidation renews its freshness, so it keeps it
  // for good. A tag naming a rendering we no longer produce has to miss.
  it("re-serves in full when the client holds an older rendering", async () => {
    const docId = await twoVersionDoc();
    const current = (await get(`/d/${docId}`)).headers.get("etag")!;
    const older = current.replace(/\.r(\d+)"$/, (_, n) => `.r${Number(n) - 1}"`);

    expect(older).not.toBe(current);

    const response = await get(`/d/${docId}`, { headers: { "if-none-match": older } });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(OPENARTIFACTS_FOOTER);
    expect(response.headers.get("etag")).toBe(current);
  });

  it("still 304s the same rendering on HEAD as on GET", async () => {
    const docId = await twoVersionDoc();
    const etag = (await get(`/d/${docId}`)).headers.get("etag")!;

    const head = await send("HEAD", `/d/${docId}`, { headers: { "if-none-match": etag } });

    expect(head.status).toBe(304);
    expect(head.headers.get("etag")).toBe(etag);
  });

  // A real revalidation sends both validators, and RFC 9110 says the date is
  // ignored whenever an entity tag is present. That has to hold when *no* tag
  // survives translation, which is exactly when it matters: those tags name an
  // older rendering, and a document older than the date would otherwise answer
  // 304 and hand back the stale bylines the revision suffix exists to refuse.
  it("ignores If-Modified-Since when the client's etag names an older rendering", async () => {
    const docId = await twoVersionDoc();
    const current = (await get(`/d/${docId}`)).headers.get("etag")!;
    const older = current.replace(/\.r(\d+)"$/, (_, n) => `.r${Number(n) - 1}"`);

    for (const method of ["GET", "HEAD"]) {
      const response = await send(method, `/d/${docId}`, {
        headers: {
          "if-none-match": older,
          // Comfortably after the push, so on its own this date is a 304.
          "if-modified-since": new Date(Date.now() + 60_000).toUTCString(),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe(current);
    }
  });

  // The other half of the same rule: a date alone is still honoured.
  it("still 304s on If-Modified-Since when no etag was sent", async () => {
    const docId = await twoVersionDoc();

    const response = await get(`/d/${docId}`, {
      headers: { "if-modified-since": new Date(Date.now() + 60_000).toUTCString() },
    });

    expect(response.status).toBe(304);
  });
});

describe("an invited-only document", () => {
  const API = "https://api.openartifacts.ai";
  const PRIVATE = {
    SERVING_HOST: "openartifacts.site",
    API_HOST: "api.openartifacts.ai",
    READER_SESSION_SECRET: "k".repeat(32),
    OAUTH_GITHUB_CLIENT_ID: "github-client",
    OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
  } satisfies Partial<Env>;

  /** A second publisher, Q, beside the suite's own publisher, P. */
  const KEY_Q = "cplus_live_f1e2d3c4b5a60718";
  let ownerQ = "";

  beforeEach(async () => {
    const keyHash = await sha256Hex(KEY_Q);
    ownerQ = `account-${keyHash.slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO publishers (key_hash, plan, validated_at, owner)
       VALUES (?, 'believer', ?, ?)`,
    )
      .bind(keyHash, Date.now(), ownerQ)
      .run();
  });

  /**
   * A private page, and the origin that serves it. The mode is set directly:
   * serving is under test, and `private-docs` is not what this file is about.
   */
  async function privateDoc(text = "for invited eyes", key = KEY, mode: "invited" | "anyone" = "invited") {
    const response = await send("POST", "/api/v1/docs", {
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Secret", html: page(`<p>${text}</p>`) }),
    });
    expect(response.status).toBe(201);
    const { docId } = (await response.json()) as { docId: string };
    await env.DB.prepare("UPDATE docs SET link_access = ? WHERE id = ?").bind(mode, docId).run();
    const row = await env.DB.prepare("SELECT owner FROM docs WHERE id = ?").bind(docId).first<{ owner: string }>();
    return { docId, owner: row!.owner, host: `https://${await originLabel(row!.owner)}.openartifacts.site` };
  }

  /** What `/open` would redirect `principal` to. */
  const grantFor = async (doc: { docId: string; owner: string }, principal: string) =>
    (await grantUrl({ ...env, ...PRIVATE }, doc.owner, { docId: doc.docId, pinned: null }, principal, Date.now()))!.url;

  /** Follow a grant url the way a browser does, and return the cookie it is handed. */
  async function cookieFor(doc: { docId: string; owner: string }, principal: string): Promise<string> {
    const swapped = await get(await grantFor(doc, principal), {}, PRIVATE);
    expect(swapped.status).toBe(303);
    return swapped.headers.get("set-cookie")!.split(";")[0]!;
  }

  /** A reader account, optionally on the invite list of the given documents. */
  async function reader(email: string, ...invitedTo: string[]): Promise<string> {
    const id = newAccountId();
    await env.DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)")
      .bind(id, email, Date.now())
      .run();
    for (const docId of invitedTo) {
      await env.DB.prepare("INSERT INTO doc_invites (doc_id, email, created_at) VALUES (?, ?, ?)")
        .bind(docId, email, Date.now())
        .run();
    }
    return id;
  }

  const ISOLATION = {
    "cross-origin-opener-policy": "same-origin-allow-popups",
    "cross-origin-resource-policy": "same-origin",
  };

  it("redirects its canonical url to sign-in, with no bytes, no cookie and no caching", async () => {
    const { docId } = await privateDoc();

    for (const suffix of ["", "/v1"]) {
      const response = await get(`https://openartifacts.site/d/${docId}${suffix}`, {}, PRIVATE);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`https://api.openartifacts.ai/open/${docId}${suffix}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toBe("");
    }
  });

  it("swaps a grant for a cookie on its publisher's origin, then serves the page private and uncacheable", async () => {
    const doc = await privateDoc();

    const swapped = await get(await grantFor(doc, doc.owner), {}, PRIVATE);
    expect(swapped.status).toBe(303);
    expect(swapped.headers.get("location")).toBe(`/d/${doc.docId}`);
    expect(await swapped.text()).toBe("");
    const cookie = swapped.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-oa_grant=.+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=3600$/);

    const served = await get(`${doc.host}/d/${doc.docId}`, { headers: { cookie: cookie.split(";")[0]! } }, PRIVATE);
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("private, no-store");
    expect(served.headers.get("set-cookie")).toBeNull();
    expect(await served.text()).toContain("for invited eyes");

    // With no cookie the same url sends the reader to sign in rather than serving.
    const anonymous = await get(`${doc.host}/d/${doc.docId}`, {}, PRIVATE);
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toBe(`${API}/open/${doc.docId}`);
  });

  it("serves a second invited document of the same publisher on the same cookie, with no redirect", async () => {
    const first = await privateDoc("first private page");
    const second = await privateDoc("second private page");
    const third = await privateDoc("a page alice is not invited to");
    expect(second.host).toBe(first.host);
    const alice = await reader("alice@acme.com", first.docId, second.docId);

    // One grant, minted for the first document, is all the second one needs.
    const cookie = await cookieFor(first, alice);
    for (const [doc, text] of [[first, "first private page"], [second, "second private page"]] as const) {
      const served = await get(`${doc.host}/d/${doc.docId}`, { headers: { cookie } }, PRIVATE);
      expect(served.status).toBe(200);
      expect(served.headers.get("cache-control")).toBe("private, no-store");
      expect(await served.text()).toContain(text);
    }

    // Not on that document's list: sent to the one not-available page, never shown it.
    const refused = await get(`${third.host}/d/${third.docId}`, { headers: { cookie } }, PRIVATE);
    expect(refused.status).toBe(302);
    expect(refused.headers.get("location")).toBe(`${API}/open/${third.docId}`);
    expect(await refused.text()).toBe("");
  });

  it("refuses a grant for publisher P's origin on publisher Q's origin", async () => {
    const p = await privateDoc("text of P");
    const q = await privateDoc("text of Q", KEY_Q);
    expect(q.host).not.toBe(p.host);
    const grantP = new URL(await grantFor(p, p.owner)).searchParams.get("grant")!;
    const cookieP = await cookieFor(p, p.owner);

    // The grant names P's origin. Presented on Q's, in the URL or as a cookie, for
    // Q's document or P's own, it is a miss: sent to sign in, nothing set, nothing served.
    for (const attempt of [
      get(`${q.host}/d/${q.docId}?grant=${grantP}`, {}, PRIVATE),
      get(`${q.host}/d/${p.docId}?grant=${grantP}`, {}, PRIVATE),
      get(`${q.host}/d/${q.docId}`, { headers: { cookie: cookieP } }, PRIVATE),
    ]) {
      const response = await attempt;
      expect(response.status).toBe(302);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).not.toContain("text of Q");
    }
  });

  it("404s a document of publisher Q on publisher P's host, even for P's own valid cookie", async () => {
    const p = await privateDoc("text of P");
    const q = await privateDoc("text of Q", KEY_Q);
    const publicQ = await privateDoc("a public page of Q", KEY_Q, "anyone");
    const goneQ = await privateDoc("a withdrawn page of Q", KEY_Q);
    await softDelete(goneQ.docId);
    const cookieP = await cookieFor(p, p.owner);

    // Whatever Q's document is — private, public, deleted, nonexistent — P's host
    // answers the same 404, so it cannot be used to learn anything about Q.
    for (const docId of [q.docId, publicQ.docId, goneQ.docId, UNKNOWN_DOC_ID]) {
      const response = await get(`${p.host}/d/${docId}`, { headers: { cookie: cookieP } }, PRIVATE);
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).not.toContain("text of Q");
    }
  });

  it("sends a reader who is not on the list to /open on their next request, never invited or just removed", async () => {
    const { docId, host, owner: publisher } = await privateDoc();
    const alice = await reader("alice@acme.com");
    const cookie = await cookieFor({ docId, owner: publisher }, alice);
    const read = () => get(`${host}/d/${docId}`, { headers: { cookie } }, PRIVATE);

    const refused = await read();
    expect(refused.status).toBe(302);
    expect(refused.headers.get("location")).toBe(`${API}/open/${docId}`);

    await env.DB.prepare("INSERT INTO doc_invites (doc_id, email, created_at) VALUES (?, 'alice@acme.com', ?)")
      .bind(docId, Date.now())
      .run();
    expect((await read()).status).toBe(200);

    // The grant cookie is still valid for an hour; the list is what changed.
    await env.DB.prepare("DELETE FROM doc_invites WHERE doc_id = ?").bind(docId).run();
    const removed = await read();
    expect(removed.status).toBe(302);
    expect(removed.headers.get("location")).toBe(`${API}/open/${docId}`);
    expect(await removed.text()).toBe("");
  });

  it("answers 410 for a deleted document and sends a document switched to anyone to its public url", async () => {
    const gone = await privateDoc("withdrawn");
    const opened = await privateDoc("opened up");
    const cookie = await cookieFor(gone, gone.owner);

    await softDelete(gone.docId);
    expect((await get(`${gone.host}/d/${gone.docId}`, { headers: { cookie } }, PRIVATE)).status).toBe(410);

    await env.DB.prepare("UPDATE docs SET link_access = 'anyone' WHERE id = ?").bind(opened.docId).run();
    const redirected = await get(`${opened.host}/d/${opened.docId}/v1`, { headers: { cookie } }, PRIVATE);
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe(`https://openartifacts.site/d/${opened.docId}/v1`);
  });

  it("carries the isolation headers on every response a publisher's origin gives, a 500 included", async () => {
    const doc = await privateDoc();
    const cookie = await cookieFor(doc, doc.owner);
    const broken = { ...PRIVATE, DB: { prepare: () => { throw new Error("boom"); } } as unknown as D1Database };

    const responses = [
      await get(await grantFor(doc, doc.owner), {}, PRIVATE), // 303, the grant swap
      await get(`${doc.host}/d/${doc.docId}`, { headers: { cookie } }, PRIVATE), // 200
      await get(`${doc.host}/d/${doc.docId}`, {}, PRIVATE), // 302, to sign in
      await get(`${doc.host}/d/${UNKNOWN_DOC_ID}`, { headers: { cookie } }, PRIVATE), // 404
      await get(`${doc.host}/elsewhere`, {}, PRIVATE), // 404
      await send("POST", `${doc.host}/d/${doc.docId}`, {}, PRIVATE), // 404
      await get(`${doc.host}/d/${doc.docId}`, { headers: { cookie } }, broken), // 500
    ];
    expect(responses.map((response) => response.status)).toEqual([303, 200, 302, 404, 404, 404, 500]);
    for (const response of responses) {
      for (const [name, value] of Object.entries(ISOLATION)) expect(response.headers.get(name)).toBe(value);
    }
    expect((await get(`${doc.host}/health`, {}, PRIVATE)).status).toBe(404);
  });

  it("mints /open's grant for the label of the document's own owner, not the reader's account", async () => {
    const doc = await privateDoc();
    const alice = await reader("alice@acme.com");
    // Alice's account is the same owner as the license key that published the document.
    expect(await linkExternalOwner(env.DB, doc.owner, alice, Date.now())).toBe("linked");
    const session = await signPayload(PRIVATE.READER_SESSION_SECRET, "session", { a: alice }, Date.now() + 60_000);

    const opened = await get(`${API}/open/${doc.docId}`, { headers: { cookie: `__Host-oa_session=${session}` } }, PRIVATE);

    expect(opened.status).toBe(302);
    const target = new URL(opened.headers.get("location")!);
    expect(target.origin).toBe(doc.host);
    expect(target.origin).not.toBe(`https://${await originLabel(alice)}.openartifacts.site`);
    expect(target.pathname).toBe(`/d/${doc.docId}`);
    expect((await get(target.toString(), {}, PRIVATE)).status).toBe(303);
  });

  it("answers 404 to everything private when reader sign-in is not configured, and never serves the bytes", async () => {
    const doc = await privateDoc();
    const cookie = await cookieFor(doc, doc.owner);
    const noMethod = { ...PRIVATE, OAUTH_GITHUB_CLIENT_ID: "", OAUTH_GITHUB_CLIENT_SECRET: "", EMAIL: undefined };

    for (const over of [
      { ...PRIVATE, READER_SESSION_SECRET: undefined },
      { ...PRIVATE, READER_SESSION_SECRET: "short" },
      noMethod,
    ]) {
      expect(readerSignInConfigured({ ...env, ...over } as Env)).toBe(false);
      // The publisher's origin and the reader pages are not there.
      expect((await get(`${doc.host}/d/${doc.docId}`, { headers: { cookie } }, over)).status).toBe(404);
      const open = await get(`${API}/open/${doc.docId}`, {}, over);
      expect(open.status).toBe(404);
      expect(open.headers.get("cache-control")).toBe("no-store");
      expect((await send("POST", `${API}/signin/out`, { body: new URLSearchParams({ next: `/open/${doc.docId}` }) }, over)).status).toBe(404);
      // The stored mode is not undone: the canonical url still sends the reader to /open, which 404s.
      const apex = await get(`https://openartifacts.site/d/${doc.docId}`, {}, over);
      expect(apex.status).toBe(302);
      expect(apex.headers.get("location")).toBe(`${API}/open/${doc.docId}`);
      expect(await apex.text()).not.toContain("for invited eyes");
    }
    // With no API host there is nowhere to send them: a plain 404, never the bytes.
    const noApi = await get(`https://openartifacts.site/d/${doc.docId}`, {}, { ...PRIVATE, API_HOST: "" });
    expect(noApi.status).toBe(404);
    expect(await noApi.text()).not.toContain("for invited eyes");
  });

  it("is configured only with a secret, both hosts and at least one sign-in method", () => {
    const configured = (over: Partial<Env>) => readerSignInConfigured({ ...env, ...PRIVATE, EMAIL: undefined, ...over } as Env);
    expect(configured({})).toBe(true);
    expect(configured({ OAUTH_GITHUB_CLIENT_SECRET: "" })).toBe(false); // half a pair is no provider
    expect(configured({ OAUTH_GITHUB_CLIENT_SECRET: "", OAUTH_GOOGLE_CLIENT_ID: "g", OAUTH_GOOGLE_CLIENT_SECRET: "s" })).toBe(true);
    const mail = { EMAIL: { send: async () => undefined }, EMAIL_FROM: "share@mail.openartifacts.ai" };
    expect(configured({ OAUTH_GITHUB_CLIENT_ID: "", ...mail })).toBe(true);
    expect(configured({ OAUTH_GITHUB_CLIENT_ID: "", ...mail, EMAIL_FROM: " " })).toBe(false);
    expect(configured({ READER_SESSION_SECRET: "k".repeat(31) })).toBe(false);
    expect(configured({ SERVING_HOST: "" })).toBe(false);
    expect(configured({ API_HOST: " " })).toBe(false);
  });

  it("names a publisher's origin by a one-way hash of docs.owner, the same for all of their documents", async () => {
    const labels = await Promise.all(["account-a", "account-b", "user_123"].map(originLabel));
    expect(new Set(labels).size).toBe(3);
    for (const label of labels) expect(label).toMatch(PRIVATE_LABEL);
    expect(await originLabel("account-a")).toBe(labels[0]);

    const one = await privateDoc("one");
    const two = await privateDoc("two");
    expect(one.docId).not.toBe(two.docId);
    expect(one.host).toBe(two.host);
    expect(one.host).toBe(`https://${await originLabel(one.owner)}.openartifacts.site`);
    expect(one.host).not.toContain(one.docId);
    expect(one.host).not.toContain(one.owner);
  });
});
