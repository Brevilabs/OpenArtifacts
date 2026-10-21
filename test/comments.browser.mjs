/**
 * Inline comments in a real browser: `npm run test:browser`, with the Share
 * popover's test beside it.
 *
 * The vitest suite runs inside workerd and cannot load a page, so
 * `test/comments-*.test.ts` and `test/serve.test.ts` cover the HTTP contract and
 * this covers the DOM: the page script's selection, canonical text, highlights
 * and measuring; the comments frame's sidebar and sheet and its writes; and the two
 * halves talking across the origin line.
 *
 * It uses the same harness as `test/share-popover.browser.mjs` (read its header
 * for why: the deployed bundle under Miniflare over HTTPS, Chrome pointed at it
 * by `--host-resolver-rules`, no `context.route`), with the one addition comments
 * need, the `DocComments` Durable Object binding. Threads are created through the
 * real API as the owner's agent where a test is not about posting, and through
 * the frame, with a token minted for the test, where it is. The sign-in popup
 * itself is the Share popover's test.
 *
 * Needs Node 22 and a Google Chrome. `OA_HEADED=1` shows the browser, and
 * `OA_SCREENSHOTS={dir}` saves the sidebar a private page's owner sees before
 * anyone has commented.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { Miniflare } = require("miniflare");
const { chromium } = require("playwright-core");
const { readD1Migrations } = require("@cloudflare/vitest-pool-workers/config");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVING = "openartifacts.site";
const API = "api.openartifacts.ai";
const SECRET = "k".repeat(32);
const KEY = "cplus_live_a1b2c3d4e5f60718";
const OWNER = "owner-c";
// Not the share test's directory: `node --test` may run both files at once.
const BUILD = join(ROOT, "node_modules", ".cache", "comments-browser");

const accountId = (seed) => `oa_${seed}${"0123456789abcdefghjkmnpqrs".slice(seed.length)}`;
const OWNER_ACCOUNT = accountId("a");
const ALICE = accountId("b");
const BOB = accountId("c");

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

/** A value signed the way `src/session.ts` does, for `purpose`. */
function signed(purpose, payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 86_400_000 })).toString("base64url");
  const mac = createHmac("sha256", SECRET).update(`${purpose}.${body}`).digest("base64url");
  return `${body}.${mac}`;
}

const sessionCookie = (account) => ({
  name: "__Host-oa_session",
  value: signed("session", { a: account }),
  url: `https://${API}`,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
});

/** A per-document token the Share popover or the comments frame would hold, minted for a test that is not about signing in. */
const frameToken = (account, doc) => ({ token: `oas_${signed("share-token", { a: account, d: doc })}`, expiresAt: Date.now() + 86_000_000 });

function wranglerVars() {
  const text = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return JSON.parse(text).vars;
}

/** Obsidian Copilot's export shape: a 46rem column, centred, which leaves 272px at the right of a 1280px viewport. */
const page = (body, head = "") =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Q3 report</title>\n` +
  `<style>body{margin:0;font:16px/1.6 Georgia,serif;color:#222;background:#fffdf8}main{width:min(100% - 2rem, 46rem);margin:0 auto;padding:1rem 0}h1{font-size:28px;margin:24px 0}p{margin:0 0 22px}</style>${head}\n</head>\n<body>\n<main id="content">\n${body}\n</main>\n</body>\n</html>\n`;

const REPORT = `<h1>Q3 client report</h1>
<p id="growth">Revenue grew 18% quarter over quarter, led by the integration pilot and two enterprise renewals.</p>
<p id="risk"><b>Risks.</b> Renewal risk is concentrated in three accounts, two of which are mid-migration. Next steps for the pilot are below.</p>
<p>Staffing is unchanged. The budget is on the next page.</p>
<p>Closing remarks follow in the appendix.</p>`;

async function until(label, read, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await read();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label} (last: ${last})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let mf;
let browser;
let db;

const screenshots = process.env.OA_SCREENSHOTS;
async function shoot(target, name) {
  if (!screenshots) return;
  mkdirSync(screenshots, { recursive: true });
  await target.screenshot({ path: join(screenshots, `${name}.png`) });
}

const api = (path, init = {}) =>
  mf.dispatchFetch(`https://${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...init.headers },
  });

/** Publish as the owner, give the readers who comment in these tests a Can comment role, and return the doc id. */
async function publish(title, body, { route = "docs", comments = true, html } = {}) {
  const response = await api(`/api/v1/${route}`, { method: "POST", body: JSON.stringify({ title, html: html ?? page(body) }) });
  assert.equal(response.status, 201, await response.clone().text());
  const { docId } = await response.json();
  if (comments) await grantCommenters(docId);
  return docId;
}

/**
 * There is no switch: a page has comments once someone holds Can comment on it.
 * Alice is the reader these tests comment as; Bob is never given a role here, so
 * he reads and cannot write.
 */
async function grantCommenters(docId) {
  await db
    .prepare("INSERT OR IGNORE INTO doc_invites (doc_id, email, role, created_at) VALUES (?, 'alice@example.com', 'comment', ?)")
    .bind(docId, Date.now())
    .run();
}

async function update(docId, body) {
  const response = await api(`/api/v1/docs/${docId}`, { method: "PUT", body: JSON.stringify({ html: page(body) }) });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).version;
}

/** A thread by the owner's agent; returns its id. */
async function agentThread(docId, anchor, body, version) {
  const response = await api(`/api/v1/docs/${docId}/threads`, { method: "POST", body: JSON.stringify({ anchor, body, ...(version ? { version } : {}) }) });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).threadId;
}

const threadsOf = async (docId, state = "all") => (await (await api(`/api/v1/docs/${docId}/threads?state=${state}`)).json()).threads;

const docUrl = (docId, pinned) => `https://${SERVING}/d/${docId}${pinned ? `/v${pinned}` : ""}`;
const commentsFrame = (page, docId) => page.frames().find((frame) => frame.url().startsWith(`https://${API}/embed/comments?doc=${docId}`));
const hostBox = (page) => page.locator(".openartifacts-comments").boundingBox();
const barButton = (page) => page.locator(".openartifacts-bar button[aria-pressed]");

/** The viewport rectangle of the first occurrence of `text` in the author's content. */
const rectOf = (page, text) =>
  page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.getElementById("content"), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.data.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + needle.length);
      const box = range.getClientRects()[0];
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }
    return null;
  }, text);

