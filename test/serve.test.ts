import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import { PAGE_SCRIPT } from "../src/embed-scripts.js";
import { DOC_ID_LENGTH } from "../src/ids.js";
import { newAccountId } from "../src/ids.js";
import { linkExternalOwner } from "../src/owners.js";
import { grantUrl, originLabel, PRIVATE_LABEL } from "../src/private.js";
import { readerSignInConfigured } from "../src/reader-config.js";
import { signPayload, verifyPayload } from "../src/session.js";
import { FAVICON_LINK, NOINDEX_META, OPENARTIFACTS_FOOTER, OPENARTIFACTS_HEADER, OPENARTIFACTS_MARK_SVG } from "../src/render.js";
import { OPENARTIFACTS_BAR_SPACER, OPENARTIFACTS_BAR_STYLE } from "../src/render.js";
import { SHARE_TOKEN_PREFIX } from "../src/ids.js";
import { putEmbedHandoff, takeEmbedHandoff } from "../src/db.js";
import { FRAME_SCRIPT, POPUP_DONE_SCRIPT } from "../src/embed-scripts.js";
import { COMMENTS_FRAME_CSS, COMMENTS_FRAME_SCRIPT, PAGE_COMMENTS_SCRIPT } from "../src/comments-scripts.js";
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
    new Request(`${ORIGIN}${path}`, { method, ...init }),
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
    // With no reader sign-in there is no bar, so no comments switch in the validator either.
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

/**
 * `send` for the private tests: they address absolute urls, the apex, the API
 * host and a publisher's own label host, where the rest of this file stays on
 * one relative origin. A relative path still resolves against ORIGIN.
 */
async function sendTo(
  method: string,
  target: string,
  init: RequestInit = {},
  overrides: Partial<Env> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(target.startsWith("https://") ? target : `${ORIGIN}${target}`, { method, ...init }),
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
  const body = await response.arrayBuffer();
  return new Response(BODILESS.has(response.status) ? null : body, {
    status: response.status,
    headers: response.headers,
  });
}

