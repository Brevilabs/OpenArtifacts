/**
 * Inline comments in a real browser: `npm run test:browser`, with the Share
 * popover's test beside it.
 *
 * The vitest suite runs inside workerd and cannot load a page, so
 * `test/comments-*.test.ts` and `test/serve.test.ts` cover the HTTP contract and
 * this covers the DOM: the page script's selection, canonical text, highlights
 * and measuring; the margin frame's cards, sign-in and writes; and the two
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
 * `OA_SCREENSHOTS={dir}` saves the margin with an open card, a resolved card, the
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

/** A page with room at the right for a margin: a 640px column, centred, at the desktop viewport. */
const page = (body, head = "") =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Q3 report</title>\n` +
  `<style>body{max-width:640px;margin:0 auto;padding:0 16px;font:16px/1.6 Georgia,serif;color:#222}h1{font-size:28px;margin:24px 0}p{margin:0 0 22px}</style>${head}\n</head>\n<body>\n<main id="content">\n${body}\n</main>\n</body>\n</html>\n`;

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

/** Publish as the owner, turn comments on, and return the doc id. */
async function publish(title, body, { route = "docs", comments = true } = {}) {
  const response = await api(`/api/v1/${route}`, { method: "POST", body: JSON.stringify({ title, html: page(body) }) });
  assert.equal(response.status, 201, await response.clone().text());
  const { docId } = await response.json();
  if (comments) await setComments(docId, true);
  return docId;
}

async function setComments(docId, on) {
  const response = await api(`/api/v1/docs/${docId}/settings`, { method: "PUT", body: JSON.stringify({ comments: on }) });
  assert.equal(response.status, 200, await response.clone().text());
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
    // No display name: her first comment asks for one.
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

  // 1. The bar gets a comments button beside Share, counting no open threads yet.
  const button = barButton(tab);
  await button.waitFor();
  assert.match(await button.innerText(), /0$/);
  assert.equal(await button.getAttribute("aria-pressed"), "true");
  const bar = await tab.locator(".openartifacts-bar").boundingBox();
  const shareBox = await tab.locator("a[data-openartifacts-share]").boundingBox();
  const buttonBox = await button.boundingBox();
  assert.ok(buttonBox.x + buttonBox.width <= shareBox.x && shareBox.x - (buttonBox.x + buttonBox.width) < 24, "the button sits just left of Share");
  assert.ok(bar.width > 0);

  // 2. The margin is a frame to the right of the content, as tall as the page.
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("the frame to be shown", async () => (await hostBox(tab)) !== null);
  const content = await tab.locator("#content").boundingBox();
  const margin = await hostBox(tab);
  assert.ok(margin.x >= content.x + content.width + 15, `the frame (${margin.x}) starts right of the content (${content.x + content.width})`);
  assert.ok(margin.x + margin.width <= 1280 - 8);
  assert.ok(margin.height >= (await tab.evaluate(() => document.documentElement.scrollHeight)) - 2);
  const authorBefore = await tab.locator("#content").innerHTML();

  // 3. Selecting text shows a floating Comment button; a selection inside the bar shows none.
  const quote = "Renewal risk is concentrated in three accounts";
  assert.equal(await select(tab, quote), true);
  const tip = tab.locator(".openartifacts-comment-tip");
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

  // 4. Comment opens a draft card at the selection, with the quote, asking to sign in.
  await tab.mouse.click(tipBox.x + tipBox.width / 2, tipBox.y + tipBox.height / 2);
  const signIn = frame.getByRole("button", { name: "Sign in to comment" });
  await signIn.waitFor();
  await frame.getByText("Comment on “Q3 client report”").waitFor();
  assert.equal(await frame.locator(".quote").first().innerText(), quote);
  const [popup] = await Promise.all([context.waitForEvent("page"), signIn.click()]);
  await popup.waitForEvent("close").catch(() => {});

  // 5. Signed in, the composer appears. Carol has no name, so the first post asks for one.
  const box = frame.getByRole("textbox", { name: "Add a comment…" });
  await box.waitFor();
  await shoot(tab, "margin-draft-card");
  await box.fill("This overstates the renewal risk; two of the three accounts already renewed.");
  await frame.getByRole("button", { name: "Post" }).click();
  const name = frame.getByRole("textbox", { name: "Your name" });
  await name.waitFor();
  await name.fill("Carol");
  await frame.getByRole("button", { name: "Save and post" }).click();

  // 6. The card stays beside the passage, the highlight is painted, the count is 1.
  const card = frame.locator("[data-thread]:not([data-thread=''])");
  await card.waitFor();
  assert.match(await card.innerText(), /Carol/);
  assert.match(await card.innerText(), /This overstates the renewal risk/);
  await until("the bar to count one", async () => /1$/.test(await button.innerText()));
  await until("the card to sit at its passage", async () => {
    const level = await rectOf(tab, quote);
    const cardBox = await card.boundingBox();
    return Math.abs(cardBox.y - level.y) < 24;
  });
  assert.deepEqual(await painted(tab, "openartifacts-open"), [quote]);
  assert.equal(await tab.locator("#content").innerHTML(), authorBefore, "the author's DOM is untouched");
  await shoot(tab, "margin-open-card");

  // 7. The page holds no credential: nothing of ours in its storage or cookies.
  assert.deepEqual(await tab.evaluate(() => Object.keys(window.localStorage).concat(Object.keys(window.sessionStorage))), []);
  assert.equal(await tab.evaluate(() => document.cookie), "");
  const stored = await threadsOf(docId);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].comments[0].author, { name: "Carol", kind: "human" });
  assert.equal(stored[0].anchor.exact, quote);
  assert.equal(stored[0].anchor.prefix.length > 0 && stored[0].anchor.suffix.length > 0, true);
  assert.equal(stored[0].anchor.section, "risk");

  // 8. Pressing the bar's button hides the cards and the highlights, and again shows them.
  await button.click();
  await until("the margin to hide", async () => (await hostBox(tab)) === null);
  assert.equal(await button.getAttribute("aria-pressed"), "false");
  assert.deepEqual(await painted(tab, "openartifacts-open"), []);
  await button.click();
  await until("the margin to show", async () => (await hostBox(tab)) !== null);
  assert.deepEqual(await painted(tab, "openartifacts-open"), [quote]);

  // 9. Replying in the card posts under it, and the count does not change.
  const reply = frame.getByRole("textbox", { name: "Reply…" });
  await reply.fill("Fixed in my draft.");
  await frame.getByRole("button", { name: "Post" }).click();
  await until("the reply", async () => (await card.innerText()).includes("Fixed in my draft."));
  assert.equal((await threadsOf(docId))[0].comments.length, 2);
  await context.close();
});