/** Select the first occurrence of `text`, the way dragging over it would. */
const select = (page, text) =>
  page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.getElementById("content"), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.data.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + needle.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    return false;
  }, text);

/** What the highlight registry holds: the text of each painted range, by name. */
const painted = (page, name) =>
  page.evaluate((key) => (CSS.highlights.has(key) ? [...CSS.highlights.get(key)].map((range) => range.toString()) : []), name);

/** Select `text` and press the floating Comment button with the mouse, the way a reader does. */
async function pressComment(tab, text) {
  const tip = tab.locator(".openartifacts-comment-tip");
  assert.equal(await select(tab, text), true);
  await until("the Comment button", async () => (await tip.isVisible()) && (await tip.boundingBox()).width > 0);
  const box = await tip.boundingBox();
  await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Press the bar's Comments button unless the sidebar is already open, and wait for the column. */
async function openSidebar(tab) {
  const button = barButton(tab);
  await button.waitFor();
  if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  await until("the sidebar", async () => (await hostBox(tab)) !== null);
}

const cardFor = (frame, remark) => frame.locator("[data-thread]", { hasText: remark });

before(async () => {
  mkdirSync(BUILD, { recursive: true });
  execFileSync(process.execPath, [require.resolve("wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--outdir", BUILD], {
    cwd: ROOT,
    stdio: "pipe",
  });

  const vars = wranglerVars();
  mf = new Miniflare({
    modules: true,
    scriptPath: join(BUILD, "index.js"),
    compatibilityDate: "2026-03-01",
    d1Databases: ["DB"],
    r2Buckets: ["DOCS"],
    // The page validator reads the deploy time from this binding; wrangler.jsonc
    // declares it, but this harness does not read wrangler.jsonc.
    versionMetadata: "CF_VERSION_METADATA",
    durableObjects: { COMMENTS: { className: "DocComments", useSQLite: true } },
    https: true,
    port: 0,
    bindings: {
      SERVING_HOST: SERVING,
      API_HOST: API,
      LEGACY_SERVING_HOST: "",
      RETIRED_API_HOST: "",
      READER_SESSION_SECRET: SECRET,
      OAUTH_GITHUB_CLIENT_ID: "x",
      OAUTH_GITHUB_CLIENT_SECRET: "y",
      DEFAULT_PLAN: vars.DEFAULT_PLAN,
      PLAN_LIMITS: vars.PLAN_LIMITS,
    },
  });
  const { port } = await mf.ready;

  db = await mf.getD1Database("DB");
  for (const migration of await readD1Migrations(join(ROOT, "migrations"))) {
    for (const query of migration.queries) await db.prepare(query).run();
  }

  const now = Date.now();
  await db
    .prepare("INSERT INTO publishers (key_hash, plan, validated_at, owner) VALUES (?, 'believer', ?, ?)")
    .bind(sha256Hex(KEY), now, OWNER)
    .run();
  const people = [
    [OWNER_ACCOUNT, "owner@example.com", "Logan"],
    [ALICE, "alice@example.com", "Alice"],
    [BOB, "bob@example.com", "Bob"],
  ];
  for (const [id, email, name] of people) {
    await db
      .prepare("INSERT INTO accounts (id, email, plan, created_at, display_name) VALUES (?, ?, 'pro', ?, ?)")
      .bind(id, email, now, name)
      .run();
  }
  await db
    .prepare("INSERT INTO owner_links (external_owner, account_id, created_at) VALUES (?, ?, ?)")
    .bind(OWNER, OWNER_ACCOUNT, now)
    .run();

  browser = await chromium.launch({
    channel: "chrome",
    headless: !process.env.OA_HEADED,
    args: [
      `--host-resolver-rules=MAP ${SERVING}:443 127.0.0.1:${port}, MAP *.${SERVING}:443 127.0.0.1:${port}, MAP ${API}:443 127.0.0.1:${port}`,
      "--ignore-certificate-errors",
    ],
  });
});

after(async () => {
  await browser?.close();
  await mf?.dispose();
});

/**
 * A browser context with the reader's session cookie, and optionally the
 * frame's token for `signedInTo` (a document id) already in its storage, written
 * before the frame's own script runs, for tests that are not about signing in.
 */
async function newContext(account, { viewport = { width: 1280, height: 800 }, signedInTo, ...options } = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport, ...options });
  if (account) await context.addCookies([sessionCookie(account)]);
  if (signedInTo) {
    const value = JSON.stringify(frameToken(account, signedInTo));
    const key = `openartifacts:share-token:${signedInTo}`;
    await context.addInitScript(
      ({ key, value, origin }) => {
        if (location.origin === origin) window.localStorage.setItem(key, value);
      },
      { key, value, origin: `https://${API}` },
    );
  }
  return context;
}

test("on a phone with no threads yet, the bar's button opens the sheet with its one line, and again closes it", { timeout: 120_000 }, async () => {
  const docId = await publish("Phone, no threads", REPORT);
  const context = await newContext(null, { viewport: { width: 390, height: 844 } });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  const button = barButton(tab);
  await button.waitFor();
  assert.equal(await hostBox(tab), null, "nothing is drawn until the button is pressed");
  await button.click();
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  await frame.getByRole("button", { name: "Invited to comment? Sign in." }).waitFor();
  assert.equal(await button.getAttribute("aria-pressed"), "true");
  await button.click();
  await until("the sheet to close", async () => (await hostBox(tab)) === null);
  await context.close();
});