const getFrom = (target: string, init?: RequestInit, overrides?: Partial<Env>) =>
  sendTo("GET", target, init, overrides);

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
    const response = await sendTo("POST", "/api/v1/docs", {
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
    const swapped = await getFrom(await grantFor(doc, principal), {}, PRIVATE);
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
      const response = await getFrom(`https://openartifacts.site/d/${docId}${suffix}`, {}, PRIVATE);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`https://api.openartifacts.ai/open/${docId}${suffix}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toBe("");
    }
  });

  it("swaps a grant for a cookie on its publisher's origin, then serves the page private and uncacheable", async () => {
    const doc = await privateDoc();

    const swapped = await getFrom(await grantFor(doc, doc.owner), {}, PRIVATE);
    expect(swapped.status).toBe(303);
    expect(swapped.headers.get("location")).toBe(`/d/${doc.docId}`);
    expect(await swapped.text()).toBe("");
    const cookie = swapped.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-oa_grant=.+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=3600$/);

    const served = await getFrom(`${doc.host}/d/${doc.docId}`, { headers: { cookie: cookie.split(";")[0]! } }, PRIVATE);
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("private, no-store");
    expect(served.headers.get("set-cookie")).toBeNull();
    expect(await served.text()).toContain("for invited eyes");

    // A pinned version is private too: the immutable lifetime a public /v{n}
    // gets must never reach an invited-only document.
    const pinned = await getFrom(`${doc.host}/d/${doc.docId}/v1`, { headers: { cookie: cookie.split(";")[0]! } }, PRIVATE);
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get("cache-control")).toBe("private, no-store");
    expect(pinned.headers.get("cache-control")).not.toContain("immutable");
    expect(await pinned.text()).toContain("for invited eyes");

    // With no cookie the same url sends the reader to sign in rather than serving.
    const anonymous = await getFrom(`${doc.host}/d/${doc.docId}`, {}, PRIVATE);
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toBe(`${API}/open/${doc.docId}`);
  });

  it("sends a signed-in reader who follows /open for a document that is now public to its public url", async () => {
    const doc = await privateDoc();
    // Alice is not on the list: public wins before the invite list is consulted.
    const alice = await reader("alice@acme.com");
    await env.DB.prepare("UPDATE docs SET link_access = 'anyone' WHERE id = ?").bind(doc.docId).run();

    for (const suffix of ["", "/v1"]) {
      const response = await getFrom(`${API}/open/${doc.docId}${suffix}`, { headers: { cookie: await sessionFor(alice) } }, PRIVATE);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`https://openartifacts.site/d/${doc.docId}${suffix}`);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("lets a grant, a grant cookie and a session expire, at the lifetimes the design gives", async () => {
    const doc = await privateDoc();
    const label = await originLabel(doc.owner);
    const SECRET_K = PRIVATE.READER_SESSION_SECRET;
    const signIn = `${API}/open/${doc.docId}`;

    // An expired URL grant is refused before any read: sent to sign in, no cookie.
    const expiredUrl = await signPayload(SECRET_K, "grant-url", { l: label, p: doc.owner }, Date.now() - 1);
    const refusedUrl = await getFrom(`${doc.host}/d/${doc.docId}?grant=${expiredUrl}`, {}, PRIVATE);
    expect(refusedUrl.status).toBe(302);
    expect(refusedUrl.headers.get("location")).toBe(signIn);
    expect(refusedUrl.headers.get("set-cookie")).toBeNull();

    // A fresh one of the same shape is accepted, so the refusal above is the expiry.
    const freshUrl = await signPayload(SECRET_K, "grant-url", { l: label, p: doc.owner }, Date.now() + 60_000);
    expect((await getFrom(`${doc.host}/d/${doc.docId}?grant=${freshUrl}`, {}, PRIVATE)).status).toBe(303);

    // An expired cookie grant is no credential: the page is not served.
    const expiredCookie = await signPayload(SECRET_K, "grant-cookie", { l: label, p: doc.owner }, Date.now() - 1);
    const refusedCookie = await getFrom(`${doc.host}/d/${doc.docId}`, { headers: { cookie: `__Host-oa_grant=${expiredCookie}` } }, PRIVATE);
    expect(refusedCookie.status).toBe(302);
    expect(refusedCookie.headers.get("location")).toBe(signIn);
    expect(await refusedCookie.text()).not.toContain("for invited eyes");

    // An expired session at /open is signed out: the sign-in page, not a redirect or the page.
    const alice = await reader("alice@acme.com", doc.docId);
    const expiredSession = await signPayload(SECRET_K, "session", { a: alice }, Date.now() - 1);
    const signedOut = await getFrom(signIn, { headers: { cookie: `__Host-oa_session=${expiredSession}` } }, PRIVATE);
    expect(signedOut.status).toBe(200);
    expect(await signedOut.text()).toContain("Sign in or create an account to open this document");

    // The minted grant lives 60 seconds, the cookie an hour, the session thirty days.
    const before = Date.now();
    const minted = await grantUrl({ ...env, ...PRIVATE }, doc.owner, { docId: doc.docId, pinned: null }, doc.owner, before);
    expect(minted!.expiresAt).toBe(before + 60_000);
    const grant = new URL(minted!.url).searchParams.get("grant");
    expect(await verifyPayload(SECRET_K, "grant-url", grant, before + 59_999)).not.toBeNull();
    expect(await verifyPayload(SECRET_K, "grant-url", grant, before + 60_001)).toBeNull();

    const swapped = await getFrom(minted!.url, {}, PRIVATE);
    const held = swapped.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    const cookieGrant = await verifyPayload(SECRET_K, "grant-cookie", held, Date.now());
    expect(cookieGrant).not.toBeNull();
    expect(cookieGrant!.exp).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(cookieGrant!.exp).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
    expect(await verifyPayload(SECRET_K, "grant-cookie", held, Date.now() + 61 * 60_000)).toBeNull();

    // Whatever a value is signed for, an exp that has passed (or is exactly now) is refused.
    const lapsed = await signPayload(SECRET_K, "session", { a: alice }, 1_000);
    expect(await verifyPayload(SECRET_K, "session", lapsed, 1_000)).toBeNull();
    expect(await verifyPayload(SECRET_K, "session", lapsed, 999)).not.toBeNull();
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
      const served = await getFrom(`${doc.host}/d/${doc.docId}`, { headers: { cookie } }, PRIVATE);
      expect(served.status).toBe(200);
      expect(served.headers.get("cache-control")).toBe("private, no-store");
      expect(await served.text()).toContain(text);
    }

    // Not on that document's list: sent to the one not-available page, never shown it.
    const refused = await getFrom(`${third.host}/d/${third.docId}`, { headers: { cookie } }, PRIVATE);
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
      getFrom(`${q.host}/d/${q.docId}?grant=${grantP}`, {}, PRIVATE),
      getFrom(`${q.host}/d/${p.docId}?grant=${grantP}`, {}, PRIVATE),
      getFrom(`${q.host}/d/${q.docId}`, { headers: { cookie: cookieP } }, PRIVATE),
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
      const response = await getFrom(`${p.host}/d/${docId}`, { headers: { cookie: cookieP } }, PRIVATE);
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).not.toContain("text of Q");
    }
  });

  it("sends a reader who is not on the list to /open on their next request, never invited or just removed", async () => {
    const { docId, host, owner: publisher } = await privateDoc();
    const alice = await reader("alice@acme.com");
    const cookie = await cookieFor({ docId, owner: publisher }, alice);
    const read = () => getFrom(`${host}/d/${docId}`, { headers: { cookie } }, PRIVATE);

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
    expect((await getFrom(`${gone.host}/d/${gone.docId}`, { headers: { cookie } }, PRIVATE)).status).toBe(410);

    await env.DB.prepare("UPDATE docs SET link_access = 'anyone' WHERE id = ?").bind(opened.docId).run();
    const redirected = await getFrom(`${opened.host}/d/${opened.docId}/v1`, { headers: { cookie } }, PRIVATE);
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe(`https://openartifacts.site/d/${opened.docId}/v1`);
  });

  it("carries the isolation headers on every response a publisher's origin gives, a 500 included", async () => {
    const doc = await privateDoc();
    const cookie = await cookieFor(doc, doc.owner);
    const broken = { ...PRIVATE, DB: { prepare: () => { throw new Error("boom"); } } as unknown as D1Database };

    const responses = [
      await getFrom(await grantFor(doc, doc.owner), {}, PRIVATE), // 303, the grant swap
      await getFrom(`${doc.host}/d/${doc.docId}`, { headers: { cookie } }, PRIVATE), // 200
      await getFrom(`${doc.host}/d/${doc.docId}`, {}, PRIVATE), // 302, to sign in
      await getFrom(`${doc.host}/d/${UNKNOWN_DOC_ID}`, { headers: { cookie } }, PRIVATE), // 404
      await getFrom(`${doc.host}/elsewhere`, {}, PRIVATE), // 404
      await sendTo("POST", `${doc.host}/d/${doc.docId}`, {}, PRIVATE), // 404
      await getFrom(`${doc.host}/d/${doc.docId}`, { headers: { cookie } }, broken), // 500
    ];
    expect(responses.map((response) => response.status)).toEqual([303, 200, 302, 404, 404, 404, 500]);
    for (const response of responses) {
      for (const [name, value] of Object.entries(ISOLATION)) expect(response.headers.get(name)).toBe(value);
    }
    expect((await getFrom(`${doc.host}/health`, {}, PRIVATE)).status).toBe(404);
  });

  it("mints /open's grant for the label of the document's own owner, not the reader's account", async () => {
    const doc = await privateDoc();
    const alice = await reader("alice@acme.com");
    // Alice's account is the same owner as the license key that published the document.
    expect(await linkExternalOwner(env.DB, doc.owner, alice, Date.now())).toBe("linked");
    const session = await signPayload(PRIVATE.READER_SESSION_SECRET, "session", { a: alice }, Date.now() + 60_000);

    const opened = await getFrom(`${API}/open/${doc.docId}`, { headers: { cookie: `__Host-oa_session=${session}` } }, PRIVATE);

    expect(opened.status).toBe(302);
    const target = new URL(opened.headers.get("location")!);
    expect(target.origin).toBe(doc.host);
    expect(target.origin).not.toBe(`https://${await originLabel(alice)}.openartifacts.site`);
    expect(target.pathname).toBe(`/d/${doc.docId}`);
    expect((await getFrom(target.toString(), {}, PRIVATE)).status).toBe(303);
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
      expect((await getFrom(`${doc.host}/d/${doc.docId}`, { headers: { cookie } }, over)).status).toBe(404);
      const open = await getFrom(`${API}/open/${doc.docId}`, {}, over);
      expect(open.status).toBe(404);
      expect(open.headers.get("cache-control")).toBe("no-store");
      expect((await sendTo("POST", `${API}/signin/out`, { body: new URLSearchParams({ next: `/open/${doc.docId}` }) }, over)).status).toBe(404);
      // The stored mode is not undone: the canonical url still sends the reader to /open, which 404s.
      const apex = await getFrom(`https://openartifacts.site/d/${doc.docId}`, {}, over);
      expect(apex.status).toBe(302);
      expect(apex.headers.get("location")).toBe(`${API}/open/${doc.docId}`);
      expect(await apex.text()).not.toContain("for invited eyes");
    }
    // With no API host there is nowhere to send them: a plain 404, never the bytes.
    const noApi = await getFrom(`https://openartifacts.site/d/${doc.docId}`, {}, { ...PRIVATE, API_HOST: "" });
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

  // ---- Stage S3: sign-in first, requesting access, the top bar and the share page ----

  const SECRET = PRIVATE.READER_SESSION_SECRET;

  /** The session cookie a browser holds after signing in as `accountId`. */
  const sessionFor = async (accountId: string) =>
    `__Host-oa_session=${await signPayload(SECRET, "session", { a: accountId }, Date.now() + 60_000)}`;

  /** An Email Service stub that keeps what it was asked to send. */
  function mailbox() {
    const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
    const over = {
      ...PRIVATE,
      EMAIL: { send: async (message: (typeof sent)[number]) => void sent.push(message) },
      EMAIL_FROM: "share@mail.openartifacts.ai",
    } as Partial<Env>;
    return { sent, over };
  }

  /** The owner's own browser account: its license-key documents are in its owner scope. */
  async function ownerAccount(doc: { owner: string }, plan = "pro"): Promise<string> {
    const id = await reader("owner@acme.com");
    expect(await linkExternalOwner(env.DB, doc.owner, id, Date.now())).toBe("linked");
    await env.DB.prepare("UPDATE accounts SET plan = ?, plan_checked_at = ? WHERE id = ?")
      .bind(plan, Date.now(), id)
      .run();
    return id;
  }

  const requestRows = async (docId: string) =>
    (
      await env.DB.prepare("SELECT email, created_at FROM doc_access_requests WHERE doc_id = ? ORDER BY email")
        .bind(docId)
        .all<{ email: string; created_at: number }>()
    ).results;

  const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };
  const occurrences = (html: string, needle: string) => html.split(needle).length - 1;

  it("shows the sign-in page, and names no address or title, to a reader with no session", async () => {
    const doc = await privateDoc("for invited eyes");
    await reader("alice@acme.com", doc.docId);

    const response = await getFrom(`${API}/open/${doc.docId}`, {}, PRIVATE);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("Sign in or create an account to open this document");
    expect(html).toContain("Sign in with GitHub");
    expect(html).not.toContain("@");
    expect(html).not.toContain("Secret");
    expect(html).not.toContain("alice");
    expect(html).not.toContain(doc.owner);
  });

  it("measures revocation: a removed reader reaches /open and gets the not-available page with the request form", async () => {
    const doc = await privateDoc();
    const alice = await reader("alice@acme.com", doc.docId);
    const cookie = await cookieFor(doc, alice);
    const read = () => getFrom(`${doc.host}/d/${doc.docId}`, { headers: { cookie } }, PRIVATE);
    expect((await read()).status).toBe(200);

    await env.DB.prepare("DELETE FROM doc_invites WHERE doc_id = ?").bind(doc.docId).run();
    const redirected = await read();
    expect(redirected.status).toBe(302);

    const opened = await getFrom(redirected.headers.get("location")!, { headers: { cookie: await sessionFor(alice) } }, PRIVATE);
    expect(opened.status).toBe(404);
    const html = await opened.text();
    expect(html).toContain("This document isn't available to <b><bdi>alice@acme.com</bdi></b>");
    expect(html).toContain("If you were invited with another address, sign in with that address. Otherwise you can ask the owner.");
    expect(html).toContain(`<form method="post" action="/open/${doc.docId}/request">`);
    expect(html).toContain("Request access");
    expect(html).toContain("Use another account");
    expect(html).not.toContain("Secret");
    // The same page for a document that never existed, button included.
    const unknown = await (await getFrom(`${API}/open/${UNKNOWN_DOC_ID}`, { headers: { cookie: await sessionFor(alice) } }, PRIVATE)).text();
    expect(unknown.replaceAll(UNKNOWN_DOC_ID, "ID")).toBe(html.replaceAll(doc.docId, "ID"));
  });

  it("gives every API-host reader response the same opener policy, so an opener cannot tell allowed from refused", async () => {
    const doc = await privateDoc();
    const anyone = await privateDoc("public", KEY, "anyone");
    const owner = await ownerAccount(doc);
    const alice = await reader("alice@acme.com", doc.docId);
    const bob = await reader("bob@other.com");
    const as = async (accountId: string) => ({ headers: { cookie: await sessionFor(accountId) } });
    const asSameOrigin = async (accountId: string) => ({ headers: { cookie: await sessionFor(accountId), ...SAME_ORIGIN } });
    const shareUrl = `${API}/share/${doc.docId}`;

    const responses: Record<string, Response> = {
      "sign-in page": await getFrom(`${API}/open/${doc.docId}`, {}, PRIVATE),
      "not available": await getFrom(`${API}/open/${doc.docId}`, await as(bob), PRIVATE),
      "invited reader": await getFrom(`${API}/open/${doc.docId}`, await as(alice), PRIVATE),
      "anyone doc": await getFrom(`${API}/open/${anyone.docId}`, await as(bob), PRIVATE),
      "request sent": await sendTo("POST", `${API}/open/${doc.docId}/request`, await asSameOrigin(bob), PRIVATE),
      "sign out": await sendTo(
        "POST",
        `${API}/signin/out`,
        { ...(await asSameOrigin(bob)), body: new URLSearchParams({ next: `/open/${doc.docId}` }) },
        PRIVATE,
      ),
      "share, no session": await getFrom(shareUrl, {}, PRIVATE),
      "share, owner": await getFrom(shareUrl, await as(owner), PRIVATE),
      "share, non-owner": await getFrom(shareUrl, await as(bob), PRIVATE),
      "share, link write": await sendTo(
        "POST",
        shareUrl,
        { ...(await asSameOrigin(owner)), body: new URLSearchParams({ op: "link", linkAccess: "anyone" }) },
        PRIVATE,
      ),
      "no reader sign-in": await getFrom(`${API}/open/${doc.docId}`, {}, { ...PRIVATE, READER_SESSION_SECRET: undefined }),
    };

    // The statuses show the outcomes really differ, which is what an opener must not see.
    expect(Object.fromEntries(Object.entries(responses).map(([name, response]) => [name, response.status]))).toEqual({
      "sign-in page": 200,
      "not available": 404,
      "invited reader": 302,
      "anyone doc": 302,
      "request sent": 200,
      "sign out": 303,
      "share, no session": 200,
      "share, owner": 200,
      "share, non-owner": 404,
      "share, link write": 303,
      "no reader sign-in": 404,
    });
    for (const [name, response] of Object.entries(responses)) {
      expect([name, response.headers.get("cross-origin-opener-policy")]).toEqual([name, "same-origin"]);
    }

    // The label host keeps its own policy.
    const swapped = await getFrom(await grantFor(doc, doc.owner), {}, PRIVATE);
    expect(swapped.headers.get("cross-origin-opener-policy")).toBe(ISOLATION["cross-origin-opener-policy"]);
  });

  describe("POST /open/{docId}/request", () => {
    const API_OPEN = (docId: string) => `${API}/open/${docId}/request`;
    const post = async (docId: string, accountId: string, over: Partial<Env> = PRIVATE, headers: Record<string, string> = SAME_ORIGIN) =>
      sendTo("POST", API_OPEN(docId), { headers: { cookie: await sessionFor(accountId), ...headers } }, over);

    it("stores one row, nothing on a repeat or for an id that cannot be requested, and answers one page every time", async () => {
      const doc = await privateDoc();
      const publicDoc = await privateDoc("a public page", KEY, "anyone");
      const deleted = await privateDoc("withdrawn");
      await softDelete(deleted.docId);
      const invitedDoc = await privateDoc("alice is in");
      const bob = await reader("bob@other.com");
      const alice = await reader("alice@acme.com", invitedDoc.docId);

      const first = await post(doc.docId, bob);
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(first.headers.get("referrer-policy")).toBe("same-origin");
      const rows = await requestRows(doc.docId);
      expect(rows.map((row) => row.email)).toEqual(["bob@other.com"]);

      const repeat = await post(doc.docId, bob);
      expect(await requestRows(doc.docId)).toEqual(rows);

      const bytes = async (response: Response, docId: string) => (await response.text()).replaceAll(docId, "ID");
      const expected = await bytes(first, doc.docId);
      expect(expected).toContain("Request sent");
      expect(expected).toContain("The owner will decide. If they approve, you'll get an email at <b><bdi>bob@other.com</bdi></b> with the link.");
      expect(await bytes(repeat, doc.docId)).toBe(expected);

      const others: Array<[string, string]> = [
        [UNKNOWN_DOC_ID, bob],
        [publicDoc.docId, bob],
        [deleted.docId, bob],
        [invitedDoc.docId, alice],
      ];
      for (const [docId, account] of others) {
        const response = await post(docId, account);
        expect(response.status).toBe(200);
        expect(await bytes(response, docId)).toBe(account === alice ? (await bytes(await post(docId, alice), docId)) : expected);
        expect(await requestRows(docId)).toEqual([]);
      }
      // Alice, already allowed, sees her own address in the same words.
      expect(await (await post(invitedDoc.docId, alice)).text()).toContain("alice@acme.com");
    });

    it("says what will happen instead when the server cannot send email", async () => {
      const doc = await privateDoc();
      const bob = await reader("bob@other.com");
      const response = await post(doc.docId, bob, { ...PRIVATE, EMAIL: undefined });
      expect(await response.text()).toContain("The owner will decide. If they approve, the link will open for <b><bdi>bob@other.com</bdi></b>.");
      expect((await requestRows(doc.docId)).length).toBe(1);
    });

    it("rejects a request made from another site, and stores nothing", async () => {
      const doc = await privateDoc();
      const bob = await reader("bob@other.com");

      const foreign: Array<Record<string, string>> = [
        { "sec-fetch-site": "cross-site" },
        { "sec-fetch-site": "same-site" },
        { "sec-fetch-site": "none" },
        { origin: "https://evil.example" },
        // What a form posted from a no-referrer page sends in a browser without
        // Fetch Metadata. Refused, which is why the API host's pages are
        // same-origin: asserted below, so the policy cannot go back.
        { origin: "null" },
        {},
      ];
      for (const headers of foreign) {
        const response = await post(doc.docId, bob, PRIVATE, headers);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("Request sent");
      }
      expect(await requestRows(doc.docId)).toEqual([]);
      // A browser that sends no Fetch Metadata is held to its Origin.
      expect((await post(doc.docId, bob, PRIVATE, { origin: API })).status).toBe(200);
      expect((await requestRows(doc.docId)).length).toBe(1);
    });

    it("takes only a POST from a signed-in session, and sends the rest to sign in or to a 404", async () => {
      const doc = await privateDoc();
      const bob = await reader("bob@other.com");

      const anonymous = await sendTo("POST", API_OPEN(doc.docId), { headers: SAME_ORIGIN }, PRIVATE);
      expect(anonymous.status).toBe(200);
      const html = await anonymous.text();
      expect(html).toContain("Sign in or create an account to open this document");
      expect(html).toContain(`value="/open/${doc.docId}"`);
      expect(html).not.toContain("request");

      const forged = await sendTo("POST", API_OPEN(doc.docId), { headers: { ...SAME_ORIGIN, cookie: "__Host-oa_session=forged.value" } }, PRIVATE);
      expect(await forged.text()).toContain("Sign in or create an account");

      for (const method of ["GET", "PUT", "DELETE"]) {
        expect((await sendTo(method, API_OPEN(doc.docId), { headers: { cookie: await sessionFor(bob) } }, PRIVATE)).status).toBe(404);
      }
      expect((await sendTo("POST", `${API}/open/${doc.docId}/v1/request`, { headers: SAME_ORIGIN }, PRIVATE)).status).toBe(404);
      expect(await requestRows(doc.docId)).toEqual([]);
    });

    it("stops storing past 100 pending requests, still answering Request sent", async () => {
      const doc = await privateDoc();
      for (let n = 0; n < 100; n += 1) {
        await env.DB.prepare("INSERT INTO doc_access_requests (doc_id, email, created_at) VALUES (?, ?, ?)")
          .bind(doc.docId, `person${n}@acme.com`, Date.now())
          .run();
      }
      const bob = await reader("bob@other.com");

      const response = await post(doc.docId, bob);

      expect(await response.text()).toContain("Request sent");
      expect((await requestRows(doc.docId)).length).toBe(100);
    });

    it("stores nothing once the account is over its allowance, and still answers Request sent", async () => {
      const bob = await reader("bob@other.com");
      const docs = [await privateDoc("one"), await privateDoc("two")];
      // The allowance is 10 a minute per account: ten requests for the first document are one row and nine repeats.
      for (let n = 0; n < 10; n += 1) await post(docs[0]!.docId, bob);
      expect((await requestRows(docs[0]!.docId)).length).toBe(1);

      const limited = await post(docs[1]!.docId, bob);

      expect(limited.status).toBe(200);
      expect(await limited.text()).toContain("Request sent");
      expect(await requestRows(docs[1]!.docId)).toEqual([]);
    });

    it("emails the owner once, with the share page link and no token, and never tells the requester who they are", async () => {
      const { sent, over } = mailbox();
      const doc = await privateDoc();
      await ownerAccount(doc);
      const bob = await reader("bob@other.com");

      const response = await post(doc.docId, bob, over);
      await post(doc.docId, bob, over);

      expect(sent).toHaveLength(1);
      const [message] = sent;
      expect(message!.to).toBe("owner@acme.com");
      expect(message!.subject).toBe('bob@other.com asked to open "Secret"');
      const link = `https://api.openartifacts.ai/share/${doc.docId}`;
      for (const body of [message!.text, message!.html]) {
        expect(body).toContain(link);
        expect(body).toContain("Nothing has been shared yet.");
        expect(body).toContain("bob@other.com");
        expect(body).not.toMatch(/grant|token|session|signed/i);
        expect(body.match(/https?:\/\/[^\s"<]+/g)).toEqual([link]);
      }
      expect(message!.html).toContain("Review request");
      expect(await response.text()).not.toContain("owner@acme.com");
    });

    it("sends no email when the owner's address is unknown, but still lists the request", async () => {
      const { sent, over } = mailbox();
      const doc = await privateDoc(); // owned by a license key nobody linked
      const bob = await reader("bob@other.com");

      await post(doc.docId, bob, over);

      expect(sent).toEqual([]);
      expect((await requestRows(doc.docId)).length).toBe(1);
    });

    it("is not there at all on a server with no reader sign-in", async () => {
      const doc = await privateDoc();
      const bob = await reader("bob@other.com");
      expect((await post(doc.docId, bob, { ...PRIVATE, READER_SESSION_SECRET: undefined })).status).toBe(404);
      expect(await requestRows(doc.docId)).toEqual([]);
    });
  });

  describe("the top bar", () => {
    const shareLink = (docId: string) => `data-openartifacts-share href="https://api.openartifacts.ai/share/${docId}"`;
    const SCRIPT_TAG = '<script defer src="https://api.openartifacts.ai/embed/page.js"></script>';
    const MARKER = '<style id="openartifacts-obsidian-publish-baseline"></style>';

    /** A Copilot-marked public page, so the byline text has somewhere to go. */
    async function markedPublicDoc(): Promise<string> {
      const response = await sendTo("POST", "/api/v1/docs", {
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "Marked", html: page("<p>a public page</p>").replace("</head>", `${MARKER}</head>`) }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { docId: string }).docId;
    }

    it("S1: is on public, pinned and private pages exactly once, with Share pointing at the share page", async () => {
      const publicDoc = await privateDoc("a public page", KEY, "anyone");
      const doc = await privateDoc("for invited eyes");
      const cookie = await cookieFor(doc, doc.owner);

      const open = await getFrom(`https://openartifacts.site/d/${publicDoc.docId}`, {}, PRIVATE);
      const pinned = await getFrom(`https://openartifacts.site/d/${publicDoc.docId}/v1`, {}, PRIVATE);
      const closed = await getFrom(`${doc.host}/d/${doc.docId}`, { headers: { cookie } }, PRIVATE);

      expect(open.headers.get("cache-control")).toBe("public, max-age=60");
      expect(pinned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(closed.headers.get("cache-control")).toBe("private, no-store");
      expect(open.headers.get("set-cookie")).toBeNull();
      expect(pinned.headers.get("set-cookie")).toBeNull();

      for (const [response, docId] of [[open, publicDoc.docId], [pinned, publicDoc.docId], [closed, doc.docId]] as const) {
        const html = await response.text();
        expect(occurrences(html, OPENARTIFACTS_BAR_SPACER)).toBe(1);
        expect(occurrences(html, 'class="openartifacts-bar"')).toBe(1);
        expect(occurrences(html, shareLink(docId))).toBe(1);
        expect(occurrences(html, SCRIPT_TAG)).toBe(1);
        expect(occurrences(html, OPENARTIFACTS_BAR_STYLE)).toBe(1);
        // The footer is unchanged and keeps the link smoke.sh looks for; the Manage link is gone.
        expect(html).toContain(OPENARTIFACTS_FOOTER);
        expect(html).not.toContain(">Manage</a>");
        expect(html).not.toContain("openartifacts-manage");
      }
      expect(await (await getFrom(`${doc.host}/d/${doc.docId}`, { headers: { cookie } }, PRIVATE)).text()).toContain("for invited eyes");
    });

    // The page script asks the threads resource only when the bar does not say the
    // document has comments off, so the switch rides on the shared link.
    it("S2: the shared link carries the comments switch, a pinned page carries none, and a flip is a 200 on revalidation", async () => {
      const publicDoc = await privateDoc("a public page", KEY, "anyone");
      const url = `https://openartifacts.site/d/${publicDoc.docId}`;
      const flag = async (response: Response) => /data-comments="(on|off)"/.exec(await response.text())?.[1] ?? null;

      const off = await getFrom(url, {}, PRIVATE);
      expect(await flag(off)).toBe("off");
      expect(off.headers.get("etag")).toMatch(/\.r\d+\.c0"$/);
      expect(await flag(await getFrom(`${url}/v1`, {}, PRIVATE))).toBeNull();
      const pinnedTag = (await getFrom(`${url}/v1`, {}, PRIVATE)).headers.get("etag")!;
      expect(pinnedTag).not.toMatch(/\.c[01]"$/);

      // Unchanged, the same tag is a 304 on GET and HEAD.
      for (const method of ["GET", "HEAD"]) {
        const same = await getFrom(url, { method, headers: { "if-none-match": off.headers.get("etag")! } }, PRIVATE);
        expect(same.status).toBe(304);
      }

      await env.DB.prepare("UPDATE docs SET comments_enabled = 1 WHERE id = ?").bind(publicDoc.docId).run();

      for (const method of ["GET", "HEAD"]) {
        const flipped = await getFrom(url, { method, headers: { "if-none-match": off.headers.get("etag")! } }, PRIVATE);
        expect(flipped.status).toBe(200);
        expect(flipped.headers.get("etag")).toMatch(/\.r\d+\.c1"$/);
        if (method === "GET") expect(await flag(flipped)).toBe("on");
      }
      // The pinned page is untouched by the flip, and still answers 304.
      expect((await getFrom(`${url}/v1`, { headers: { "if-none-match": pinnedTag } }, PRIVATE)).status).toBe(304);
    });

    it("S3: an invited-only page carries the switch on its latest rendering and none on a pinned one", async () => {
      const doc = await privateDoc("for invited eyes");
      const cookie = await cookieFor(doc, doc.owner);
      const latest = await getFrom(`${doc.host}/d/${doc.docId}`, { headers: { cookie } }, PRIVATE);
      expect(await latest.text()).toContain('data-comments="off"');
      const pinned = await getFrom(`${doc.host}/d/${doc.docId}/v1`, { headers: { cookie } }, PRIVATE);
      expect(await pinned.text()).not.toContain("data-comments");
    });

    it("S1: replaces the header byline with the bar, keeping the byline text smoke.sh looks for", async () => {
      const docId = await markedPublicDoc();

      const html = await (await getFrom(`https://openartifacts.site/d/${docId}`, {}, PRIVATE)).text();

      expect(html).not.toContain(OPENARTIFACTS_HEADER);
      expect(occurrences(html, "Copilot for Obsidian</span>")).toBe(1);
      expect(html).toContain(`<body>${OPENARTIFACTS_BAR_SPACER}`);
    });

    it("S2: is absent on a server with no reader sign-in, which keeps the header byline and changes nothing else", async () => {
      const docId = await markedPublicDoc();

      for (const over of [{ ...PRIVATE, READER_SESSION_SECRET: undefined }, { ...PRIVATE, OAUTH_GITHUB_CLIENT_ID: "", EMAIL: undefined }, { ...PRIVATE, API_HOST: "" }]) {
        const html = await (await getFrom(`https://openartifacts.site/d/${docId}`, {}, over)).text();
        // No bar, so the comments switch is not in the bytes and not in the validator.
        const etag = (await getFrom(`https://openartifacts.site/d/${docId}`, {}, over)).headers.get("etag");
        expect(etag).not.toMatch(/\.c[01]"$/);
        expect(html).toContain(OPENARTIFACTS_HEADER);
        expect(html).toContain(OPENARTIFACTS_FOOTER);
        expect(html).not.toContain("openartifacts-bar");
        expect(html).not.toContain("scroll-padding");
        expect(html).not.toContain("/embed/page.js");
        expect(html).not.toContain("/share/");
      }
    });
  });

  describe("the page script", () => {
    const SCRIPT = "https://api.openartifacts.ai/embed/page.js";
    const etagOf = async () => `"${(await sha256Hex(PAGE_SCRIPT)).slice(0, 32)}"`;

    it("S3: is the constant script, cached by the browser for an hour, with the headers that make it safe to load cross-site", async () => {
      const response = await getFrom(SCRIPT, {}, PRIVATE);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(PAGE_SCRIPT);
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
      expect(response.headers.get("cache-control")).toBe("public, max-age=3600, stale-while-revalidate=86400");
      expect(response.headers.get("etag")).toBe(await etagOf());
      expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("S3: answers a matching validator, weak or not, with a bodiless 304", async () => {
      const etag = await etagOf();

      for (const sent of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
        const response = await getFrom(SCRIPT, { headers: { "if-none-match": sent } }, PRIVATE);
        expect(response.status).toBe(304);
        expect(await response.text()).toBe("");
        expect(response.headers.get("etag")).toBe(etag);
        expect(response.headers.get("cache-control")).toBe("public, max-age=3600, stale-while-revalidate=86400");
      }
      const stale = await getFrom(SCRIPT, { headers: { "if-none-match": '"0123"' } }, PRIVATE);
      expect(stale.status).toBe(200);
      expect(await stale.text()).toBe(PAGE_SCRIPT);
    });

    it("S3: answers HEAD with the headers and no body, and every other method as not found", async () => {
      const head = await sendTo("HEAD", SCRIPT, {}, PRIVATE);
      expect(head.status).toBe(200);
      expect(head.headers.get("etag")).toBe(await etagOf());
      expect(head.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(await head.text()).toBe("");

      for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
        const response = await sendTo(method, SCRIPT, {}, PRIVATE);
        expect(response.status).toBe(404);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      }
    });

    it("S3: exists on the API host only", async () => {
      const doc = await privateDoc();

      expect((await getFrom("https://openartifacts.site/embed/page.js", {}, PRIVATE)).status).toBe(404);
      expect((await getFrom(`${doc.host}/embed/page.js`, {}, PRIVATE)).status).toBe(404);
      expect((await getFrom("https://api.openartifacts.ai/embed/other.js", {}, PRIVATE)).status).toBe(404);
      expect((await getFrom("https://api.openartifacts.ai/embed", {}, PRIVATE)).status).toBe(404);
    });

    it("S8: is not there at all on a server with no reader sign-in", async () => {
      for (const over of [{ ...PRIVATE, READER_SESSION_SECRET: undefined }, { ...PRIVATE, OAUTH_GITHUB_CLIENT_ID: "", EMAIL: undefined }, { ...PRIVATE, API_HOST: "" }]) {
        const response = await getFrom(SCRIPT, {}, over);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toBe(PAGE_SCRIPT);
        expect(response.headers.get("etag")).toBeNull();
      }
    });
  });

  describe("the Share popover", () => {
    /** S5–S8 pass with these limiters off: their counters live in the runtime and every test request shares one anonymous bucket. */
    const OPEN = { ...PRIVATE, APPROVAL_LOOKUP_LIMITER: undefined, EMBED_TOKEN_LIMITER: undefined } satisfies Partial<Env>;
    const frameUrl = (docId: string, origin?: string) =>
      `${API}/embed/share?doc=${docId}${origin === undefined ? "" : `&origin=${encodeURIComponent(origin)}`}`;
    const APEX = "https://openartifacts.site";

    const hashOf = async (script: string) =>
      btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)))));
    const inlineScript = (html: string) => /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;

    const newNonce = () =>
      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");

    const popupUrl = (docId: string, h: string, query = "") => `${API}/embed/sign-in?doc=${docId}&h=${h}${query}`;
    const popup = (docId: string, h: string, headers: Record<string, string>, query = "", over: Partial<Env> = OPEN) =>
      getFrom(popupUrl(docId, h, query), { headers }, over);
    const claim = (body: unknown, over: Partial<Env> = OPEN, headers: Record<string, string> = SAME_ORIGIN) =>
      sendTo("POST", `${API}/embed/token`, { headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }, over);
    const bindingName = (h: string) => `__Host-oa_embed_${h.slice(0, 16)}`;

    /** A per-document token, minted directly the way the claim route does. */
    const tokenFor = async (accountId: string, docId: string, exp = Date.now() + 60_000, purpose: "share-token" | "session" = "share-token") =>
      SHARE_TOKEN_PREFIX + (await signPayload(SECRET, purpose, { a: accountId, d: docId }, exp));
    const embedApi = (path: string, token: string | null, init: RequestInit = {}, over: Partial<Env> = OPEN) =>
      sendTo(init.method ?? "GET", `${API}/embed/api/docs/${path}`, { ...init, headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(init.headers as Record<string, string> | undefined) } }, over);
    const json = (value: unknown): RequestInit => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

    it("S4: serves the same frame for every id, framed only by the document's own serving origin", async () => {
      const publicDoc = await privateDoc("a public page", KEY, "anyone");
      const doc = await privateDoc("for invited eyes");
      const other = await privateDoc("text of Q", KEY_Q);
      const gone = await privateDoc("withdrawn");
      await softDelete(gone.docId);
      const label = new URL(doc.host).origin;

      const cases: Array<[string, string | undefined, string]> = [
        [publicDoc.docId, APEX, APEX],
        [publicDoc.docId, other.host, "'none'"],
        [doc.docId, doc.host, label],
        [doc.docId, APEX, "'none'"],
        [doc.docId, other.host, "'none'"],
        [doc.docId, undefined, "'none'"],
        [doc.docId, doc.host.toUpperCase().replace("HTTPS", "https"), label],
        [gone.docId, APEX, "'none'"],
        [UNKNOWN_DOC_ID, APEX, "'none'"],
      ];
      for (const [docId, origin, ancestors] of cases) {
        const response = await getFrom(frameUrl(docId, origin), {}, OPEN);
        expect(response.status, `${docId} ${origin}`).toBe(200);
        const csp = response.headers.get("content-security-policy")!;
        expect(csp, `${docId} ${origin}`).toContain(`frame-ancestors ${ancestors}`);
        const html = await response.text();
        expect(csp).toContain(`script-src 'sha256-${await hashOf(inlineScript(html))}'`);
        expect(csp).toContain("connect-src 'self'");
        expect(csp).toContain("default-src 'none'");
        expect(response.headers.get("x-frame-options")).toBeNull();
        expect(response.headers.get("referrer-policy")).toBe("same-origin");
        expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(html).not.toContain("Secret");
        expect(html).not.toContain("data-title");
        expect(html).not.toContain("title=");
        expect(html).toContain("Sign in to manage");
        expect(html).toContain("<h1 id=\"oa-title\">Share</h1>");
        expect(html).toContain(`data-link="https://openartifacts.site/d/${docId}"`);
      }

      // Nothing but the doc id and the origin the caller named reaches the body.
      const body = async (docId: string, origin?: string, mark?: string) => {
        const html = await (await getFrom(frameUrl(docId, origin), {}, OPEN)).text();
        const same = html.replaceAll(docId, "ID");
        return mark === undefined ? same : same.replace(`data-origin="${mark}"`, 'data-origin="ORIGIN"');
      };
      expect(await body(publicDoc.docId, APEX, APEX)).toBe(await body(doc.docId, doc.host, label));
      const refused = [await body(doc.docId, APEX), await body(gone.docId, APEX), await body(UNKNOWN_DOC_ID, APEX), await body(doc.docId)];
      expect(new Set(refused).size).toBe(1);
      expect(refused[0]).toContain('data-origin=""');

      // The script is the constant, sends exactly one kind of message call, and reports no size.
      const html = await (await getFrom(frameUrl(doc.docId, doc.host), {}, OPEN)).text();
      expect(inlineScript(html)).toBe(FRAME_SCRIPT);
      expect(occurrences(FRAME_SCRIPT, "postMessage(")).toBe(1);
      expect(FRAME_SCRIPT).not.toContain("ResizeObserver");
      expect(FRAME_SCRIPT).not.toContain('"size"');
      expect(FRAME_SCRIPT).not.toContain("autofocus");
      // A focusable element carries no id, in the shell or in the views the script draws.
      // <main> counts: it scrolls, and a scroller takes focus when its content overflows.
      expect(html).not.toMatch(/<(?:main|button|a|input)\b[^>]*\sid=/);
      expect(FRAME_SCRIPT).not.toContain("oa-close");

      // Not a frame for a malformed id, a missing one or any other method.
      expect((await getFrom(frameUrl("nope"), {}, OPEN)).status).toBe(404);
      expect((await getFrom(`${API}/embed/share`, {}, OPEN)).status).toBe(404);
      expect((await sendTo("POST", frameUrl(doc.docId), {}, OPEN)).status).toBe(404);
      expect((await getFrom(`${doc.host}/embed/share?doc=${doc.docId}`, {}, OPEN)).status).toBe(404);
    });

    it("S5: signs the popup in from a session, hands the frame its token once, and refuses a popup our frame did not open", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      const session = await sessionFor(owner);
      const nonce = newNonce();
      const h = await sha256Hex(nonce);
      const rowFor = (docId: string, hash: string) =>
        env.DB.prepare("SELECT account_id, expires_at FROM embed_handoffs WHERE doc_id = ? AND h = ?")
          .bind(docId, hash)
          .first<{ account_id: string; expires_at: number }>();

      // A session and a request our frame made: the done page, the row, a cleared binding.
      const done = await popup(doc.docId, h, { cookie: session, "sec-fetch-site": "same-origin" });
      expect(done.status).toBe(200);
      expect(done.headers.get("cache-control")).toBe("no-store");
      expect(done.headers.get("referrer-policy")).toBe("same-origin");
      expect(done.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(done.headers.get("set-cookie")).toBe(`${bindingName(h)}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
      const csp = done.headers.get("content-security-policy")!;
      expect(csp).toContain("frame-ancestors 'none'");
      const page = await done.text();
      expect(page).toContain("Signed in.");
      // One inline script, and the policy admits exactly that one.
      expect(occurrences(page, "<script")).toBe(1);
      expect(csp).toContain(`script-src 'sha256-${await hashOf(inlineScript(page))}'`);
      expect(inlineScript(page)).toBe(POPUP_DONE_SCRIPT);
      expect(inlineScript(page)).toContain("location.origin");
      expect(inlineScript(page)).not.toContain('"*"');
      // The page also carries the token, and it is this account's for this document.
      const carried = /data-token="([^"]+)"/.exec(page)![1]!;
      expect(carried.startsWith("oas_")).toBe(true);
      expect(await verifyPayload(SECRET, "share-token", carried.slice(4), Date.now())).toMatchObject({ a: owner, d: doc.docId });
      expect(await verifyPayload(SECRET, "session", carried.slice(4), Date.now())).toBeNull();
      expect(page).toContain(`data-doc="${doc.docId}"`);

      const row = await rowFor(doc.docId, h);
      expect(row!.account_id).toBe(owner);
      expect(Math.abs(row!.expires_at - (Date.now() + 60_000))).toBeLessThan(30_000);

      // The claim: the token for that account and document, about a day, and once only.
      const claimed = await claim({ doc: doc.docId, nonce });
      expect(claimed.status).toBe(200);
      expect(claimed.headers.get("cache-control")).toBe("no-store");
      expect(claimed.headers.get("set-cookie")).toBeNull();
      const { token, expiresAt } = (await claimed.json()) as { token: string; expiresAt: number };
      expect(token.startsWith("oas_")).toBe(true);
      const payload = await verifyPayload(SECRET, "share-token", token.slice(4), Date.now());
      expect(payload).toMatchObject({ a: owner, d: doc.docId });
      expect(Math.abs(expiresAt - (Date.now() + 24 * 60 * 60 * 1000))).toBeLessThan(60_000);
      expect(payload!.exp).toBe(expiresAt);
      expect((await claim({ doc: doc.docId, nonce })).status).toBe(404);
      expect(await rowFor(doc.docId, h)).toBeNull();

      // Not opened by our frame: cross-site, none, or no Fetch Metadata at all.
      for (const headers of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "none" }, { "sec-fetch-site": "same-site" }, {}] as Array<Record<string, string>>) {
        const n = newNonce();
        const hash = await sha256Hex(n);
        const refused = await popup(doc.docId, hash, { cookie: session, ...headers });
        expect(refused.status).toBe(400);
        const text = await refused.text();
        expect(text).toContain("Start from the page.");
        expect(text).toContain(`<a href="/share/${doc.docId}">Open the share page</a>`);
        expect(refused.headers.get("set-cookie")).toBeNull();
        expect(await rowFor(doc.docId, hash)).toBeNull();
        expect((await claim({ doc: doc.docId, nonce: n })).status).toBe(404);
      }

      // No session: the manage sign-in page, returning here, with a binding cookie.
      const fresh = newNonce();
      const hFresh = await sha256Hex(fresh);
      const signIn = await popup(doc.docId, hFresh, { "sec-fetch-site": "same-origin" });
      expect(signIn.status).toBe(200);
      const html = await signIn.text();
      expect(html).toContain("Sign in to manage this document");
      expect(html).toContain(`name="next" value="/embed/sign-in?doc=${doc.docId}&amp;h=${hFresh}"`);
      const binding = signIn.headers.get("set-cookie")!;
      expect(binding).toMatch(new RegExp(`^${bindingName(hFresh)}=.+; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600$`));
      expect(await rowFor(doc.docId, hFresh)).toBeNull();
      expect((await claim({ doc: doc.docId, nonce: fresh })).status).toBe(404);

      // The return from a provider is cross-site; the binding cookie is what lets it through.
      const returned = await popup(doc.docId, hFresh, { cookie: `${session}; ${binding.split(";")[0]}`, "sec-fetch-site": "cross-site" });
      expect(returned.status).toBe(200);
      expect(await returned.text()).toContain("Signed in.");
      expect((await claim({ doc: doc.docId, nonce: fresh })).status).toBe(200);

      // Two popups open at once keep two bindings, and each return finds its own.
      const [n1, n2] = [newNonce(), newNonce()];
      const [h1, h2] = [await sha256Hex(n1), await sha256Hex(n2)];
      const cookies = [
        (await popup(doc.docId, h1, { "sec-fetch-site": "same-origin" })).headers.get("set-cookie")!.split(";")[0]!,
        (await popup(doc.docId, h2, { "sec-fetch-site": "same-origin" })).headers.get("set-cookie")!.split(";")[0]!,
      ];
      expect(cookies[0]!.split("=")[0]).not.toBe(cookies[1]!.split("=")[0]);
      for (const [hash, nonceOf] of [[h1, n1], [h2, n2]] as const) {
        const back = await popup(doc.docId, hash, { cookie: `${session}; ${cookies.join("; ")}`, "sec-fetch-site": "cross-site" });
        expect(back.status).toBe(200);
        expect((await claim({ doc: doc.docId, nonce: nonceOf })).status).toBe(200);
      }

      // A binding for another handshake, or another document, is no binding.
      const stranger = newNonce();
      const hStranger = await sha256Hex(stranger);
      const wrong = await popup(doc.docId, hStranger, { cookie: `${session}; ${cookies[0]}`, "sec-fetch-site": "cross-site" });
      expect(wrong.status).toBe(400);
      const otherDoc = await privateDoc("another");
      const wrongDoc = await popup(otherDoc.docId, h1, { cookie: `${session}; ${cookies[0]}`, "sec-fetch-site": "cross-site" });
      expect(wrongDoc.status).toBe(400);
      // A binding signed for a different purpose is no binding either.
      const forged = `${bindingName(hStranger)}=${await signPayload(SECRET, "login", { d: doc.docId, h: hStranger }, Date.now() + 60_000)}`;
      expect((await popup(doc.docId, hStranger, { cookie: `${session}; ${forged}`, "sec-fetch-site": "cross-site" })).status).toBe(400);

      // Use another account: the sign-in page even with a session, and nothing stored.
      const switching = newNonce();
      const hSwitch = await sha256Hex(switching);
      const asked = await popup(doc.docId, hSwitch, { cookie: session, "sec-fetch-site": "same-origin" }, "&switch=1");
      expect(await asked.text()).toContain("Sign in to manage this document");
      expect(await rowFor(doc.docId, hSwitch)).toBeNull();

      // A malformed popup address is not a page.
      for (const bad of [`${API}/embed/sign-in?doc=${doc.docId}&h=${h.slice(1)}`, `${API}/embed/sign-in?doc=${doc.docId}&h=${h.toUpperCase()}`, `${API}/embed/sign-in?h=${h}`, `${API}/embed/sign-in?doc=nope&h=${h}`]) {
        expect((await getFrom(bad, { headers: { cookie: session, ...SAME_ORIGIN } }, OPEN)).status).toBe(404);
      }
    });

    it("S5: claims only with the right nonce for the right document, within a minute, and limits the polling", async () => {
      const doc = await privateDoc();
      const other = await privateDoc("another");
      const owner = await ownerAccount(doc);
      const nonce = newNonce();
      const h = await sha256Hex(nonce);
      const T = Date.now();

      // The row lives a minute and one use, with the time passed explicitly.
      await putEmbedHandoff(env.DB, doc.docId, h, owner, T);
      expect(await takeEmbedHandoff(env.DB, doc.docId, h, T + 60_001)).toBeNull();
      await putEmbedHandoff(env.DB, doc.docId, h, owner, T);
      expect(await takeEmbedHandoff(env.DB, other.docId, h, T + 1_000)).toBeNull();
      expect(await takeEmbedHandoff(env.DB, doc.docId, h, T + 59_000)).toBe(owner);
      expect(await takeEmbedHandoff(env.DB, doc.docId, h, T + 59_000)).toBeNull();

      // Wrong nonce, other document, an expired row and a row nobody wrote all look alike.
      await putEmbedHandoff(env.DB, doc.docId, h, owner, T);
      for (const body of [
        { doc: doc.docId, nonce: newNonce() },
        { doc: other.docId, nonce },
      ]) {
        const response = await claim(body);
        expect(response.status).toBe(404);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
      }
      await env.DB.prepare("UPDATE embed_handoffs SET expires_at = ? WHERE h = ?").bind(Date.now() - 1, h).run();
      expect((await claim({ doc: doc.docId, nonce })).status).toBe(404);

      // What is not a claim at all.
      expect((await claim("not json")).status).toBe(400);
      expect((await claim({ doc: doc.docId, nonce: "short" })).status).toBe(400);
      expect((await claim({ doc: "nope", nonce })).status).toBe(400);
      expect((await claim({ doc: doc.docId, nonce, extra: 1 })).status).toBe(400);
      expect((await claim([doc.docId, nonce])).status).toBe(400);
      expect((await claim("x".repeat(2000))).status).toBe(400);
      expect((await sendTo("POST", `${API}/embed/token`, { headers: { "content-type": "text/plain", ...SAME_ORIGIN }, body: JSON.stringify({ doc: doc.docId, nonce }) }, OPEN)).status).toBe(400);
      expect((await claim({ doc: doc.docId, nonce }, OPEN, { "sec-fetch-site": "cross-site" })).status).toBe(404);
      expect((await claim({ doc: doc.docId, nonce }, OPEN, { origin: "https://evil.example" })).status).toBe(404);
      expect((await getFrom(`${API}/embed/token`, {}, OPEN)).status).toBe(404);

      // A claim from a client that has used its allowance is told to slow down, and takes nothing.
      await putEmbedHandoff(env.DB, doc.docId, h, owner, Date.now());
      const refusing = { limit: async () => ({ success: false }) } as unknown as RateLimit;
      const limited = await claim({ doc: doc.docId, nonce }, { ...OPEN, EMBED_TOKEN_LIMITER: refusing });
      expect(limited.status).toBe(400);
      expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("slow_down");
      expect((await claim({ doc: doc.docId, nonce })).status).toBe(200);

      // The popup's own mint is limited per client too, and stores nothing when refused.
      const n = newNonce();
      const hMint = await sha256Hex(n);
      const tooMany = await popup(doc.docId, hMint, { cookie: await sessionFor(owner), "sec-fetch-site": "same-origin" }, "", { ...OPEN, APPROVAL_LOOKUP_LIMITER: refusing });
      expect(tooMany.status).toBe(429);
      expect((await claim({ doc: doc.docId, nonce: n })).status).toBe(404);
    });

    it("leaves `comments` out of the popover's owner view where the comments object is not bound, so it draws no switch", async () => {
      const doc = await privateDoc("for invited eyes");
      const owner = await ownerAccount(doc);
      const token = await tokenFor(owner, doc.docId);

      const bound = (await (await embedApi(`${doc.docId}/access`, token)).json()) as Record<string, unknown>;
      expect(typeof bound.comments).toBe("boolean");
      const unbound = (await (await embedApi(`${doc.docId}/access`, token, {}, { ...OPEN, COMMENTS: undefined })).json()) as Record<string, unknown>;
      expect("comments" in unbound).toBe(false);
      expect(unbound.viewer).toBe("owner");
    });

    it("S6: refuses the popover token everywhere but its own document's frame routes", async () => {
      const a = await privateDoc("for invited eyes");
      const b = await privateDoc("a second page");
      const owner = await ownerAccount(a);
      const token = await tokenFor(owner, a.docId);

      expect((await embedApi(`${a.docId}/access`, token)).status).toBe(200);
      // Another document's routes.
      expect((await embedApi(`${b.docId}/access`, token)).status).toBe(401);

      // Not an API credential: refused before the license path, never stored.
      const api = await getFrom(`${API}/api/v1/docs/${a.docId}/access`, { headers: { authorization: `Bearer ${token}` } }, PRIVATE);
      expect(api.status).toBe(401);
      expect(((await api.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
      const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM publishers WHERE key_hash = ?").bind(await sha256Hex(token)).first<{ n: number }>();
      expect(stored!.n).toBe(0);
      expect((await getFrom(`${API}/api/v1/docs`, { headers: { authorization: `Bearer ${token}` } }, PRIVATE)).status).toBe(401);

      // Not a session, not a grant.
      const share = await getFrom(`${API}/share/${a.docId}`, { headers: { authorization: `Bearer ${token}` } }, PRIVATE);
      expect(await share.text()).toContain("Sign in to manage this document");
      const label = await getFrom(`${a.host}/d/${a.docId}`, { headers: { authorization: `Bearer ${token}` } }, PRIVATE);
      expect(label.status).toBe(302);
      expect(label.headers.get("location")).toBe(`${API}/open/${a.docId}`);
      const open = await getFrom(`${API}/open/${a.docId}`, { headers: { authorization: `Bearer ${token}`, cookie: `__Host-oa_session=${token}` } }, PRIVATE);
      expect(await open.text()).toContain("Sign in or create an account to open this document");

      // What else is not a popover token.
      const bare = token.slice(4);
      const signed = (purpose: "session" | "grant-url" | "login") => signPayload(SECRET, purpose, { a: owner, d: a.docId }, Date.now() + 60_000);
      for (const bad of [
        bare,
        KEY,
        "oat_" + bare,
        await tokenFor(owner, a.docId, Date.now() + 60_000, "session"),
        (await signed("session")),
        "oas_" + (await signed("session")),
        "oas_" + (await signed("grant-url")),
        "oas_" + (await signed("login")),
        await tokenFor(owner, a.docId, Date.now() - 1),
        await tokenFor(newAccountId(), a.docId),
        await tokenFor("", a.docId),
        token + "x",
        "oas_",
      ]) {
        const response = await embedApi(`${a.docId}/access`, bad);
        expect(response.status, bad.slice(0, 12)).toBe(401);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
      }
      expect((await embedApi(`${a.docId}/access`, null)).status).toBe(401);
      // And another secret's signature.
      const foreign = SHARE_TOKEN_PREFIX + (await signPayload("z".repeat(32), "share-token", { a: owner, d: a.docId }, Date.now() + 60_000));
      expect((await embedApi(`${a.docId}/access`, foreign)).status).toBe(401);
    });

    it("S7: shows an owner the controls, a reader the title, a stranger nothing, and writes through the same operations as /api/v1", async () => {
      const { sent, over } = mailbox();
      const config = { ...over, APPROVAL_LOOKUP_LIMITER: undefined, EMBED_TOKEN_LIMITER: undefined } as Partial<Env>;
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      const invitee = await reader("alice@acme.com", doc.docId);
      const stranger = await reader("mallory@evil.example");
      await env.DB.prepare("INSERT INTO doc_access_requests (doc_id, email, created_at) VALUES (?, 'bob@other.com', ?)").bind(doc.docId, Date.now()).run();

      const mine = await embedApi(`${doc.docId}/access`, await tokenFor(owner, doc.docId), {}, config);
      expect(mine.status).toBe(200);
      expect(mine.headers.get("cache-control")).toBe("no-store");
      expect(await mine.json()).toMatchObject({
        viewer: "owner",
        account: "owner@acme.com",
        title: "Secret",
        docId: doc.docId,
        url: `https://openartifacts.site/d/${doc.docId}`,
        linkAccess: "invited",
        email: true,
        people: [{ email: "alice@acme.com", role: "comment" }],
        requests: [{ email: "bob@other.com" }],
      });

      const seen = await embedApi(`${doc.docId}/access`, await tokenFor(invitee, doc.docId), {}, config);
      expect(seen.status).toBe(200);
      expect(await seen.json()).toEqual({
        viewer: "reader",
        account: "alice@acme.com",
        docId: doc.docId,
        url: `https://openartifacts.site/d/${doc.docId}`,
        title: "Secret",
      });
      const nobody = await embedApi(`${doc.docId}/access`, await tokenFor(stranger, doc.docId), {}, config);
      expect(nobody.status).toBe(404);
      expect(await nobody.text()).not.toContain("Secret");
      // Writes by someone who cannot manage are the same 404, never a 403.
      for (const [method, path] of [["PUT", "/people/x@acme.com"], ["DELETE", "/people/alice@acme.com"], ["DELETE", "/requests/bob@other.com"]] as const) {
        const denied = await embedApi(`${doc.docId}/access${path}`, await tokenFor(invitee, doc.docId), { method }, config);
        expect(denied.status).toBe(404);
      }
      expect((await embedApi(`${doc.docId}/access`, await tokenFor(invitee, doc.docId), { method: "PUT", ...json({ linkAccess: "anyone" }) }, config)).status).toBe(404);

      // A deleted or unknown document is a 404 to the owner too.
      expect((await embedApi(`${UNKNOWN_DOC_ID}/access`, await tokenFor(owner, UNKNOWN_DOC_ID), {}, config)).status).toBe(404);

      // An owner on a public document: switch it private, and the API sees it.
      const publicDoc = await privateDoc("a public page", KEY, "anyone");
      const token = await tokenFor(owner, publicDoc.docId);
      const switched = await embedApi(`${publicDoc.docId}/access`, token, { method: "PUT", ...json({ linkAccess: "invited" }) }, config);
      expect(switched.status).toBe(200);
      expect(((await switched.json()) as { linkAccess: string }).linkAccess).toBe("invited");
      const viaApi = await getFrom(`${API}/api/v1/docs/${publicDoc.docId}/access`, { headers: { authorization: `Bearer ${KEY}` } }, PRIVATE);
      expect(((await viaApi.json()) as { linkAccess: string }).linkAccess).toBe("invited");
      expect((await embedApi(`${publicDoc.docId}/access`, token, { method: "PUT", ...json({ linkAccess: "sideways" }) }, config)).status).toBe(400);
      expect((await embedApi(`${publicDoc.docId}/access`, token, { method: "PUT", ...json({}) }, config)).status).toBe(400);

      // Adding a person sends the one invite; declining sends nothing.
      const added = await embedApi(`${publicDoc.docId}/access/people/alice%40acme.com`, token, { method: "PUT" }, config);
      expect(added.status).toBe(200);
      expect(((await added.json()) as { people: Array<{ email: string }> }).people.map((p) => p.email)).toEqual(["alice@acme.com"]);
      expect(sent.map((m) => m.to)).toEqual(["alice@acme.com"]);
      await env.DB.prepare("INSERT INTO doc_access_requests (doc_id, email, created_at) VALUES (?, 'carol@other.com', ?)").bind(publicDoc.docId, Date.now()).run();
      const declined = await embedApi(`${publicDoc.docId}/access/requests/carol@other.com`, token, { method: "DELETE" }, config);
      expect(((await declined.json()) as { requests: unknown[] }).requests).toEqual([]);
      expect(sent).toHaveLength(1);
      // The role select's body: the person's role moves, and anything else is a 400 that changes nothing.
      const roleOf = async (response: Response) => ((await response.json()) as { people: Array<{ role: string }> }).people[0]!.role;
      expect(await roleOf(await embedApi(`${publicDoc.docId}/access/people/alice@acme.com`, token, { method: "PUT", ...json({ role: "view" }) }, config))).toBe("view");
      expect(await roleOf(await embedApi(`${publicDoc.docId}/access/people/alice@acme.com`, token, { method: "PUT", ...json({ role: "comment" }) }, config))).toBe("comment");
      expect((await embedApi(`${publicDoc.docId}/access/people/alice@acme.com`, token, { method: "PUT", ...json({ role: "admin" }) }, config)).status).toBe(400);
      expect(sent).toHaveLength(1);
      const removed = await embedApi(`${publicDoc.docId}/access/people/alice@acme.com`, token, { method: "DELETE" }, config);
      expect(((await removed.json()) as { people: unknown[] }).people).toEqual([]);
      expect((await embedApi(`${publicDoc.docId}/access/people/not-an-address`, token, { method: "PUT" }, config)).status).toBe(400);

      // The plan gate is the API's: a free plan cannot make a public page private.
      const freeDoc = await privateDoc("a page of a free owner", KEY_Q, "anyone");
      const free = await reader("free@acme.com");
      expect(await linkExternalOwner(env.DB, freeDoc.owner, free, Date.now())).toBe("linked");
      await env.DB.prepare("UPDATE accounts SET plan = 'free', plan_checked_at = ? WHERE id = ?").bind(Date.now(), free).run();
      const refused = await embedApi(`${freeDoc.docId}/access`, await tokenFor(free, freeDoc.docId), { method: "PUT", ...json({ linkAccess: "invited" }) }, config);
      expect(refused.status).toBe(402);
      const refusal = (await refused.json()) as { error: { code: string; limit: string; upgrade_url?: string } };
      expect(refusal.error).toMatchObject({ code: "limit_reached", limit: "privateSharing" });
      expect(refusal.error.upgrade_url).toMatch(/^https:\/\//);
      expect(refused.headers.get("cache-control")).toBe("no-store");

      // No `/embed/` response is readable by another origin, whatever the method.
      for (const [method, target] of [
        ["GET", `${API}/embed/page.js`],
        ["OPTIONS", `${API}/embed/page.js`],
        ["GET", frameUrl(doc.docId, APEX)],
        ["OPTIONS", `${API}/embed/token`],
        ["POST", `${API}/embed/token`],
        ["GET", popupUrl(doc.docId, "0".repeat(64))],
        ["GET", `${API}/embed/api/docs/${doc.docId}/access`],
        ["OPTIONS", `${API}/embed/api/docs/${doc.docId}/access`],
        ["PUT", `${API}/embed/api/docs/${doc.docId}/access`],
        ["GET", `${API}/embed/nothing`],
      ] as const) {
        const response = await sendTo(method, target, { headers: { origin: "https://evil.example" } }, config);
        for (const [name] of response.headers) expect(name.startsWith("access-control-"), `${method} ${target} ${name}`).toBe(false);
      }
      expect((await sendTo("OPTIONS", `${API}/embed/api/docs/${doc.docId}/access`, {}, config)).status).toBe(404);
      expect((await embedApi(`${doc.docId}/access/people`, await tokenFor(owner, doc.docId), { method: "PUT" }, config)).status).toBe(404);
      expect((await embedApi(`${doc.docId}/access/extra/x`, await tokenFor(owner, doc.docId), {}, config)).status).toBe(404);
    });

    it("S7: says through `changed` whether a write changed the link access or the invite list", async () => {
      const { over } = mailbox();
      const config = { ...over, APPROVAL_LOOKUP_LIMITER: undefined, EMBED_TOKEN_LIMITER: undefined } as Partial<Env>;
      const doc = await privateDoc("a public page", KEY, "anyone");
      const owner = await ownerAccount(doc);
      const token = await tokenFor(owner, doc.docId);
      const changed = async (method: string, path: string, body?: unknown) => {
        const response = await embedApi(`${doc.docId}/access${path}`, token, { method, ...(body === undefined ? {} : json(body)) }, config);
        expect(response.status, `${method} ${path}`).toBe(200);
        return ((await response.json()) as { changed: boolean }).changed;
      };

      expect(await changed("GET", "")).toBe(false);
      // The first switch to invited-only is a change; the repeat of it is not.
      expect(await changed("PUT", "", { linkAccess: "invited" })).toBe(true);
      expect(await changed("PUT", "", { linkAccess: "invited" })).toBe(false);
      expect(await changed("GET", "")).toBe(false);
      // Adding an address is a change, adding it again is not.
      expect(await changed("PUT", "/people/alice%40acme.com")).toBe(true);
      expect(await changed("PUT", "/people/alice%40acme.com")).toBe(false);
      // A decline deletes the request and answers false: requests are not what `changed` reports.
      await env.DB.prepare("INSERT INTO doc_access_requests (doc_id, email, created_at) VALUES (?, 'carol@other.com', ?)").bind(doc.docId, Date.now()).run();
      expect(await changed("DELETE", "/requests/carol@other.com")).toBe(false);
      expect(await changed("DELETE", "/people/alice@acme.com")).toBe(true);
      expect(await changed("PUT", "", { linkAccess: "anyone" })).toBe(true);
      expect(await changed("PUT", "", { linkAccess: "anyone" })).toBe(false);
    });

    it("S8: is not there at all on a server with no reader sign-in", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      const token = await tokenFor(owner, doc.docId);
      const h = "a".repeat(64);
      for (const over of [{ ...PRIVATE, READER_SESSION_SECRET: undefined }, { ...PRIVATE, OAUTH_GITHUB_CLIENT_ID: "", EMAIL: undefined }, { ...PRIVATE, API_HOST: "" }]) {
        const requests: Array<Promise<Response>> = [
          getFrom(frameUrl(doc.docId, APEX), {}, over),
          getFrom(popupUrl(doc.docId, h), { headers: { cookie: await sessionFor(owner), ...SAME_ORIGIN } }, over),
          claim({ doc: doc.docId, nonce: newNonce() }, over),
          embedApi(`${doc.docId}/access`, token, {}, over),
        ];
        for (const response of await Promise.all(requests)) expect(response.status).toBe(404);
      }
    });
  });

  describe("the comments frame", () => {
    const OPEN = { ...PRIVATE, APPROVAL_LOOKUP_LIMITER: undefined, EMBED_TOKEN_LIMITER: undefined } satisfies Partial<Env>;
    const APEX = "https://openartifacts.site";
    const frameUrl = (docId: string, origin?: string, extra = "") =>
      `${API}/embed/comments?doc=${docId}${origin === undefined ? "" : `&origin=${encodeURIComponent(origin)}`}${extra}`;
    const hashOf = async (script: string) =>
      btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)))));
    const inlineScript = (html: string) => /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    it("C1: serves the same frame for every id, framed only by the document's own serving origin", async () => {
      const publicDoc = await privateDoc("a public page", KEY, "anyone");
      const doc = await privateDoc("for invited eyes");
      const other = await privateDoc("text of Q", KEY_Q);
      const gone = await privateDoc("withdrawn");
      await softDelete(gone.docId);
      const label = new URL(doc.host).origin;

      const cases: Array<[string, string | undefined, string]> = [
        [publicDoc.docId, APEX, APEX],
        [publicDoc.docId, other.host, "'none'"],
        [doc.docId, doc.host, label],
        [doc.docId, APEX, "'none'"],
        [doc.docId, other.host, "'none'"],
        [doc.docId, undefined, "'none'"],
        [doc.docId, doc.host.toUpperCase().replace("HTTPS", "https"), label],
        [gone.docId, APEX, "'none'"],
        [UNKNOWN_DOC_ID, APEX, "'none'"],
      ];
      for (const [docId, origin, ancestors] of cases) {
        const response = await getFrom(frameUrl(docId, origin), {}, OPEN);
        expect(response.status, `${docId} ${origin}`).toBe(200);
        const csp = response.headers.get("content-security-policy")!;
        expect(csp, `${docId} ${origin}`).toContain(`frame-ancestors ${ancestors}`);
        const html = await response.text();
        expect(csp).toBe(
          `default-src 'none'; script-src 'sha256-${await hashOf(inlineScript(html))}'; style-src 'unsafe-inline'; img-src data:; ` +
            `connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors}`,
        );
        expect(response.headers.get("x-frame-options")).toBeNull();
        expect(response.headers.get("referrer-policy")).toBe("same-origin");
        expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        // Nothing of the document, only its id and the origin the caller named.
        expect(html).not.toContain("for invited eyes");
        expect(html).not.toContain("a public page");
        expect(html).toContain(`data-doc="${docId}"`);
      }

      // The body is one shell: the id and the matched origin are the only differences.
      const body = async (docId: string, origin?: string, mark?: string) => {
        const html = (await (await getFrom(frameUrl(docId, origin), {}, OPEN)).text()).replaceAll(docId, "ID");
        return mark === undefined ? html : html.replace(`data-origin="${mark}"`, 'data-origin="ORIGIN"');
      };
      expect(await body(publicDoc.docId, APEX, APEX)).toBe(await body(doc.docId, doc.host, label));
      const refused = [await body(doc.docId, APEX), await body(gone.docId, APEX), await body(UNKNOWN_DOC_ID, APEX), await body(doc.docId)];
      expect(new Set(refused).size).toBe(1);
      expect(refused[0]).toContain('data-origin=""');

      // The query beyond the id and the origin (the pinned version) changes nothing in the shell.
      expect(await body(publicDoc.docId, APEX, APEX)).toBe(
        (await (await getFrom(frameUrl(publicDoc.docId, APEX, "&v=3"), {}, OPEN)).text()).replaceAll(publicDoc.docId, "ID").replace(`data-origin="${APEX}"`, 'data-origin="ORIGIN"'),
      );
    });

    it("C1: the shell is the constants, draws no id, and the script is written to the front-end rules", async () => {
      const doc = await privateDoc("for invited eyes");
      const html = await (await getFrom(frameUrl(doc.docId, doc.host), {}, OPEN)).text();
      expect(inlineScript(html)).toBe(COMMENTS_FRAME_SCRIPT);
      expect(html).toContain(`<style>${COMMENTS_FRAME_CSS}</style>`);
      expect(count(html, "<script")).toBe(1);
      // An element id is a fragment an embedding page can navigate the frame to: none in the shell or the script's views.
      expect(html).not.toMatch(/\sid=/);
      expect(COMMENTS_FRAME_SCRIPT).not.toMatch(/\bid:|"id"|getElementById/);
      // Comments are only ever text, and the confirm is drawn in the frame.
      expect(COMMENTS_FRAME_SCRIPT).not.toContain("innerHTML");
      expect(COMMENTS_FRAME_SCRIPT).not.toContain("confirm(");
      expect(COMMENTS_FRAME_SCRIPT).not.toContain("document.write");
      expect(COMMENTS_FRAME_SCRIPT).not.toContain("autofocus");
      // One `postMessage` call, to the parent, at the origin the shell names.
      expect(count(COMMENTS_FRAME_SCRIPT, "postMessage(")).toBe(1);
      expect(COMMENTS_FRAME_SCRIPT).toContain("parentOrigin");
      expect(COMMENTS_FRAME_SCRIPT).not.toContain('"*"');
      // Plain strings: no backtick, no interpolation, no backslash, in any script this adds.
      for (const script of [COMMENTS_FRAME_SCRIPT, PAGE_COMMENTS_SCRIPT, PAGE_SCRIPT]) {
        expect(script).not.toContain("`");
        expect(script).not.toContain("${");
        expect(script).not.toContain("\\");
      }
      // The page half is part of the one script every page loads.
      expect(PAGE_SCRIPT).toContain(PAGE_COMMENTS_SCRIPT);
    });

    it("C2: the page script's comment half is credential-free", () => {
      for (const word of ["localStorage", "sessionStorage", "document.cookie", "indexedDB", "authorization", "oas_"]) {
        expect(PAGE_COMMENTS_SCRIPT, word).not.toContain(word);
      }
      // It talks to the frame at the API origin only, never `*`, and takes messages only from that frame's window.
      expect(PAGE_COMMENTS_SCRIPT).not.toContain('"*"');
      expect(PAGE_COMMENTS_SCRIPT).toContain("event.source !== mframe.contentWindow || event.origin !== api");
    });

    it("C3: is not there without comments, without reader sign-in, for another method or on any other host", async () => {
      const doc = await privateDoc("for invited eyes", KEY, "anyone");
      expect((await getFrom(frameUrl(doc.docId, APEX), {}, OPEN)).status).toBe(200);

      expect((await getFrom(frameUrl(doc.docId, APEX), {}, { ...OPEN, COMMENTS: undefined })).status).toBe(404);
      for (const over of [{ ...OPEN, READER_SESSION_SECRET: undefined }, { ...OPEN, OAUTH_GITHUB_CLIENT_ID: "", EMAIL: undefined }, { ...OPEN, API_HOST: "" }]) {
        const response = await getFrom(frameUrl(doc.docId, APEX), {}, over);
        expect(response.status).toBe(404);
        expect(response.headers.get("content-security-policy") ?? "").not.toContain("script-src 'sha256-");
      }
      expect((await getFrom(`${API}/embed/comments`, {}, OPEN)).status).toBe(404);
      expect((await getFrom(frameUrl("nope"), {}, OPEN)).status).toBe(404);
      expect((await sendTo("POST", frameUrl(doc.docId, APEX), {}, OPEN)).status).toBe(404);
      expect((await sendTo("HEAD", frameUrl(doc.docId, APEX), {}, OPEN)).status).toBe(404);
      expect((await getFrom(`${APEX}/embed/comments?doc=${doc.docId}`, {}, OPEN)).status).toBe(404);
      expect((await getFrom(`${new URL((await privateDoc()).host).origin}/embed/comments?doc=${doc.docId}`, {}, OPEN)).status).toBe(404);
    });
  });

  describe("the share page", () => {
    const SHARE = (docId: string) => `${API}/share/${docId}`;
    const open = async (docId: string, accountId: string | null, over: Partial<Env> = PRIVATE, query = "") =>
      getFrom(`${SHARE(docId)}${query}`, accountId === null ? {} : { headers: { cookie: await sessionFor(accountId) } }, over);
    const write = async (docId: string, accountId: string, fields: Record<string, string>, over: Partial<Env> = PRIVATE, headers: Record<string, string> = SAME_ORIGIN) =>
      sendTo("POST", SHARE(docId), { headers: { cookie: await sessionFor(accountId), ...headers }, body: new URLSearchParams(fields) }, over);
    const access = async (docId: string) =>
      (await getFrom(`${API}/api/v1/docs/${docId}/access`, { headers: { authorization: `Bearer ${KEY}` } }, PRIVATE)).json<{
        linkAccess: string;
        people: Array<{ email: string }>;
        requests: Array<{ email: string }>;
      }>();

    it("shows the sign-in page to a reader with no session, to come back to the share page after", async () => {
      const doc = await privateDoc();

      const response = await open(doc.docId, null);

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Sign in to manage this document");
      expect(html).toContain("Sign in with the account that published it. New here? Signing in creates a free account.");
      expect(html).toContain(`name="next" value="/share/${doc.docId}"`);
      expect(html).not.toContain("Secret");
      expect(html).not.toContain("@");
    });

    it("shows the not-available page, with no title, to a signed-in non-owner, and the same one for an id that is not there", async () => {
      const doc = await privateDoc();
      const deleted = await privateDoc("gone");
      await softDelete(deleted.docId);
      const bob = await reader("bob@other.com"); // not invited: an invitee sees Copy link instead

      const responses = await Promise.all([open(doc.docId, bob), open(UNKNOWN_DOC_ID, bob), open(deleted.docId, bob)]);

      const pages: string[] = [];
      for (const [index, response] of responses.entries()) {
        expect(response.status).toBe(404);
        const html = await response.text();
        expect(html).toContain("This document isn't available to <b><bdi>bob@other.com</bdi></b>");
        expect(html).toContain("Request access");
        expect(html).not.toContain("Secret");
        pages.push(html.replaceAll([doc.docId, UNKNOWN_DOC_ID, deleted.docId][index]!, "ID"));
      }
      expect(new Set(pages).size).toBe(1);
      // "Use another account" comes back here, not to /open.
      expect(pages[0]).toContain('name="next" value="/share/ID"');
    });

    it("SP-b: shows readers only Copy link: a visitor to a public page, and an invitee with a session on a private one", async () => {
      const pub = await privateDoc("a public page", KEY, "anyone");
      const doc = await privateDoc();
      const bob = await reader("bob@other.com", doc.docId);
      const carol = await reader("carol@other.com"); // not invited, but the public page is open to her
      const hint = "Open the note in Copilot and run Publish file to OpenArtifacts";

      // A visitor to a public document: the title and link, an invitation to sign in to manage.
      const visitor = await open(pub.docId, null);
      expect(visitor.status).toBe(200);
      expect(visitor.headers.get("cache-control")).toBe("no-store");
      expect(visitor.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      const html = await visitor.text();
      expect(html).toContain("Share “Secret”");
      expect(html).toContain("Only the owner can change who can open this.");
      expect(html).toContain(`value="https://openartifacts.site/d/${pub.docId}"`);
      expect(html).toContain(`href="/share/${pub.docId}?signin"`);
      expect(html).toContain("Is this your page? Sign in to manage");
      for (const absent of ["Who has access", "Add people", "Link access", "Sign in or create", "Sign in to manage this document", hint, "Use another account"]) {
        expect(html, absent).not.toContain(absent);
      }
      expect(occurrences(html, "<script")).toBe(1);
      // The policy admits exactly the one inline script, by hash.
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
      const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)))));
      expect(visitor.headers.get("content-security-policy")).toContain(`script-src 'sha256-${digest}'`);

      // ?signin selects the manage sign-in page, and changes nothing.
      const signin = await (await open(pub.docId, null, PRIVATE, "?signin")).text();
      expect(signin).toContain("Sign in to manage this document");
      expect(signin).toContain(`name="next" value="/share/${pub.docId}"`);
      expect(signin).not.toContain("Secret");

      // Invited-only, unknown and deleted ids are one page for a visitor.
      const deleted = await privateDoc("gone", KEY, "anyone");
      await softDelete(deleted.docId);
      const pages = await Promise.all(
        [doc.docId, UNKNOWN_DOC_ID, deleted.docId].map(async (id) => (await (await open(id, null)).text()).replaceAll(id, "ID")),
      );
      expect(new Set(pages).size).toBe(1);
      expect(pages[0]).toContain("Sign in to manage this document");
      expect(pages[0]).not.toContain("Secret");

      // An invitee with a session on the private document, and any signed-in reader of a public one.
      for (const [account, id] of [[bob, doc.docId], [carol, pub.docId]] as const) {
        const reading = await open(id, account);
        expect(reading.status).toBe(200);
        const page = await reading.text();
        expect(page).toContain("Share “Secret”");
        expect(page).toContain("Only the owner can change who can open this.");
        expect(page).toContain(`value="https://openartifacts.site/d/${id}"`);
        expect(page).toContain("Use another account");
        expect(page).toContain(`name="next" value="/share/${id}?signin"`);
        expect(page).toContain(hint);
        for (const absent of ["Add people", "Who has access", "Link access", "Is this your page"]) {
          expect(page, absent).not.toContain(absent);
        }
      }

      // Use another account signs out and lands on the sign-in page, on a public
      // document as on an invited-only one, not on the visitor view.
      for (const id of [pub.docId, doc.docId]) {
        const out = await sendTo("POST", `${API}/signin/out`, { headers: SAME_ORIGIN, body: new URLSearchParams({ next: `/share/${id}?signin` }) }, PRIVATE);
        expect(out.status).toBe(303);
        expect(out.headers.get("location")).toBe(`/share/${id}?signin`);
        const landed = await (await open(id, null, PRIVATE, "?signin")).text();
        expect(landed, id).toContain("Sign in to manage this document");
      }
    });

    it("shows the owner the dialog, with the link, the people and the requests, and no role control", async () => {
      const { over } = mailbox();
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      await env.DB.prepare("INSERT INTO doc_invites (doc_id, email, created_at) VALUES (?, 'alice@acme.com', ?)")
        .bind(doc.docId, Date.now())
        .run();
      await env.DB.prepare("INSERT INTO doc_access_requests (doc_id, email, created_at) VALUES (?, 'bob@other.com', ?)")
        .bind(doc.docId, Date.now())
        .run();

      const response = await open(doc.docId, owner, over);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      const csp = response.headers.get("content-security-policy")!;
      expect(csp).toContain("frame-ancestors 'none'");
      const html = await response.text();
      // The policy admits exactly the one inline script on the page, by hash.
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
      const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)))));
      expect(csp).toContain(`script-src 'sha256-${digest}'`);
      expect(occurrences(html, "<script")).toBe(1);

      expect(html).toContain("Manage “Secret”");
      for (const text of ["Link access", "Anyone with the link", "Only those invited", "Add people", "Requests", "Who has access", "Copy link"]) {
        expect(html).toContain(text);
      }
      expect(html).toContain('value="invited" checked');
      expect(html).toContain(`value="https://openartifacts.site/d/${doc.docId}"`);
      expect(html).toContain("<b>You</b><small>Owner</small>");
      expect(html).toContain("alice@acme.com");
      expect(html).toContain("<small>Invited</small>");
      expect(html).toContain("OpenArtifacts emails each invitation. If someone doesn’t get it, send them the link.");
      expect(html).not.toContain("Invited · email sent");
      expect(html).toContain("bob@other.com");
      expect(html).toContain("Asked to open it");
      expect(html).toContain("Approve");
      expect(html).toContain("Decline");
      expect(html.indexOf("Requests")).toBeLessThan(html.indexOf("Who has access"));
      expect(html).not.toContain("may have kept a copy");
      // Comments are bound in this suite, so the switch and each person's role are drawn.
      expect(html).toContain("<h2>Comments</h2>");
      expect(html).toContain('name="comments" value="off" checked');
      expect(html).toContain('<option value="comment" selected>Can comment</option>');
    });

    it("draws neither the Comments switch nor a role where comments are not bound", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      await env.DB.prepare("INSERT INTO doc_invites (doc_id, email, created_at) VALUES (?, 'alice@acme.com', ?)")
        .bind(doc.docId, Date.now())
        .run();

      const html = await (await open(doc.docId, owner, { ...PRIVATE, COMMENTS: undefined })).text();

      expect(html).toContain("alice@acme.com");
      expect(html).not.toMatch(/Comments|Can comment|Can view|name="role"/);
    });

    it("turns comments on and off from the page, on the plan the API's switch needs", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      const enabled = async () =>
        (await env.DB.prepare("SELECT comments_enabled AS c FROM docs WHERE id = ?").bind(doc.docId).first<{ c: number }>())!.c;

      expect((await write(doc.docId, owner, { op: "comments", comments: "on" })).status).toBe(303);
      expect(await enabled()).toBe(1);
      expect(await (await open(doc.docId, owner)).text()).toContain('name="comments" value="on" checked');
      expect((await write(doc.docId, owner, { op: "comments", comments: "off" })).status).toBe(303);
      expect(await enabled()).toBe(0);
      expect((await write(doc.docId, owner, { op: "comments", comments: "sideways" })).status).toBe(404);

      // A free plan is refused with the upgrade link, and the page says what stayed as it was.
      await env.DB.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(owner).run();
      const refused = await write(doc.docId, owner, { op: "comments", comments: "on" });
      expect(refused.status).toBe(402);
      const html = await refused.text();
      expect(html).toContain("Comments need a paid plan. Nothing was changed.");
      expect(html).toContain('<a href="https://openartifacts.ai/account">Upgrade</a>');
      expect(await enabled()).toBe(0);

      // Only the owner: another reader's write is the not-available page and changes nothing.
      const bob = await reader("bob@other.com");
      expect((await write(doc.docId, bob, { op: "comments", comments: "on" })).status).toBe(404);
      expect(await enabled()).toBe(0);
    });

    it("changes a person's role from the page, and refuses a role that is not one", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      await env.DB.prepare("INSERT INTO doc_invites (doc_id, email, role, created_at) VALUES (?, 'alice@acme.com', 'comment', ?)")
        .bind(doc.docId, Date.now())
        .run();
      const role = async () =>
        (await env.DB.prepare("SELECT role FROM doc_invites WHERE doc_id = ? AND email = 'alice@acme.com'").bind(doc.docId).first<{ role: string }>())!.role;

      expect((await write(doc.docId, owner, { op: "role", email: "alice@acme.com", role: "view" })).status).toBe(303);
      expect(await role()).toBe("view");
      expect(await (await open(doc.docId, owner)).text()).toContain('<option value="view" selected>Can view</option>');
      expect((await write(doc.docId, owner, { op: "role", email: "alice@acme.com", role: "admin" })).status).toBe(404);
      expect(await role()).toBe("view");
    });

    it("hides the Requests section when nothing is pending, and says to send the link when the server sends no email", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      await env.DB.prepare("INSERT INTO doc_invites (doc_id, email, created_at) VALUES (?, 'alice@acme.com', ?)")
        .bind(doc.docId, Date.now())
        .run();

      const html = await (await open(doc.docId, owner, { ...PRIVATE, EMAIL: undefined })).text();

      expect(html).not.toContain("<h2>Requests</h2>");
      expect(html).toContain("Invited · send them the link");
      expect(html).not.toContain("Invited · email sent");
    });

    it("writes through the page into Access: add, which emails the invitee, then remove", async () => {
      const { sent, over } = mailbox();
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);

      const added = await write(doc.docId, owner, { op: "add", email: "Alice@Acme.com" }, over);

      expect(added.status).toBe(303);
      expect(added.headers.get("location")).toBe(`/share/${doc.docId}`);
      expect(added.headers.get("cache-control")).toBe("no-store");
      expect((await access(doc.docId)).people.map((person) => person.email)).toEqual(["alice@acme.com"]);
      expect(sent.map((message) => message.to)).toEqual(["alice@acme.com"]);
      expect(sent[0]!.text).toContain("Sign in with this address, alice@acme.com, to open it.");
      expect(sent[0]!.text).toContain(`https://openartifacts.site/d/${doc.docId}`);
      // A repeat is the same list and no second email.
      await write(doc.docId, owner, { op: "add", email: "alice@acme.com" }, over);
      expect(sent).toHaveLength(1);

      const removed = await write(doc.docId, owner, { op: "remove", email: "alice@acme.com" }, over);
      expect(removed.status).toBe(303);
      expect((await access(doc.docId)).people).toEqual([]);
    });

    it("approves a request as an add, which clears it and sends the invite, and declines one silently", async () => {
      const { sent, over } = mailbox();
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      for (const email of ["bob@other.com", "carol@other.com"]) {
        await env.DB.prepare("INSERT INTO doc_access_requests (doc_id, email, created_at) VALUES (?, ?, ?)")
          .bind(doc.docId, email, Date.now())
          .run();
      }

      await write(doc.docId, owner, { op: "add", email: "bob@other.com" }, over);
      await write(doc.docId, owner, { op: "decline", email: "carol@other.com" }, over);

      const state = await access(doc.docId);
      expect(state.people.map((person) => person.email)).toEqual(["bob@other.com"]);
      expect(state.requests).toEqual([]);
      expect(sent.map((message) => message.to)).toEqual(["bob@other.com"]);
    });

    it("switches the link access, and shows the copy notice only after a switch to private", async () => {
      const doc = await privateDoc("a public page", KEY, "anyone");
      const owner = await ownerAccount(doc);

      const toPrivate = await write(doc.docId, owner, { op: "link", linkAccess: "invited" });
      expect(toPrivate.status).toBe(303);
      expect(toPrivate.headers.get("location")).toBe(`/share/${doc.docId}?notice=private`);
      expect((await access(doc.docId)).linkAccess).toBe("invited");
      expect(await (await open(doc.docId, owner, PRIVATE, "?notice=private")).text()).toContain(
        "People who opened it while it was public may have kept a copy.",
      );
      expect(await (await open(doc.docId, owner)).text()).not.toContain("may have kept a copy");

      // A repeat is not a switch, and going back to public needs no plan and shows no notice.
      expect((await write(doc.docId, owner, { op: "link", linkAccess: "invited" })).headers.get("location")).toBe(`/share/${doc.docId}`);
      const toPublic = await write(doc.docId, owner, { op: "link", linkAccess: "anyone" });
      expect(toPublic.headers.get("location")).toBe(`/share/${doc.docId}`);
      expect((await access(doc.docId)).linkAccess).toBe("anyone");
      expect((await write(doc.docId, owner, { op: "link", linkAccess: "sideways" })).status).toBe(404);
    });

    it("applies the plan gate to the page's writes, with the upgrade link, and still lets a free plan remove, decline and go public", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc, "free");
      await env.DB.prepare("INSERT INTO doc_invites (doc_id, email, created_at) VALUES (?, 'alice@acme.com', ?)")
        .bind(doc.docId, Date.now())
        .run();
      await env.DB.prepare("INSERT INTO doc_access_requests (doc_id, email, created_at) VALUES (?, 'bob@other.com', ?)")
        .bind(doc.docId, Date.now())
        .run();

      const refused = await write(doc.docId, owner, { op: "add", email: "bob@other.com" });
      expect(refused.status).toBe(402);
      const html = await refused.text();
      expect(html).toContain("Private sharing needs a paid plan. Nothing was changed.");
      expect(html).toContain('<a href="https://openartifacts.ai/account">Upgrade</a>');
      expect(html).not.toContain("openartifacts account --open");
      expect((await access(doc.docId)).people.map((person) => person.email)).toEqual(["alice@acme.com"]);
      expect((await access(doc.docId)).requests.map((request) => request.email)).toEqual(["bob@other.com"]);

      expect((await write(doc.docId, owner, { op: "decline", email: "bob@other.com" })).status).toBe(303);
      expect((await write(doc.docId, owner, { op: "remove", email: "alice@acme.com" })).status).toBe(303);
      expect((await write(doc.docId, owner, { op: "link", linkAccess: "anyone" })).status).toBe(303);
      const state = await access(doc.docId);
      expect([state.linkAccess, state.people, state.requests]).toEqual(["anyone", [], []]);
      // And back to private is the other write the plan guards.
      expect((await write(doc.docId, owner, { op: "link", linkAccess: "invited" })).status).toBe(402);
      expect((await access(doc.docId)).linkAccess).toBe("anyone");
    });

    it("says an address is not an address, and changes nothing", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);

      const response = await write(doc.docId, owner, { op: "add", email: "not-an-address" });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("That is not an email address.");
      expect((await access(doc.docId)).people).toEqual([]);
    });

    it("adds several people pasted at once, and says so", async () => {
      const { sent, over } = mailbox();
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);

      const response = await write(doc.docId, owner, { op: "add", email: "Ann <ann@acme.com>, bob@acme.com;\ncarol@acme.com BOB@acme.com" }, over);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Added 3 people.");
      expect((await access(doc.docId)).people.map((person) => person.email).sort()).toEqual(["ann@acme.com", "bob@acme.com", "carol@acme.com"]);
      expect(sent.map((message) => message.to).sort()).toEqual(["ann@acme.com", "bob@acme.com", "carol@acme.com"]);
      // Posting the same list again is fine: nobody is added twice or emailed again.
      expect(await (await write(doc.docId, owner, { op: "add", email: "ann@acme.com, bob@acme.com" }, over)).text()).toContain("Added 2 people.");
      expect(sent).toHaveLength(3);
    });

    it("adds the addresses in a paste that are addresses and names the ones that are not", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);

      const response = await write(doc.docId, owner, { op: "add", email: "ann@acme.com\nbob@\n&@\ncarol@acme.com" });

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Added 2 people. Not added: bob@ (not an email address), &amp;@ (not an email address).");
      expect((await access(doc.docId)).people.map((person) => person.email).sort()).toEqual(["ann@acme.com", "carol@acme.com"]);
    });

    it("stops a paste at the document's cap and keeps the people added before it", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      for (let n = 0; n < 98; n++) {
        await env.DB.prepare("INSERT INTO doc_invites (doc_id, email, role, created_at) VALUES (?, ?, 'comment', ?)")
          .bind(doc.docId, `p${n}@acme.com`, Date.now())
          .run();
      }

      const response = await write(doc.docId, owner, { op: "add", email: "a@acme.com b@acme.com c@acme.com d@acme.com" });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Added 2 people. Stopped: A document can be shared with at most 100 people.");
      const people = (await access(doc.docId)).people.map((person) => person.email);
      expect(people).toHaveLength(100);
      expect(people).toContain("b@acme.com");
      expect(people).not.toContain("c@acme.com");
      expect(people).not.toContain("d@acme.com");
    });

    it("takes a pasted list as long as the document's cap, past the size of the other forms", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      const list = Array.from({ length: 90 }, (_, n) => `"Person ${n}" <person.number.${n}@acme-example.com>`).join(",\n");
      expect(new URLSearchParams({ op: "add", email: list }).toString().length).toBeGreaterThan(4096);

      const response = await write(doc.docId, owner, { op: "add", email: list });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Added 90 people.");
      expect((await access(doc.docId)).people).toHaveLength(90);
    });

    it("takes the longest list a document can hold, a hundred of the longest addresses", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      // 254 characters each, all but the digits three bytes long: nine bytes apiece once form-encoded.
      const list = Array.from({ length: 100 }, (_, n) => `${String(n).padStart(3, "0")}${"€".repeat(197)}@${"€".repeat(53)}`).join("\n");
      expect(list.split("\n").every((address) => address.length === 254)).toBe(true);
      expect(new URLSearchParams({ op: "add", email: list }).toString().length).toBeGreaterThan(200 * 1024);

      const response = await write(doc.docId, owner, { op: "add", email: list });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Added 100 people.");
      expect((await access(doc.docId)).people).toHaveLength(100);
    });

    it("reads a lone pasted contact as its address", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);

      expect((await write(doc.docId, owner, { op: "add", email: "Ann Lee <Ann@Acme.com>" })).status).toBe(303);
      expect((await access(doc.docId)).people.map((person) => person.email)).toEqual(["ann@acme.com"]);
    });

    it("refuses a write from another site, with the header or without it, and changes nothing", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      const fields = { op: "add", email: "mallory@evil.example" };

      const foreign: Array<Record<string, string>> = [
        { "sec-fetch-site": "cross-site" },
        { "sec-fetch-site": "same-site" },
        { "sec-fetch-site": "none" },
        { origin: "https://evil.example" },
        {},
      ];
      for (const headers of foreign) {
        expect((await write(doc.docId, owner, fields, PRIVATE, headers)).status).toBe(404);
      }
      expect((await access(doc.docId)).people).toEqual([]);
      // A browser that sends no Fetch Metadata is held to its Origin.
      expect((await write(doc.docId, owner, fields, PRIVATE, { origin: API })).status).toBe(303);
      expect((await access(doc.docId)).people.length).toBe(1);
    });

    it("lets only the owner write, and never writes on a GET", async () => {
      const doc = await privateDoc();
      const bob = await reader("bob@other.com");
      const owner = await ownerAccount(doc);

      const denied = await write(doc.docId, bob, { op: "add", email: "bob@other.com" });
      expect(denied.status).toBe(404);
      expect(await denied.text()).toContain("isn't available to");
      expect((await write(UNKNOWN_DOC_ID, owner, { op: "add", email: "x@acme.com" })).status).toBe(404);
      expect((await sendTo("POST", SHARE(doc.docId), { headers: SAME_ORIGIN, body: new URLSearchParams({ op: "add", email: "x@acme.com" }) }, PRIVATE)).status).toBe(200); // sign-in, no write
      expect((await write(doc.docId, owner, { op: "mystery", email: "x@acme.com" })).status).toBe(404);

      await open(doc.docId, owner, PRIVATE, "?op=add&email=bob@other.com&linkAccess=anyone&notice=private");
      const state = await access(doc.docId);
      expect([state.linkAccess, state.people]).toEqual(["invited", []]);
      for (const method of ["PUT", "DELETE", "PATCH"]) {
        expect((await sendTo(method, SHARE(doc.docId), { headers: { cookie: await sessionFor(owner), ...SAME_ORIGIN } }, PRIVATE)).status).toBe(404);
      }
      expect((await getFrom(`${SHARE(doc.docId)}/v1`, { headers: { cookie: await sessionFor(owner) } }, PRIVATE)).status).toBe(404);
    });

    it("is not there on a server with no reader sign-in", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc);
      for (const over of [{ ...PRIVATE, READER_SESSION_SECRET: undefined }, { ...PRIVATE, OAUTH_GITHUB_CLIENT_ID: "", EMAIL: undefined }]) {
        expect((await open(doc.docId, owner, over)).status).toBe(404);
        expect((await write(doc.docId, owner, { op: "add", email: "x@acme.com" }, over)).status).toBe(404);
      }
      expect((await access(doc.docId)).people).toEqual([]);
    });

    it("answers a re-add of a listed address as a repeat on a free plan, not a refusal", async () => {
      const doc = await privateDoc();
      const owner = await ownerAccount(doc, "free");
      await env.DB.prepare("INSERT INTO doc_invites (doc_id, email, created_at) VALUES (?, 'alice@acme.com', ?)")
        .bind(doc.docId, Date.now())
        .run();

      const repeat = await write(doc.docId, owner, { op: "add", email: "alice@acme.com" });

      expect(repeat.status).toBe(303);
      expect((await access(doc.docId)).people.map((person) => person.email)).toEqual(["alice@acme.com"]);
      expect((await write(doc.docId, owner, { op: "add", email: "carol@acme.com" })).status).toBe(402);
    });

    it("refuses a new address past the daily invite cap with 429, keeps the pending request and changes nothing", async () => {
      const doc = await privateDoc();
      const other = await privateDoc("other");
      expect(other.owner).toBe(doc.owner);
      const owner = await ownerAccount(doc);
      for (let i = 0; i < 100; i++) {
        await env.DB.prepare("INSERT INTO doc_invites (doc_id, email, created_at) VALUES (?, ?, ?)")
          .bind(other.docId, `p${i}@acme.com`, Date.now() - 1000)
          .run();
        await env.DB.prepare("INSERT INTO invite_sends (owner, created_at) VALUES (?, ?)")
          .bind(doc.owner, Date.now() - 1000)
          .run();
      }
      await env.DB.prepare("INSERT INTO doc_access_requests (doc_id, email, created_at) VALUES (?, 'bob@other.com', ?)")
        .bind(doc.docId, Date.now())
        .run();

      const refused = await write(doc.docId, owner, { op: "add", email: "bob@other.com" });

      expect(refused.status).toBe(429);
      const html = await refused.text();
      expect(html).toContain("You have added 100 new people in the last 24 hours. Try again later.");
      expect(html).toContain("Nothing was changed.");
      const state = await access(doc.docId);
      expect(state.requests.map((request) => request.email)).toEqual(["bob@other.com"]);
      expect(state.people).toEqual([]);
    });
  });
});