test("cards that would overlap are pushed down, and the owner's agent is labelled", { timeout: 120_000 }, async () => {
  const docId = await publish("Overlap", REPORT);
  const first = "Revenue grew 18% quarter over quarter";
  const second = "led by the integration pilot";
  await agentThread(docId, { exact: first, section: "growth" }, "Is 18% the right base?");
  await agentThread(docId, { exact: second, prefix: "quarter over quarter, ", section: "growth" }, "Name the pilot.");
  await agentThread(docId, { exact: "The budget is on the next page" }, "Which page?");

  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  const cards = frame.locator("[data-thread]");
  await until("three cards", async () => (await cards.count()) === 3);
  await until("the bar to count three", async () => /3$/.test(await barButton(tab).innerText()));

  const boxes = [];
  for (let i = 0; i < 3; i++) boxes.push(await cards.nth(i).boundingBox());
  // The first two passages share a line, so the second card is pushed below the first.
  assert.ok(boxes[1].y >= boxes[0].y + boxes[0].height, `second card (${boxes[1].y}) clears the first (${boxes[0].y + boxes[0].height})`);
  const level = await rectOf(tab, first);
  assert.ok(Math.abs(boxes[0].y - level.y) < 24);
  // The third sits at its own passage, not pushed.
  const third = await rectOf(tab, "The budget is on the next page");
  assert.ok(Math.abs(boxes[2].y - third.y) < 24 || boxes[2].y > third.y);
  assert.match(await cards.first().innerText(), /Logan's agent/);
  assert.match(await cards.first().innerText(), /agent/);
  assert.deepEqual((await painted(tab, "openartifacts-open")).sort(), [first, second, "The budget is on the next page"].sort());
  await context.close();
});

test("a resolved thread collapses to one line, grey, and expands with its agent reply", { timeout: 120_000 }, async () => {
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
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  const line = frame.getByRole("button", { name: /Resolved in v1 by Logan's agent/ });
  await line.waitFor();
  await until("the bar to count the open thread only", async () => /1$/.test(await barButton(tab).innerText()));
  assert.deepEqual(await painted(tab, "openartifacts-resolved"), [quote]);
  assert.deepEqual(await painted(tab, "openartifacts-open"), ["Staffing is unchanged"]);
  const collapsed = await line.boundingBox();
  assert.ok(collapsed.height < 60, `one line (${collapsed.height}px)`);
  await shoot(tab, "margin-resolved-collapsed");

  await line.click();
  const expanded = frame.locator("[data-thread].resolved");
  await expanded.getByText("Softened in v1.").waitFor();
  assert.equal(await expanded.locator(".who .badge", { hasText: "agent" }).count(), 2, "both comments are the agent's");
  await expanded.getByRole("button", { name: "Reopen" }).click();
  await until("the thread to reopen", async () => (await threadsOf(docId, "open")).length === 2);
  await until("the count", async () => /2$/.test(await barButton(tab).innerText()));
  await owner.close();
});

test("a thread whose text was rewritten waits at the top under the new version, and returns beside it when the text does", { timeout: 180_000 }, async () => {
  const docId = await publish("Orphan", REPORT);
  const quote = "The budget is on the next page";
  await agentThread(docId, { exact: quote }, "Which page?");
  await agentThread(docId, { exact: "Staffing is unchanged" }, "Say who is staffed.");

  const context = await newContext(ALICE, { signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("two cards", async () => (await frame.locator("[data-thread]").count()) === 2);

  // v2 rewrites the first quote away.
  const v2 = await update(docId, REPORT.replace(quote, "Appendix B has the budget"));
  assert.equal(v2, 2);
  await tab.reload();
  const again = await until("the comments frame", () => commentsFrame(tab, docId));
  await again.getByText("On text that changed in v2").waitFor();
  const orphan = again.locator("[data-thread].muted");
  await orphan.waitFor();
  assert.match(await orphan.innerText(), /The budget is on the next page/);
  assert.match(await orphan.innerText(), /Which page\?/);
  // Still open, still counted, and the other thread still sits at its passage.
  await until("the bar to count both", async () => /2$/.test(await barButton(tab).innerText()));
  assert.deepEqual(await painted(tab, "openartifacts-open"), ["Staffing is unchanged"]);
  const heading = await again.getByText("On text that changed in v2").boundingBox();
  const orphanBox = await orphan.boundingBox();
  const staffing = await again.locator("[data-thread]:not(.muted)").boundingBox();
  assert.ok(heading.y < orphanBox.y && orphanBox.y + orphanBox.height <= staffing.y + 1, "the orphan is stacked above the anchored cards");
  await shoot(tab, "margin-orphaned");

  // The pinned page of v1 still has the text, so its card is back beside it.
  const old = await context.newPage();
  await old.goto(docUrl(docId, 1));
  const pinnedFrame = await until("the pinned frame", () => commentsFrame(old, docId));
  assert.match(pinnedFrame.url(), /&v=1$/);
  await until("both cards beside their text", async () => (await painted(old, "openartifacts-open")).length === 2);
  assert.equal(await pinnedFrame.getByText("On text that changed").count(), 0);

  // v3 brings the text back; the thread anchors again on its own.
  await update(docId, REPORT);
  await tab.reload();
  const third = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("both beside their text again", async () => (await painted(tab, "openartifacts-open")).length === 2);
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
    const card = frame.locator("[data-thread]");
    await card.waitFor();
    assert.match(await card.innerText(), /Add owners for each step/);
    assert.deepEqual(await painted(tab, "openartifacts-open"), [quote]);

    if (canComment) {
      await frame.getByRole("textbox", { name: "Reply…" }).waitFor();
      assert.equal(await frame.getByText("You can view this page.").count(), 0);
    } else {
      await frame.getByText("You can view this page.").waitFor();
      assert.equal(await frame.getByRole("textbox").count(), 0);
      assert.equal(await frame.getByRole("button", { name: "Post" }).count(), 0);
      // Selecting text shows no Comment button once the frame has said so.
      await select(tab, "Staffing is unchanged");
      await tab.waitForTimeout(600);
      assert.equal(await tab.locator(".openartifacts-comment-tip").isVisible().catch(() => false), false);
      await shoot(tab, "margin-can-view");
    }
    await context.close();
  }
});

test("a narrow page draws no margin; a tapped highlight or Comment opens a bottom sheet", { timeout: 180_000 }, async () => {
  const docId = await publish("Phone", REPORT);
  const quote = "Renewal risk is concentrated in three accounts";
  await agentThread(docId, { exact: quote, section: "risk" }, "Is this still true?");

  const context = await newContext(ALICE, { viewport: { width: 390, height: 844 }, signedInTo: docId });
  const tab = await context.newPage();
  await tab.goto(docUrl(docId));
  const frame = await until("the comments frame", () => commentsFrame(tab, docId));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).length === 1);
  assert.equal(await hostBox(tab), null, "no margin on a phone");
  assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal scroll");

  // Tapping the highlight opens its card as a sheet across the bottom.
  const at = await rectOf(tab, quote);
  await tab.mouse.click(at.x + at.width / 3, at.y + at.height / 2);
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  const sheet = await hostBox(tab);
  assert.equal(Math.round(sheet.x), 0);
  assert.equal(Math.round(sheet.width), 390);
  assert.ok(Math.abs(sheet.y + sheet.height - 844) < 2, "the sheet sits on the bottom edge");
  assert.ok(Math.abs(sheet.height - 844 * 0.55) < 4);
  await frame.getByText("Is this still true?").waitFor();
  assert.equal(await frame.locator("[data-thread]").count(), 1);
  await shoot(tab, "phone-bottom-sheet");

  // Its close button hides it again.
  await frame.getByRole("button", { name: "Close" }).click();
  await until("the sheet to close", async () => (await hostBox(tab)) === null);

  // Selecting text and pressing Comment opens a new card the same way.
  await select(tab, "Staffing is unchanged");
  const tip = tab.locator(".openartifacts-comment-tip");
  await until("the Comment button", async () => await tip.isVisible());
  const tipBox = await tip.boundingBox();
  await tab.mouse.click(tipBox.x + tipBox.width / 2, tipBox.y + tipBox.height / 2);
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  const area = frame.getByRole("textbox", { name: "Add a comment…" });
  await area.fill("Who is staffed?");
  await frame.getByRole("button", { name: "Post" }).click();
  await until("the new thread", async () => (await threadsOf(docId)).length === 2);
  await until("the new thread to show", async () => (await frame.getByText("Who is staffed?").count()) === 1);
  assert.equal((await threadsOf(docId))[1].anchor.exact, "Staffing is unchanged");
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

test("a page whose document has comments off is untouched by the script", { timeout: 60_000 }, async () => {
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
  assert.equal(await tab.evaluate(() => CSS.highlights.size), 0);
  // The Share popover still works.
  await tab.locator("a[data-openartifacts-share]").click();
  await until("the Share frame", () => tab.frames().find((frame) => frame.url().includes("/embed/share")));
  await context.close();
});