test("the page finds the same text the server does: entities, decomposed accents, reflowed spaces, repeats", { timeout: 120_000 }, async () => {
  const body = `<p id="a">Caf&eacute; &amp; bar: the price is &lt;5&gt; today.</p>
<p id="b">Cafe&#769; Noir is closed.</p>
<script>var hidden = "Caf\u00e9 &amp; hidden";</script>
<p id="c">two   spaced
 words here</p>
<p id="d">Same words. Same words.</p>
<p id="e">Same words. Different tail.</p>
<template><p>templated text</p></template>
<noscript>fallback text</noscript>`;
  const docId = await publish("Canonical", body);
  await agentThread(docId, { exact: "Café & bar: the price is <5>" }, "entities");
  await agentThread(docId, { exact: "Café Noir" }, "decomposed");
  await agentThread(docId, { exact: "two spaced words" }, "whitespace");
  await agentThread(docId, { exact: "Same words.", suffix: " Different tail.", section: "e" }, "repeat");
  const stored = await threadsOf(docId);
  assert.deepEqual(stored.map((t) => t.anchorStatus), ["anchored", "anchored", "anchored", "anchored"]);
  assert.equal(stored[2].anchor.exact, "two   spaced\n words", "the whitespace rung rewrote the quote to the text as it reads");

  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await until("four highlights", async () => (await painted(tab, "openartifacts-open")).length === 4);
  const texts = (await painted(tab, "openartifacts-open")).map((text) => text.normalize("NFC"));
  assert.deepEqual(texts.sort(), ["Café & bar: the price is <5>", "Café Noir", "Same words.", "two   spaced\n words"].sort());
  // The repeat was picked by its suffix: the second paragraph's.
  const ownerOfRepeat = await tab.evaluate(() => {
    const range = [...CSS.highlights.get("openartifacts-open")].find((r) => r.toString() === "Same words.");
    return range.startContainer.parentElement.id;
  });
  assert.equal(ownerOfRepeat, "e");
  await context.close();
});

