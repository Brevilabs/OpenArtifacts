/**
 * Inline comments in a real browser: `npm run test:browser`, with the Share
 * popover's test beside it.
 *
 * The vitest suite runs inside workerd and cannot load a page, so
 * `test/comments-*.test.ts` and `test/serve.test.ts` cover the HTTP contract and
 * this covers the DOM: the page script's selection, canonical text, highlights
 * and measuring; the comments frame's sidebar and sheet, sign-in and writes; and the two
 * halves talking across the origin line.
 *
 * It uses the same harness as `test/share-popover.browser.mjs` (read its header
 * for why: the deployed bundle under Miniflare over HTTPS, Chrome pointed at it
 * by `--host-resolver-rules`, no `context.route`), with the one addition comments
 * need, the `DocComments` Durable Object binding. Threads are created through the
 * real API as the owner's agent where a test is not about posting, and through
 * the frame, after the real sign-in popup, where it is.
 *
 * Needs Node 22 and a Google Chrome. `OA_HEADED=1` shows the browser, and
 * `OA_SCREENSHOTS={dir}` saves the sidebar with an open card, a resolved card, the
 * orphaned section, a Can-view card and the phone's bottom sheet.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

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
const CAROL = accountId("d");

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
 * Alice, Carol and Dan are the readers these tests comment as; Bob is never given a role
 * here, so he reads and cannot write.
 */
async function grantCommenters(docId) {
  for (const email of ["alice@example.com", "carol@example.com", "dan@example.com", "fran@example.com"]) {
    await db
      .prepare("INSERT OR IGNORE INTO doc_invites (doc_id, email, role, created_at) VALUES (?, ?, 'comment', ?)")
      .bind(docId, email, Date.now())
      .run();
  }
}

async function update(docId, body, head = "") {
  const response = await api(`/api/v1/docs/${docId}`, { method: "PUT", body: JSON.stringify({ html: page(body, head) }) });
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
    // No display name: her first comment names her from her email.
    [CAROL, "carol@example.com", null],
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
async function newContext(account, { viewport = { width: 1280, height: 800 }, signedInTo } = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
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

test("a selection offers Comment, the frame posts after sign-in, and the card sits level with its passage", { timeout: 180_000 }, async () => {
  const docId = await publish("Q3 client report", REPORT);
  const context = await newContext(CAROL);
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));

  // 1. The bar gets a Comments button beside Share, with no count while nothing is open, and the sidebar closed.
  const button = barButton(tab);
  await button.waitFor();
  assert.equal((await button.textContent()).trim(), "Comments");
  assert.equal(await button.getAttribute("aria-pressed"), "false");
  const bar = await tab.locator(".openartifacts-bar").boundingBox();
  const shareBox = await tab.locator("a[data-openartifacts-share]").boundingBox();
  const buttonBox = await button.boundingBox();
  assert.ok(buttonBox.x + buttonBox.width <= shareBox.x && shareBox.x - (buttonBox.x + buttonBox.width) < 24, "the button sits just left of Share");
  assert.ok(bar.width > 0);

  // 2. Pressed, it opens the sidebar: a frame to the right of the content, as tall as the page.
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  const content = await tab.locator("#content").boundingBox();
  const side = await hostBox(tab);
  assert.ok(side.x >= content.x + content.width, `the frame (${side.x}) starts right of the content (${content.x + content.width})`);
  assert.ok(side.x + side.width <= 1280);
  assert.ok(side.height >= (await tab.evaluate(() => document.documentElement.scrollHeight)) - 2);
  const authorBefore = await tab.locator("#content").innerHTML();

  // 3. Signed out, nothing offers Comment: the sidebar's one line invites the people who may comment to sign in.
  const quote = "Renewal risk is concentrated in three accounts";
  const tip = tab.locator(".openartifacts-comment-tip");
  assert.equal(await select(tab, quote), true);
  await tab.waitForTimeout(400);
  assert.equal(await tip.isVisible().catch(() => false), false, "no Comment before sign-in");
  const signIn = frame.getByRole("button", { name: "Invited to comment? Sign in." });
  await signIn.waitFor();
  const [popup] = await Promise.all([context.waitForEvent("page"), signIn.click()]);
  await popup.waitForEvent("close").catch(() => {});
  await frame.getByText("Select text to comment.").waitFor();

  // Signed in and allowed, selecting text shows a floating Comment button; a selection inside the bar shows none.
  await select(tab, quote);
  await until("the Comment button", async () => (await tip.isVisible()) && (await tip.boundingBox()).width > 0);
  const passage = await rectOf(tab, quote);
  const tipBox = await tip.boundingBox();
  assert.ok(tipBox.y < passage.y, "the button is above the selection");
  await tab.evaluate(() => {
    const selection = window.getSelection();
    selection.selectAllChildren(document.querySelector(".openartifacts-bar"));
  });
  await until("the button to go away", async () => !(await tip.isVisible()));
  await select(tab, quote);
  await until("the Comment button", async () => await tip.isVisible());

  // 4. Comment opens a draft card at the selection, with the quote.
  await tab.mouse.click(tipBox.x + tipBox.width / 2, tipBox.y + tipBox.height / 2);
  const composer = frame.getByRole("textbox", { name: "Add a comment…" });
  await composer.waitFor();
  assert.equal(await frame.getByText("Comment on “Q3 client report”").count(), 0, "no header");
  assert.equal(await frame.locator("[data-thread=''] .quote").count(), 0, "no quoted passage");
  assert.equal(await frame.getByRole("button", { name: "Cancel" }).count(), 0, "no Cancel");

  // 5. The composer is there. Carol has no name: she is not asked, and is named from her email.
  const box = frame.getByRole("textbox", { name: "Add a comment…" });
  await box.waitFor();
  await shoot(tab, "sidebar-draft-card");
  await box.fill("This overstates the renewal risk; two of the three accounts already renewed.");
  await frame.locator("[data-thread='']").getByRole("button", { name: "Send" }).click();

  // 6. The card stays beside the passage, the highlight is painted, the count is 1.
  const card = frame.locator("[data-thread]:not([data-thread=''])");
  await card.waitFor();
  assert.match(await card.innerText(), /carol/);
  assert.match(await card.innerText(), /This overstates the renewal risk/);
  await until("the bar to count one", async () => (await button.textContent()).trim() === "Comments 1");
  await until("the card to sit level with its passage", async () => {
    const level = await rectOf(tab, quote);
    const cardBox = await card.boundingBox();
    return Math.abs(cardBox.y - level.y) <= 2;
  });
  assert.deepEqual(await painted(tab, "openartifacts-open"), [quote]);
  assert.equal(await tab.locator("#content").innerHTML(), authorBefore, "the author's DOM is untouched");
  await shoot(tab, "sidebar-open-card");

  // 7. The page holds no credential: nothing of ours in its storage or cookies.
  assert.deepEqual(await tab.evaluate(() => Object.keys(window.localStorage).concat(Object.keys(window.sessionStorage))), []);
  assert.equal(await tab.evaluate(() => document.cookie), "");
  const stored = await threadsOf(docId);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].comments[0].author, { name: "carol", kind: "human" });
  assert.equal(stored[0].anchor.exact, quote);
  assert.equal(stored[0].anchor.prefix.length > 0 && stored[0].anchor.suffix.length > 0, true);
  assert.equal(stored[0].anchor.section, "risk");

  // 8. Pressing the bar's button closes the sidebar and the highlights stay; again, it opens it.
  await button.click();
  await until("the sidebar to close", async () => (await hostBox(tab)) === null);
  assert.equal(await button.getAttribute("aria-pressed"), "false");
  // Released, it is Share's own painted pill, not see-through: an older cached page's bar is light.
  assert.equal(await button.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(29, 32, 39)");
  assert.deepEqual(await painted(tab, "openartifacts-open"), [quote]);
  await button.click();
  await until("the sidebar", async () => (await hostBox(tab)) !== null);

  // 9. Replying in the card posts under it, and the count does not change.
  await card.locator(".txt").first().click();
  const reply = frame.getByRole("textbox", { name: "Reply…" });
  await reply.fill("Fixed in my draft.");
  await frame.getByRole("button", { name: "Send" }).click();
  await until("the reply", async () => (await card.innerText()).includes("Fixed in my draft."));
  assert.equal((await threadsOf(docId))[0].comments.length, 2);
  await context.close();
});

