/**
 * Inline comments, start to finish: `npm run test:browser`.
 *
 * One story, told in order, by the people who would be in it. The owner (a Pro
 * account) and the owner's agent drive the real `openartifacts` CLI code
 * (`packages/openartifacts/src/cli.js`, in this process, with its `fetch` aimed at
 * the Miniflare Worker), and the readers drive real Chrome: Alice who may
 * comment, Bob who may only view, a stranger who may do neither, a signed-out
 * reader of a public page, a Free-plan owner, a phone, and finally the unshare.
 * Each test is one step of `OpenArtifacts Inline Comments Design.md` ("User
 * flow" and "How to verify") and relies on the state the one before it left, so
 * a failure at step N makes the later steps meaningless, and they fail with it.
 *
 * The harness is `test/comments.browser.mjs`'s (read its header): the deployed
 * bundle under Miniflare over HTTPS with the real D1, R2 and Durable Object,
 * Chrome pointed at it by `--host-resolver-rules`. What this file adds is the
 * email: the Worker is wrapped by a module that replaces its `EMAIL` binding with
 * one that hands each message to this process, so a test can read what was sent
 * and to whom. Nothing else is replaced.
 *
 * Needs Node 22 and a Google Chrome. `OA_HEADED=1` shows the browser and
 * `OA_SCREENSHOTS={dir}` saves the key moments of the story.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { Miniflare } = require("miniflare");
const { chromium, devices } = require("playwright-core");
const { readD1Migrations } = require("@cloudflare/vitest-pool-workers/config");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVING = "openartifacts.site";
const API = "api.openartifacts.ai";
const SECRET = "k".repeat(32);
// Not another browser test's directory: `node --test` may run the files at once.
const BUILD = join(ROOT, "node_modules", ".cache", "comments-e2e");

const accountId = (seed) => `oa_${seed}${"0123456789abcdefghjkmnpqrs".slice(seed.length)}`;
const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

// Everyone in the story: id, address, plan, and the name their comments carry (Alice has none until she is asked).
const PEOPLE = {
  owner: { id: accountId("a"), email: "logan@owner.test", plan: "pro", name: "Logan" },
  alice: { id: accountId("b"), email: "alice@acme.com", plan: "pro", name: null },
  bob: { id: accountId("c"), email: "bob@other.com", plan: "pro", name: "Bob" },
  stranger: { id: accountId("d"), email: "mallory@elsewhere.test", plan: "pro", name: "Mallory" },
  erin: { id: accountId("e"), email: "erin@public.test", plan: "pro", name: "Erin" },
  free: { id: accountId("f"), email: "freebie@owner.test", plan: "free", name: "Fran" },
};
/** An account token (`oat_…`) per person, as `openartifacts login` would have stored. */
const TOKENS = Object.fromEntries(Object.keys(PEOPLE).map((who) => [who, `oat_${randomBytes(26).toString("hex").slice(0, 52)}`]));

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

/** A per-document token, for the requests of a reader who has not got one (a stranger's attempts on the embed family). */
const shareToken = (account, doc) => `oas_${signed("share-token", { a: account, d: doc })}`;

function wranglerVars() {
  const text = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return JSON.parse(text).vars;
}