const postedTo = (tab) => {
  const seen = [];
  tab.on("request", (request) => {
    if (request.url().includes("/embed/api/")) seen.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return seen;
};

test("a message from the page never moves focus into the frame, and nothing posts without a click on Send", { timeout: 180_000 }, async () => {
  const victim = await publish("Victim", REPORT);
  const hostileBody = `<h1>Survey</h1><p>Type your name:</p><input id="name" style="font-size:20px">
<script>
const f = document.createElement("iframe");
f.src = "https://${API}/embed/comments?doc=${victim}&origin=" + encodeURIComponent(location.origin);
f.style.cssText = "position:absolute;left:0;top:0;width:320px;height:400px;opacity:0;pointer-events:none";
document.body.append(f);
window.heard = [];
window.addEventListener("message", (e) => { if (e.source === f.contentWindow) window.heard.push(e.data && e.data.event); });
document.getElementById("name").addEventListener("input", () => {
  f.contentWindow.postMessage({ type: "openartifacts:comments", event: "draft", anchor: { exact: "Staffing is unchanged" }, top: 0 }, "https://${API}");
}, { once: true });
</script>`;
  const hostile = await publish("Hostile", hostileBody, { comments: false });

  // Alice holds a token for the victim; the hostile public page frames the victim's comments frame and tries to type for her.
  const context = await newContext(ALICE, { signedInTo: victim });
  const tab = await context.newPage();
  await tab.goto(docUrl(hostile));
  await until("the victim's frame", () => commentsFrame(tab, victim));
  await until("its ready", () => tab.evaluate(() => window.heard.includes("ready")));
  await tab.click("#name");
  await tab.keyboard.type("A");
  await tab.waitForTimeout(600);
  assert.notEqual(await tab.evaluate(() => document.activeElement.tagName), "IFRAME", "the page's own input kept the focus");
  await tab.keyboard.type("I agree to the terms");
  assert.equal(await tab.inputValue("#name"), "AI agree to the terms");
  await tab.keyboard.press("Control+Enter");
  await tab.waitForTimeout(800);
  assert.equal((await threadsOf(victim)).length, 0, "nothing was posted as Alice");
  await context.close();

  // In the document itself: Comment draws the draft, but focus stays put; the reader clicks into the box; a thread above the selection does not take the text.
  const docId = await publish("Focus", REPORT);
  await agentThread(docId, { exact: "Revenue grew 18% quarter over quarter" }, "Is 18% the right base?");
  const own = await newContext(ALICE, { signedInTo: docId });
  const page2 = await own.newPage();
  await page2.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(page2, docId));
  await select(page2, "Staffing is unchanged");
  const tip = page2.locator(".openartifacts-comment-tip");
  await until("the Comment button", async () => await tip.isVisible());
  const tipBox = await tip.boundingBox();
  const scrolled = await page2.evaluate(() => window.scrollY);
  await page2.mouse.click(tipBox.x + tipBox.width / 2, tipBox.y + tipBox.height / 2);
  const draft = frame.getByRole("textbox", { name: "Add a comment…" });
  await draft.waitFor();
  // The Comment click itself puts the cursor in the box, so the reader types at once.
  await until("the box to hold the focus", () => frame.evaluate(() => document.activeElement.tagName === "TEXTAREA"));
  await page2.keyboard.type("typed by hand");
  assert.equal(await draft.inputValue(), "typed by hand");
  assert.equal(await frame.locator("textarea[data-key^='r:']").inputValue(), "");
  assert.equal(await page2.evaluate(() => window.scrollY), scrolled, "the page did not jump");
  await page2.keyboard.press("Control+Enter");
  await page2.waitForTimeout(800);
  assert.equal((await threadsOf(docId)).length, 1, "Ctrl+Enter does not post");
  await frame.locator("[data-thread='']").getByRole("button", { name: "Send" }).click();
  await until("the post", async () => (await threadsOf(docId)).length === 2);
  await own.close();
});

test("a frame draws relayed threads read-only and does not let the page drive its reads", { timeout: 120_000 }, async () => {
  const victim = await publish("Victim", REPORT);
  const hostileBody = `<h1>Survey</h1>
<script>
const f = document.createElement("iframe");
// A version that does not exist: the frame's own read answers 404, so only what the page relays is left to draw.
f.src = "https://${API}/embed/comments?doc=${victim}&v=999999999&origin=" + encodeURIComponent(location.origin);
f.style.cssText = "position:absolute;left:0;top:0;width:320px;height:500px";
document.body.append(f);
const fake = { title: "x", version: 1, threads: [{ threadId: "th_fake", anchor: { exact: "x" }, anchorStatus: "orphaned", state: "open", canResolve: true,
  comments: [{ commentId: "cm_fake", author: { name: "OpenArtifacts Security", kind: "human" }, body: "Sign in again", createdAt: 1, mine: true }] },
  { threadId: "th_done", anchor: { exact: "y" }, anchorStatus: "orphaned", state: "resolved", resolution: { atVersion: "2 by OpenArtifacts Security", by: {} }, comments: [{ commentId: "cm_done", author: { name: "x", kind: "human" }, body: "Settled", createdAt: 1 }] }] };
window.addEventListener("message", (e) => {
  if (e.source !== f.contentWindow || !e.data || e.data.event !== "ready") return;
  for (let i = 0; i < 20; i++) f.contentWindow.postMessage({ type: "openartifacts:comments", event: "threads", data: fake }, "https://${API}");
});
</script>`;
  const hostile = await publish("Hostile", hostileBody, { comments: false });
  const context = await newContext(ALICE, { signedInTo: victim });
  const tab = await context.newPage();
  const seen = postedTo(tab);
  await tab.goto(docUrl(hostile));
  const frame = await until("the victim's frame", () => commentsFrame(tab, victim));
  // Relayed data has no names: the page can invent a comment, not a commenter.
  await frame.getByText("Sign in again").waitFor();
  assert.equal(await frame.getByText("OpenArtifacts Security").count(), 0);
  await frame.getByText("A commenter").waitFor();
  await frame.getByRole("button", { name: "Continue to see names and comment." }).waitFor();
  await tab.waitForTimeout(800);
  assert.equal(await frame.getByRole("button", { name: "Delete" }).count(), 0);
  assert.equal(await frame.getByRole("button", { name: "Resolve", exact: true }).count(), 0);
  assert.equal(await frame.getByRole("textbox").count(), 0);
  assert.deepEqual(seen.filter((line) => !line.startsWith("GET ")), []);
  assert.ok(seen.length <= 3, `twenty relayed messages made ${seen.length} reads`);
  // The resolved card's summary too: its version is typed, so a string cannot carry a name into it.
  await frame.getByRole("button", { name: "1 resolved" }).click();
  await frame.getByText("Resolved", { exact: true }).waitFor();
  assert.equal(await frame.getByText("OpenArtifacts Security").count(), 0);
  await context.close();
});

test("a 30,000-character decomposed paragraph is located without freezing the page", { timeout: 120_000 }, async () => {
  const nfd = "Tiếng Việt ".repeat(2500);
  const docId = await publish("Slow", `<p id="big">${nfd}ENDMARK closes the paragraph here.</p>`);
  await agentThread(docId, { exact: "ENDMARK closes the paragraph", section: "big" }, "At the very end.");
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  const started = Date.now();
  await tab.goto(docUrl(docId));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1, 20_000);
  assert.ok(Date.now() - started < 8000, `located in ${Date.now() - started} ms`);
  await context.close();
});

/** A public page that embeds `victim`'s comments frame and relays a made-up thread into it, under a real-looking name. */
const relayingPage = (victim) => `<h1>Survey</h1>
<script>
const f = document.createElement("iframe");
f.src = "https://${API}/embed/comments?doc=${victim}&origin=" + encodeURIComponent(location.origin);
f.style.cssText = "position:absolute;left:0;top:0;width:320px;height:500px";
document.body.append(f);
const fake = { title: "x", version: 1, threads: [{ threadId: "th_fake", anchor: { exact: "x" }, anchorStatus: "orphaned", state: "open", canResolve: true,
  comments: [{ commentId: "cm_fake", author: { name: "OpenArtifacts Security", kind: "human" }, body: "Made-up words", createdAt: 1, mine: true }] }] };
window.addEventListener("message", (e) => {
  if (e.source !== f.contentWindow || !e.data || e.data.event !== "ready") return;
  f.contentWindow.postMessage({ type: "openartifacts:comments", event: "threads", data: fake }, "https://${API}");
});
</script>`;

test("the frame's own read wins over what the page relays", { timeout: 120_000 }, async () => {
  const victim = await publish("Public victim", REPORT);
  await agentThread(victim, { exact: "Staffing is unchanged" }, "A real remark.");
  // Orphaned by the next version, so the thread is drawn even though no page script places it.
  await update(victim, REPORT.replace("Staffing is unchanged", "Staff are unchanged"));
  const hostile = await publish("Relayer", relayingPage(victim), { comments: false });
  const context = await newContext(null);
  const tab = await context.newPage();
  await tab.goto(docUrl(hostile));
  const frame = await until("the victim's frame", () => commentsFrame(tab, victim));
  await frame.getByText("A real remark.").waitFor();
  await tab.waitForTimeout(800);
  assert.equal(await frame.getByText("Made-up words").count(), 0);
  assert.equal(await frame.getByRole("button", { name: "Continue to see names and comment." }).count(), 0);
  await context.close();
});