describe("GET /d/{docId}/threads", () => {
  const API = "https://api.openartifacts.ai";
  const APEX = "https://openartifacts.site";
  const HOSTS = {
    SERVING_HOST: "openartifacts.site",
    API_HOST: "api.openartifacts.ai",
    READER_SESSION_SECRET: "k".repeat(32),
    OAUTH_GITHUB_CLIENT_ID: "github-client",
    OAUTH_GITHUB_CLIENT_SECRET: "github-secret",
  } satisfies Partial<Env>;
  const ISOLATION = {
    "cross-origin-opener-policy": "same-origin-allow-popups",
    "cross-origin-resource-policy": "same-origin",
  };

  const KEY_Q = "cplus_live_f1e2d3c4b5a60718";

  /** The account with that address, made on first use, so a test can call this for the same person twice. */
  async function account(email: string, name: string | null): Promise<string> {
    const existing = await env.DB.prepare("SELECT id FROM accounts WHERE email = ?").bind(email).first<{ id: string }>();
    if (existing) return existing.id;
    const id = newAccountId();
    await env.DB.prepare("INSERT INTO accounts (id, email, created_at, display_name) VALUES (?, ?, ?, ?)")
      .bind(id, email, Date.now(), name)
      .run();
    return id;
  }

  /**
   * A document at version 2 whose v1 says "first draft" and v2 "second draft",
   * with comments switched on and two threads written through the real object:
   * one by Alice, one by Alice's agent. Their addresses and ids must never come out.
   */
  async function commented(mode: "anyone" | "invited" = "anyone") {
    const docId = await twoVersionDoc();
    await env.DB.prepare("UPDATE docs SET link_access = ?, comments_enabled = 1 WHERE id = ?").bind(mode, docId).run();
    const alice = await account("alice@acme.com", "Alice");
    const stub = env.COMMENTS!.get(env.COMMENTS!.idFromName(docId));
    const base = { docId, version: 1, at: 1_000 };
    await stub.createThread({ ...base, principal: alice, kind: "human", onBehalfOf: null, anchor: { exact: "first draft" }, body: "Why first?" });
    await stub.createThread({ ...base, principal: alice, kind: "agent", onBehalfOf: alice, anchor: { exact: "first" }, body: "Same, from my agent" });
    const row = await env.DB.prepare("SELECT owner FROM docs WHERE id = ?").bind(docId).first<{ owner: string }>();
    return { docId, alice, owner: row!.owner, host: `https://${await originLabel(row!.owner)}.openartifacts.site` };
  }

  interface Served {
    docId: string;
    title: string;
    version: number;
    latestVersion: number;
    viewer?: unknown;
    threads: Array<{
      anchorStatus: string;
      matchedText: string | null;
      comments: Array<{ author: { name: string; kind: string }; body: string; mine?: boolean }>;
      canResolve?: boolean;
    }>;
  }

  describe("on the public origin", () => {
    it("serves the unauthenticated threads, with the serving header policy, no cookie and no caching", async () => {
      const { docId, alice } = await commented();

      const response = await getFrom(`${APEX}/d/${docId}/threads`, {}, HOSTS);
      const page = await getFrom(`${APEX}/d/${docId}`, {}, HOSTS);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      // The whole policy the page carries, byte for byte, bar its cache lifetime.
      for (const name of ["content-security-policy", "x-robots-tag", "x-content-type-options", "referrer-policy"]) {
        expect(response.headers.get(name), name).toBe(page.headers.get(name));
        expect(response.headers.get(name), name).not.toBeNull();
      }

      const text = await response.text();
      const body = JSON.parse(text) as Served;
      expect(body).toMatchObject({ docId, title: "A note", version: 2, latestVersion: 2 });
      // Anchored for v2, where "first draft" is gone: both threads orphaned, still there.
      expect(body.threads.map((t) => t.anchorStatus)).toEqual(["orphaned", "orphaned"]);
      expect(body.threads.map((t) => t.comments[0]!.author)).toEqual([
        { name: "Alice", kind: "human" },
        { name: "Alice's agent", kind: "agent" },
      ]);
      // The reader is anonymous: no viewer, no per-comment ownership, no ids or addresses.
      expect(body.viewer).toBeUndefined();
      expect(body.threads[0]!.canResolve).toBeUndefined();
      expect(body.threads[0]!.comments[0]!.mine).toBeUndefined();
      for (const leaked of [alice, "alice@acme.com", "createdBy", "updatedAt", "principal", "onBehalfOf"]) {
        expect(text).not.toContain(leaked);
      }
    });

    it("answers for the version asked, and for the latest by default", async () => {
      const { docId } = await commented();

      const pinned = (await (await getFrom(`${APEX}/d/${docId}/threads?v=1`, {}, HOSTS)).json()) as Served;
      expect(pinned).toMatchObject({ version: 1, latestVersion: 2 });
      expect(pinned.threads.map((t) => [t.anchorStatus, t.matchedText])).toEqual([
        ["anchored", "first draft"],
        ["anchored", "first"],
      ]);

      // A trailing slash is the same resource.
      const slash = (await (await getFrom(`${APEX}/d/${docId}/threads/`, {}, HOSTS)).json()) as Served;
      expect(slash.version).toBe(2);
    });

    it("answers HEAD with the headers and no body, and counts no view on any verb", async () => {
      const { docId } = await commented();

      const head = await sendTo("HEAD", `${APEX}/d/${docId}/threads`, {}, HOSTS);
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(head.headers.get("cache-control")).toBe("no-store");
      expect(await head.text()).toBe("");

      const events: Array<{ name: string }> = [];
      const sink = { record: (event: { name: string }) => void events.push(event) };
      const { handleServing } = await import("../src/serve.js");
      for (const method of ["GET", "HEAD"]) {
        const served = await handleServing(
          new Request(`${APEX}/d/${docId}/threads`, { method }),
          new URL(`${APEX}/d/${docId}/threads`),
          { ...env, ...HOSTS } as Env,
          sink as never,
        );
        expect(served.status).toBe(200);
        await served.arrayBuffer();
      }
      expect(events).toEqual([]);
    });

    it("is 404 for an unknown id, comments off, comments unavailable and a version that does not exist", async () => {
      const { docId } = await commented();
      const status = async (path: string, overrides: Partial<Env> = {}) => {
        const response = await getFrom(`${APEX}${path}`, {}, { ...HOSTS, ...overrides });
        expect(response.headers.get("set-cookie")).toBeNull();
        return response;
      };

      expect((await status(`/d/${UNKNOWN_DOC_ID}/threads`)).status).toBe(404);
      for (const query of ["?v=9", "?v=0", "?v=01", "?v=abc", "?v="]) {
        expect((await status(`/d/${docId}/threads${query}`)).status, query).toBe(404);
      }
      expect((await status(`/d/${docId}/threads`, { COMMENTS: undefined })).status).toBe(404);
      // Without reader sign-in no other surface serves threads either, so neither does the apex.
      expect((await status(`/d/${docId}/threads`, { READER_SESSION_SECRET: "" })).status).toBe(404);

      const miss = await status(`/d/${UNKNOWN_DOC_ID}/threads`);
      expect(miss.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const missBody = await miss.text();
      expect(JSON.parse(missBody)).toMatchObject({ error: { code: "not_found" } });

      await env.DB.prepare("UPDATE docs SET comments_enabled = 0 WHERE id = ?").bind(docId).run();
      const off = await status(`/d/${docId}/threads`);
      expect(off.status).toBe(404);
      // The same bytes as an id that never existed.
      expect(await off.text()).toBe(missBody);
    });

    it("is 410 for a deleted document, before it asks which version, and 404 for an invited-only one with no redirect", async () => {
      const { docId } = await commented();
      await softDelete(docId);
      for (const query of ["", "?v=1", "?v=9"]) {
        const response = await getFrom(`${APEX}/d/${docId}/threads${query}`, {}, HOSTS);
        expect(response.status, query).toBe(410);
        expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(await response.json()).toMatchObject({ error: { code: "gone" } });
      }

      const invited = await commented("invited");
      const response = await getFrom(`${APEX}/d/${invited.docId}/threads`, {}, HOSTS);
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    });

    it("takes no other method, and does not widen what the page route answers", async () => {
      const { docId } = await commented();
      for (const method of ["POST", "PUT", "DELETE"]) {
        expect((await sendTo(method, `${APEX}/d/${docId}/threads`, {}, HOSTS)).status, method).toBe(404);
      }
      for (const path of [`/d/${docId}/threads/x`, `/d/${docId}/thread`, `/d/${docId}/v1/threads`]) {
        const response = await getFrom(`${APEX}${path}`, {}, HOSTS);
        expect(response.status, path).toBe(404);
        expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      }
    });

    it("is not an API route: the API host asks for a credential and serves no threads here", async () => {
      const { docId } = await commented();
      expect((await getFrom(`${API}/d/${docId}/threads`, {}, HOSTS)).status).toBe(401);
    });
  });

  describe("on a publisher's origin", () => {
    async function reader(email: string, docId: string): Promise<string> {
      const id = await account(email, null);
      await env.DB.prepare("INSERT INTO doc_invites (doc_id, email, created_at) VALUES (?, ?, ?)")
        .bind(docId, email, Date.now())
        .run();
      return id;
    }

    const cookieFor = async (doc: { docId: string; owner: string }, principal: string) => {
      const url = (await grantUrl({ ...env, ...HOSTS }, doc.owner, { docId: doc.docId, pinned: null }, principal, Date.now()))!.url;
      const swapped = await getFrom(url, {}, HOSTS);
      expect(swapped.status).toBe(303);
      return swapped.headers.get("set-cookie")!.split(";")[0]!;
    };

    it("serves the threads behind the grant cookie, isolated and uncacheable, to the owner and to an invited reader", async () => {
      const doc = await commented("invited");
      const invited = await reader("bob@acme.com", doc.docId);

      for (const principal of [doc.owner, invited]) {
        const cookie = await cookieFor(doc, principal);
        const response = await getFrom(`${doc.host}/d/${doc.docId}/threads`, { headers: { cookie } }, HOSTS);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("set-cookie")).toBeNull();
        for (const [name, value] of Object.entries(ISOLATION)) expect(response.headers.get(name)).toBe(value);
        const body = (await response.json()) as Served;
        expect(body.threads).toHaveLength(2);
        expect(body.viewer).toBeUndefined();

        const pinned = (await (await getFrom(`${doc.host}/d/${doc.docId}/threads?v=1`, { headers: { cookie } }, HOSTS)).json()) as Served;
        expect(pinned.threads[0]!.anchorStatus).toBe("anchored");
      }
    });

    it("answers 404 JSON with no redirect to no cookie, to a reader not on the list and to another publisher's cookie", async () => {
      const doc = await commented("invited");
      const stranger = await account("carol@other.com", null);
      const other = await commented("invited");

      const bare = await getFrom(`${doc.host}/d/${doc.docId}/threads`, {}, HOSTS);
      expect(bare.status).toBe(404);
      expect(bare.headers.get("location")).toBeNull();
      expect(bare.headers.get("set-cookie")).toBeNull();
      expect(bare.headers.get("content-type")).toBe("application/json; charset=utf-8");
      for (const [name, value] of Object.entries(ISOLATION)) expect(bare.headers.get(name)).toBe(value);

      const notListed = await getFrom(`${doc.host}/d/${doc.docId}/threads`, { headers: { cookie: await cookieFor(doc, stranger) } }, HOSTS);
      expect(notListed.status).toBe(404);
      // The same bytes as a document that does not exist.
      const missing = await getFrom(`${doc.host}/d/${UNKNOWN_DOC_ID}/threads`, { headers: { cookie: await cookieFor(doc, doc.owner) } }, HOSTS);
      expect(await notListed.text()).toBe(await missing.text());

      // A cookie names its origin: this publisher's, replayed on a document of another label, is nothing.
      await env.DB.prepare("UPDATE docs SET owner = 'someone-else' WHERE id = ?").bind(other.docId).run();
      const otherHost = `https://${await originLabel("someone-else")}.openartifacts.site`;
      const replay = await getFrom(`${otherHost}/d/${other.docId}/threads`, { headers: { cookie: await cookieFor(doc, doc.owner) } }, HOSTS);
      expect(replay.status).toBe(404);
      // And this host does not confirm another publisher's document either.
      const wrongHost = await getFrom(`${doc.host}/d/${other.docId}/threads`, { headers: { cookie: await cookieFor(doc, doc.owner) } }, HOSTS);
      expect(wrongHost.status).toBe(404);
    });

    it("never takes the ?grant= swap: no 303, no cookie, a plain 404", async () => {
      const doc = await commented("invited");
      const grant = new URL(await (async () => (await grantUrl({ ...env, ...HOSTS }, doc.owner, { docId: doc.docId, pinned: null }, doc.owner, Date.now()))!.url)());
      const response = await getFrom(`${doc.host}/d/${doc.docId}/threads${grant.search}`, {}, HOSTS);
      expect(response.status).toBe(404);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("location")).toBeNull();
    });

    it("is 404 for a public document here (the apex serves it), comments off, and 410 once deleted", async () => {
      const doc = await commented("invited");
      const cookie = await cookieFor(doc, doc.owner);
      const read = (init = { headers: { cookie } }) => getFrom(`${doc.host}/d/${doc.docId}/threads`, init, HOSTS);

      await env.DB.prepare("UPDATE docs SET comments_enabled = 0 WHERE id = ?").bind(doc.docId).run();
      expect((await read()).status).toBe(404);
      await env.DB.prepare("UPDATE docs SET comments_enabled = 1, link_access = 'anyone' WHERE id = ?").bind(doc.docId).run();
      const toApex = await read();
      expect(toApex.status).toBe(404);
      expect(toApex.headers.get("location")).toBeNull();

      await env.DB.prepare("UPDATE docs SET link_access = 'invited' WHERE id = ?").bind(doc.docId).run();
      expect((await read()).status).toBe(200);
      await softDelete(doc.docId);
      const gone = await read();
      expect(gone.status).toBe(410);
      for (const [name, value] of Object.entries(ISOLATION)) expect(gone.headers.get(name)).toBe(value);
    });

    it("answers 404 where reader sign-in is not configured", async () => {
      const doc = await commented("invited");
      const cookie = await cookieFor(doc, doc.owner);
      const response = await getFrom(`${doc.host}/d/${doc.docId}/threads`, { headers: { cookie } }, { ...HOSTS, READER_SESSION_SECRET: "" });
      expect(response.status).toBe(404);
    });
  });
});