test("a resolved thread is off the page, waits behind a count, and opens with its agent reply", { timeout: 120_000 }, async () => {
  const docId = await publish("Resolved", REPORT);
  const quote = "Renewal risk is concentrated in three accounts";
  const threadId = await agentThread(docId, { exact: quote, section: "risk" }, "This overstates the renewal risk.");
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Is that deliberate?");
  const reply = await api(`/api/v1/docs/${docId}/threads/${threadId}/comments`, { method: "POST", body: JSON.stringify({ body: "Softened in v1." }) });
  assert.equal(reply.status, 201);
  assert.equal((await api(`/api/v1/docs/${docId}/threads/${threadId}/resolve`, { method: "POST", body: "{}" })).status, 200);

  // Alice owns nothing here; the owner's token would see Reopen, hers does not.
  const owner = await newContext(OWNER_ACCOUNT, { signedInTo: docId });
  const tab = await owner.newPage();
  await tab.goto(docUrl(docId));
  await openSidebar(tab);
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  const toggle = frame.getByRole("button", { name: "1 resolved" });
  await toggle.waitFor();
  await until("the bar to count the open thread only", async () => /1$/.test(await barButton(tab).innerText()));
  assert.deepEqual(await painted(tab, "openartifacts-resolved"), []);
  assert.deepEqual(await painted(tab, "openartifacts-open"), ["Staffing is unchanged"]);
  assert.equal(await frame.locator("[data-thread]").count(), 1, "only the open thread has a card");

  await toggle.click();
  const expanded = frame.locator("[data-thread].resolved");
  await expanded.getByText("Softened in v1.").waitFor();
  assert.match(await expanded.locator(".where").innerText(), /^Resolved in v1 by Logan's agent$/);
  assert.equal(await expanded.locator(".who .badge", { hasText: "agent" }).count(), 2, "both comments are the agent's");
  await shoot(tab, "sidebar-resolved-expanded");
  await expanded.getByRole("button", { name: "Reopen" }).click();
  await until("the thread to reopen", async () => (await threadsOf(docId, "open")).length === 2);
  await until("the count", async () => /2$/.test(await barButton(tab).innerText()));
  await owner.close();
});

test("a thread whose text was rewritten waits at the top under On text that changed, with its quote, and returns beside it when the text does", { timeout: 180_000 }, async () => {
  const docId = await publish("Orphan", REPORT);
  const quote = "The budget is on the next page";
  await agentThread(docId, { exact: quote }, "Which page?");
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Say who is staffed.");

  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await openSidebar(tab);
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("two cards", async () => (await frame.locator("[data-thread]").count()) === 2);

  // v2 rewrites the first quote away.
  const v2 = await update(docId, REPORT.replace(quote, "Appendix B has the budget"));
  assert.equal(v2, 2);
  await tab.reload();
  await openSidebar(tab);
  const again = await until("the comments frame", () => commentsFrame(tab, docId));
  const heading = again.getByText("On text that changed", { exact: true });
  await heading.waitFor();
  const orphan = again.locator("[data-thread].muted");
  await orphan.waitFor();
  assert.match(await orphan.locator(".quote").innerText(), /The budget is on the next page/);
  assert.match(await orphan.innerText(), /Which page\?/);
  // Still open, still counted, and the other thread still sits level with its passage.
  await until("the bar to count both", async () => /2$/.test(await barButton(tab).innerText()));
  assert.deepEqual(await painted(tab, "openartifacts-open"), ["Staffing is unchanged"]);
  await until("the anchored card level with its passage", allLevel(tab, again, [["Say who is staffed.", "Staffing is unchanged"]]));
  const top = await heading.boundingBox();
  const orphanBox = await orphan.boundingBox();
  const staffing = await again.locator("[data-thread]:not(.muted)").boundingBox();
  assert.ok(top.y < orphanBox.y && orphanBox.y + orphanBox.height <= staffing.y + 1, "the orphan is stacked above the anchored cards");
  await shoot(tab, "sidebar-orphaned");
  // Opaque on any author background: no opacity to let a dark page through, and a chip behind the heading.
  assert.equal(await orphan.evaluate((el) => getComputedStyle(el).opacity), "1");
  assert.equal(await again.locator(".heading").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)");

  // The pinned page of v1 still has the text, so its card is back beside it.
  const old = await context.newPage();
  await old.goto(docUrl(docId, 1));
  const pinnedFrame = await until("the pinned frame", () => commentsFrame(old, docId));
  assert.match(pinnedFrame.url(), /&v=1$/);
  await until("both cards beside their text", async () => (await painted(old, "openartifacts-open")).length === 2);
  await openSidebar(old);
  await until("two cards", async () => (await pinnedFrame.locator("[data-thread]").count()) === 2);
  assert.equal(await pinnedFrame.getByText("On text that changed").count(), 0);

  // v3 brings the text back; the thread anchors again on its own.
  await update(docId, REPORT);
  await tab.reload();
  await openSidebar(tab);
  const third = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("both beside their text again", async () => (await painted(tab, "openartifacts-open")).length === 2);
  await until("two cards", async () => (await third.locator("[data-thread]").count()) === 2);
  assert.equal(await third.getByText("On text that changed").count(), 0);
  await context.close();
});

test("a Can-view reader sees the cards with no reply box and no Comment button", { timeout: 180_000 }, async () => {
  const docId = await publish("Private report", REPORT, { route: "private-docs" });
  const invite = async (email, role) => {
    const response = await api(`/api/v1/docs/${docId}/access/people/${encodeURIComponent(email)}`, { method: "PUT", body: JSON.stringify({ role }) });
    assert.equal(response.status, 200, await response.clone().text());
  };
  await invite("bob@example.com", "view");
  await invite("alice@example.com", "comment");
  const quote = "Renewal risk is concentrated in three accounts";
  await agentThread(docId, { exact: quote, section: "risk" }, "Add owners for each step.");

  for (const [who, account, canComment] of [["Bob", BOB, false], ["Alice", ALICE, true]]) {
    const context = await newContext(account, { signedInTo: docId });
    const tab = await context.newPage();
    // The door on the API host swaps the session for the publisher origin's grant.
    await tab.goto(`https://${API}/open/${docId}`);
    await tab.waitForURL(new RegExp(`^https://[a-z0-9]+\\.${SERVING.replaceAll(".", "\\.")}/d/${docId}`));
    const frame = await until(`${who}'s comments frame`, () => commentsFrame(tab, docId));
    await openSidebar(tab);
    const card = frame.locator("[data-thread]");
    await card.waitFor();
    assert.match(await card.innerText(), /Add owners for each step/);
    assert.deepEqual(await painted(tab, "openartifacts-open"), [quote]);

    if (canComment) {
      await card.locator(".txt").first().click();
      await frame.getByRole("textbox", { name: "Reply…" }).waitFor();
      assert.equal(await frame.getByText("You can view this page.").count(), 0);
    } else {
      await frame.getByText("You can view this page.").waitFor();
      assert.equal(await frame.getByRole("textbox").count(), 0);
      assert.equal(await frame.getByRole("button", { name: "Send" }).count(), 0);
      // Selecting text shows no Comment button once the frame has said so.
      await select(tab, "Staffing is unchanged");
      await tab.waitForTimeout(600);
      assert.equal(await tab.locator(".openartifacts-comment-tip").isVisible().catch(() => false), false);
      await shoot(tab, "sidebar-can-view");
    }
    await context.close();
  }
});

test("a narrow page draws no sidebar; a tapped highlight or Comment opens a bottom sheet", { timeout: 180_000 }, async () => {
  const docId = await publish("Phone", REPORT);
  const quote = "Renewal risk is concentrated in three accounts";
  await agentThread(docId, { exact: quote, section: "risk" }, "Is this still true?");

  const context = await newContext(ALICE, { viewport: { width: 390, height: 844 }, signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  assert.equal(await hostBox(tab), null, "nothing drawn on a phone until something is tapped");
  assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal scroll");

  // Tapping the highlight opens its card as a sheet across the bottom, drawn as that card from the start: a sheet drawn first as the list would change height under the reader's finger.
  await frame.evaluate(() => {
    window.sawList = false;
    new MutationObserver(() => { if (document.querySelector("button.row")) window.sawList = true; }).observe(document.body, { childList: true, subtree: true });
  });
  const at = await rectOf(tab, quote);
  await tab.mouse.click(at.x + at.width / 3, at.y + at.height / 2);
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  await frame.getByText("Is this still true?").waitFor();
  assert.equal(await frame.evaluate(() => window.sawList), false, "the tapped thread, never the list first");
  const sheet = await hostBox(tab);
  assert.equal(Math.round(sheet.x), 0);
  assert.equal(Math.round(sheet.width), 390);
  assert.ok(Math.abs(sheet.y + sheet.height - 844) < 2, "the sheet sits on the bottom edge");
  assert.ok(sheet.height <= 844 * 0.55 + 4, "never taller than 55vh");
  await frame.getByText("Is this still true?").waitFor();
  assert.equal(await frame.locator("[data-thread]").count(), 1);
  await shoot(tab, "phone-bottom-sheet");

  // Its close button hides it again.
  await frame.getByRole("button", { name: "Close" }).click();
  await until("the sheet to close", async () => (await hostBox(tab)) === null);

  // The bar's button closes a sheet that is open, and opens the list of comments when none is: no stale focused passage, and the highlights stay.
  await tab.mouse.click(at.x + at.width / 3, at.y + at.height / 2);
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  await until("the focused passage", async () => (await painted(tab, "openartifacts-focus")).length === 1);
  await barButton(tab).click();
  await until("the sheet to close", async () => (await hostBox(tab)) === null);
  await barButton(tab).click();
  await until("the list", async () => (await hostBox(tab)) !== null);
  await frame.locator("button.row").waitFor();
  assert.equal((await painted(tab, "openartifacts-focus")).length, 0, "no stale focus");
  assert.equal((await painted(tab, "openartifacts-open")).length, 1);
  await barButton(tab).click();
  await until("the sheet to close", async () => (await hostBox(tab)) === null);

  // Selecting text and pressing Comment opens a new card the same way.
  await select(tab, "Staffing is unchanged");
  const tip = tab.locator(".openartifacts-comment-tip");
  await until("the Comment button", async () => await tip.isVisible());
  const tipBox = await tip.boundingBox();
  await tab.mouse.click(tipBox.x + tipBox.width / 2, tipBox.y + tipBox.height / 2);
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  const area = frame.getByRole("textbox", { name: "Add a comment…" });
  await until("the sheet to fit its card", async () => (await hostBox(tab)).height < 844 * 0.55 - 20);
  await area.fill("Who is staffed?");
  await frame.locator("[data-thread='']").getByRole("button", { name: "Send" }).click();
  await until("the new thread", async () => (await threadsOf(docId)).length === 2);
  await until("the new thread to show", async () => (await frame.getByText("Who is staffed?").count()) === 1);
  assert.equal((await threadsOf(docId))[1].anchor.exact, "Staffing is unchanged");
  await context.close();
});

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

test("a page with no thread and nobody who can comment is untouched by the script", { timeout: 60_000 }, async () => {
  const docId = await publish("Quiet", REPORT, { comments: false });
  const context = await newContext(ALICE);
  const tab = await context.newPage();
  const requests = [];
  tab.on("request", (request) => requests.push(request.url()));
  await tab.goto(docUrl(docId));
  await tab.locator("a[data-openartifacts-share]").waitFor();
  await tab.waitForTimeout(800);
  assert.equal(await barButton(tab).count(), 0);
  assert.equal(await tab.locator(".openartifacts-comments").count(), 0);
  assert.equal(requests.some((url) => url.includes("/embed/comments")), false);
  // The bar says comments are off, so the script does not even ask the threads resource.
  assert.equal(await tab.locator("a[data-openartifacts-share]").getAttribute("data-comments"), "off");
  assert.equal(requests.some((url) => url.includes("/threads")), false);
  assert.equal(await tab.evaluate(() => CSS.highlights.size), 0);
  // The Share popover still works.
  await tab.locator("a[data-openartifacts-share]").click();
  await until("the Share frame", () => tab.frames().find((frame) => frame.url().includes("/embed/share")));
  await context.close();
});

test("the Comments button appears, without a reload, after the owner adds a person who can comment in Share", { timeout: 120_000 }, async () => {
  const docId = await publish("Nobody yet", REPORT, { comments: false });
  const context = await newContext(OWNER_ACCOUNT, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await tab.locator("a[data-openartifacts-share]").waitFor();
  assert.equal(await tab.locator("a[data-openartifacts-share]").getAttribute("data-comments"), "off");
  await tab.waitForTimeout(500);
  assert.equal(await barButton(tab).count(), 0);

  await tab.locator("a[data-openartifacts-share]").click();
  const share = await until("the Share frame", () => tab.frames().find((frame) => frame.url().includes("/embed/share")));
  const box = share.getByPlaceholder("Emails, separated by commas");
  await box.waitFor();
  // Opening the popover as the owner changed nothing on the page.
  assert.equal(await barButton(tab).count(), 0);
  await box.fill("newcomer@example.com");
  await share.getByRole("button", { name: "Add", exact: true }).click();
  await barButton(tab).waitFor();
  assert.equal((await barButton(tab).textContent()).trim(), "Comments");
  await context.close();
});

test("the Share popover posts nothing when its owner view is drawn; closing it as the owner brings the Comments button and Comment", { timeout: 120_000 }, async () => {
  const docId = await publish("Owner only", REPORT, { comments: false });
  const context = await newContext(OWNER_ACCOUNT, { signedInTo: docId });
  const tab = await context.newPage();
  const requests = [];
  tab.on("request", (request) => requests.push(request.url()));
  await tab.goto(docUrl(docId));
  await tab.locator("a[data-openartifacts-share]").click();
  const share = await until("the Share frame", () => tab.frames().find((frame) => frame.url().includes("/embed/share")));
  await share.getByPlaceholder("Emails, separated by commas").waitFor();
  // Drawn, not clicked: a page that could see this would learn that its visitor owns the document.
  await tab.waitForTimeout(800);
  assert.equal(await barButton(tab).count(), 0);
  assert.equal(requests.some((url) => url.includes("/threads")), false);
  await share.getByRole("button", { name: "Close" }).click();
  await barButton(tab).waitFor();
  assert.equal((await barButton(tab).textContent()).trim(), "Comments");
  // The owner is signed in to the frame through Share's own token, so Comment is theirs before anyone else can write.
  await openSidebar(tab);
  await commentsFrame(tab, docId).getByText("Select text to comment.").waitFor();
  await select(tab, "Staffing is unchanged");
  await until("the Comment button", () => tab.locator(".openartifacts-comment-tip").isVisible());
  await context.close();
});

test("a signed-out reader is shown no sign-in line when only the owner's agent has commented", { timeout: 120_000 }, async () => {
  const docId = await publish("Agent only", REPORT, { comments: false });
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Is that deliberate?");
  const context = await newContext(null);
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  await frame.locator("[data-thread]").waitFor();
  await tab.waitForTimeout(500);
  assert.deepEqual(await frame.getByRole("button").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label"))), ["Close comments"], "nothing to press but the header's close");
  assert.equal(await frame.getByText(/Sign in|Select text|Continue/).count(), 0);
  assert.equal(await frame.getByRole("textbox").count(), 0);
  await context.close();
});

test("a stranger signed in on a public page gets no Comment and is told they can view", { timeout: 120_000 }, async () => {
  const docId = await publish("Public", REPORT);
  await agentThread(docId, { exact: "Closing remarks follow in the appendix" }, "A remark.");
  const context = await newContext(BOB, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  await frame.getByText("You can view this page.").waitFor();
  assert.equal(await frame.getByRole("textbox").count(), 0);
  assert.equal(await frame.getByText(/Select text|Invited to comment/).count(), 0);
  await select(tab, "Staffing is unchanged");
  await tab.waitForTimeout(500);
  assert.equal(await tab.locator(".openartifacts-comment-tip").isVisible().catch(() => false), false);
  await context.close();
});

// ---- front-end review fixes ---------------------------------------------------------------------------------

/** What Obsidian Copilot's export wraps a note in: a 46rem column, centred, which leaves 272px at 1280px. */
const copilotPage = (body, extra = "") =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Q3 report</title>\n` +
  `<style>body{margin:0;font:16px/1.6 Georgia,serif;color:#222;background:#fffdf8}main.publish-renderer{width:min(100% - 2rem, 46rem);margin:0 auto;padding:2rem 0}p{margin:0 0 1.2rem}${extra}</style>\n</head>\n` +
  `<body>\n<main class="publish-renderer" id="content">\n${body}\n</main>\n</body>\n</html>\n`;

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
  comments: [{ commentId: "cm_fake", author: { name: "OpenArtifacts Security", kind: "human" }, body: "Sign in again", createdAt: 1, mine: true }] }] };
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
  assert.equal(await frame.getByRole("button", { name: "Resolve" }).count(), 0);
  assert.equal(await frame.getByRole("textbox").count(), 0);
  assert.deepEqual(seen.filter((line) => !line.startsWith("GET ")), []);
  assert.ok(seen.length <= 3, `twenty relayed messages made ${seen.length} reads`);
  await context.close();
});

test("the real Copilot column gets the sidebar beside it at 1280px, and cards past the document's end extend the page", { timeout: 180_000 }, async () => {
  const body = REPORT.replace("<h1>Q3 client report</h1>", "<h1>Q3 client report</h1>");
  const docId = await publish("Copilot", body, { html: copilotPage(body) });
  const last = "Closing remarks follow in the appendix";
  const first = await agentThread(docId, { exact: last }, "Which appendix?");
  for (let i = 1; i <= 9; i++) {
    const reply = await api(`/api/v1/docs/${docId}/threads/${first}/comments`, { method: "POST", body: JSON.stringify({ body: `Reply number ${i}: the appendix needs a title, a date and the name of whoever owns it, so the reader can tell.` }) });
    assert.equal(reply.status, 201);
  }
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  const content = await tab.locator("#content").boundingBox();
  const side = await hostBox(tab);
  assert.ok(side.x >= content.x + content.width, "a column beside the text, not a sheet");
  assert.equal(Math.round(side.width), 320);
  const card = frame.locator("[data-thread]");
  await card.waitFor();
  await until("the page to grow to the card", async () => {
    const box = await card.boundingBox();
    const scrollY = await tab.evaluate(() => window.scrollY);
    const total = await tab.evaluate(() => document.scrollingElement.scrollHeight);
    return total >= box.y + scrollY + box.height - 2;
  });
  assert.equal(await frame.evaluate(() => document.scrollingElement.scrollHeight <= window.innerHeight + 1), true, "the frame itself does not scroll");
  await tab.mouse.wheel(0, 3000);
  await tab.waitForTimeout(300);
  assert.equal(await frame.evaluate(() => document.scrollingElement.scrollTop), 0);
  await shoot(tab, "sidebar-long-thread");
  await context.close();
});

test("an empty reply box shows no buttons, and typing, or dragging the box taller, re-stacks the cards", { timeout: 120_000 }, async () => {
  const docId = await publish("Stack", REPORT);
  await agentThread(docId, { exact: "Revenue grew 18% quarter over quarter", section: "growth" }, "Is 18% the right base?");
  await agentThread(docId, { exact: "led by the integration pilot", prefix: "quarter over quarter, ", section: "growth" }, "Name the pilot.");
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  const cards = frame.locator("[data-thread]");
  await until("two cards", async () => (await cards.count()) === 2);
  const clear = async () => {
    const a = await cards.nth(0).boundingBox();
    const b = await cards.nth(1).boundingBox();
    return b.y >= a.y + a.height - 1;
  };
  await cards.nth(0).locator(".txt").click();
  assert.equal(await cards.nth(0).getByRole("button", { name: "Send" }).isDisabled(), true, "Send is off while the box is empty");
  assert.equal(await clear(), true);
  await cards.nth(0).getByRole("textbox").fill("A reply");
  assert.equal(await cards.nth(0).getByRole("button", { name: "Send" }).isDisabled(), false);
  await until("the second card to stay clear", clear);
  await cards.nth(0).getByRole("textbox").evaluate((el) => { el.style.height = "220px"; });
  await until("the second card to make room", clear);
  assert.ok((await cards.nth(0).boundingBox()).height > 220);
  await context.close();
});

test("the phone sheet fits its card, keeps the passage in view, and a touch on the page keeps a draft", { timeout: 180_000 }, async () => {
  const filler = Array.from({ length: 14 }, (_, i) => `<p>Filler paragraph ${i + 1}. It carries enough words to push the passages below the first screen of a phone, so that tapping one has to bring it back into view.</p>`).join("\n");
  const body = `${filler}\n<p id="late">The renewal pipeline closes on Friday and nobody owns it yet.</p>\n${filler}`;
  const docId = await publish("Phone", body);
  const quote = "The renewal pipeline closes on Friday";
  await agentThread(docId, { exact: quote, section: "late" }, "Who owns it?");
  const context = await newContext(ALICE, { viewport: { width: 390, height: 844 }, signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  await tab.evaluate(() => window.scrollTo(0, document.getElementById("late").getBoundingClientRect().top + window.scrollY - 500));
  await tab.waitForTimeout(300);
  const at = await rectOf(tab, quote);
  await tab.mouse.click(at.x + at.width / 3, at.y + at.height / 2);
  const sheet = await until("the sheet", () => hostBox(tab));
  await frame.getByText("Who owns it?").waitFor();
  await until("the passage to clear the sheet", async () => {
    const now = await rectOf(tab, quote);
    const box = await hostBox(tab);
    return now.y >= 40 && now.y + now.height <= box.y;
  });
  // The reply box arrives once the frame has read who is looking; the sheet grows to hold it.
  await frame.getByRole("textbox", { name: "Reply…" }).waitFor();
  await until("the sheet to wrap its whole card", async () => {
    const box = await hostBox(tab);
    const card = await frame.locator("[data-thread]").boundingBox();
    const slack = box.y + box.height - (card.y + card.height);
    return slack >= 0 && slack < 40 && box.height < 844 * 0.55 - 40;
  });
  const fitted = await hostBox(tab);
  await shoot(tab, "phone-bottom-sheet-fitted");
  assert.ok(sheet);

  // The close button is a plain ×, inside the sheet.
  const x = await frame.getByRole("button", { name: "Close" }).evaluate((el) => ({ border: getComputedStyle(el).borderTopWidth, right: el.getBoundingClientRect().right, width: window.innerWidth }));
  assert.equal(x.border, "0px");
  assert.ok(x.right <= x.width);
  await frame.getByRole("button", { name: "Close" }).click();
  await until("the sheet to close", async () => (await hostBox(tab)) === null);

  // A draft survives a touch on the page above the sheet.
  await tab.evaluate(() => window.scrollTo(0, 0));
  await select(tab, "Filler paragraph 2.");
  const tip = tab.locator(".openartifacts-comment-tip");
  await until("the Comment button", async () => await tip.isVisible());
  const tipBox = await tip.boundingBox();
  await tab.mouse.click(tipBox.x + tipBox.width / 2, tipBox.y + tipBox.height / 2);
  const area = frame.getByRole("textbox", { name: "Add a comment…" });
  await until("the sheet to fit its card", async () => (await hostBox(tab)).height < 844 * 0.55 - 20);
  await area.fill("A long careful comment I was writing");
  await tab.mouse.click(200, 60);
  await tab.waitForTimeout(400);
  assert.notEqual(await hostBox(tab), null, "the sheet stays up");
  assert.equal(await area.inputValue(), "A long careful comment I was writing");
  await context.close();
});

test("a selection that ends in our footer, or crosses a body-level script, still offers Comment and posts", { timeout: 180_000 }, async () => {
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bare</title>\n<style>body{max-width:640px;margin:0 auto;padding:0 16px;font:16px/1.6 Georgia,serif}</style></head>\n<body>\n<p id="a">Alpha text sits above the script.</p>\n<style>.x{color:red}</style>\n<script>var zzz = 1;</script>\n<p id="b">Beta text sits below the script.</p>\n</body></html>\n`;
  const docId = await publish("Bare", "", { html });
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  const tip = tab.locator(".openartifacts-comment-tip");

  // Triple-clicking the last paragraph selects up to the footer.
  await tab.locator("#b").click({ clickCount: 3 });
  await until("the Comment button after a triple-click", async () => await tip.isVisible());

  // A selection across the style and script that are direct children of <body>.
  await tab.evaluate(() => {
    const range = document.createRange();
    range.setStart(document.getElementById("a").firstChild, 22);
    range.setEnd(document.getElementById("b").firstChild, 9);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await until("the Comment button across the script", async () => await tip.isVisible());
  const box = await tip.boundingBox();
  await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await frame.getByRole("textbox", { name: "Add a comment…" }).fill("Across the script");
  await frame.locator("[data-thread='']").getByRole("button", { name: "Send" }).click();
  await until("the thread", async () => (await threadsOf(docId)).length === 1);
  const [thread] = await threadsOf(docId);
  assert.equal(thread.anchorStatus, "anchored");
  assert.match(thread.anchor.exact, /^the script\.\s+Beta text$/);

  // Select-all covers the bar and is still refused.
  await tab.evaluate(() => document.execCommand("selectAll"));
  await tab.waitForTimeout(600);
  assert.equal(await tip.isVisible().catch(() => false), false);
  await context.close();
});

test("a quote that runs into a <pre> posts, and text drawn by the page's own script says why it cannot", { timeout: 180_000 }, async () => {
  const body = `<p id="p">Before the log:</p>\n<pre id="log">\nline one of the log\nline two of the log</pre>\n<p id="drawn"></p>\n<script>document.getElementById("drawn").textContent = "This sentence is drawn by a script.";</script>`;
  const docId = await publish("Pre", body);
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  const tip = tab.locator(".openartifacts-comment-tip");
  const pick = async (from, fromAt, to, toAt) => {
    await tab.evaluate(([a, ai, b, bi]) => {
      const node = (id) => { const w = document.createTreeWalker(document.getElementById(id), NodeFilter.SHOW_TEXT); return w.nextNode(); };
      const range = document.createRange();
      range.setStart(node(a), ai);
      range.setEnd(node(b), bi);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, [from, fromAt, to, toAt]);
    await until("the Comment button", async () => await tip.isVisible());
    const box = await tip.boundingBox();
    await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  await pick("p", 11, "log", 12);
  await frame.getByRole("textbox", { name: "Add a comment…" }).fill("Spans into the pre.");
  await frame.locator("[data-thread='']").getByRole("button", { name: "Send" }).click();
  await until("the thread", async () => (await threadsOf(docId)).length === 1);
  assert.equal((await threadsOf(docId))[0].anchorStatus, "anchored");

  await pick("drawn", 0, "drawn", 18);
  await frame.getByRole("textbox", { name: "Add a comment…" }).fill("On drawn text.");
  await frame.locator("[data-thread='']").getByRole("button", { name: "Send" }).click();
  await frame.getByText(/isn’t in the document itself/).waitFor();
  assert.equal(await frame.getByText(/Quote it exactly as that version reads/).count(), 0);
  assert.equal((await threadsOf(docId)).length, 1);
  await context.close();
});

test("the page re-measures when a <details> opens under html,body{height:100%}, and a poll does not rebuild the box being typed in", { timeout: 180_000 }, async () => {
  const body = `<p>Intro paragraph that comes first.</p>\n<details id="d"><summary>More</summary>${"<p>Hidden filler text that makes the section tall when it is opened.</p>".repeat(6)}</details>\n<p id="after">The text after the details block is the thread's passage.</p>`;
  const docId = await publish("Details", body, { html: page(body, "<style>html,body{height:100%}</style>") });
  await agentThread(docId, { exact: "The text after the details block", section: "after" }, "Moves with the text?");
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  const card = frame.locator("[data-thread]");
  await card.waitFor();
  const level = async () => Math.abs((await card.boundingBox()).y - (await rectOf(tab, "The text after the details block")).y) <= 2;
  await until("level at first", level);
  await tab.locator("#d summary").click();
  await until("level after the details opened", level);

  // A refresh with nothing new leaves the focused box (and so its caret, undo history and composition) alone.
  // The reply box shows on the focused card.
  await card.locator(".txt").first().click();
  const box = card.getByRole("textbox");
  await box.fill("half a thought");
  const handle = await box.elementHandle();
  await tab.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await tab.waitForTimeout(1200);
  assert.equal(await handle.evaluate((el) => el.isConnected), true, "the same textarea is still in the frame");
  assert.equal(await box.inputValue(), "half a thought");
  await context.close();
});

test("html{zoom} and an inner scroller do not break the sidebar, and a fixed contents list beside the text stays clickable", { timeout: 180_000 }, async () => {
  const quote = "Renewal risk is concentrated in three accounts";
  // 1. html{zoom:1.5} at 1920px: the host stays inside the viewport and the page does not scroll sideways.
  const zoomed = await publish("Zoom", REPORT, { html: page(REPORT, "<style>html{zoom:1.5}</style>") });
  await agentThread(zoomed, { exact: quote, section: "risk" }, "Zoomed?");
  let context = await newContext(ALICE, { viewport: { width: 1920, height: 900 }, signedInTo: zoomed });
  let tab = await context.newPage();
  await tab.goto(docUrl(zoomed));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  await openSidebar(tab);
  const h = await hostBox(tab);
  assert.ok(h.x + h.width <= 1920, `the host (${h.x + h.width}) is inside the viewport`);
  assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "no sideways scroll");
  const content = await tab.locator("#content").boundingBox();
  assert.ok(content.x + content.width <= h.x, "the zoomed text stays left of the column");
  // The floating Comment button is zoomed with the page too: it must still sit by the selection, inside the viewport.
  await select(tab, "Staffing is unchanged");
  const zoomTip = tab.locator(".openartifacts-comment-tip");
  await until("the Comment button", async () => await zoomTip.isVisible());
  const zoomTipBox = await zoomTip.boundingBox();
  const selected = await tab.evaluate(() => { const r = window.getSelection().getRangeAt(0).getClientRects(); return { mid: (r[0].left + r[0].right) / 2, top: r[0].top }; });
  assert.ok(zoomTipBox.y >= 0 && zoomTipBox.y + zoomTipBox.height <= 900, `the button (${zoomTipBox.y}) is inside the viewport`);
  assert.ok(Math.abs(zoomTipBox.y - (selected.top - 44)) < 12 && Math.abs(zoomTipBox.x + zoomTipBox.width / 2 - selected.mid) < 12, "the button is centred over the selection");
  await context.close();

  // 2. A page that scrolls in a 100vh container, not in the window, gets the sheet, not a column that cannot follow it.
  const inner = `<div id="sc" style="width:600px;height:100vh;overflow:auto;margin:0 auto"><div id="content">${"<p>Filler paragraph before the passage, with some words.</p>".repeat(30)}<p id="t">The passage that is far down inside the container.</p></div></div>`;
  const scroller = await publish("Inner", inner, { html: `<!doctype html><html><head><meta charset="utf-8"><title>Inner</title><style>html,body{height:100%;overflow:hidden;margin:0}</style></head><body>${inner}</body></html>` });
  await agentThread(scroller, { exact: "The passage that is far down inside the container" }, "Far down.");
  context = await newContext(ALICE, { signedInTo: scroller });
  tab = await context.newPage();
  await tab.goto(docUrl(scroller));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  await barButton(tab).click();
  const sheet = await until("the sheet", () => hostBox(tab));
  assert.ok(Math.abs(sheet.y + sheet.height - 800) < 2, "a bottom sheet, not a column");
  assert.equal(await tab.evaluate(() => getComputedStyle(document.documentElement).paddingRight), "0px", "the page keeps its width");
  await context.close();

  // 3. A fixed contents list beside the text stays clickable with the sidebar open.
  const nav = `<nav id="toc" style="position:fixed;left:700px;top:120px;width:160px"><a id="toclink" href="#risk">Risks</a></nav>`;
  const fixed = await publish("Fixed", REPORT + nav);
  await agentThread(fixed, { exact: quote, section: "risk" }, "Fixed?");
  context = await newContext(ALICE, { signedInTo: fixed });
  tab = await context.newPage();
  await tab.goto(docUrl(fixed));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  await openSidebar(tab);
  const link = await tab.locator("#toclink").boundingBox();
  assert.equal(await tab.evaluate(([x, y]) => document.elementFromPoint(x, y).id, [link.x + 4, link.y + 4]), "toclink");
  await context.close();
});

test("an inner scroller that starts with its passage in view switches from the sidebar to the sheet once it scrolls away, even with tall cards", { timeout: 120_000 }, async () => {
  const inner = `<div id="sc" style="width:600px;height:100vh;overflow:auto;margin:0 auto"><div id="content"><p id="t">The passage that is in view at load.</p>${"<p>Filler paragraph after the passage, with some words.</p>".repeat(40)}</div></div>`;
  const docId = await publish("InnerTall", inner, { html: `<!doctype html><html><head><meta charset="utf-8"><title>Inner</title><style>html,body{height:100%;overflow:hidden;margin:0}</style></head><body>${inner}</body></html>` });
  // One comment taller than the viewport: the sidebar's column then needs more than a screen.
  await agentThread(docId, { exact: "The passage that is in view at load" }, "A long remark that fills the card. ".repeat(70));
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  await openSidebar(tab);
  await until("the cards to need more than a screen", async () => (await hostBox(tab)).height > 800);
  await tab.evaluate(() => { document.getElementById("sc").scrollTop = 1500; });
  await until("the sidebar to give way to the sheet", async () => {
    const box = await hostBox(tab);
    return box !== null && Math.abs(box.y + box.height - 800) < 2 && box.height <= 800 * 0.55 + 2;
  });
  assert.equal(await tab.evaluate(() => getComputedStyle(document.documentElement).paddingRight), "0px", "the page has its width back");
  await context.close();
});

test("in an inner scroller, the first draft on a page with no thread switches from the sidebar to the sheet once it scrolls away", { timeout: 120_000 }, async () => {
  const inner = `<div id="sc" style="width:600px;height:100vh;overflow:auto;margin:0 auto"><div id="content"><p id="t">The passage that is in view at load.</p>${"<p>Filler paragraph after the passage, with some words.</p>".repeat(40)}</div></div>`;
  const docId = await publish("InnerDraft", inner, { html: `<!doctype html><html><head><meta charset="utf-8"><title>Inner</title><style>html,body{height:100%;overflow:hidden;margin:0}</style></head><body>${inner}</body></html>` });
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await until("the comments frame", () => commentsFrame(tab, docId));
  await pressComment(tab, "The passage that is in view at load");
  await until("the sidebar", async () => (await tab.evaluate(() => getComputedStyle(document.documentElement).paddingRight)) === "320px");
  await tab.evaluate(() => { document.getElementById("sc").scrollTop = 1500; });
  await until("the sidebar to give way to the sheet", async () => {
    const box = await hostBox(tab);
    return box !== null && Math.abs(box.y + box.height - 800) < 2 && box.height <= 800 * 0.55 + 2;
  });
  assert.equal(await tab.evaluate(() => getComputedStyle(document.documentElement).paddingRight), "0px", "the page has its width back");
  await context.close();
});

test("a positions message that only changes the host height does not rebuild the reply box being typed in", { timeout: 120_000 }, async () => {
  const docId = await publish("LastLine", `<p>First line.</p><p id="last">The very last line of text.</p>`);
  await agentThread(docId, { exact: "The very last line of text", section: "last" }, "Last?");
  const context = await newContext(ALICE, { viewport: { width: 1280, height: 700 }, signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  const card = frame.locator("[data-thread]");
  await card.waitFor();
  await card.locator(".txt").first().click();
  const box = card.getByRole("textbox");
  await box.fill("a reply\n".repeat(12));
  await until("the field to grow to its cap", async () => (await box.boundingBox()).height >= 150);
  const grown = (await box.boundingBox()).height;
  const handle = await box.elementHandle();
  await tab.waitForTimeout(1500);
  assert.equal(await handle.evaluate((el) => el.isConnected), true, "the same textarea is still in the frame");
  assert.equal((await box.boundingBox()).height, grown, "it keeps the height it grew to");
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

test("a reader with no token sees the cards read-only and one sign-in line, only where someone can comment", { timeout: 120_000 }, async () => {
  const docId = await publish("Anonymous", REPORT);
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Is that deliberate?");
  const context = await newContext(null);
  const tab = await context.newPage();
  const seen = postedTo(tab);
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  const card = frame.locator("[data-thread]");
  await card.waitFor();
  await frame.getByRole("button", { name: "Invited to comment? Sign in." }).waitFor();
  assert.equal(await card.getByRole("textbox").count(), 0);
  // Select text: a signed-out reader is never offered Comment.
  await select(tab, "Staffing is unchanged");
  await tab.waitForTimeout(500);
  assert.equal(await tab.locator(".openartifacts-comment-tip").isVisible().catch(() => false), false);
  assert.equal(await card.getByRole("button", { name: "Delete" }).count(), 0);
  assert.equal(await card.getByRole("button", { name: "Resolve" }).count(), 0);
  assert.deepEqual(seen.filter((line) => !line.startsWith("GET ")), []);
  await shoot(tab, "sidebar-sign-in-card");
  await context.close();
});

test("on a dark author page the orphan heading and the muted card stay legible", { timeout: 120_000 }, async () => {
  const dark = "<style>body{background:#111316!important;color:#e8e6e1}</style>";
  const body = REPORT;
  const docId = await publish("Dark", body, { html: page(body, dark) });
  await agentThread(docId, { exact: "The budget is on the next page" }, "Which page?");
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Say who is staffed.");
  await update(docId, REPORT.replace("The budget is on the next page", "Appendix B has the budget"), dark);
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  await frame.getByText("On text that changed", { exact: true }).waitFor();
  assert.equal(await frame.locator(".card.muted").evaluate((el) => getComputedStyle(el).opacity), "1");
  await shoot(tab, "sidebar-dark-page-orphan");
  await context.close();
});

/** A public page that embeds `victim`'s comments frame and relays a made-up thread into it, under a real-looking name. */
const relayingPage = (victim, query = "") => `<h1>Survey</h1>
<script>
const f = document.createElement("iframe");
f.src = "https://${API}/embed/comments?doc=${victim}${query}&origin=" + encodeURIComponent(location.origin);
f.style.cssText = "position:absolute;left:0;top:0;width:320px;height:500px";
document.body.append(f);
const fake = { title: "x", version: 1, threads: [{ threadId: "th_fake", anchor: { exact: "x" }, anchorStatus: "orphaned", state: "open", canResolve: true,
  comments: [{ commentId: "cm_fake", author: { name: "OpenArtifacts Security", kind: "human" }, body: "Made-up words", createdAt: 1, mine: true }] },
  { threadId: "th_done", anchor: { exact: "y" }, anchorStatus: "orphaned", state: "resolved", resolution: { atVersion: "2 by OpenArtifacts Security", by: {} },
  comments: [{ commentId: "cm_done", author: { name: "x", kind: "human" }, body: "Settled", createdAt: 1 }] }] };
window.addEventListener("message", (e) => {
  if (e.source !== f.contentWindow || !e.data || e.data.event !== "ready") return;
  f.contentWindow.postMessage({ type: "openartifacts:comments", event: "threads", data: fake }, "https://${API}");
});
</script>`;

test("relayed threads are drawn without names and with a sign-in note when the frame has no read of its own", { timeout: 120_000 }, async () => {
  const victim = await publish("Victim", REPORT);
  // A version that does not exist: the anonymous read answers 404, as a private document's would, so only the relay is left to draw.
  const hostile = await publish("Relayer", relayingPage(victim, "&v=999999999"), { comments: false });
  const context = await newContext(null);
  const tab = await context.newPage();
  await tab.goto(docUrl(hostile));
  const frame = await until("the victim's frame", () => commentsFrame(tab, victim));
  await frame.getByText("Made-up words").waitFor();
  // The resolved card's summary too: its version is typed, so a string cannot carry a name into it.
  await frame.getByRole("button", { name: "1 resolved" }).click();
  await frame.getByText("Resolved", { exact: true }).waitFor();
  assert.equal(await frame.getByText("OpenArtifacts Security").count(), 0);
  await frame.getByText("A commenter").first().waitFor();
  await frame.getByRole("button", { name: "Continue to see names and comment." }).waitFor();
  await context.close();
});

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

test("a pinned page carries no comments flag and still asks; the shared link says on", { timeout: 120_000 }, async () => {
  const docId = await publish("Pinned", REPORT);
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Pinned remark.");
  const context = await newContext(ALICE);
  const tab = await context.newPage();
  const asked = [];
  tab.on("request", (request) => { if (request.url().includes("/threads")) asked.push(request.url()); });
  await tab.goto(docUrl(docId));
  assert.equal(await tab.locator("a[data-openartifacts-share]").getAttribute("data-comments"), "on");
  await barButton(tab).waitFor();
  assert.ok(asked.some((url) => url.includes(`/d/${docId}/threads`)));
  const old = await context.newPage();
  await old.goto(docUrl(docId, 1));
  assert.equal(await old.locator("a[data-openartifacts-share]").getAttribute("data-comments"), null);
  await barButton(old).waitFor();
  await context.close();
});

test("the bar counts every open thread, on a phone and on a wide screen, those whose text changed too", { timeout: 120_000 }, async () => {
  const docId = await publish("Sheet count", REPORT);
  const gone = "The budget is on the next page";
  await agentThread(docId, { exact: gone }, "Which page?");
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Say who is staffed.");
  await update(docId, REPORT.replace(gone, "Appendix B has the budget"));
  // On a phone the word gives way to the count; the sheet's list holds both threads.
  for (const [viewport, expected] of [[{ width: 390, height: 844 }, "2"], [{ width: 1280, height: 800 }, "Comments 2"]]) {
    const context = await newContext(ALICE, { viewport, signedInTo: docId });
    const tab = await context.newPage();
    await tab.goto(docUrl(docId));
    await until("the count", async () => (await barButton(tab).textContent().catch(() => "")).trim() === expected);
    await context.close();
  }
});

test("on a phone, a signed-out invitee can still open the sheet's sign-in line after an update orphaned every thread", { timeout: 120_000 }, async () => {
  const docId = await publish("Phone, all orphaned", REPORT);
  const gone = "The budget is on the next page";
  await agentThread(docId, { exact: gone }, "Which page?");
  await update(docId, REPORT.replace(gone, "Appendix B has the budget"));
  const context = await newContext(null, { viewport: { width: 390, height: 844 } });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  const button = barButton(tab);
  await button.waitFor();
  assert.equal((await painted(tab, "openartifacts-open")).length, 0, "no highlight to tap");
  await button.click();
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  await frame.getByRole("button", { name: "Invited to comment? Sign in." }).waitFor();
  await context.close();
});

test("on a phone, a signed-out invitee can open the sheet's sign-in line when every thread's text is folded away", { timeout: 120_000 }, async () => {
  const hidden = "The folded figures sit here";
  const docId = await publish("Phone, folded", REPORT + `<details><summary>More</summary><p>${hidden}.</p></details>`);
  await agentThread(docId, { exact: hidden }, "Unfold this?");
  const context = await newContext(null, { viewport: { width: 390, height: 844 } });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  const button = barButton(tab);
  await button.waitFor();
  // Located, so the highlight exists, but inside a closed <details> it draws nothing to tap.
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  await button.click();
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  await frame.getByRole("button", { name: "Invited to comment? Sign in." }).waitFor();
  await context.close();
});

test("on a phone without the highlight API, a signed-out invitee can still open the sheet's sign-in line", { timeout: 120_000 }, async () => {
  const docId = await publish("Phone, no highlights", REPORT);
  await agentThread(docId, { exact: "The budget is on the next page" }, "Which page?");
  const context = await newContext(null, { viewport: { width: 390, height: 844 } });
  // A browser that cannot paint: the thread is located, with rects, but nothing marks it to tap.
  await context.addInitScript(() => { delete window.Highlight; });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  const button = barButton(tab);
  await button.waitFor();
  await button.click();
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  await frame.getByRole("button", { name: "Invited to comment? Sign in." }).waitFor();
  await context.close();
});

test("on a phone, a reader who cannot comment on a thread-less page gets a sheet that says so, never a blank one", { timeout: 120_000 }, async () => {
  const docId = await publish("Phone, nothing to show", REPORT);
  const context = await newContext(BOB, { viewport: { width: 390, height: 844 }, signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  const button = barButton(tab);
  await button.waitFor();
  await button.click();
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  await frame.getByText("No comments yet.", { exact: true }).waitFor();
  await frame.locator(".head").getByText("Comments", { exact: true }).waitFor();
  await context.close();
});

test("a signed-in Can-view reader is never offered Comment, not even before the frame answers", { timeout: 120_000 }, async () => {
  const docId = await publish("Can view", REPORT, { route: "private-docs" });
  // A card, so the frame has a reply box to replace with "You can view this page." once it knows.
  await agentThread(docId, { exact: "Closing remarks follow in the appendix" }, "A remark.");
  const response = await api(`/api/v1/docs/${docId}/access/people/bob%40example.com`, { method: "PUT", body: JSON.stringify({ role: "view" }) });
  assert.equal(response.status, 200, await response.clone().text());
  const context = await newContext(BOB, { signedInTo: docId });
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

test("the owner of a public page nobody can comment on gets Comment on the first selection, found by one probe", { timeout: 120_000 }, async () => {
  const docId = await publish("Public, alone", REPORT, { comments: false });
  const context = await newContext(OWNER_ACCOUNT, { signedInTo: docId });
  const tab = await context.newPage();
  const requests = [];
  tab.on("request", (request) => requests.push(request.url()));
  await tab.goto(docUrl(docId));
  await tab.locator("a[data-openartifacts-share]").waitFor();
  assert.equal(await tab.locator("a[data-openartifacts-share]").getAttribute("data-comments"), "off");
  assert.equal(requests.some((url) => url.includes("/embed/comments")), false, "the load itself asks nothing");
  assert.equal(await barButton(tab).count(), 0);
  await select(tab, "Staffing is unchanged");
  await until("the Comment button", () => tab.locator(".openartifacts-comment-tip").isVisible());
  await barButton(tab).waitFor();
  await context.close();
});

test("a page that went inert builds no second comments frame when a reader selects text", { timeout: 120_000 }, async () => {
  const docId = await publish("Went inert", REPORT);
  const context = await newContext(null);
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await barButton(tab).waitFor();
  assert.equal(await tab.locator(".openartifacts-comments").count(), 1);
  // The last person at Can comment is removed elsewhere; the next refresh finds nothing to show.
  await db.prepare("DELETE FROM doc_invites WHERE doc_id = ?").bind(docId).run();
  await tab.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await until("the button to go", async () => !(await barButton(tab).isVisible()));
  await select(tab, "Staffing is unchanged");
  await tab.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await tab.locator(".openartifacts-comments").count(), 1, "the one frame the page already has");
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

test("the composer is one field with a Send arrow: grey until there are words, Enter is a newline, an empty draft closes on a click outside", { timeout: 180_000 }, async () => {
  const docId = await publish("Composer", REPORT);
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  await frame.getByText("Select text to comment.").waitFor();
  const tip = tab.locator(".openartifacts-comment-tip");
  const open = async () => {
    await select(tab, "Staffing is unchanged");
    await until("the Comment button", async () => await tip.isVisible());
    const box = await tip.boundingBox();
    await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const field = frame.getByRole("textbox", { name: "Add a comment…" });
    await field.waitFor();
    return field;
  };

  // The button: a dark pill, above the selection and clear of it.
  await select(tab, "Staffing is unchanged");
  await until("the Comment button", async () => await tip.isVisible());
  const pill = await tip.boundingBox();
  const passage = await rectOf(tab, "Staffing is unchanged");
  assert.ok(pill.height >= 34 && pill.height <= 40, `the pill is ${pill.height}px tall`);
  assert.ok(pill.y + pill.height <= passage.y, "the pill is above the text, not over it");
  await shoot(tab, "comment-tip");

  let field = await open();
  const send = frame.getByRole("button", { name: "Send" });
  assert.equal(await send.isDisabled(), true, "grey until there are words");
  await shoot(tab, "composer-empty");
  await field.fill("   ");
  assert.equal(await send.isDisabled(), true, "spaces are not words");
  const one = (await field.boundingBox()).height;
  await field.click();
  await tab.keyboard.type("first line");
  assert.equal(await send.isDisabled(), false);
  await tab.keyboard.press("Enter");
  await tab.keyboard.type("second line");
  await tab.waitForTimeout(300);
  assert.equal((await threadsOf(docId)).length, 0, "Enter did not post");
  assert.ok((await field.boundingBox()).height > one, "the field grew with its text");
  assert.match(await field.inputValue(), /second line$/);
  // Words stay through a click outside and through Escape; emptied, the draft closes on Escape.
  await tab.mouse.click(20, 400);
  await tab.waitForTimeout(300);
  assert.equal(await frame.getByRole("textbox", { name: "Add a comment…" }).count(), 1, "a draft with words stays");
  await field.press("Escape");
  await tab.waitForTimeout(300);
  assert.equal(await frame.getByRole("textbox", { name: "Add a comment…" }).count(), 1, "Escape keeps a draft with words");
  await field.fill("");
  await field.press("Escape");
  await until("the draft to close", async () => (await frame.getByRole("textbox", { name: "Add a comment…" }).count()) === 0);

  // An empty draft closes on a click on the page, and on Escape.
  field = await open();
  await tab.mouse.click(20, 400);
  await until("the empty draft to close on a page click", async () => (await frame.getByRole("textbox", { name: "Add a comment…" }).count()) === 0);
  field = await open();
  await field.press("Escape");
  await until("the empty draft to close on Escape", async () => (await frame.getByRole("textbox", { name: "Add a comment…" }).count()) === 0);

  // Send posts.
  field = await open();
  await field.fill("Is this right?");
  await send.click();
  await until("the post", async () => (await threadsOf(docId)).length === 1);
  await context.close();
});

/** Select `text` and press the floating Comment button with the mouse, the way a reader does. */
async function pressComment(tab, text) {
  const tip = tab.locator(".openartifacts-comment-tip");
  assert.equal(await select(tab, text), true);
  await until("the Comment button", async () => (await tip.isVisible()) && (await tip.boundingBox()).width > 0);
  const box = await tip.boundingBox();
  await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

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

test("resolving takes the thread off the page and offers Undo; resolved threads wait behind a count", { timeout: 120_000 }, async () => {
  const docId = await publish("Resolve", REPORT);
  const risk = "Renewal risk is concentrated in three accounts";
  await agentThread(docId, { exact: risk, section: "risk" }, "This overstates the renewal risk.");
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Is that deliberate?");
  const owner = await newContext(OWNER_ACCOUNT, { signedInTo: docId });
  const tab = await owner.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  const cards = frame.locator("[data-thread]");
  await until("two cards", async () => (await cards.count()) === 2);

  const resolve = cards.first().getByRole("button", { name: "Resolve" });
  assert.equal(await resolve.evaluate((el) => el.textContent.trim()), "", "an icon, not a text link");
  assert.equal(await resolve.getAttribute("title"), "Resolve");
  await resolve.click();
  await until("one card", async () => (await cards.count()) === 1);
  await until("the highlight to go", async () => (await painted(tab, "openartifacts-open")).length === 1);
  assert.deepEqual(await painted(tab, "openartifacts-resolved"), []);
  // In the header row, in place of the count, so it never pushes the cards down.
  await frame.locator(".head").getByRole("button", { name: "Undo" }).waitFor();
  assert.match(await frame.locator(".head").innerText(), /Resolved\s*Undo/);
  await shoot(tab, "sidebar-resolved-undo");

  // Undo brings it back where it was.
  await frame.getByRole("button", { name: "Undo" }).click();
  await until("two cards again", async () => (await cards.count()) === 2);
  await until("both highlights", async () => (await painted(tab, "openartifacts-open")).length === 2);

  // Left alone, the offer goes after a few seconds and the thread waits behind a count.
  await cards.first().getByRole("button", { name: "Resolve" }).click();
  await until("the Undo offer to go", async () => (await frame.getByRole("button", { name: "Undo" }).count()) === 0, 12_000);
  const toggle = frame.getByRole("button", { name: "1 resolved" });
  await toggle.waitFor();
  assert.equal(await cards.count(), 1);
  await toggle.click();
  const done = frame.locator("[data-thread].resolved");
  await done.waitFor();
  const line = done.locator(".where");
  assert.match(await line.innerText(), /^Resolved in v1 by Logan$/);
  assert.equal(await line.evaluate((el) => getComputedStyle(el).textTransform), "none", "a plain sentence");
  assert.equal(await done.locator(".badge.done").count(), 0);
  await shoot(tab, "sidebar-resolved-list");
  await done.getByRole("button", { name: "Reopen" }).click();
  await until("the thread to reopen", async () => (await threadsOf(docId, "open")).length === 2);
  await until("both highlights", async () => (await painted(tab, "openartifacts-open")).length === 2);
  await owner.close();
});

test("in the header, Undo is a button for its few seconds and the resolved count a button whose chevron turns, on a light page and a dark one", { timeout: 180_000 }, async () => {
  const cases = [["light", page(REPORT)], ["dark", page(REPORT, "<style>body{background:#111316;color:#e8e6e1}</style>")]];
  // Found and read in one task inside the frame: the frame rebuilds its header on every render, and a node a locator found can be replaced before a separate read reaches it.
  const headButton = (frame, label, read) =>
    frame.evaluate(([label, read]) => {
      const el = Array.from(document.querySelectorAll(".head button")).find((b) => b.textContent.trim() === label);
      const style = getComputedStyle(read === "turn" ? el.querySelector("svg") : el);
      return read === "turn" ? style.transform : { bg: style.backgroundColor, border: style.borderTopWidth, size: parseFloat(style.fontSize) };
    }, [label, read]);
  for (const [name, html] of cases) {
    const docId = await publish(`Header ${name}`, REPORT, { html });
    await agentThread(docId, { exact: "Renewal risk is concentrated in three accounts", section: "risk" }, "This overstates the renewal risk.");
    await agentThread(docId, { exact: "Staffing is unchanged" }, "Is that deliberate?");
    const owner = await newContext(OWNER_ACCOUNT, { signedInTo: docId });
    const tab = await owner.newPage();
    await tab.goto(docUrl(docId));
    const frame = await until("the comments frame", () => commentsFrame(tab, docId));
    await openSidebar(tab);
    const cards = frame.locator("[data-thread]");
    await until("two cards", async () => (await cards.count()) === 2);
    const head = frame.locator(".head");
    const rowHeight = (await head.boundingBox()).height;

    await cardFor(frame, "Is that deliberate?").getByRole("button", { name: "Resolve" }).click();
    await until("one card", async () => (await cards.count()) === 1);
    const undo = head.getByRole("button", { name: "Undo" });
    await undo.waitFor();
    const offer = await headButton(frame, "Undo");
    assert.notEqual(offer.bg, "rgba(0, 0, 0, 0)", `${name}: Undo is a filled button, not grey text`);
    assert.ok(offer.size >= 12, `${name}: Undo is not small print`);
    assert.equal((await head.boundingBox()).height, rowHeight, `${name}: Undo does not grow the header row`);
    await shoot(tab, `header-undo-${name}`);

    await until("the Undo offer to go", async () => (await undo.count()) === 0, 12_000);
    const toggle = head.getByRole("button", { name: "1 resolved" });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal((await headButton(frame, "1 resolved")).border, "1px", `${name}: the count is outlined as a button`);
    assert.equal(await headButton(frame, "1 resolved", "turn"), "none", `${name}: the chevron points down while closed`);
    const resting = (await headButton(frame, "1 resolved")).bg;
    await toggle.hover();
    await until(`${name}: a hover state`, async () => (await headButton(frame, "1 resolved")).bg !== resting);
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await frame.locator("[data-thread].resolved").waitFor();
    await until(`${name}: the chevron turned`, async () => /^matrix\(-1, /.test(await headButton(frame, "1 resolved", "turn")));
    assert.equal((await head.boundingBox()).height, rowHeight, `${name}: the count does not grow the header row`);
    await shoot(tab, `header-resolved-open-${name}`);
    await owner.close();
  }
});

test("a header control the keyboard is on keeps focus when the frame redraws on its own: Undo, the resolved count and Close", { timeout: 180_000 }, async () => {
  const docId = await publish("Header focus", REPORT);
  await agentThread(docId, { exact: "Renewal risk is concentrated in three accounts", section: "risk" }, "This overstates the renewal risk.");
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Is that deliberate?");
  const owner = await newContext(OWNER_ACCOUNT, { signedInTo: docId });
  const tab = await owner.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  const cards = frame.locator("[data-thread]");
  await until("two cards", async () => (await cards.count()) === 2);
  const head = frame.locator(".head");
  const focused = () => frame.evaluate(() => (document.activeElement ? document.activeElement.getAttribute("aria-label") || document.activeElement.textContent.trim() : ""));
  let width = 1280;
  // Focus the control, mark its node, and reflow the page without any input to the frame: the page's new positions redraw the frame, which a node without the mark proves.
  const survives = async (label, control) => {
    await control.focus();
    await control.evaluate((el) => { el.dataset.before = "1"; });
    width = width === 1280 ? 1000 : 1280;
    await tab.setViewportSize({ width, height: 800 });
    await until(`the header redrawn under ${label}`, () => frame.evaluate(() => !document.querySelector(".head [data-before]")));
    assert.equal(await focused(), label, `${label} keeps focus through a redraw`);
  };

  await cardFor(frame, "Is that deliberate?").getByRole("button", { name: "Resolve" }).click();
  await until("one card", async () => (await cards.count()) === 1);
  await survives("Undo", head.getByRole("button", { name: "Undo" }));
  await until("the Undo offer to go", async () => (await head.getByRole("button", { name: "Undo" }).count()) === 0, 12_000);
  await survives("1 resolved", head.getByRole("button", { name: "1 resolved" }));
  await survives("Close comments", head.getByRole("button", { name: "Close comments" }));
  await owner.close();
});

test("a thread card has no Open badge, a Resolve icon, one menu per comment, and a reply box only while focused", { timeout: 120_000 }, async () => {
  const docId = await publish("Card", REPORT);
  const risk = "Renewal risk is concentrated in three accounts";
  const threadId = await agentThread(docId, { exact: risk, section: "risk" }, "This overstates the renewal risk.");
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Is that deliberate?");
  assert.equal((await api(`/api/v1/docs/${docId}/threads/${threadId}/comments`, { method: "POST", body: JSON.stringify({ body: "Softened in v1." }) })).status, 201);
  const owner = await newContext(OWNER_ACCOUNT, { signedInTo: docId });
  const tab = await owner.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  const cards = frame.locator("[data-thread]");
  await until("two cards", async () => (await cards.count()) === 2);
  const [first, second] = [cards.nth(0), cards.nth(1)];

  assert.equal(await frame.locator(".badge.open").count(), 0, "open is the default and says nothing");
  assert.equal(await first.getByRole("button", { name: "Resolve" }).count(), 1, "one Resolve, on the first comment");
  assert.equal(await frame.locator(".quote").count(), 0, "the card sits beside its passage, so it does not repeat it");
  // A reply box on every card made them tall; only the focused card has one. Every card shows its replies, and no count of them under them.
  assert.equal(await first.getByRole("textbox").isVisible(), false);
  assert.equal(await second.getByRole("textbox").isVisible(), false);
  assert.match(await first.innerText(), /Softened in v1\./);
  assert.doesNotMatch(await first.innerText(), /1 repl/, "the reply is shown, so nothing counts it");
  await first.locator(".txt").first().click();
  await until("the reply box on the focused card", async () => await first.getByRole("textbox", { name: "Reply…" }).isVisible());
  assert.equal(await second.getByRole("textbox").isVisible(), false);
  await shoot(tab, "sidebar-card-focused");

  // Two comments, two menus, each naming what it deletes; both ask first.
  const more = first.getByRole("button", { name: "More actions" });
  assert.equal(await more.count(), 2);
  await more.nth(0).click();
  assert.equal(await frame.getByRole("menuitem", { name: "Delete comment" }).count(), 0);
  await frame.getByRole("menuitem", { name: "Delete thread" }).click();
  assert.match(await first.innerText(), /Delete this thread\?/);
  await first.getByRole("button", { name: "Keep" }).click();
  await more.nth(1).click();
  assert.equal(await frame.getByRole("menuitem", { name: "Delete thread" }).count(), 0);
  await frame.getByRole("menuitem", { name: "Delete comment" }).click();
  assert.match(await first.innerText(), /Delete this comment\?/);
  await first.getByRole("button", { name: "Keep" }).click();
  const stored = await threadsOf(docId);
  assert.deepEqual(stored.map((thread) => thread.comments.length), [2, 1], "nothing was deleted");
  await more.nth(1).click();
  await frame.getByRole("menuitem", { name: "Delete comment" }).click();
  await first.getByRole("button", { name: "Delete comment", exact: true }).click();
  await until("the reply to go", async () => (await threadsOf(docId))[0].comments.length === 1);
  await owner.close();
});

test("Escape keeps a draft that has words in it", { timeout: 120_000 }, async () => {
  const docId = await publish("Escape", REPORT);
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await openSidebar(tab);
  await frame.getByText("Select text to comment.").waitFor();
  await pressComment(tab, "Staffing is unchanged");
  const field = frame.getByRole("textbox", { name: "Add a comment…" });
  await field.fill("A careful thought");
  await field.press("Escape");
  await tab.waitForTimeout(300);
  assert.equal(await field.count(), 1, "the draft is still there");
  assert.equal(await field.inputValue(), "A careful thought");
  await context.close();
});

test("on a phone the bar's button opens the list of open comments, and a row shows its passage", { timeout: 180_000 }, async () => {
  const docId = await publish("Phone list", REPORT);
  const quote = "Renewal risk is concentrated in three accounts";
  await agentThread(docId, { exact: quote, section: "risk" }, "Is this still true?");
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Is that deliberate?");
  const context = await newContext(ALICE, { viewport: { width: 390, height: 844 }, signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("the highlights", async () => (await painted(tab, "openartifacts-open")).length === 2);
  const button = barButton(tab);
  assert.equal((await button.textContent()).trim(), "2", "at phone width the bubble and the count, without the word");
  await button.click();
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  assert.equal(await button.getAttribute("aria-pressed"), "true");
  assert.equal((await painted(tab, "openartifacts-open")).length, 2, "the highlights stay");
  const rows = frame.locator("button.row");
  await until("two rows", async () => (await rows.count()) === 2);
  assert.match(await rows.nth(1).innerText(), /Staffing is unchanged/);
  await shoot(tab, "phone-comment-list");

  await rows.nth(1).click();
  await frame.getByText("Is that deliberate?").waitFor();
  await until("the passage", async () => (await painted(tab, "openartifacts-focus")).length === 1);
  const now = await rectOf(tab, "Staffing is unchanged");
  const sheet = await hostBox(tab);
  assert.ok(now.y >= 40 && now.y + now.height <= sheet.y, "the passage is in view above the sheet");

  await button.click();
  await until("the sheet to close", async () => (await hostBox(tab)) === null);
  assert.equal(await button.getAttribute("aria-pressed"), "false");
  await context.close();
});

test("on a phone the Comment button sits below the selection, centred and 44px tall, and the composer has focus", { timeout: 180_000 }, async () => {
  const docId = await publish("Phone pill", REPORT);
  await agentThread(docId, { exact: "Closing remarks follow in the appendix" }, "Which appendix?");
  const context = await newContext(ALICE, { viewport: { width: 390, height: 844 }, signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  const quote = "Staffing is unchanged";
  assert.equal(await select(tab, quote), true);
  const tip = tab.locator(".openartifacts-comment-tip");
  await until("the Comment button", async () => (await tip.isVisible()) && (await tip.boundingBox()).width > 0);
  const pill = await tip.boundingBox();
  const passage = await rectOf(tab, quote);
  assert.ok(pill.height >= 44, `the pill is ${pill.height}px tall`);
  assert.ok(pill.y >= passage.y + passage.height, "below the last line, where the system's Copy menu is not");
  assert.ok(Math.abs(pill.x + pill.width / 2 - (passage.x + passage.width / 2)) < 6, "centred under it");
  await shoot(tab, "phone-comment-pill");

  await tab.mouse.click(pill.x + pill.width / 2, pill.y + pill.height / 2);
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  await until("the composer to have focus", async () => frame.evaluate(() => document.activeElement && document.activeElement.dataset.key === "draft"));
  await context.close();
});

// ---- the sidebar ----------------------------------------------------------------------------------------------

/** A page with no max-width: its text runs the full width, so opening the sidebar reflows every line. */
const widePage = (body, head = "") =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Wide</title>\n` +
  `<style>body{margin:0;padding:0 24px;font:16px/1.6 Georgia,serif;color:#222}h1{font-size:28px;margin:24px 0}p{margin:0 0 22px}</style>${head}\n</head>\n<body>\n<div id="content">\n${body}\n</div>\n</body>\n</html>\n`;

const LONG = "This sentence is here to make the paragraph long enough that it wraps across several lines at any width, so that narrowing the page moves every line below it. ";

/** Press the bar's Comments button unless the sidebar is already open, and wait for the column. */
async function openSidebar(tab) {
  const button = barButton(tab);
  await button.waitFor();
  if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  await until("the sidebar", async () => (await hostBox(tab)) !== null);
}

const cardFor = (frame, remark) => frame.locator("[data-thread]", { hasText: remark });

/** How far a card's top is from the top of the first line of its passage. */
const offsetOf = async (tab, frame, remark, passage) => (await cardFor(frame, remark).boundingBox()).y - (await rectOf(tab, passage)).y;
const allLevel = (tab, frame, pairs) => async () => {
  for (const [remark, passage] of pairs) if (Math.abs(await offsetOf(tab, frame, remark, passage)) > 2) return false;
  return true;
};
/** Wait for each card to be within `within` px of its passage, and fail with the offsets if they never are. */
async function assertLevel(tab, frame, pairs, label, within = 2) {
  const offsets = () => Promise.all(pairs.map(([remark, passage]) => offsetOf(tab, frame, remark, passage)));
  const ok = await until(label, async () => (await offsets()).every((o) => Math.abs(o) <= within), 5000).catch(() => false);
  if (!ok) assert.fail(`${label}: offsets ${(await offsets()).map((o) => o.toFixed(2)).join(", ")}, not within ${within}px`);
}

/** The colour of one screen pixel, read from a 1x1 PNG (with one pixel every filter type leaves the bytes as they are). */
async function pixelAt(tab, x, y) {
  const png = await tab.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const parts = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") parts.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  return [raw[1], raw[2], raw[3]];
}

test("the Comments button sits left of Share and toggles a sidebar that narrows the page; it is closed on every load", { timeout: 120_000 }, async () => {
  const docId = await publish("Sidebar", REPORT);
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Is that deliberate?");
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const button = barButton(tab);
  await button.waitFor();
  await until("the label and count", async () => (await button.textContent()).trim() === "Comments 1");
  assert.equal(await button.getAttribute("aria-pressed"), "false");
  const share = await tab.locator("a[data-openartifacts-share]").boundingBox();
  const own = await button.boundingBox();
  assert.ok(own.x + own.width <= share.x && share.x - (own.x + own.width) <= 16, "immediately left of Share");
  assert.equal(Math.round(own.height), Math.round(share.height), "in Share's pill shape");
  // Closed, the highlights are still there.
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  assert.equal(await hostBox(tab), null, "closed on load");
  const before = await tab.locator("#content").boundingBox();
  const vw = await tab.evaluate(() => document.documentElement.clientWidth);

  await button.click();
  await until("the sidebar", async () => (await hostBox(tab)) !== null);
  assert.equal(await button.getAttribute("aria-pressed"), "true");
  const frame = commentsFrame(tab, docId);
  await frame.locator(".head").getByText("Comments", { exact: true }).waitFor();
  const side = await hostBox(tab);
  assert.ok(Math.abs(side.width - 320) <= 1, `a 320px column (${side.width})`);
  assert.ok(Math.abs(side.x + side.width - vw) <= 1, "at the right edge");
  const narrowed = await tab.locator("#content").boundingBox();
  assert.ok(narrowed.x + narrowed.width <= side.x, `the text (${narrowed.x + narrowed.width}) stays left of the column (${side.x})`);
  assert.equal(Math.round((await tab.locator(".openartifacts-bar").boundingBox()).width), vw, "our bar keeps the full width");
  assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "no sideways scroll");
  await shoot(tab, "sidebar-open");

  await frame.getByRole("button", { name: "Close comments" }).click();
  await until("the sidebar to close", async () => (await hostBox(tab)) === null);
  assert.equal(await button.getAttribute("aria-pressed"), "false");
  assert.deepEqual(await tab.locator("#content").boundingBox(), before, "the page is back to its width");
  assert.equal((await painted(tab, "openartifacts-open")).length, 1);

  await button.click();
  await until("the sidebar", async () => (await hostBox(tab)) !== null);
  await tab.reload();
  await barButton(tab).waitFor();
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  assert.equal(await hostBox(tab), null, "not remembered");
  assert.equal(await barButton(tab).getAttribute("aria-pressed"), "false");
  await context.close();
});

test("in the sidebar each card is level with its passage, after the page reflows and after a resize", { timeout: 180_000 }, async () => {
  const filler = (n) => Array.from({ length: n }, () => `<p>${LONG.repeat(3)}</p>`).join("\n");
  const body = `<h1>Aligned</h1>\n${filler(3)}\n<p id="one">${LONG.repeat(2)}The first passage sits after two long sentences.</p>\n${filler(6)}\n` +
    `<p id="two">${LONG}The second passage is further down.</p>\n${filler(6)}\n<p id="three">${LONG.repeat(3)}The third passage ends the report.</p>\n${filler(2)}`;
  const docId = await publish("Aligned", body, { html: widePage(body) });
  const pairs = [
    ["First remark.", "The first passage sits after two long sentences"],
    ["Second remark.", "The second passage is further down"],
    ["Third remark.", "The third passage ends the report"],
  ];
  for (const [remark, exact] of pairs) await agentThread(docId, { exact }, remark);
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await until("three highlights", async () => (await painted(tab, "openartifacts-open")).length === 3);
  const before = await rectOf(tab, pairs[0][1]);
  await openSidebar(tab);
  const frame = commentsFrame(tab, docId);
  await until("three cards", async () => (await frame.locator("[data-thread]").count()) === 3);
  await until("every card level with its passage", allLevel(tab, frame, pairs));
  assert.ok((await rectOf(tab, pairs[0][1])).y > before.y + 10, "the fixture's text reflowed when the page narrowed");
  await shoot(tab, "sidebar-aligned");

  await tab.setViewportSize({ width: 1040, height: 800 });
  await until("every card level after a resize", allLevel(tab, frame, pairs));
  await context.close();
});

test("cards on adjacent lines stack in passage order 8px apart, the clicked one moves level with its passage, and the owner's agent is labelled", { timeout: 120_000 }, async () => {
  const body = `<h1>Stack</h1>\n<p>${LONG.repeat(4)}</p>\n<p id="a">Alpha passage on the first line.</p>\n<p id="b">Bravo passage on the second line.</p>\n<p id="c">Charlie passage on the third line.</p>\n<p>${LONG.repeat(16)}</p>`;
  const docId = await publish("Stack", body, { html: widePage(body, "<style>p{margin:0}</style>") });
  // Created out of passage order: the column follows the text, not the clock.
  await agentThread(docId, { exact: "Charlie passage on the third line" }, "Charlie remark.");
  await agentThread(docId, { exact: "Alpha passage on the first line" }, "Alpha remark.");
  await agentThread(docId, { exact: "Bravo passage on the second line" }, "Bravo remark.");
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await until("three highlights", async () => (await painted(tab, "openartifacts-open")).length === 3);
  await openSidebar(tab);
  const frame = commentsFrame(tab, docId);
  const boxes = async () => Promise.all(["Alpha remark.", "Bravo remark.", "Charlie remark."].map((remark) => cardFor(frame, remark).boundingBox()));
  const near = (a, b) => Math.abs(a - b) <= 1;
  await until("the stack", async () => {
    const [a, b, c] = await boxes();
    const alpha = await rectOf(tab, "Alpha passage");
    return Math.abs(a.y - alpha.y) <= 2 && near(b.y, a.y + a.height + 8) && near(c.y, b.y + b.height + 8);
  });
  assert.match(await cardFor(frame, "Alpha remark.").innerText(), /Logan's agent/);
  assert.equal(await cardFor(frame, "Alpha remark.").locator(".who .badge", { hasText: "agent" }).count(), 1, "the agent is badged");
  await shoot(tab, "sidebar-stacked");

  await cardFor(frame, "Bravo remark.").locator(".txt").first().click();
  await until("Bravo level with its passage, the others making room", async () => {
    const [a, b, c] = await boxes();
    const bravo = await rectOf(tab, "Bravo passage");
    return Math.abs(b.y - bravo.y) <= 2 && near(a.y + a.height + 8, b.y) && near(c.y, b.y + b.height + 8);
  });
  await shoot(tab, "sidebar-active-card");
  await context.close();
});

test("the page's text stays readable on its highlights, open and active, at 4.5:1 or more on a light page and a dark one", { timeout: 180_000 }, async () => {
  const quote = "Staffing is unchanged";
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  // What the highlight paints behind the glyphs: the most common colour along the bottom of the passage, where few letters reach.
  const behind = async (tab) => {
    const box = await rectOf(tab, quote);
    const seen = new Map();
    for (let i = 1; i < 10; i++) {
      const rgb = await pixelAt(tab, Math.round(box.x + (box.width * i) / 10), Math.floor(box.y + box.height - 2));
      seen.set(rgb.join(), (seen.get(rgb.join()) || 0) + 1);
    }
    return [...seen].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
  };
  // The owner's own dark page: light-grey text on a near-black panel.
  const cases = [["light", page(REPORT)], ["dark", page(REPORT, "<style>body{background:#191c1a;color:#99a19c}</style>")]];
  for (const [name, html] of cases) {
    const docId = await publish(`Readable ${name}`, REPORT, { html });
    await agentThread(docId, { exact: quote }, "Is that deliberate?");
    const context = await newContext(ALICE, { signedInTo: docId });
    const tab = await context.newPage();
    await tab.goto(docUrl(docId));
    await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
    const ink = (await tab.evaluate(() => getComputedStyle(document.querySelector("#content p")).color)).match(/[0-9.]+/g).slice(0, 3).map(Number);
    const page0 = await tab.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const open = await behind(tab);
    assert.notDeepEqual(open, page0.match(/[0-9.]+/g).slice(0, 3).map(Number), `${name}: the open highlight shows`);
    assert.ok(contrast(ink, open) >= 4.5, `${name}: text on the open highlight rgb(${open}) is ${contrast(ink, open).toFixed(2)}:1`);
    const at = await rectOf(tab, quote);
    await tab.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    await until("the active highlight", async () => (await painted(tab, "openartifacts-focus")).length === 1);
    await tab.mouse.move(5, 5);
    await tab.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const active = await behind(tab);
    assert.notDeepEqual(active, open, `${name}: the active highlight is stronger than the open one`);
    assert.ok(contrast(ink, active) >= 4.5, `${name}: text on the active highlight rgb(${active}) is ${contrast(ink, active).toFixed(2)}:1`);
    await shoot(tab, `highlight-${name}`);
    await context.close();
  }
});

test("highlights show with the sidebar closed, in one yellow without an underline, and clicking one opens its card level with it", { timeout: 120_000 }, async () => {
  const docId = await publish("Highlights", REPORT);
  const quote = "Renewal risk is concentrated in three accounts";
  await agentThread(docId, { exact: quote, section: "risk" }, "Is this still true?");
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  assert.equal(await hostBox(tab), null);
  const css = await tab.evaluate(() => document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n"));
  assert.match(css, /::highlight\(openartifacts-open\) \{ background-color: rgba\(255, 200, 0, 0\.28\); \}/);
  assert.match(css, /::highlight\(openartifacts-focus\) \{ background-color: rgba\(255, 200, 0, 0\.5\); \}/);
  assert.doesNotMatch(css, /underline/);

  const at = await rectOf(tab, quote);
  await tab.mouse.click(at.x + at.width / 3, at.y + at.height / 2);
  await until("the sidebar", async () => (await hostBox(tab)) !== null);
  assert.equal(await barButton(tab).getAttribute("aria-pressed"), "true");
  const frame = commentsFrame(tab, docId);
  await until("the card, focused", async () => (await cardFor(frame, "Is this still true?").getAttribute("class")).includes("focus"));
  await assertLevel(tab, frame, [["Is this still true?", quote]], "the active card", 0.1);
  assert.deepEqual(await painted(tab, "openartifacts-focus"), [quote]);
  await context.close();
});

test("Comment on a selection opens the sidebar with the composer level with the selection", { timeout: 120_000 }, async () => {
  const docId = await publish("Pill", REPORT, { html: widePage(REPORT) });
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await barButton(tab).waitFor();
  const quote = "Staffing is unchanged";
  await pressComment(tab, quote);
  await until("the sidebar", async () => (await hostBox(tab)) !== null);
  const frame = commentsFrame(tab, docId);
  const field = frame.getByRole("textbox", { name: "Add a comment…" });
  await field.waitFor();
  await until("the composer to have focus", () => frame.evaluate(() => document.activeElement && document.activeElement.dataset.key === "draft"));
  // The active card is exactly level: no rounding on the way.
  const composerOffset = async () => (await frame.locator("[data-thread='']").boundingBox()).y - (await rectOf(tab, quote)).y;
  const settled = await until("the composer level with the selection", async () => Math.abs(await composerOffset()) <= 0.1, 5000).catch(() => false);
  assert.ok(settled, `the composer is ${(await composerOffset()).toFixed(2)}px off its selection`);
  assert.deepEqual(await painted(tab, "openartifacts-draft"), [quote]);
  await context.close();
});

test("the sidebar narrows a centred column, a full-width page and a dark page, and each page's background fills the column", { timeout: 180_000 }, async () => {
  const quote = "Renewal risk is concentrated in three accounts";
  const styles = [
    ["centred", page(REPORT), [255, 253, 248]],
    ["full-width", widePage(REPORT), [255, 255, 255]],
    ["dark", page(REPORT, "<style>body{background:#111316;color:#e8e6e1}</style>"), [17, 19, 22]],
    // <html> and <body> transparent, the page painted by a wrapper: the canvas is white, so the column takes the wrapper's colour.
    ["dark-wrapper", widePage(REPORT, "<style>body{padding:0}#content{background:#0f172a;color:#e2e8f0;min-height:100vh;padding:1px 24px}</style>"), [15, 23, 42]],
    // A reset that sizes the root: padding alone would widen it rather than narrow its content.
    ["sized-root", page(REPORT, "<style>html,body{width:100%;height:100%}</style>"), [255, 253, 248]],
  ];
  for (const [name, html, background] of styles) {
    const docId = await publish(name, REPORT, { html });
    await agentThread(docId, { exact: quote, section: "risk" }, `A remark on the ${name} page.`);
    const context = await newContext(ALICE, { signedInTo: docId });
    const tab = await context.newPage();
    await tab.goto(docUrl(docId));
    await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
    await openSidebar(tab);
    const frame = commentsFrame(tab, docId);
    await until(`the ${name} card level with its passage`, allLevel(tab, frame, [[`A remark on the ${name} page.`, quote]]));
    const side = await hostBox(tab);
    const content = await tab.locator("#content").boundingBox();
    assert.ok(content.x + content.width <= side.x, `${name}: the text stays left of the column`);
    assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${name}: no sideways scroll`);
    const [r, g, b] = await pixelAt(tab, side.x + side.width - 4, 600);
    assert.ok(Math.abs(r - background[0]) <= 2 && Math.abs(g - background[1]) <= 2 && Math.abs(b - background[2]) <= 2, `${name}: the column shows the page's background, not rgb(${r}, ${g}, ${b})`);
    await shoot(tab, `sidebar-${name}`);
    await context.close();
  }
});

test("a refused post shows the frame's own error and keeps the words, never a name prompt", { timeout: 120_000 }, async () => {
  const docId = await publish("Refused", REPORT);
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  // The server no longer asks for a name; a client written against the old 409 must still treat it as an ordinary failure.
  await tab.addInitScript((api) => {
    if (location.host !== api || location.pathname !== "/embed/comments") return;
    const original = window.fetch;
    window.fetch = (input, init) =>
      init && init.method === "POST" && String(input).endsWith("/threads")
        ? Promise.resolve(new Response(JSON.stringify({ error: { code: "name_required", message: "Add a display name to comment." } }), { status: 409, headers: { "content-type": "application/json" } }))
        : original(input, init);
  }, API);
  await tab.goto(docUrl(docId));
  await openSidebar(tab);
  const frame = commentsFrame(tab, docId);
  await pressComment(tab, "Staffing is unchanged");
  const field = frame.getByRole("textbox", { name: "Add a comment…" });
  await field.fill("Who is staffed?");
  await frame.getByRole("button", { name: "Send" }).click();
  await frame.getByRole("alert").filter({ hasText: "Add a display name to comment." }).waitFor();
  assert.equal(await frame.getByRole("textbox", { name: "Your name" }).count(), 0, "no name prompt");
  assert.equal(await field.inputValue(), "Who is staffed?", "the words are kept");
  await context.close();
});


test("cards follow the page's theme: white on a light page, dark grey on a dark body or a dark <html>, and the phone sheet too", { timeout: 180_000 }, async () => {
  const quote = "Renewal risk is concentrated in three accounts";
  const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const rgb = (value) => value.match(/[0-9.]+/g).slice(0, 3).map(Number);
  const cases = [
    ["light", page(REPORT), false],
    ["dark body", page(REPORT, "<style>body{background:#111316;color:#e8e6e1}</style>"), true],
    ["dark html", page(REPORT, "<style>html{background:#0b0c0f}body{background:transparent;color:#e8e6e1}</style>"), true],
    ["dark wrapper", widePage(REPORT, "<style>body{padding:0}#content{background:#0f172a;color:#e2e8f0;min-height:100vh;padding:1px 24px}</style>"), true],
    // Tailwind v4's palette: the computed colour keeps its oklch() syntax.
    ["oklch light", page(REPORT, "<style>body{background:oklch(0.985 0.002 247.839)}</style>"), false],
    ["oklch dark", page(REPORT, "<style>body{background:oklch(0.21 0.034 264.665);color:#e8e6e1}</style>"), true],
  ];
  for (const [name, html, dark] of cases) {
    const docId = await publish(name, REPORT, { html });
    await agentThread(docId, { exact: quote, section: "risk" }, `A remark on the ${name} page.`);
    const context = await newContext(ALICE, { signedInTo: docId });
    const tab = await context.newPage();
    await tab.goto(docUrl(docId));
    await openSidebar(tab);
    const frame = commentsFrame(tab, docId);
    const card = cardFor(frame, `A remark on the ${name} page.`);
    await card.waitFor();
    const style = await card.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, ink: getComputedStyle(el).color, border: getComputedStyle(el).borderTopWidth, shadow: getComputedStyle(el).boxShadow }));
    const head = await frame.locator(".head").evaluate((el) => getComputedStyle(el).backgroundColor);
    if (dark) {
      await until(`${name}: a dark card`, async () => luminance(rgb(await card.evaluate((el) => getComputedStyle(el).backgroundColor))) < 0.25);
      const bg = rgb(await card.evaluate((el) => getComputedStyle(el).backgroundColor));
      assert.ok(luminance(bg) > 0.1, `${name}: the card (${bg}) stands off a near-black page`);
      assert.ok(luminance(rgb(await card.evaluate((el) => getComputedStyle(el).color))) > 0.75, `${name}: light text`);
      assert.ok(luminance(rgb(head)) < 0.25, `${name}: a dark header`);
    } else {
      assert.equal(style.bg, "rgb(255, 255, 255)", "a white card");
      assert.ok(luminance(rgb(style.ink)) < 0.2, "dark text");
      assert.equal(style.border, "1px", "a hairline border");
      assert.notEqual(style.shadow, "none", "a soft shadow");
      assert.equal(head, "rgb(255, 255, 255)");
    }
    await shoot(tab, `theme-${name.replace(" ", "-")}`);
    await context.close();
  }

  // On a phone the sheet behind the cards is dark on a dark page.
  const docId = await publish("dark phone", REPORT, { html: page(REPORT, "<style>body{background:#111316;color:#e8e6e1}</style>") });
  await agentThread(docId, { exact: quote, section: "risk" }, "A remark on a phone.");
  const context = await newContext(ALICE, { viewport: { width: 390, height: 844 }, signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await barButton(tab).click();
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  const host = await tab.locator(".openartifacts-comments").evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.ok(luminance(rgb(host)) < 0.25, `a dark sheet (${host})`);
  await context.close();
});

test("a selection made before signing in gets its Comment button once the frame says the reader may comment", { timeout: 180_000 }, async () => {
  const docId = await publish("Select, then sign in", REPORT);
  const context = await newContext(CAROL);
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await openSidebar(tab);
  const frame = commentsFrame(tab, docId);
  const tip = tab.locator(".openartifacts-comment-tip");
  assert.equal(await select(tab, "Staffing is unchanged"), true);
  await tab.waitForTimeout(400);
  assert.equal(await tip.isVisible().catch(() => false), false, "no Comment before sign-in");
  const signIn = frame.getByRole("button", { name: "Invited to comment? Sign in." });
  await signIn.waitFor();
  const [popup] = await Promise.all([context.waitForEvent("page"), signIn.click()]);
  await popup.waitForEvent("close").catch(() => {});
  await frame.getByText("Select text to comment.").waitFor();
  assert.equal(await tab.evaluate(() => window.getSelection().toString()), "Staffing is unchanged", "the selection is still there");
  await until("the Comment button, without selecting again", async () => await tip.isVisible());
  await context.close();
});

test("the Comment button is centred over the selection, and ⌘⌥M (Ctrl+Alt+M elsewhere) opens the composer without posting", { timeout: 120_000 }, async () => {
  const docId = await publish("Centred", REPORT);
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await openSidebar(tab);
  const frame = commentsFrame(tab, docId);
  await frame.getByText("Select text to comment.").waitFor();
  const tip = tab.locator(".openartifacts-comment-tip");
  const quote = "Renewal risk is concentrated in three accounts";
  await select(tab, quote);
  await until("the Comment button", async () => await tip.isVisible());
  const pill = await tip.boundingBox();
  const passage = await rectOf(tab, quote);
  assert.ok(Math.abs(pill.x + pill.width / 2 - (passage.x + passage.width / 2)) <= 2, `centred over the selection (${pill.x + pill.width / 2} vs ${passage.x + passage.width / 2})`);
  assert.ok(pill.y + pill.height <= passage.y, "above it");

  const mac = await tab.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await tab.keyboard.press(`${mac ? "Meta" : "Control"}+Alt+KeyM`);
  const field = frame.getByRole("textbox", { name: "Add a comment…" });
  await field.waitFor();
  await until("the composer to have focus", () => frame.evaluate(() => document.activeElement && document.activeElement.dataset.key === "draft"));
  assert.deepEqual(await painted(tab, "openartifacts-draft"), [quote]);
  await tab.waitForTimeout(300);
  assert.equal((await threadsOf(docId)).length, 0, "the shortcut never posts");
  await context.close();
});

test("with no comments the sidebar says so in plain text, and the phone sheet's thread view carries no such line", { timeout: 180_000 }, async () => {
  const docId = await publish("Empty", REPORT);
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await openSidebar(tab);
  const frame = commentsFrame(tab, docId);
  const empty = frame.getByText("No comments yet. Select text to comment.", { exact: true });
  await empty.waitFor();
  assert.equal(await empty.evaluate((el) => el.closest(".card") === null), true, "not inside a card");
  assert.equal(await empty.evaluate((el) => getComputedStyle(el).borderTopWidth), "0px", "no border");
  assert.equal(await frame.getByText("No open comments.").count(), 0);
  await shoot(tab, "sidebar-empty");
  await context.close();

  const quote = "Renewal risk is concentrated in three accounts";
  await agentThread(docId, { exact: quote, section: "risk" }, "Is this still true?");
  const phone = await newContext(ALICE, { viewport: { width: 390, height: 844 }, signedInTo: docId });
  const small = await phone.newPage();
  await small.goto(docUrl(docId));
  const sheetFrame = await until("the comments frame", () => commentsFrame(small, docId));
  await until("the highlight", async () => (await painted(small, "openartifacts-open")).length === 1);
  const at = await rectOf(small, quote);
  await small.mouse.click(at.x + at.width / 3, at.y + at.height / 2);
  await sheetFrame.getByText("Is this still true?").waitFor();
  assert.equal(await sheetFrame.getByText("Select text to comment.").count(), 0, "no instruction over the thread");
  assert.equal(await sheetFrame.getByText("No comments yet").count(), 0);
  await phone.close();
});

/** A public page that relays comments made at the given ages (ms before now) into `victim`'s frame, which has no read of its own. */
const agesPage = (victim, ages) => `<h1>Ages</h1>
<script>
const f = document.createElement("iframe");
f.src = "https://${API}/embed/comments?doc=${victim}&v=999999999&origin=" + encodeURIComponent(location.origin);
f.style.cssText = "position:absolute;left:0;top:0;width:320px;height:1400px";
document.body.append(f);
const now = Date.now();
const threads = ${JSON.stringify(ages)}.map((age, i) => ({ threadId: "th_" + i, anchor: { exact: "x" + i }, anchorStatus: "orphaned", state: "open",
  comments: [{ commentId: "cm_" + i, author: { name: "x", kind: "human" }, body: "Remark " + i, createdAt: now - age }] }));
window.addEventListener("message", (e) => {
  if (e.source !== f.contentWindow || !e.data || e.data.event !== "ready") return;
  f.contentWindow.postMessage({ type: "openartifacts:comments", event: "threads", data: { title: "x", version: 1, threads } }, "https://${API}");
});
</script>`;
test("times read now, 5m, 3h, 2d, then a short date after a week, with the exact time on hover", { timeout: 120_000 }, async () => {
  const victim = await publish("Ages victim", REPORT);
  const minute = 60_000;
  const ages = [10_000, 5 * minute, 3 * 60 * minute, 2 * 24 * 60 * minute, 10 * 24 * 60 * minute];
  const relay = await publish("Ages", agesPage(victim, ages), { comments: false });
  const context = await newContext(null);
  const tab = await context.newPage();
  await tab.goto(docUrl(relay));
  const frame = await until("the victim's frame", () => commentsFrame(tab, victim));
  await frame.getByText("Remark 4").waitFor();
  const shown = await frame.locator(".who small").evaluateAll((els) => els.map((el) => [el.textContent, el.title]));
  const expected = await frame.evaluate((list) => {
    const old = new Date(Date.now() - list[4]);
    return { date: old.toLocaleDateString(undefined, { month: "short", day: "numeric" }) };
  }, ages);
  assert.deepEqual(shown.map(([text]) => text), ["now", "5m", "3h", "2d", expected.date]);
  for (const [, title] of shown) assert.match(title, /[0-9]{4}/, "the exact date and time as a tooltip");
  await context.close();
});

test("after a post, focus moves to the new card's reply field and the frame announces it", { timeout: 120_000 }, async () => {
  const docId = await publish("Announce", REPORT);
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await openSidebar(tab);
  const frame = commentsFrame(tab, docId);
  await frame.getByText("Select text to comment.").waitFor();
  const live = frame.locator("[aria-live='polite']");
  assert.equal(await live.count(), 1);
  assert.equal((await live.textContent()).trim(), "");
  await pressComment(tab, "Staffing is unchanged");
  await frame.getByRole("textbox", { name: "Add a comment…" }).fill("Who is staffed?");
  await frame.getByRole("button", { name: "Send" }).click();
  await until("the post", async () => (await threadsOf(docId)).length === 1);
  const threadId = (await threadsOf(docId))[0].threadId;
  await until("the reply field to have focus", () => frame.evaluate((key) => document.activeElement && document.activeElement.dataset.key === key, `r:${threadId}`));
  await until("the announcement", async () => (await live.textContent()) === "Comment posted");
  await context.close();
});

test("hovering a highlight or its card links them: the passage darkens and the card lifts, and leaving restores both", { timeout: 120_000 }, async () => {
  const docId = await publish("Hover", REPORT);
  const quote = "Renewal risk is concentrated in three accounts";
  await agentThread(docId, { exact: quote, section: "risk" }, "Is this still true?");
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await openSidebar(tab);
  const frame = commentsFrame(tab, docId);
  const card = cardFor(frame, "Is this still true?");
  await until("the card level with its passage", allLevel(tab, frame, [["Is this still true?", quote]]));
  const rest = await card.evaluate((el) => getComputedStyle(el).boxShadow);
  const lifted = () => card.evaluate((el, before) => getComputedStyle(el).boxShadow !== before, rest);
  assert.deepEqual(await painted(tab, "openartifacts-focus"), []);

  const at = await rectOf(tab, quote);
  await tab.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await until("the passage in the active yellow", async () => (await painted(tab, "openartifacts-focus")).length === 1);
  await until("the card lifted", lifted);
  await tab.mouse.move(20, 700);
  await until("the passage back", async () => (await painted(tab, "openartifacts-focus")).length === 0);
  await until("the card back", async () => !(await lifted()));

  // Straight from the passage into an empty part of the sidebar, in one move: the page is told nothing, and only the frame sees the pointer arrive.
  await tab.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await until("the passage in the active yellow again", async () => (await painted(tab, "openartifacts-focus")).length === 1);
  const side = await hostBox(tab);
  await tab.mouse.move(side.x + side.width / 2, 700);
  await until("the passage back after a jump into the sidebar", async () => (await painted(tab, "openartifacts-focus")).length === 0);
  await until("the card back after a jump into the sidebar", async () => !(await lifted()));

  const box = await card.boundingBox();
  await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await until("the passage in the active yellow from the card", async () => (await painted(tab, "openartifacts-focus")).length === 1);
  await until("the card lifted", lifted);
  await tab.mouse.move(20, 700);
  await until("the passage back after the card", async () => (await painted(tab, "openartifacts-focus")).length === 0);
  await until("the card back after the card", async () => !(await lifted()));
  await context.close();
});

test("each person's avatar has their initial and one colour, picked from their name", { timeout: 120_000 }, async () => {
  const docId = await publish("Avatars", REPORT);
  const quote = "Renewal risk is concentrated in three accounts";
  const threadId = await agentThread(docId, { exact: quote, section: "risk" }, "From the agent.");
  // Two people reply through the frame's own API, Alice twice.
  const reply = async (account, body) => {
    const response = await mf.dispatchFetch(`https://${API}/embed/api/docs/${docId}/threads/${threadId}/comments`, {
      method: "POST",
      headers: { authorization: `Bearer ${frameToken(account, docId).token}`, "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    assert.equal(response.status, 201, await response.clone().text());
  };
  await reply(ALICE, "Alice once.");
  await reply(CAROL, "Carol once.");
  await reply(ALICE, "Alice twice.");
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await openSidebar(tab);
  const frame = commentsFrame(tab, docId);
  const card = cardFor(frame, "From the agent.");
  await card.getByText("Alice twice.").waitFor();
  const avatars = await card.locator(".av").evaluateAll((els) => els.map((el) => [el.textContent, getComputedStyle(el).backgroundColor]));
  assert.deepEqual(avatars.map(([initial]) => initial), ["L", "A", "C", "A"]);
  const [agent, alice, carol, alice2] = avatars.map(([, colour]) => colour);
  assert.equal(alice, alice2, "one colour per person");
  assert.equal(new Set([agent, alice, carol]).size, 3, `three people, three colours (${agent}, ${alice}, ${carol})`);
  await context.close();
});

test("on a full-width page, opening and closing the sidebar keeps the text the reader is looking at where it is", { timeout: 180_000 }, async () => {
  const filler = (n) => Array.from({ length: n }, () => `<p>${LONG.repeat(3)}</p>`).join("\n");
  const body = `<h1>Steady</h1>\n${filler(8)}\n<p>Button passage, read while the comments open.</p>\n${filler(8)}\n<p>Pill passage, about to be commented on.</p>\n` +
    `${filler(8)}\n<p>Highlight passage, with a thread on it.</p>\n${filler(8)}`;
  const docId = await publish("Steady", body, { html: widePage(body) });
  await agentThread(docId, { exact: "Highlight passage, with a thread on it" }, "A remark.");
  const context = await newContext(ALICE, { viewport: { width: 1440, height: 900 }, signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  /** Scroll a passage to viewport y, and return where it landed. */
  const bring = async (text, y) => {
    const at = await rectOf(tab, text);
    await tab.evaluate((dy) => window.scrollBy({ top: dy, behavior: "instant" }), at.y - y);
    return (await rectOf(tab, text)).y;
  };
  const steady = async (text, was, label) => {
    const now = (await rectOf(tab, text)).y;
    assert.ok(Math.abs(now - was) <= 1, `${label}: the passage moved from ${was} to ${now}`);
  };
  const closed = async () => {
    await barButton(tab).click();
    await until("the sidebar to close", async () => (await hostBox(tab)) === null);
  };

  // The bar's button: the line in the middle of the window stays where it was, opening and closing.
  let was = await bring("Button passage", 440);
  await openSidebar(tab);
  await cardFor(frame, "A remark.").waitFor();
  await steady("Button passage", was, "opening");
  await closed();
  await steady("Button passage", was, "closing");

  // Comment on a selection: the selection stays where it was, and the composer opens beside it.
  was = await bring("Pill passage", 440);
  await pressComment(tab, "Pill passage");
  await frame.getByRole("textbox", { name: "Add a comment…" }).waitFor();
  await steady("Pill passage", was, "Comment");
  await closed();

  // A highlight: the passage stays under the pointer that clicked it.
  was = await bring("Highlight passage", 300);
  const at = await rectOf(tab, "Highlight passage");
  await tab.mouse.click(at.x + at.width / 3, at.y + at.height / 2);
  await until("the card, focused", async () => ((await cardFor(frame, "A remark.").getAttribute("class")) || "").includes("focus"));
  await steady("Highlight passage", was, "a highlight");
  await context.close();
});

test("cards for passages at the top of the page sit level with them, while Undo is offered too, and an active card is level under the resolved list", { timeout: 180_000 }, async () => {
  const body = `<h1>Q3 client report</h1>\n<p>${LONG.repeat(2)}Revenue grew 18% quarter over quarter.</p>\n<p>${LONG.repeat(3)}</p>\n<p>Closing remarks follow in the appendix.</p>`;
  const docId = await publish("Top", body);
  await agentThread(docId, { exact: "Q3 client report" }, "A sharper title?");
  await agentThread(docId, { exact: "Revenue grew 18%" }, "Against which quarter?");
  await agentThread(docId, { exact: "Closing remarks follow" }, "Which appendix?");
  const owner = await newContext(OWNER_ACCOUNT, { signedInTo: docId });
  const tab = await owner.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("three highlights", async () => (await painted(tab, "openartifacts-open")).length === 3);
  await openSidebar(tab);
  await until("three cards", async () => (await frame.locator("[data-thread]").count()) === 3);
  const top = [["A sharper title?", "Q3 client report"], ["Against which quarter?", "Revenue grew 18%"]];
  await assertLevel(tab, frame, top, "on opening");

  await cardFor(frame, "Which appendix?").getByRole("button", { name: "Resolve" }).click();
  await frame.getByRole("button", { name: "Undo" }).waitFor();
  await assertLevel(tab, frame, top, "while Undo is offered");

  await until("the Undo offer to go", async () => (await frame.getByRole("button", { name: "Undo" }).count()) === 0, 12_000);
  await frame.getByRole("button", { name: "1 resolved" }).click();
  await frame.locator("[data-thread].resolved").waitFor();
  await cardFor(frame, "A sharper title?").locator(".txt").click();
  await until("the title card, focused", async () => (await cardFor(frame, "A sharper title?").getAttribute("class")).includes("focus"));
  await assertLevel(tab, frame, [top[0]], "the active card under the resolved list", 0.1);
  await owner.close();
});

test("a keyboard user can Tab to a card, which becomes active, and on to its reply field", { timeout: 120_000 }, async () => {
  const docId = await publish("Keyboard", REPORT);
  const quote = "Renewal risk is concentrated in three accounts";
  const threadId = await agentThread(docId, { exact: quote, section: "risk" }, "Is this still true?");
  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  await openSidebar(tab);
  const frame = commentsFrame(tab, docId);
  const card = cardFor(frame, "Is this still true?");
  await card.waitFor();
  await frame.getByRole("button", { name: "Close comments" }).focus();
  await tab.keyboard.press("Tab");
  const active = await until("the card to take focus and become active", async () => (await card.evaluate((el) => document.activeElement === el)) && (await card.getAttribute("class")).includes("focus"), 3000).catch(() => false);
  assert.ok(active, `Tab from Close went to ${await frame.evaluate(() => document.activeElement && document.activeElement.outerHTML.slice(0, 80))}`);
  assert.deepEqual(await painted(tab, "openartifacts-focus"), [quote]);
  await tab.keyboard.press("Tab");
  await until("the reply field to have focus", () => frame.evaluate((id) => document.activeElement && document.activeElement.dataset.key === "r:" + id, threadId), 3000);
  await context.close();
});