test("a signed-in reader of a private page sees who commented without signing in to the frame", { timeout: 120_000 }, async () => {
  const docId = await publish("Names", REPORT, { route: "private-docs" });
  await agentThread(docId, { exact: "Staffing is unchanged" }, "A named remark.");
  // Signed in to the API host, but the comments frame holds no token of its own.
  const context = await newContext(OWNER_ACCOUNT);
  const tab = await context.newPage();
  await tab.goto(`https://${API}/open/${docId}`);
  await tab.waitForURL(new RegExp(`/d/${docId}`));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  await frame.getByText("A named remark.").waitFor();
  // The read ticket the page relays lets the frame read the names itself: no "A commenter", no button to see them.
  await until("the author's name", async () => (await frame.locator(".who").first().innerText()).includes("Logan"));
  assert.equal(await frame.getByText("A commenter").count(), 0);
  assert.equal(await frame.getByRole("button", { name: "Continue to see names and comment." }).count(), 0);
  await frame.getByRole("button", { name: "Sign in to comment." }).waitFor();
  await shoot(tab, "private-names");
  await context.close();
});

test("a signed-in Can-view reader on a phone is never offered Comment, not even before the frame answers", { timeout: 120_000 }, async () => {
  const docId = await publish("Can view", REPORT, { route: "private-docs" });
  // A card, so the frame has a reply box to replace with "You can view this page." once it knows.
  await agentThread(docId, { exact: "Closing remarks follow in the appendix" }, "A remark.");
  const response = await api(`/api/v1/docs/${docId}/access/people/bob%40example.com`, { method: "PUT", body: JSON.stringify({ role: "view" }) });
  assert.equal(response.status, 200, await response.clone().text());
  const context = await newContext(BOB, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, signedInTo: docId });
  const tab = await context.newPage();
  // The frame's thread reads wait for the test's word, so the page has no viewer message yet when the reader selects. Held inside the frame rather than by `context.route`, which this harness does not use.
  await tab.addInitScript((api) => {
    if (location.host !== api || location.pathname !== "/embed/comments") return;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    window.__release = () => release();
    const original = window.fetch;
    window.fetch = (input, init) => {
      const held = String(input).includes("/threads") && (!init || !init.method || init.method === "GET");
      return held ? gate.then(() => original(input, init)) : original(input, init);
    };
  }, API);
  await tab.goto(`https://${API}/open/${docId}`);
  await tab.waitForURL(new RegExp(`/d/${docId}`));
  await barButton(tab).waitFor();
  const tip = tab.locator(".openartifacts-comment-tip");
  await select(tab, "Staffing is unchanged");
  // Past the page's 150 ms settle, so the tip would be up by now if it were going to be.
  await tab.waitForTimeout(400);
  assert.equal(await tip.isVisible(), false, "no Comment before the frame answers");
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  await frame.evaluate(() => window.__release());
  await frame.locator("button.row").click();
  await frame.getByText("You can view this page.").waitFor();
  await select(tab, "The budget is on the next page");
  await tab.waitForTimeout(400);
  assert.equal(await tip.isVisible(), false, "no Comment once the frame says view");
  await context.close();
});

test("typing in a card survives the page re-measuring and the frame redrawing on every few keystrokes", { timeout: 120_000 }, async () => {
  // A page whose own script keeps moving its text (a ticker, a clock): every move re-measures the sidebar and sends new positions, which redraw the cards, while the reader types.
  const docId = await publish("Ticker", REPORT, { html: page(REPORT, "<style>main.tick{padding-top:3px}</style>") });
  await agentThread(docId, { exact: "Revenue grew 18% quarter over quarter" }, "Is 18% the right base?");
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  await frame.locator("textarea[data-key^='r:']").waitFor({ state: "attached" });
  await select(tab, "Staffing is unchanged");
  const tip = tab.locator(".openartifacts-comment-tip");
  await until("the Comment button", async () => await tip.isVisible());
  await tip.click();
  const draft = frame.getByRole("textbox", { name: "Add a comment…" });
  await draft.waitFor();
  await draft.click();
  // Each new position the page measures redraws the cards: count the redraws.
  await frame.evaluate(() => {
    window.redrawn = 0;
    new MutationObserver(() => window.redrawn++).observe(document.querySelector("main").firstElementChild, { childList: true });
  });
  await tab.evaluate(() => { window.ticker = setInterval(() => document.querySelector("main").classList.toggle("tick"), 30); });
  const words = "the sidebar moved under me while I was typing this";
  await tab.keyboard.type(words, { delay: 20 });
  await tab.evaluate(() => clearInterval(window.ticker));
  assert.ok((await frame.evaluate(() => window.redrawn)) >= 5, "the page re-measured, and the frame redrew the cards, while the reader typed");
  assert.equal(await draft.inputValue(), words, "no keystroke was lost");
  assert.equal(await frame.evaluate(() => document.activeElement.dataset.key), "draft", "the draft kept the focus");
  await context.close();
});