/** Obsidian Copilot's export shape: a 46rem column, centred. */
const page = (body) =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Q3 client report</title>\n` +
  `<style>body{margin:0;font:16px/1.6 Georgia,serif;color:#222;background:#fffdf8}main{width:min(100% - 2rem, 46rem);margin:0 auto;padding:1rem 0}h1{font-size:28px;margin:24px 0}p{margin:0 0 22px}</style>\n</head>\n<body>\n<main id="content">\n${body}\n</main>\n</body>\n</html>\n`;

const SENTENCE = "Renewal risk is concentrated in three accounts";
const REWRITTEN = "Two of the three accounts have renewed";
const STAFFING = "Staffing is unchanged";
const BODY = (risk, staffing) => `<h1>Q3 client report</h1>
<p id="growth">Revenue grew 18% quarter over quarter, led by the integration pilot and two enterprise renewals.</p>
<p id="risk"><b>Risks.</b> ${risk}. Next steps for the pilot are below.</p>
<p id="staffing">${staffing}The budget is on the next page.</p>
<p>Closing remarks follow in the appendix.</p>`;
const V1 = BODY(`${SENTENCE}, two of which are mid-migration`, `${STAFFING}. `);
const V2 = BODY(`${REWRITTEN}`, `${STAFFING}. `);
const V3 = BODY(`${REWRITTEN}`, "");

async function until(label, read, timeout = 20_000) {
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
let workdir;
/** Every email the Worker tried to send, oldest first. */
const mail = [];

const screenshots = process.env.OA_SCREENSHOTS;
async function shoot(target, name) {
  if (!screenshots) return;
  mkdirSync(screenshots, { recursive: true });
  await target.screenshot({ path: join(screenshots, `${name}.png`) });
}

/** A request to the API host as `who` (an account token), straight to the Worker. */
const request = (who, path, init = {}) =>
  mf.dispatchFetch(`https://${API}${path}`, {
    ...init,
    headers: { ...(who ? { authorization: `Bearer ${TOKENS[who]}` } : {}), "content-type": "application/json", ...init.headers },
  });

// ---------------------------------------------------------------------------------------------------------------------
// The CLI: the real `main`, in this process, with `fetch` aimed at the Worker and its output captured.
// ---------------------------------------------------------------------------------------------------------------------

let cliModule;
/**
 * Run `openartifacts {args}` as `who` and return what it printed. A failure comes back as `error` with
 * `presentError`'s stderr, which is what the person at the terminal would read.
 */
async function cli(who, args) {
  const real = { fetch: globalThis.fetch, log: console.log, error: console.error };
  const out = [];
  const err = [];
  const env = { token: process.env.OPENARTIFACTS_TOKEN, host: process.env.OPENARTIFACTS_API_HOST };
  process.env.OPENARTIFACTS_TOKEN = TOKENS[who];
  process.env.OPENARTIFACTS_API_HOST = `https://${API}`;
  globalThis.fetch = (input, init) => mf.dispatchFetch(String(input), init);
  console.log = (...parts) => out.push(parts.join(" "));
  console.error = (...parts) => err.push(parts.join(" "));
  let error;
  try {
    await cliModule.main(args);
  } catch (caught) {
    error = caught;
    cliModule.presentError(caught);
  } finally {
    Object.assign(globalThis, { fetch: real.fetch });
    console.log = real.log;
    console.error = real.error;
    for (const [key, value] of [["OPENARTIFACTS_TOKEN", env.token], ["OPENARTIFACTS_API_HOST", env.host]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const stdout = out.join("\n");
  return { stdout, stderr: err.join("\n"), error, json: () => JSON.parse(stdout) };
}

/** Write `html` to a file for `publish` and return its path. */
let files = 0;
function htmlFile(html) {
  const path = join(workdir, `report-${++files}.html`);
  writeFileSync(path, html);
  return path;
}

// ---------------------------------------------------------------------------------------------------------------------
// The browser.
// ---------------------------------------------------------------------------------------------------------------------

const docUrl = (docId, pinned) => `https://${SERVING}/d/${docId}${pinned ? `/v${pinned}` : ""}`;
const commentsFrame = (tab, docId) => tab.frames().find((frame) => frame.url().startsWith(`https://${API}/embed/comments?doc=${docId}`));
const shareFrame = (tab, docId) => tab.frames().find((frame) => frame.url().startsWith(`https://${API}/embed/share?doc=${docId}`));
const hostBox = (tab) => tab.locator(".openartifacts-comments").boundingBox();
const barButton = (tab) => tab.locator(".openartifacts-bar button[aria-pressed]");
/** The bar button's label: "Comments", then the open-thread count when there are any. */
const counted = async (tab, n) => (await barButton(tab).textContent()).trim() === (n ? `Comments ${n}` : "Comments");

/** Press Comments unless the sidebar is already open; the comments are closed on every page load. */
async function openSidebar(tab) {
  await barButton(tab).waitFor();
  if ((await barButton(tab).getAttribute("aria-pressed")) !== "true") await barButton(tab).click();
  await until("the sidebar", async () => (await hostBox(tab)) !== null);
}

/** The viewport rectangle of the first occurrence of `text` in the author's content. */
const rectOf = (tab, text) =>
  tab.evaluate((needle) => {
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
const select = (tab, text) =>
  tab.evaluate((needle) => {
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
const painted = (tab, name) =>
  tab.evaluate((key) => (CSS.highlights.has(key) ? [...CSS.highlights.get(key)].map((range) => range.toString()) : []), name);

/** Select `text` and press the floating Comment button (a tap on a touch screen). */
async function pressComment(tab, text, { touch = false } = {}) {
  assert.equal(await select(tab, text), true, `${text} is on the page`);
  const tip = tab.locator(".openartifacts-comment-tip");
  await until("the Comment button", async () => (await tip.isVisible()) && (await tip.boundingBox()).width > 0);
  const box = await tip.boundingBox();
  if (touch) await tab.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  else await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Press a sign-in button of the comments frame and let the popup finish; the session cookie is already in the context. */
async function signInThroughPopup(context, button) {
  const [popup] = await Promise.all([context.waitForEvent("page"), button.click()]);
  await popup.waitForEvent("close").catch(() => {});
}

async function newContext(who, options = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, ...options });
  if (who) await context.addCookies([sessionCookie(PEOPLE[who].id)]);
  return context;
}

/** Open a private document the way an invitation does: through the door on the API host. */
async function openPrivate(tab, docId) {
  await tab.goto(`https://${API}/open/${docId}`);
  await tab.waitForURL(new RegExp(`^https://[a-z0-9]+\\.${SERVING.replaceAll(".", "\\.")}/d/${docId}`));
}

/** The owner's own Share popover on a public document, signed in through its popup. */
async function ownerPopover(context, docId, { private: isPrivate = false } = {}) {
  const tab = await context.newPage();
  if (isPrivate) await openPrivate(tab, docId);
  else await tab.goto(docUrl(docId));
  await tab.locator("a[data-openartifacts-share]").click();
  const frame = await until("the Share frame", () => shareFrame(tab, docId));
  await signInThroughPopup(context, frame.getByRole("button", { name: "Sign in to manage" }));
  await frame.getByRole("radiogroup", { name: "Link access" }).waitFor();
  return { tab, frame };
}

/** The mail sent to `to` since `from` (an index into `mail`). */
const mailTo = (to, from = 0) => mail.slice(from).filter((message) => message.to === to);

// ---------------------------------------------------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------------------------------------------------

/** The Worker, with its `EMAIL` binding handing messages to the test; and a door to the Durable Object for the last step. */
const WRAPPER = `import worker from "./index.js";
export { DocComments } from "./index.js";
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__e2e/comments-object") {
      const { docId, method, args } = await request.json();
      const stub = env.COMMENTS.get(env.COMMENTS.idFromName(docId));
      return Response.json(await stub[method](args));
    }
    const mailbox = env.MAILBOX;
    const wrapped = {
      ...env,
      EMAIL: { send: async (message) => void (await mailbox.fetch("http://mailbox/", { method: "POST", body: JSON.stringify(message) })) },
    };
    return worker.fetch(request, wrapped, ctx);
  },
};
`;

before(async () => {
  mkdirSync(BUILD, { recursive: true });
  workdir = mkdtempSync(join(BUILD, "work-"));
  execFileSync(process.execPath, [require.resolve("wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--outdir", BUILD], {
    cwd: ROOT,
    stdio: "pipe",
  });
  writeFileSync(join(BUILD, "e2e-entry.js"), WRAPPER);
  cliModule = await import(pathToFileURL(join(ROOT, "packages", "openartifacts", "src", "cli.js")).href);

  const vars = wranglerVars();
  mf = new Miniflare({
    modules: [
      { type: "ESModule", path: join(BUILD, "e2e-entry.js") },
      { type: "ESModule", path: join(BUILD, "index.js") },
    ],
    compatibilityDate: "2026-03-01",
    d1Databases: ["DB"],
    r2Buckets: ["DOCS"],
    // The page validator reads the deploy time from this binding; wrangler.jsonc
    // declares it, but this harness does not read wrangler.jsonc.
    versionMetadata: "CF_VERSION_METADATA",
    durableObjects: { COMMENTS: { className: "DocComments", useSQLite: true } },
    serviceBindings: {
      MAILBOX: async (incoming) => {
        mail.push(await incoming.json());
        return new Response("ok");
      },
    },
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
      EMAIL_FROM: vars.EMAIL_FROM,
      UPGRADE_URL: vars.UPGRADE_URL,
    },
  });
  const { port } = await mf.ready;

  db = await mf.getD1Database("DB");
  for (const migration of await readD1Migrations(join(ROOT, "migrations"))) {
    for (const query of migration.queries) await db.prepare(query).run();
  }
  const now = Date.now();
  for (const [who, person] of Object.entries(PEOPLE)) {
    await db
      .prepare("INSERT INTO accounts (id, email, plan, created_at, display_name) VALUES (?, ?, ?, ?, ?)")
      .bind(person.id, person.email, person.plan, now, person.name)
      .run();
    await db
      .prepare("INSERT INTO tokens (id, token_hash, account_id, label, created_at) VALUES (?, ?, ?, 'e2e', ?)")
      .bind(`tok_${who}`, sha256Hex(TOKENS[who]), person.id, now)
      .run();
  }

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

// ---------------------------------------------------------------------------------------------------------------------
// The story. State the steps share:
// ---------------------------------------------------------------------------------------------------------------------

let DOC; // the private report
let alice; // Alice's browser context, kept open from step 3 to step 6 so she is signed in to the frame once
let threadOne; // the first thread, on SENTENCE
let threadTwo; // the second, on STAFFING
const QUOTE = SENTENCE;
const COMMENT = "This overstates the renewal risk; two of the three accounts already renewed.";

test("1. the owner publishes a private page with the CLI and invites Alice to comment and Bob to view", { timeout: 60_000 }, async () => {
  const published = await cli("owner", ["publish", htmlFile(page(V1)), "--title", "Q3 client report", "--private"]);
  assert.equal(published.error, undefined, published.stderr);
  const result = published.json();
  DOC = result.docId;
  assert.equal(result.version, 1);
  assert.match(result.manageUrl, new RegExp(`/share/${DOC}$`));

  await cli("owner", ["share", DOC, "--add", PEOPLE.alice.email, "--role", "comment"]);
  const shared = await cli("owner", ["share", DOC, "--add", PEOPLE.bob.email, "--role", "view"]);
  assert.equal(shared.error, undefined, shared.stderr);
  const access = shared.json();
  assert.equal(access.linkAccess, "invited");
  assert.deepEqual(
    access.people.map((person) => [person.email, person.role]).sort(),
    [[PEOPLE.alice.email, "comment"], [PEOPLE.bob.email, "view"]],
  );
  // There is no switch: Alice holds Can comment, so the page has comments to show, with none written yet.
  const aliceRead = await request("alice", `/api/v1/docs/${DOC}/threads`);
  assert.equal(aliceRead.status, 200);
  assert.deepEqual(await aliceRead.json(), { docId: DOC, title: "Q3 client report", version: 1, latestVersion: 1, commentable: true, threads: [], viewer: { canComment: true, canManage: false, name: null } });
  assert.equal((await request("owner", `/api/v1/docs/${DOC}/threads`)).status, 200);
  // Bob, who can only view, reads the same empty list and cannot write.
  assert.equal((await request("bob", `/api/v1/docs/${DOC}/threads`)).status, 200);
});

test("2. the Share popover has no Comments switch, only roles, and the page has its Comments button because Alice can comment", { timeout: 120_000 }, async () => {
  const context = await newContext("owner");
  const { tab, frame } = await ownerPopover(context, DOC, { private: true });
  // No switch anywhere: the roles are the control.
  assert.equal(await frame.getByText("Comments", { exact: true }).count(), 0);
  assert.equal(await frame.getByRole("radio", { name: "On", exact: true }).count(), 0);
  const access = await (await request("owner", `/api/v1/docs/${DOC}/access`)).json();
  assert.deepEqual(access.roles, ["view", "comment"]);
  assert.equal("comments" in access, false);
  await frame.getByText("Only people you add can open this page.").waitFor();
  // The invite list shows the roles the CLI set.
  assert.equal(await frame.getByLabel(`Access for ${PEOPLE.alice.email}`).inputValue(), "comment");
  assert.equal(await frame.getByLabel(`Access for ${PEOPLE.bob.email}`).inputValue(), "view");
  await shoot(tab, "01-owner-share-popover-roles");

  // The page already has its button: someone can comment.
  const button = barButton(tab);
  await button.waitFor();
  assert.equal(await counted(tab, 0), true);
  await shoot(tab, "02-owner-page-comments-button");

  // The dropdown writes the role at once.
  const roleOf = async (email) => (await (await request("owner", `/api/v1/docs/${DOC}/access`)).json()).people.find((p) => p.email === email).role;
  await frame.getByLabel(`Access for ${PEOPLE.bob.email}`).selectOption("comment");
  await until("Bob's new role", async () => (await roleOf(PEOPLE.bob.email)) === "comment");
  await frame.getByLabel(`Access for ${PEOPLE.bob.email}`).selectOption("view");
  await until("Bob's role back", async () => (await roleOf(PEOPLE.bob.email)) === "view");
  await tab.reload();
  await button.waitFor();
  await context.close();
});

test("3. Alice selects a passage, signs in to the frame, and posts under her email's name, never asked for one; the owner is emailed", { timeout: 180_000 }, async () => {
  mail.length = 0;
  alice = await newContext("alice");
  const tab = await alice.newPage();
  await openPrivate(tab, DOC);
  const button = barButton(tab);
  await openSidebar(tab);
  const frame = await until("the comments frame", () => commentsFrame(tab, DOC));
  const authorBefore = await tab.locator("#content").innerHTML();

  // A private page before the token: the cards the page relayed, and the one line that leads on. No Comment yet.
  const signIn = frame.getByRole("button", { name: "Continue to see names and comment." });
  await signIn.waitFor();
  await select(tab, QUOTE);
  await tab.waitForTimeout(500);
  assert.equal(await tab.locator(".openartifacts-comment-tip").isVisible().catch(() => false), false, "no Comment before the frame has its token");
  await signInThroughPopup(alice, signIn);
  await frame.getByText("Select text to comment.").waitFor();
  await pressComment(tab, QUOTE);
  assert.equal(await frame.locator("[data-thread=''] .quote").count(), 0, "the draft does not repeat the passage");

  const box = frame.getByRole("textbox", { name: "Add a comment…" });
  await box.waitFor();
  await box.fill(COMMENT);
  await shoot(tab, "03-alice-draft-card");
  await frame.getByRole("button", { name: "Send" }).click();
  // Alice has no display name: she is not asked, and is named from her email before the @.

  const card = frame.locator("[data-thread]:not([data-thread=''])");
  await card.waitFor();
  assert.match(await card.innerText(), /alice/);
  assert.equal(await frame.getByRole("textbox", { name: "Your name" }).count(), 0, "never asked for a name");
  assert.match(await card.innerText(), /This overstates the renewal risk/);
  await until("the bar to count one", () => counted(tab, 1));
  await until("the card to sit level with its passage", async () => {
    const level = await rectOf(tab, QUOTE);
    const cardBox = await card.boundingBox();
    return Math.abs(cardBox.y - level.y) <= 2;
  });
  assert.deepEqual(await painted(tab, "openartifacts-open"), [QUOTE]);
  assert.equal(await tab.locator("#content").innerHTML(), authorBefore, "the author's DOM is untouched");
  await shoot(tab, "04-alice-posted-card-level-with-passage");

  const [stored] = (await (await request("owner", `/api/v1/docs/${DOC}/threads`)).json()).threads;
  threadOne = stored.threadId;
  assert.equal(stored.anchor.exact, QUOTE);
  assert.deepEqual(stored.comments[0].author, { name: "alice", kind: "human" });

  // The owner, and only the owner, is told: with the quote and the comment, and with nobody's address in it.
  const letters = await until("the owner's email", () => (mailTo(PEOPLE.owner.email).length ? mailTo(PEOPLE.owner.email) : null));
  assert.equal(letters.length, 1);
  assert.deepEqual([...new Set(mail.map((message) => message.to))], [PEOPLE.owner.email]);
  for (const part of [letters[0].text, letters[0].html]) {
    assert.ok(part.includes(QUOTE), "the email quotes the passage");
    assert.ok(part.includes("This overstates the renewal risk"), "the email carries the comment");
    assert.ok(part.includes("alice"), "the email names the author");
    assert.ok(!part.includes(PEOPLE.alice.email) && !part.includes(PEOPLE.bob.email), "no one else's address");
  }
  assert.ok(letters[0].text.includes(DOC), "the email links to the page");
});

test("4. the agent lists the thread, publishes v2, replies and resolves; Alice is emailed both", { timeout: 60_000 }, async () => {
  const listed = await cli("owner", ["comments", "list", DOC, "--open"]);
  assert.equal(listed.error, undefined, listed.stderr);
  const threads = listed.json().threads;
  assert.equal(threads.length, 1);
  assert.equal(threads[0].threadId, threadOne);
  assert.equal(threads[0].anchor.exact, QUOTE);
  assert.equal(threads[0].comments[0].body, COMMENT);
  assert.equal(threads[0].state, "open");

  const updated = await cli("owner", ["publish", htmlFile(page(V2)), "--doc-id", DOC]);
  assert.equal(updated.error, undefined, updated.stderr);
  assert.equal(updated.json().version, 2);

  mail.length = 0;
  const reply = await cli("owner", ["comments", "reply", DOC, threadOne, "--body", "Softened in v2: two of the three accounts have renewed."]);
  assert.equal(reply.error, undefined, reply.stderr);
  const resolved = await cli("owner", ["comments", "resolve", DOC, threadOne]);
  assert.equal(resolved.error, undefined, resolved.stderr);
  const thread = resolved.json();
  assert.equal(thread.state, "resolved");
  assert.equal(thread.resolution.atVersion, 2);
  assert.deepEqual(thread.resolution.by, { name: "Logan's agent", kind: "agent" });
  assert.deepEqual(thread.comments[1].author, { name: "Logan's agent", kind: "agent" });
  assert.equal(thread.comments[1].body, "Softened in v2: two of the three accounts have renewed.");

  const letters = await until("both emails", () => (mailTo(PEOPLE.alice.email).length >= 2 ? mailTo(PEOPLE.alice.email) : null));
  assert.deepEqual([...new Set(mail.map((message) => message.to))], [PEOPLE.alice.email], "only Alice, never the actor");
  assert.ok(letters.some((message) => message.text.includes("Softened in v2")), "the reply email");
  assert.ok(letters.every((message) => !message.text.includes(PEOPLE.owner.email) && !message.html.includes(PEOPLE.bob.email)));
  assert.equal((await cli("owner", ["comments", "list", DOC, "--open"])).json().threads.length, 0);
});

test("5. Alice reloads: the card is collapsed as resolved in v2, she can Reopen it, and resolve it again", { timeout: 180_000 }, async () => {
  const [tab] = alice.pages();
  await tab.reload();
  await openSidebar(tab);
  const frame = await until("the comments frame", () => commentsFrame(tab, DOC));
  const toggle = frame.getByRole("button", { name: "1 resolved" });
  await toggle.waitFor();
  await until("the bar to count none open", () => counted(tab, 0));
  assert.equal(await frame.locator("[data-thread]").count(), 0, "a resolved thread has no card on the page");
  await shoot(tab, "05-alice-resolved-card-collapsed");

  await toggle.click();
  const card = frame.locator("[data-thread].resolved");
  await card.getByText("Softened in v2").waitFor();
  assert.match(await card.locator(".where").innerText(), /^Resolved in v2 by Logan's agent$/);
  assert.equal(await card.locator(".who .badge", { hasText: "agent" }).count(), 1, "the agent's reply is badged");
  await shoot(tab, "06-alice-resolved-card-expanded");
  // Alice started the thread, so Reopen is hers.
  await card.getByRole("button", { name: "Reopen" }).click();
  await until("the thread to be open", async () => (await (await request("owner", `/api/v1/docs/${DOC}/threads?state=open`)).json()).threads.length === 1);
  await until("the bar to count one", () => counted(tab, 1));

  // Open again, and its text no longer on the page: it waits at the top, and Alice can resolve it from the browser.
  const open = frame.locator("[data-thread]").first();
  await open.getByRole("button", { name: "Resolve" }).click();
  await until("resolved again", async () => (await (await request("owner", `/api/v1/docs/${DOC}/threads?state=resolved`)).json()).threads.length === 1);
  const [thread] = (await (await request("owner", `/api/v1/docs/${DOC}/threads?state=resolved`)).json()).threads;
  assert.deepEqual(thread.resolution.by, { name: "alice", kind: "human" });
  await until("the bar to count none", () => counted(tab, 0));
});

test("6. v3 deletes a sentence another thread quotes: that card moves under 'On text that changed'", { timeout: 180_000 }, async () => {
  const [tab] = alice.pages();
  await tab.reload();
  await openSidebar(tab);
  const frame = await until("the comments frame", () => commentsFrame(tab, DOC));
  await frame.getByRole("button", { name: "1 resolved" }).waitFor();
  await pressComment(tab, STAFFING);
  const box = frame.getByRole("textbox", { name: "Add a comment…" });
  await box.waitFor();
  await box.fill("Is staffing really unchanged after the migration?");
  await frame.getByRole("button", { name: "Send" }).click();
  await until("the second thread", async () => (await (await request("owner", `/api/v1/docs/${DOC}/threads?state=open`)).json()).threads.length === 1);
  threadTwo = (await (await request("owner", `/api/v1/docs/${DOC}/threads?state=open`)).json()).threads[0].threadId;
  await until("its highlight", async () => (await painted(tab, "openartifacts-open")).includes(STAFFING));

  const published = await cli("owner", ["publish", htmlFile(page(V3)), "--doc-id", DOC]);
  assert.equal(published.json().version, 3);
  await tab.reload();
  await openSidebar(tab);
  const again = await until("the comments frame", () => commentsFrame(tab, DOC));
  await again.getByText("On text that changed", { exact: true }).waitFor();
  const orphan = again.locator("[data-thread].muted:not(.resolved)");
  await orphan.waitFor();
  assert.match(await orphan.innerText(), new RegExp(STAFFING));
  assert.match(await orphan.innerText(), /Is staffing really unchanged/);
  assert.equal(await orphan.evaluate((el) => getComputedStyle(el).opacity), "1");
  // Still open, still counted.
  await until("the bar to count it", () => counted(tab, 1));
  assert.deepEqual(await painted(tab, "openartifacts-open"), []);
  await shoot(tab, "07-alice-orphaned-card-v3");
  await alice.close();
});

test("7. Bob (Can view) sees the cards, no reply box and no Comment button, and his API writes are 404", { timeout: 180_000 }, async () => {
  const context = await newContext("bob");
  const tab = await context.newPage();
  await openPrivate(tab, DOC);
  await openSidebar(tab);
  const frame = await until("the comments frame", () => commentsFrame(tab, DOC));
  const card = frame.locator("[data-thread]:not(.resolved)");
  await card.waitFor();
  assert.match(await card.innerText(), /Is staffing really unchanged/);
  assert.equal(await frame.locator("[data-thread].resolved").count(), 0, "the resolved thread waits behind its count");
  await frame.getByRole("button", { name: "1 resolved" }).waitFor();
  // The frame learns who he is when he signs in; a card offers that, and never a box to type in.
  assert.equal(await frame.getByRole("textbox").count(), 0);
  await signInThroughPopup(context, frame.getByRole("button", { name: "Continue to see names and comment." }));
  await frame.getByText("You can view this page.").waitFor();
  assert.equal(await frame.getByText("Select text to comment.").count(), 0);
  assert.equal(await frame.getByRole("textbox").count(), 0);
  assert.equal(await frame.getByRole("button", { name: "Send" }).count(), 0);

  await select(tab, "Closing remarks follow in the appendix");
  await tab.waitForTimeout(600);
  assert.equal(await tab.locator(".openartifacts-comment-tip").isVisible().catch(() => false), false, "no Comment button for a viewer");
  await shoot(tab, "08-bob-can-view");

  // He can read through the API, and every write is a 404 rather than a 403.
  assert.equal((await request("bob", `/api/v1/docs/${DOC}/threads`)).status, 200);
  const anchor = { exact: "Closing remarks follow in the appendix" };
  const attempts = [
    ["POST", `/threads`, { anchor, body: "Let me in." }],
    ["POST", `/threads/${threadTwo}/comments`, { body: "Let me reply." }],
    ["POST", `/threads/${threadTwo}/resolve`, {}],
  ];
  for (const [method, path, body] of attempts) {
    const response = await request("bob", `/api/v1/docs/${DOC}${path}`, { method, body: JSON.stringify(body) });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal((await response.json()).error.code, "not_found");
  }
  assert.equal((await (await request("owner", `/api/v1/docs/${DOC}/threads`)).json()).threads.length, 2, "nothing was written");
  await context.close();
});

test("8. a stranger gets 404 from every comment route, and so does a signed-out fetch of the threads resource", { timeout: 60_000 }, async () => {
  const anchor = { exact: "Closing remarks follow in the appendix" };
  const routes = [
    ["GET", `/threads`],
    ["POST", `/threads`, { anchor, body: "hello" }],
    ["POST", `/threads/${threadTwo}/comments`, { body: "hello" }],
    ["POST", `/threads/${threadTwo}/resolve`, {}],
    ["POST", `/threads/${threadTwo}/reopen`, {}],
    ["DELETE", `/comments/cm_nothing`],
    ["GET", `/html`],
  ];
  const unknown = await request("stranger", `/api/v1/docs/doc_never_existed/threads`);
  const unknownBody = await unknown.text();
  const unknownPage = JSON.parse(unknownBody);
  for (const [method, path, body] of routes) {
    const response = await request("stranger", `/api/v1/docs/${DOC}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal((await response.json()).error.code, "not_found");
  }
  // Indistinguishable from a document that never existed.
  assert.equal(unknown.status, 404);
  assert.equal(unknownPage.error.code, "not_found");

  // The embed family, with a valid per-document token for the stranger: the same 404.
  const token = shareToken(PEOPLE.stranger.id, DOC);
  for (const [method, path, body] of routes.filter(([, path]) => !path.endsWith("/html"))) {
    const response = await mf.dispatchFetch(`https://${API}/embed/api/docs/${DOC}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 404, `embed ${method} ${path}`);
  }
  assert.equal((await mf.dispatchFetch(`https://${API}/embed/api/docs/${DOC}/threads`)).status, 404, "signed out, embed");
  // The serving origin: a private document's threads are 404 JSON on the apex, never a redirect.
  const apex = await mf.dispatchFetch(`https://${SERVING}/d/${DOC}/threads`, { redirect: "manual" });
  assert.equal(apex.status, 404);
  assert.equal(apex.headers.get("content-type")?.startsWith("application/json"), true);
  assert.equal(apex.headers.get("set-cookie"), null);
  // And the comment text is nowhere in what the stranger was told.
  assert.ok(!unknownBody.includes("staffing"));
});

let PUBLIC; // the public document of step 9
test("9. a signed-out reader of a public page sees read-only cards, signs in, and posts", { timeout: 180_000 }, async () => {
  const published = await cli("owner", ["publish", htmlFile(page(V1)), "--title", "Public report", "--public"]);
  PUBLIC = published.json().docId;
  // Erin will reply: commenting is a grant from the owner, on a public page as on a private one.
  assert.equal((await cli("owner", ["share", PUBLIC, "--add", PEOPLE.erin.email, "--role", "comment"])).error, undefined);
  const added = await cli("owner", ["comments", "add", PUBLIC, "--quote", STAFFING, "--prefix", "", "--body", "Who is staffed?", "--section", "staffing"]);
  assert.equal(added.error, undefined, added.stderr);

  const context = await newContext(null);
  const tab = await context.newPage();
  await tab.goto(docUrl(PUBLIC));
  await openSidebar(tab);
  const frame = await until("the comments frame", () => commentsFrame(tab, PUBLIC));
  const card = frame.locator("[data-thread]").first();
  await card.waitFor();
  assert.match(await card.innerText(), /Who is staffed\?/);
  assert.match(await card.innerText(), /agent/);
  await until("its highlight", async () => (await painted(tab, "openartifacts-open")).includes(STAFFING));
  assert.equal(await card.getByRole("textbox").count(), 0);
  // Erin may comment, so the sidebar invites her to sign in; the card itself stays read-only.
  const signIn = frame.getByRole("button", { name: "Invited to comment? Sign in." });
  await signIn.waitFor();
  await select(tab, STAFFING);
  await tab.waitForTimeout(500);
  assert.equal(await tab.locator(".openartifacts-comment-tip").isVisible().catch(() => false), false, "no Comment for a signed-out reader");
  await shoot(tab, "09-signed-out-reader-public-page");

  // Signing in is the one thing the context did not have; with it the same line leads to a reply box.
  await context.addCookies([sessionCookie(PEOPLE.erin.id)]);
  await signInThroughPopup(context, signIn);
  await card.locator(".txt").first().click();
  const reply = frame.getByRole("textbox", { name: "Reply…" });
  await reply.waitFor();
  await reply.fill("Three engineers, same as Q2.");
  await frame.getByRole("button", { name: "Send" }).click();
  await until("the reply", async () => (await card.innerText()).includes("Three engineers, same as Q2."));
  const [thread] = (await (await request("owner", `/api/v1/docs/${PUBLIC}/threads`)).json()).threads;
  assert.deepEqual(thread.comments[1].author, { name: "Erin", kind: "human" });
  await shoot(tab, "10-erin-signed-in-replied");
  await context.close();
});

test("10. a Free-plan owner cannot add anyone: the CLI prints the upgrade hint and the popover shows the plan line, with no Add people", { timeout: 180_000 }, async () => {
  // No flag: a Free plan has no private pages, so the CLI falls back to a public one.
  const published = await cli("free", ["publish", htmlFile(page(V1)), "--title", "Free report"]);
  assert.equal(published.error, undefined, published.stderr);
  assert.equal(published.json().linkAccess, "anyone");
  const free = published.json().docId;
  const refused = await cli("free", ["share", free, "--add", "dee@acme.com"]);
  assert.equal(refused.error?.status, 402);
  assert.equal(refused.error.code, "limit_reached");
  assert.equal(refused.error.detail.limit, "privateSharing");
  assert.match(refused.stderr, /Adding people needs a paid plan/);
  assert.match(refused.stderr, /Upgrade: https?:\/\//);

  const context = await newContext("free");
  const { tab, frame } = await ownerPopover(context, free);
  await frame.getByText(/Private pages and comments need a paid plan/).waitFor();
  assert.equal(await frame.getByRole("heading", { name: "Add people" }).count(), 0);
  const access = await (await request("free", `/api/v1/docs/${free}/access`)).json();
  assert.deepEqual(access.roles, []);
  assert.equal("comments" in access, false);
  await shoot(tab, "11-free-owner-plan-line");
  await context.close();
});

test("11. on a phone a tapped highlight opens a bottom sheet with the card, and Comment adds a new one", { timeout: 180_000 }, async () => {
  const phone = devices["iPhone 13"];
  const context = await newContext("erin", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: phone.userAgent });
  const tab = await context.newPage();
  await tab.goto(docUrl(PUBLIC));
  const frame = await until("the comments frame", () => commentsFrame(tab, PUBLIC));
  await until("the highlight", async () => (await painted(tab, "openartifacts-open")).includes(STAFFING));
  // Narrow page: no sidebar, so nothing is drawn until a highlight is tapped.
  assert.equal(await hostBox(tab), null);
  await tab.evaluate(() => document.getElementById("staffing").scrollIntoView({ block: "center" }));
  await tab.waitForTimeout(300);
  const at = await rectOf(tab, STAFFING);
  await tab.touchscreen.tap(at.x + at.width / 3, at.y + at.height / 2);
  const sheet = await until("the bottom sheet", () => hostBox(tab));
  assert.ok(sheet.y + sheet.height >= 844 - 2 && sheet.height < 844 * 0.55 + 2 && sheet.width >= 388, `a bottom sheet (${JSON.stringify(sheet)})`);
  await frame.getByText("Who is staffed?").waitFor();
  // Erin's phone has not signed in to the frame yet: the sheet carries the sidebar's one line, and the popup answers.
  await signInThroughPopup(context, frame.getByRole("button", { name: "Invited to comment? Sign in." }));
  await frame.getByText("Select text to comment.").waitFor();
  await shoot(tab, "12-phone-bottom-sheet-card");
  await frame.getByRole("button", { name: "Close" }).click();
  await until("the sheet to close", async () => (await hostBox(tab)) === null);

  await tab.evaluate(() => window.scrollTo(0, 0));
  await pressComment(tab, "Revenue grew 18% quarter over quarter", { touch: true });
  await until("the sheet", async () => (await hostBox(tab)) !== null);
  const area = frame.getByRole("textbox", { name: "Add a comment…" });
  await area.fill("What is the base for 18%?");
  await shoot(tab, "13-phone-new-comment-sheet");
  await frame.getByRole("button", { name: "Send" }).tap();
  await until("the new thread", async () => (await (await request("owner", `/api/v1/docs/${PUBLIC}/threads`)).json()).threads.length === 2);
  await until("the new card", async () => (await frame.getByText("What is the base for 18%?").count()) === 1);
  const threads = (await (await request("owner", `/api/v1/docs/${PUBLIC}/threads`)).json()).threads;
  assert.equal(threads[1].anchor.exact, "Revenue grew 18% quarter over quarter");
  await context.close();
});

test("12. unsharing answers 410 for the page and the threads, 404 for the comment routes, and purges everything", { timeout: 60_000 }, async () => {
  const bucket = await mf.getR2Bucket("DOCS");
  assert.notEqual(await bucket.head(`docs/${DOC}/threads.json`), null, "a snapshot exists before");
  const removed = await cli("owner", ["unshare", DOC]);
  assert.equal(removed.error, undefined, removed.stderr);
  assert.match(removed.stdout, /Unshared/);

  assert.equal((await mf.dispatchFetch(docUrl(DOC))).status, 410);
  assert.equal((await mf.dispatchFetch(docUrl(DOC, 1))).status, 410);
  assert.equal((await mf.dispatchFetch(`https://${SERVING}/d/${DOC}/threads`)).status, 410);
  const anchor = { exact: "Closing remarks follow in the appendix" };
  for (const [who, method, path, body] of [
    ["owner", "GET", "/threads"],
    ["owner", "POST", "/threads", { anchor, body: "after" }],
    ["owner", "POST", `/threads/${threadTwo}/comments`, { body: "after" }],
    ["owner", "POST", `/threads/${threadTwo}/resolve`, {}],
    ["alice", "POST", `/threads/${threadTwo}/comments`, { body: "after" }],
  ]) {
    const response = await request(who, `/api/v1/docs/${DOC}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 404, `${who} ${method} ${path}`);
  }
  assert.equal(await bucket.head(`docs/${DOC}/threads.json`), null, "threads.json is gone");
  assert.deepEqual(
    (await bucket.list({ prefix: `docs/${DOC}/` })).objects.map((o) => o.key),
    [`docs/${DOC}/manifest.json`],
    "nothing of the document is left in R2 but its tombstone manifest",
  );

  // The Durable Object itself refuses a write now, whatever reaches it.
  const object = async (method, args) => (await mf.dispatchFetch(`https://${API}/__e2e/comments-object`, { method: "POST", body: JSON.stringify({ docId: DOC, method, args }) })).json();
  assert.deepEqual(await object("createThread", { docId: DOC, principal: PEOPLE.owner.id, kind: "human", name: "Logan", version: 3, anchor, body: "after" }), { ok: false, reason: "purged" });
  assert.deepEqual(await object("list", { docId: DOC, version: 3 }), { ok: false, reason: "purged" });
  // The row stays (410, not 404), and the other document is untouched.
  assert.equal((await mf.dispatchFetch(docUrl(PUBLIC))).status, 200);
  assert.equal((await (await request("owner", `/api/v1/docs/${PUBLIC}/threads`)).json()).threads.length, 2);
});