test("a page served before a push reads and writes comments at the version on screen", { timeout: 120_000 }, async () => {
  const docId = await publish("Pushed under the reader", REPORT);
  const quote = "Staffing is unchanged";
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  // The page's first thread read waits until a second version has landed, as it would for a tab opened from the 60-second cache.
  await tab.addInitScript((serving) => {
    if (location.host !== serving) return;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    window.__release = () => release();
    const original = window.fetch;
    window.fetch = (input, init) => (String(input).includes("/threads") ? gate.then(() => original(input, init)) : original(input, init));
  }, SERVING);
  const asked = [];
  tab.on("request", (request) => { if (request.url().includes(`/d/${docId}/threads`)) asked.push(request.url()); });
  await tab.goto(docUrl(docId));
  assert.equal(await tab.locator("a[data-openartifacts-share]").getAttribute("data-version"), "1");
  assert.equal(await update(docId, REPORT.replace(quote, "Staff are unchanged")), 2);
  await tab.evaluate(() => window.__release());

  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await barButton(tab).waitFor();
  assert.ok(asked.length > 0 && asked.every((url) => url.endsWith("?v=1")), asked.join(", "));
  await select(tab, quote);
  const tip = tab.locator(".openartifacts-comment-tip");
  await until("the Comment button", async () => await tip.isVisible());
  await tip.click();
  const box = frame.getByRole("textbox", { name: "Add a comment…" });
  await box.waitFor();
  await box.fill("Written against the first version.");
  await frame.locator("[data-thread='']").getByRole("button", { name: "Send" }).click();
  await frame.getByText("Written against the first version.").waitFor();

  const at = async (v) => (await (await api(`/api/v1/docs/${docId}/threads?v=${v}`)).json()).threads;
  assert.equal((await at(1))[0].anchorStatus, "anchored");
  assert.equal((await at(1))[0].comments[0].atVersion, 1);
  assert.equal((await at(2))[0].anchorStatus, "orphaned");
  await context.close();
});

test("a thread read that answers after a newer one does not paint over it", { timeout: 120_000 }, async () => {
  const docId = await publish("Late answer", REPORT);
  const context = await newContext(null);
  const tab = await context.newPage();
  // On the test's word, the page's next thread read is sent at once but its answer is held, as a slow poll's would be.
  await tab.addInitScript((serving) => {
    if (location.host !== serving) return;
    const original = window.fetch;
    window.__hold = () => new Promise((taken) => {
      window.fetch = (input, init) => {
        if (!String(input).includes("/threads")) return original(input, init);
        window.fetch = original;
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        window.__release = () => release();
        taken();
        return original(input, init).then((response) => gate.then(() => response));
      };
    });
  }, SERVING);
  await tab.goto(docUrl(docId));
  const button = barButton(tab);
  await button.waitFor();
  assert.equal((await button.textContent()).trim(), "Comments");

  const ask = () => tab.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const held = tab.evaluate(() => window.__hold());
  await ask();
  await held;
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Posted between the two reads.");
  await ask();
  await until("the newer read to count one", async () => /1$/.test(await button.innerText()));
  await tab.evaluate(() => window.__release());
  await tab.waitForTimeout(500);
  assert.match(await button.innerText(), /1$/, "the older answer did not take the thread away");
  await context.close();
});

test("the owner of a private page nobody else can comment on selects text and gets Comment and the Comments button, without opening Share, and posts", { timeout: 120_000 }, async () => {
  const docId = await publish("Private, alone", REPORT, { route: "private-docs", comments: false });
  // A Can-view invitee makes nobody else a commenter, the owner's real situation.
  await db.prepare("INSERT INTO doc_invites (doc_id, email, role, created_at) VALUES (?, 'bob@example.com', 'view', ?)").bind(docId, Date.now()).run();
  const context = await newContext(OWNER_ACCOUNT, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(`https://${API}/open/${docId}`);
  await tab.waitForURL(new RegExp(`/d/${docId}`));
  assert.equal(await tab.locator("a[data-openartifacts-share]").getAttribute("data-comments"), "off");
  assert.equal(await barButton(tab).count(), 0);
  await select(tab, "Staffing is unchanged");
  await until("the Comment button", () => tab.locator(".openartifacts-comment-tip").isVisible());
  await barButton(tab).waitFor();
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  await frame.getByText("Select text to comment.").waitFor();
  await shoot(tab, "sidebar-private-owner-alone");

  // The first comment posts, and the Comments button stays, now counting it.
  await pressComment(tab, "Staffing is unchanged");
  await frame.getByRole("textbox", { name: "Add a comment…" }).fill("Is this still true?");
  await frame.locator("[data-thread='']").getByRole("button", { name: "Send" }).click();
  await until("the thread", async () => (await threadsOf(docId)).length === 1);
  await until("its card", async () => (await cardFor(frame, "Is this still true?").count()) === 1);
  await until("the Comments button counting it", async () => /1$/.test(await barButton(tab).innerText()));
  await context.close();
});

test("a signed-out visitor to a public page nobody can comment on selects text and sees nothing change", { timeout: 120_000 }, async () => {
  const docId = await publish("Public, alone", REPORT, { comments: false });
  const context = await newContext(null);
  const tab = await context.newPage();
  const requests = [];
  tab.on("request", (request) => requests.push(request.url()));
  await tab.goto(docUrl(docId));
  await tab.locator("a[data-openartifacts-share]").waitFor();
  assert.equal(requests.some((url) => url.includes("/threads")), false, "the load makes no threads request");
  const answered = tab.waitForResponse((response) => response.url().includes("/threads"));
  await select(tab, "Staffing is unchanged");
  // The probe's frame is built, and answers no: its anonymous thread read has come back and a frame has been drawn since.
  const frame = await until("the hidden probe frame", () => commentsFrame(tab, docId));
  assert.ok(frame);
  await answered;
  await tab.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await tab.locator(".openartifacts-comment-tip").isVisible().catch(() => false), false);
  assert.equal(await barButton(tab).count(), 0);
  assert.equal(await hostBox(tab), null, "no sidebar");
  await context.close();
});

test("pressing Comment under another thread's highlight starts a draft and leaves that thread alone", { timeout: 120_000 }, async () => {
  const html = page(`<h1>Stack</h1>\n<p id="a">Alpha alpha alpha alpha alpha alpha.</p>\n<p id="b">Bravo bravo bravo bravo bravo.</p>`, "<style>p{margin:0 0 4px}</style>");
  const docId = await publish("Pill over a thread", "", { html });
  await agentThread(docId, { exact: "Alpha alpha alpha alpha alpha alpha.", section: "a" }, "Above the pill.");
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  await openSidebar(tab);
  await cardFor(frame, "Above the pill.").waitFor();

  await select(tab, "Bravo bravo bravo");
  const tip = tab.locator(".openartifacts-comment-tip");
  await until("the Comment button", async () => (await tip.isVisible()) && (await tip.boundingBox()).width > 0);
  const pill = await tip.boundingBox();
  const above = await rectOf(tab, "Alpha alpha alpha");
  assert.ok(pill.y < above.y + above.height && pill.y + pill.height > above.y, "the fixture puts the pill over the other thread's line");
  await tab.mouse.click(pill.x + pill.width / 2, pill.y + pill.height / 2);

  await frame.getByRole("textbox", { name: "Add a comment…" }).waitFor();
  await tab.waitForTimeout(600);
  assert.equal(await frame.getByRole("textbox", { name: "Add a comment…" }).count(), 1, "the draft is still there");
  assert.equal(await frame.locator("[data-thread].focus").count(), 0, "the other thread was not focused");
  assert.deepEqual(await painted(tab, "openartifacts-draft"), ["Bravo bravo bravo"]);
  assert.deepEqual(await painted(tab, "openartifacts-focus"), []);
  await context.close();
});

test("Send keeps the comment on screen, with a sending state, until the page has drawn the new thread", { timeout: 120_000 }, async () => {
  const docId = await publish("Sending", REPORT);
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  await frame.getByText("Select text to comment.").waitFor();
  const quote = "Staffing is unchanged";
  await pressComment(tab, quote);
  const field = frame.getByRole("textbox", { name: "Add a comment…" });
  await field.fill("Who is staffed?");
  // A slow write in the frame, and then a slow read in the page: the two waits the reader would otherwise stare at.
  await frame.evaluate(() => {
    const real = window.fetch;
    window.fetch = (url, init) => (init && init.method === "POST" && String(url).endsWith("/threads") ? new Promise((resolve) => setTimeout(resolve, 1200)).then(() => real(url, init)) : real(url, init));
  });
  await tab.evaluate(() => {
    const real = window.fetch;
    window.fetch = (url, init) => (String(url).includes("/threads") ? new Promise((resolve) => setTimeout(resolve, 3000)).then(() => real(url, init)) : real(url, init));
  });
  await frame.getByRole("button", { name: "Send" }).click();

  // While the write is in flight the composer is still there, read-only, and Send shows it is working.
  assert.equal(await frame.locator("[data-thread=''] button.send.busy").count(), 1, "Send shows a sending state");
  assert.equal(await field.evaluate((el) => el.readOnly), true);
  assert.equal(await field.inputValue(), "Who is staffed?");

  // Once the write has landed and the page's refresh has not, the comment is a card at the passage, not nothing.
  await until("the sent comment as a card", async () => (await threadsOf(docId)).length === 1);
  const card = frame.locator("[data-thread]:not([data-thread=''])");
  await until("the card", async () => (await card.count()) === 1 && (await card.innerText()).includes("Who is staffed?"), 2500);
  assert.deepEqual(await painted(tab, "openartifacts-draft"), [quote], "the passage stays marked until the new highlight replaces it");
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1, 8000);
  assert.deepEqual(await painted(tab, "openartifacts-draft"), []);
  const level = await rectOf(tab, quote);
  await until("the card to sit level with its passage", async () => Math.abs((await card.boundingBox()).y - level.y) <= 2);
  await context.close();
});

test("on a phone Comment docks at the bottom centre, clear of the system's menu, and a tap keeps its passage even if the live selection clears", { timeout: 180_000 }, async () => {
  const filler = Array.from({ length: 10 }, (_, i) => `<p>Filler paragraph ${i + 1}. It carries enough words to reach the bottom of a phone screen.</p>`).join("\n");
  const docId = await publish("Phone pill", REPORT + filler);
  await agentThread(docId, { exact: "Closing remarks follow in the appendix" }, "Which appendix?");
  const context = await newContext(ALICE, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  const quote = "Staffing is unchanged";
  assert.equal(await select(tab, quote), true);
  const tip = tab.locator(".openartifacts-comment-tip");
  await until("the Comment button", async () => (await tip.isVisible()) && (await tip.boundingBox()).width > 0);
  // Not beside the selection, where iOS puts its Copy menu above or below as room allows: at the bottom centre of the viewport.
  const docked = async () => {
    const box = await tip.boundingBox();
    return box.height >= 44 && box.y >= 844 - 80 && box.y + box.height <= 844 - 12 + 0.5 && Math.abs(box.x + box.width / 2 - 195) < 2;
  };
  assert.ok(await docked(), `the pill is docked at the bottom centre (${JSON.stringify(await tip.boundingBox())})`);
  const pill = await tip.boundingBox();
  await shoot(tab, "phone-comment-pill");

  // Selection handles change the passage and the button stays docked; clearing it hides the button.
  await select(tab, "Revenue grew 18%");
  await tab.waitForTimeout(300);
  assert.ok(await docked(), "a selection near the top leaves it docked");
  // A selection that ends just above the dock would have the system's menu below it, over the button: it docks under the bar instead.
  const low = "Filler paragraph 9.";
  await tab.evaluate((y) => window.scrollBy(0, y), (await rectOf(tab, low)).y + 20 - (844 - 120));
  await select(tab, low);
  await until("the button under the bar", async () => {
    const box = await tip.boundingBox();
    return Math.abs(box.y - (48 + 12)) < 1 && Math.abs(box.x + box.width / 2 - 195) < 2;
  });
  await tab.evaluate(() => window.scrollTo(0, 0));
  await tab.evaluate(() => window.getSelection().removeAllRanges());
  await until("the button to hide", async () => !(await tip.isVisible()));
  await select(tab, quote);
  await until("the button back in its dock", async () => (await tip.isVisible()) && (await docked()));

  // The page changes text above the passage while the button is up, as a live clock would, and is re-measured (80ms later): the tap must still open on the passage, not on offsets into the old text.
  await tab.evaluate(() => document.querySelector("h1").firstChild.insertData(0, "Final "));
  await tab.waitForTimeout(300);
  // Reproduce the mobile selection-loss ordering deterministically: the native
  // selection disappears before the button's click handler gets its turn.
  await tab.evaluate(() => {
    document.addEventListener("click", () => window.getSelection().removeAllRanges(), { capture: true, once: true });
  });
  await tab.touchscreen.tap(pill.x + pill.width / 2, pill.y + pill.height / 2);
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  await until("the composer to have focus", async () => frame.evaluate(() => document.activeElement && document.activeElement.dataset.key === "draft"));
  assert.deepEqual(await painted(tab, "openartifacts-draft"), [quote]);
  const area = frame.getByRole("textbox", { name: "Add a comment…" });
  await area.fill("Who is staffed?");
  await frame.getByRole("button", { name: "Send" }).tap();
  await until("the new thread", async () => (await threadsOf(docId)).length === 2);
  await frame.getByText("Who is staffed?").waitFor();
  assert.equal((await threadsOf(docId))[1].anchor.exact, quote);
  await until("the posted passage to be highlighted", async () => (await painted(tab, "openartifacts-open")).includes(quote));
  await shoot(tab, "phone-comment-posted");

  // With the sheet up, a new selection's button sits just above it, never over it.
  await select(tab, "Revenue grew 18%");
  await until("the button above the sheet", async () => {
    if (!(await tip.isVisible())) return false;
    const [box, sheet] = [await tip.boundingBox(), await hostBox(tab)];
    return Math.abs(box.y + box.height - (sheet.y - 12)) < 1 && Math.abs(box.x + box.width / 2 - 195) < 2;
  });
  await context.close();
});

const MARK_RULES = {
  dark: [
    "::highlight(openartifacts-open){background-color:rgba(255,176,32,.2)}",
    "::highlight(openartifacts-focus){background-color:rgba(255,176,32,.2);text-decoration:underline;text-decoration-color:rgba(255,176,32,.9);text-decoration-thickness:2px}",
    "::highlight(openartifacts-draft){background-color:rgba(255,176,32,.36);text-decoration:underline;text-decoration-color:rgba(255,176,32,.9);text-decoration-thickness:2px}",
  ],
  light: [
    "::highlight(openartifacts-open){background-color:rgba(255,200,0,.28)}",
    "::highlight(openartifacts-focus){background-color:rgba(255,200,0,.5)}",
    "::highlight(openartifacts-draft){background-color:rgba(255,184,0,.5)}",
  ],
};

for (const [theme, head] of [
  ["dark", "<style>body{color:#e9ebee;background:#1b1d24}</style>"],
  ["light", ""],
]) {
  test(`a ${theme} page's open, active and draft passages are marked with exactly the ${theme} colours`, { timeout: 120_000 }, async () => {
    const html = page(REPORT, head);
    const docId = await publish(`Marks, ${theme}`, "", { html });
    await agentThread(docId, { exact: "Revenue grew 18% quarter over quarter", section: "growth" }, "Which quarter?");
    await agentThread(docId, { exact: "Renewal risk is concentrated in three accounts" }, "Which accounts?");
    const context = await newContext(ALICE, { signedInTo: docId });
    const tab = await context.newPage();
    await tab.goto(docUrl(docId));
    const frame = await until("the comments frame", () => commentsFrame(tab, docId));
    await until("both highlights", async () => (await painted(tab, "openartifacts-open")).length === 2);
    const rules = await tab.evaluate(() => document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).filter((text) => text.includes("openartifacts-")));
    // Compared as the browser serialises them, so build the expectation the same way.
    const expected = await tab.evaluate((texts) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(texts.join(""));
      return [...sheet.cssRules].map((rule) => rule.cssText);
    }, MARK_RULES[theme]);
    assert.deepEqual(rules, expected);
    await openSidebar(tab);
    await cardFor(frame, "Which accounts?").click();
    await until("the active thread", async () => (await painted(tab, "openartifacts-focus")).length === 1);
    await tab.mouse.move(5, 5);
    await shoot(tab, `marks-${theme}-active`);
    await pressComment(tab, "Staffing is unchanged");
    await until("the draft", async () => (await painted(tab, "openartifacts-draft")).length === 1);
    await shoot(tab, `marks-${theme}-draft`);
    await context.close();
  });
}

test("a keyboard draft on a passage under the pointer is painted as open and draft only, never with the hover layer", { timeout: 120_000 }, async () => {
  const docId = await publish("Keyboard draft", REPORT);
  const quote = "Revenue grew 18% quarter over quarter";
  await agentThread(docId, { exact: quote, section: "growth" }, "Which quarter?");
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await until("the comments frame", () => commentsFrame(tab, docId));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  const box = await rectOf(tab, quote);
  await tab.mouse.move(box.x + 20, box.y + box.height / 2);
  await until("the hover layer", async () => (await painted(tab, "openartifacts-focus")).length === 1);
  assert.equal(await select(tab, quote), true);
  const mac = await tab.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await tab.keyboard.press(mac ? "Meta+Alt+KeyM" : "Control+Alt+KeyM");
  await until("the draft", async () => (await painted(tab, "openartifacts-draft")).length === 1);
  assert.deepEqual(await painted(tab, "openartifacts-open"), [quote]);
  assert.deepEqual(await painted(tab, "openartifacts-focus"), []);
  await context.close();
});
