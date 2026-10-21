/**
 * The Share popover in a real browser: `npm run test:browser`.
 *
 * The vitest suite runs inside workerd, which cannot load a page, a frame or a
 * popup, so `test/serve.test.ts` covers the HTTP contract and this covers the
 * DOM. It is also the only check of two things that depend on a browser's own
 * policy: the popup's binding (`Sec-Fetch-Site`, `__Host-` cookies, the opener
 * policy) and the frame's rule that it tells a page embedding it nothing.
 *
 * **What is real.** The deployed bundle (`wrangler deploy --dry-run`) runs under
 * Miniflare over HTTPS with real D1 and R2, and no `upstream`, so the Worker
 * sees each request's real `Host` and its host allowlist runs as in production.
 * Chrome (the runner's own, through `channel: "chrome"`) is pointed at it with
 * `--host-resolver-rules`, so `openartifacts.site` and `api.openartifacts.ai` are
 * reached by name (the rule also maps `*.openartifacts.site`, where the owner's
 * private documents are served; their label host's own rules are covered by
 * `test/serve.test.ts` at the HTTP level). Every request therefore goes
 * through Chrome's network stack, where Fetch Metadata, cookies, CSP,
 * `frame-ancestors`, the opener policy and storage partitioning are Chrome's.
 *
 * **Do not use `context.route`.** A request answered by `route.fulfill` never
 * reaches the network stack where Fetch Metadata is added; the popup would
 * arrive with no `Sec-Fetch-Site` and be refused, and a test that injected the
 * header would prove only what the harness invented.
 *
 * **Keep `--ignore-certificate-errors`.** With only the context option
 * `ignoreHTTPSErrors`, the first popup's request in a fresh browser raced the
 * certificate override and the popup failed to open in 2 of 6 runs. With the
 * flag every run passed, and the frame still had `isSecureContext`, the popup
 * still got `Sec-Fetch-Site: same-origin`, and `__Host-` cookies were still set.
 *
 * Needs Node 22 and a Google Chrome. `OA_HEADED=1` shows the browser, and
 * `OA_SCREENSHOTS={dir}` saves `bar.png`, `popover-signed-out.png`,
 * `popover-owner.png` and `popover-private.png`.
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
// A CommonJS export, fine in Node. Never start this file with
// `node --input-type=module`: Miniflare's binding proxy runs a CommonJS worker
// thread that inherits `execArgv`, dies on `require` under that flag, and leaves
// the main thread blocked in `Atomics.wait` for good. A `.mjs` file is fine.
const { readD1Migrations } = require("@cloudflare/vitest-pool-workers/config");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVING = "openartifacts.site";
const API = "api.openartifacts.ai";
const SECRET = "k".repeat(32);
const KEY = "cplus_live_a1b2c3d4e5f60718";
const OWNER = "owner-p";
const BUILD = join(ROOT, "node_modules", ".cache", "share-popover-browser");

/** `oa_` and 26 Crockford characters, which the accounts table's check requires. */
const accountId = (seed) => `oa_${seed}${"0123456789abcdefghjkmnpqrs".slice(seed.length)}`;
const OWNER_ACCOUNT = accountId("a");

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

/** A session cookie value, signed the way `src/session.ts` does. */
function sessionValue(account) {
  const body = Buffer.from(JSON.stringify({ a: account, exp: Date.now() + 86_400_000 })).toString("base64url");
  const mac = createHmac("sha256", SECRET).update(`session.${body}`).digest("base64url");
  return `${body}.${mac}`;
}

const sessionCookie = (account) => ({
  name: "__Host-oa_session",
  value: sessionValue(account),
  url: `https://${API}`,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
});

/** `wrangler.jsonc` without its comment lines. The only `//` at a line's start is a comment. */
function wranglerVars() {
  const text = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return JSON.parse(text).vars;
}

const html = (title, body = "") =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body>\n<p>${title}</p>\n${body}\n</body>\n</html>\n`;

/** Poll `read` until it returns something truthy; a thrown error counts as not yet. */
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
let mfPort;
let browser;
let db;

const screenshots = process.env.OA_SCREENSHOTS;
async function shoot(page, name) {
  if (!screenshots) return;
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, `${name}.png`) });
}

const api = (path, init = {}) =>
  mf.dispatchFetch(`https://${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...init.headers },
  });

/** Publish through the real push route and return the doc id. */
async function publish(title, body, route = "docs") {
  const response = await api(`/api/v1/${route}`, { method: "POST", body: JSON.stringify({ title, html: html(title, body) }) });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).docId;
}

const docUrl = (docId) => `https://${SERVING}/d/${docId}`;
const frameUrl = (docId) => new RegExp(`^https://${API.replaceAll(".", "\\.")}/embed/share\\?doc=${docId}(&|$)`);
const frameOf = (page, docId) => page.frames().find((frame) => frameUrl(docId).test(frame.url()));

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
    // Roles are only offered where the comments object is bound.
    durableObjects: { COMMENTS: { className: "DocComments", useSQLite: true } },
    // The page validator reads the deploy time from this binding; wrangler.jsonc
    // declares it, but this harness does not read wrangler.jsonc.
    versionMetadata: "CF_VERSION_METADATA",
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
      ACCOUNT_ACTION_URL: vars.ACCOUNT_ACTION_URL,
      UPGRADE_URL: vars.UPGRADE_URL,
    },
  });
  const { port } = await mf.ready;
  mfPort = port;

  db = await mf.getD1Database("DB");
  for (const migration of await readD1Migrations(join(ROOT, "migrations"))) {
    for (const query of migration.queries) await db.prepare(query).run();
  }

  // The key's publisher row, validated now so no license server is asked; an
  // account on a paid plan; and the link that makes the account the key's owner.
  // Inserting the link nulls the account's `plan_checked_at`, which is harmless
  // here: with no license server configured the stored plan stands.
  const now = Date.now();
  await db
    .prepare("INSERT INTO publishers (key_hash, plan, validated_at, owner) VALUES (?, 'believer', ?, ?)")
    .bind(sha256Hex(KEY), now, OWNER)
    .run();
  await db
    .prepare("INSERT INTO accounts (id, email, plan, created_at) VALUES (?, 'owner@example.com', 'pro', ?)")
    .bind(OWNER_ACCOUNT, now)
    .run();
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

const newContext = (account) =>
  browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } }).then(async (context) => {
    if (account) await context.addCookies([sessionCookie(account)]);
    return context;
  });

test("Share opens the popover, the owner signs in through the popup, and a switch to private lands", { timeout: 120_000 }, async () => {
  const X = await publish("Quarterly plan", "<p>Mine.</p>");
  const Y = await publish(
    "Hostile page",
    `<iframe id="f" src="https://${API}/embed/share?doc=${X}&origin=${encodeURIComponent(`https://${SERVING}`)}" style="width:380px;height:480px"></iframe>
<script>
window.__messages = [];
window.addEventListener("message", (event) => {
  window.__messages.push({ origin: event.origin, data: event.data });
  // The frame is listening by now: a forged token, from the embedding page.
  if (event.data && event.data.event === "ready") {
    document.getElementById("f").contentWindow.postMessage({ type: "openartifacts:share-token", doc: "${X}", token: "oas_forged", expiresAt: Date.now() + 86400000 }, "*");
  }
});
window.setInterval(() => { if (document.activeElement !== document.body) window.__focusMoved = true; }, 25);
</script>`,
  );

  const context = await newContext(OWNER_ACCOUNT);
  const claims = [];
  context.on("response", (r) => {
    if (r.url().endsWith("/embed/token")) claims.push(r.status());
  });
  const page = await context.newPage();

  // 1. The page is served on the mapped host, with the bar.
  const response = await page.goto(docUrl(X));
  assert.equal(response.status(), 200);
  const share = page.locator("a[data-openartifacts-share]");
  await share.waitFor();
  await shoot(page, "bar");

  // 2. Share opens a frame on the API host (the shadow root is closed, so it is
  //    found through the page's frames), and the frame offers sign-in.
  await share.click();
  const frame = await until("the Share frame", () => frameOf(page, X));
  assert.match(frame.url(), new RegExp(`origin=${encodeURIComponent(`https://${SERVING}`)}$`));
  const signIn = frame.getByRole("button", { name: "Sign in to manage" });
  await signIn.waitFor();
  // A page embedding the frame could navigate it to `#id` and watch for a focus move; no id is there to find.
  const focusableIds = () => frame.evaluate(() => Array.from(document.querySelectorAll("[id]")).filter((e) => e.matches("main,a[href],button,input,select,textarea,summary,[tabindex],[contenteditable]")).map((e) => e.id));
  assert.deepEqual(await focusableIds(), [], "signed-out view: no focusable element has an id");
  assert.equal(await frame.evaluate(() => window.isSecureContext), true);
  await shoot(page, "popover-signed-out");
  // A short view is the row (link, Copy link, ×), the sentence under it, and the
  // account line pinned to the floor of the fixed-height popover.
  const mainBox = await frame.locator("main").boundingBox();
  const bottom = await frame.locator(".bottom").boundingBox();
  assert.ok(mainBox.y + mainBox.height - (bottom.y + bottom.height) < 32, "the account line and hint are pinned to the bottom");
  assert.ok(await frame.getByText("Published from Copilot?").isVisible(), "the guest view carries the Copilot hint");

  // 3. Sign in to manage opens the popup, which sees the owner's session through
  //    the browser's own Sec-Fetch-Site and cookie. A 400 here would mean the
  //    popup's binding refused it. Embedded in a document page the popup's opener
  //    is severed (see step 4), so the poll is what lands.
  const [popup, popupResponse] = await Promise.all([
    context.waitForEvent("page"),
    context.waitForEvent("response", (r) => r.url().includes("/embed/sign-in?")),
    signIn.click(),
  ]);
  assert.equal(popupResponse.status(), 200);
  assert.equal(new URL(popupResponse.url()).searchParams.get("doc"), X);
  assert.equal(popupResponse.headers()["cross-origin-opener-policy"], "same-origin");

  // 4. The popup closes, and the frame shows the owner view.
  await popup.waitForEvent("close").catch(() => {});
  const invitedOnly = frame.getByLabel("General access");
  await invitedOnly.waitFor();
  assert.deepEqual(await focusableIds(), [], "owner view: no focusable element has an id");
  assert.equal(await invitedOnly.inputValue(), "anyone");
  // The popup's opener is gone: the page embedding the frame sends no opener
  // policy and the popup does, so Chrome puts the popup in a new browsing
  // context group. Nothing could have been posted to the frame, so the token
  // arrived by the frame's own poll, which is the path the popup's message is
  // only an addition to.
  assert.ok(claims.includes(200), `the frame collected its token by polling (claims: ${claims})`);
  await shoot(page, "popover-owner");

  // No oracle. A hostile public page on the same site embeds the same frame for
  // the same document. The stored token is in the storage partition the two
  // pages share, so the frame inside it draws the owner view, and the page
  // around it must learn nothing from that: exactly one message, `ready`, from
  // the API origin; no focus move; and a token it forges into the frame is
  // ignored, because the frame accepts one only from the popup it opened.
  const hostile = await context.newPage();
  await hostile.goto(docUrl(Y));
  await until("the hostile page's frame", () => frameOf(hostile, X));
  await until("the hostile page's frame to show the owner view", () =>
    frameOf(hostile, X).getByLabel("General access").isVisible(),
  );
  await hostile.waitForTimeout(3000);
  const token = await frame.evaluate((key) => window.localStorage.getItem(key), `openartifacts:share-token:${X}`);
  assert.ok(token, "the frame holds the owner's token");
  assert.equal(
    await frameOf(hostile, X).evaluate((key) => window.localStorage.getItem(key), `openartifacts:share-token:${X}`),
    token,
    "a forged message replaced nothing",
  );
  assert.equal(await frameOf(hostile, X).getByLabel("General access").isVisible(), true);
  assert.deepEqual(await hostile.evaluate(() => window.__messages), [
    { origin: `https://${API}`, data: { type: "openartifacts:share", event: "ready" } },
  ]);
  assert.equal(await hostile.evaluate(() => window.__focusMoved), undefined);
  await hostile.close();

  // Back on the first page: switching to private lands, and says nothing about copies.
  await invitedOnly.selectOption("invited");
  await frame.getByText("Only you can open this link").waitFor();
  assert.equal(await invitedOnly.inputValue(), "invited");
  assert.equal(await frame.getByText(/kept a copy/).count(), 0);
  const access = await api(`/api/v1/docs/${X}/access`);
  assert.equal(access.status, 200);
  assert.equal((await access.json()).linkAccess, "invited");
  await shoot(page, "popover-private");

  // Escape hides the popover.
  const popover = page.locator(".openartifacts-share-popover");
  assert.equal(await popover.isVisible(), true);
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "hidden" });
  await context.close();
});

test("a frame a hostile page embedded while the document was public shows no controls once it is private", { timeout: 180_000 }, async () => {
  // frame-ancestors is checked when a frame loads, and the frame is never
  // reloaded. A page that embedded it while the document was public keeps it, and
  // the owner's token in the storage they share would draw the owner's controls
  // under that page after the document goes private.
  const X = await publish("Went private", "<p>Mine.</p>");
  const embed = `<iframe id="f" src="https://${API}/embed/share?doc=${X}&origin=${encodeURIComponent(`https://${SERVING}`)}" style="width:380px;height:480px"></iframe>`;
  const Y1 = await publish("Hostile one", embed);
  const Y2 = await publish("Hostile two", embed);
  const Y3 = await publish("Hostile three", embed);
  const Y4 = await publish("Hostile four", embed);

  const context = await newContext(OWNER_ACCOUNT);
  const page = await context.newPage();
  await page.goto(docUrl(X));
  await page.locator("a[data-openartifacts-share]").click();
  const frame = await until("the Share frame", () => frameOf(page, X));
  const [popup] = await Promise.all([context.waitForEvent("page"), frame.getByRole("button", { name: "Sign in to manage" }).click()]);
  await popup.waitForEvent("close").catch(() => {});
  const invitedOnly = frame.getByLabel("General access");
  await invitedOnly.waitFor();

  // Someone is on the list before X goes private, so a click on Remove in a stale
  // view has something to remove.
  const invitee = "invited@example.com";
  assert.equal((await api(`/api/v1/docs/${X}/access/people/${encodeURIComponent(invitee)}`, { method: "PUT", body: "{}" })).status, 200);
  const people = async () => (await (await api(`/api/v1/docs/${X}/access`)).json()).people.map((entry) => entry.email);
  assert.deepEqual(await people(), [invitee]);

  // The hostile pages hold a frame with the owner view, drawn while X is public.
  const hostile = [];
  for (const id of [Y1, Y2, Y3]) {
    const tab = await context.newPage();
    await tab.goto(docUrl(id));
    await until("the hostile frame's owner view", () => frameOf(tab, X).getByLabel("General access").isVisible());
    hostile.push(tab);
  }
  // A fourth hostile page, for a role's stale write.
  const tab4 = await context.newPage();
  await tab4.goto(docUrl(Y4));
  await until("the fourth hostile frame's owner view", () => frameOf(tab4, X).getByLabel("General access").isVisible());
  hostile.push(tab4);

  // The owner makes X private from X's own page, whose frame made the switch.
  await invitedOnly.selectOption("invited");
  await frame.getByText("Only people invited can open this link").waitFor();
  assert.equal((await (await api(`/api/v1/docs/${X}/access`)).json()).linkAccess, "invited");

  // A click on the first hostile page's stale view is checked against the
  // document first and draws no controls, and does not turn X public again.
  const stale = frameOf(hostile[0], X);
  await stale.getByLabel("General access").selectOption("invited");
  await stale.getByText("Open Share from the document’s own page").waitFor();
  assert.equal(await stale.getByLabel("General access").count(), 0);
  assert.equal((await (await api(`/api/v1/docs/${X}/access`)).json()).linkAccess, "invited");

  // The stale view is checked before any write, not only the mode switch: a
  // Remove on the third hostile page's stale view removes no one.
  const stale2 = frameOf(hostile[2], X);
  await stale2.getByLabel(`Access for ${invitee}`).selectOption("remove");
  await stale2.getByText("Open Share from the document’s own page").waitFor();
  assert.deepEqual(await people(), [invitee], "a stale Remove changed nothing");

  // A role is a write like Remove: a stale view that offers it checks the document
  // first, and changes no one's role.
  const stale3 = frameOf(hostile[3], X);
  await stale3.getByLabel(`Access for ${invitee}`).selectOption("view");
  await stale3.getByText("Open Share from the document’s own page").waitFor();
  const roleNow = async () => (await (await api(`/api/v1/docs/${X}/access`)).json()).people.find((entry) => entry.email === invitee).role;
  assert.equal(await roleNow(), "comment", "a stale role change changed nothing");

  // The second page's frame refreshes when a token is written in the shared
  // storage, and draws the same line instead of the owner view.
  const key = `openartifacts:share-token:${X}`;
  await frame.evaluate((name) => {
    const value = window.localStorage.getItem(name);
    window.localStorage.removeItem(name);
    window.localStorage.setItem(name, value);
  }, key);
  const refreshed = frameOf(hostile[1], X);
  await refreshed.getByText("Open Share from the document’s own page").waitFor();
  assert.equal(await refreshed.getByLabel("General access").count(), 0);
  assert.equal(await refreshed.getByRole("button", { name: "Approve" }).count(), 0);

  // The owner's own frame keeps its view after a refresh of its own. A token
  // written by a hostile page's frame reaches it as a storage event while X is
  // private, which is the case the first write inside the owner's frame never
  // exercises. It keeps the mode control, but not the one-click
  // writes on the private document: a switch made in a frame is not proof that
  // the page around it is the owner's.
  await stale.evaluate((name) => {
    const value = window.localStorage.getItem(name);
    window.localStorage.removeItem(name);
    window.localStorage.setItem(name, value);
  }, key);
  await until("the owner's frame to redraw", async () => (await frame.getByText("To remove people or answer requests,").count()) > 0);
  assert.equal(await invitedOnly.inputValue(), "invited");
  // Nor a role or Remove access, which the limited view leaves to the share page.
  assert.equal(await frame.getByLabel(`Access for ${invitee}`).count(), 0);
  assert.equal(await frame.getByText(invitee).count(), 1, "the list is still shown");
  assert.equal(await frame.getByPlaceholder("Invite people by email").count(), 1);

  // Switching back to public from inside the frame brings the full view back.
  await frame.getByLabel("General access").selectOption("anyone");
  // The select shows its new value at once; the footer's sentence is what the answer draws.
  await frame.getByText("Anyone with the link can view").waitFor();
  assert.equal((await (await api(`/api/v1/docs/${X}/access`)).json()).linkAccess, "anyone");
  assert.equal(await frame.getByLabel(`Access for ${invitee}`).locator("option", { hasText: "Remove access" }).count(), 1, "the full view is back while the document is public");
  assert.equal(await frame.getByLabel(`Access for ${invitee}`).count(), 1, "and so is the role");
  await frame.getByLabel(`Access for ${invitee}`).selectOption("remove");
  await until("the removal", async () => (await people()).length === 0);
  await invitedOnly.selectOption("invited");
  await frame.getByText("Only you can open this link").waitFor();

  // Then X is made public again from elsewhere: the next refresh (a token written
  // by another page's frame) draws the public document.
  const reopened = await api(`/api/v1/docs/${X}/access`, { method: "PUT", body: JSON.stringify({ linkAccess: "anyone" }) });
  assert.equal(reopened.status, 200);
  await refreshed.evaluate((name) => {
    const value = window.localStorage.getItem(name);
    window.localStorage.removeItem(name);
    window.localStorage.setItem(name, value);
  }, key);
  await until("the owner's frame to show the public document", async () =>
    (await frame.getByLabel("General access").inputValue()) === "anyone",
  );
  await context.close();
});

/** The owner signs in to the Share frame of `docId` on its own page, through the popup. */
async function ownerFrame(context, docId) {
  const page = await context.newPage();
  await page.goto(docUrl(docId));
  await page.locator("a[data-openartifacts-share]").click();
  const frame = await until("the Share frame", () => frameOf(page, docId));
  await Promise.all([context.waitForEvent("page"), frame.getByRole("button", { name: "Sign in to manage" }).click()]);
  await frame.getByLabel("General access").waitFor();
  return { page, frame };
}

/** The frame's own measures: where its three parts end, and whether `main` would need a scrollbar. */
const measure = (frame) =>
  frame.evaluate(() => {
    const main = document.querySelector("main");
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      header: Math.round(box("header").height),
      // What the owner view needs: its last child's bottom, and main's padding under it.
      content: Math.ceil(main.lastElementChild.getBoundingClientRect().bottom - main.getBoundingClientRect().top + main.scrollTop + 16),
      main: main.scrollHeight,
      room: main.clientHeight,
      footer: Math.round(box("footer").height),
      footerBottom: Math.round(box("footer").bottom),
      sentence: Math.round(box("footer .status").height),
      overflowX: Math.max(document.documentElement.scrollWidth, main.scrollWidth) - window.innerWidth,
    };
  });

/** Where each landmark of the owner view sits, to see whether the skeleton stood in the same places. */
const places = (frame) =>
  frame.evaluate(() => Array.from(document.querySelectorAll("main .invite, main h2, main li, main .access"), (element) => Math.round(element.getBoundingClientRect().top)));

test("the owner view is invite, people, general access, above a pinned footer", { timeout: 240_000 }, async () => {
  await db.prepare("UPDATE accounts SET display_name = 'Logan Yang' WHERE id = ?").bind(OWNER_ACCOUNT).run();
  await db
    .prepare("INSERT INTO accounts (id, email, plan, created_at, display_name) VALUES (?, 'ann@example.com', 'pro', ?, 'Ann Lee')")
    .bind(accountId("e"), Date.now())
    .run();
  const X = await publish("The State of AI Prose", "<p>Mine.</p>");
  const F = await publish("A free owner's page", "<p>Mine.</p>");
  const people = async () => (await (await api(`/api/v1/docs/${X}/access`)).json()).people;
  const context = await newContext(OWNER_ACCOUNT);
  await recordViews(context);
  const { page, frame } = await ownerFrame(context, X);
  // The owner is signed in to F's frame too, so its pages below start from a stored token.
  await (await ownerFrame(context, F)).page.close();
  const mode = frame.getByLabel("General access");
  const footer = frame.locator("footer .status");

  // 1. A public page with nobody added: the title, the owner, the footer, and everything whole.
  assert.equal(await frame.locator("header .title").innerText(), "The State of AI Prose");
  assert.equal(await frame.locator("header .title").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  const ownerRow = frame.locator("li").first();
  assert.equal(await ownerRow.locator("b").innerText(), "Logan Yang (you)");
  assert.equal(await ownerRow.locator("small").innerText(), "owner@example.com");
  assert.equal(await ownerRow.locator(".av").innerText(), "LY");
  assert.equal(await ownerRow.locator(".role").innerText(), "Owner");
  assert.equal(await ownerRow.locator("select").count(), 0, "the owner has no control");
  assert.equal(await mode.inputValue(), "anyone");
  assert.equal(await footer.innerText(), "Anyone with the link can view");
  assert.equal(await frame.getByPlaceholder("Invite people by email").count(), 1);
  assert.equal(await frame.getByRole("button", { name: "Invite" }).isHidden(), true, "no Invite button until the field has text");
  const publicFit = await measure(frame);
  console.log("public", publicFit);
  assert.ok(publicFit.main <= publicFit.room, "public, nobody added: no scrollbar");
  assert.equal(publicFit.footerBottom, publicFit.height, "the footer is pinned to the floor");
  // One line of 13 px text, never two, at 400 px.
  assert.ok(publicFit.sentence < 24, "the public sentence is one line");
  await shoot(page, "owner-public");

  // The Invite button appears inside the field without moving it, and goes when the field is empty.
  const field = frame.getByPlaceholder("Invite people by email");
  const before = await field.boundingBox();
  await field.evaluate((input) => { input.value = "x"; input.dispatchEvent(new Event("input")); });
  const invite = frame.getByRole("button", { name: "Invite" });
  assert.equal(await invite.isVisible(), true);
  assert.deepEqual(await field.boundingBox(), before);
  const inside = await invite.boundingBox();
  assert.ok(inside.x + inside.width <= before.x + before.width && inside.x >= before.x, "the button is inside the field");
  await shoot(page, "owner-typing");
  await field.evaluate((input) => { input.value = ""; input.dispatchEvent(new Event("input")); });
  assert.equal(await invite.isHidden(), true);

  // Copy link says Copied, then goes back.
  const copy = frame.getByRole("button", { name: "Copy link" });
  await copy.click();
  await frame.getByRole("button", { name: "Copied" }).waitFor();
  await copy.waitFor();

  // 2. Private, nobody added.
  await mode.selectOption("invited");
  await footer.filter({ hasText: "Only you can open this link" }).waitFor();
  const privateFit = await measure(frame);
  console.log("private", privateFit);
  assert.ok(privateFit.main <= privateFit.room, "private, nobody added: no scrollbar");
  assert.ok(privateFit.sentence < 24, "the private sentence is one line");
  await shoot(page, "owner-private");

  // 3. Two invitees (one with an account that has a name), and two requests. The page goes public first:
  //    a click on a private document's list is the share page's on this origin.
  await mode.selectOption("anyone");
  await footer.filter({ hasText: "Anyone with the link can view" }).waitFor();
  const long = "a-very-long-address-that-keeps-going-and-going@a-very-long-example-domain.example.com";
  for (const address of ["ann@example.com", "ab@example.com", long]) {
    assert.equal((await api(`/api/v1/docs/${X}/access/people/${encodeURIComponent(address)}`, { method: "PUT", body: "{}" })).status, 200);
  }
  for (const address of ["wanda@example.com", "xavi@example.com"]) {
    await db.prepare("INSERT INTO doc_access_requests (doc_id, email, created_at) VALUES (?, ?, ?)").bind(X, address, Date.now()).run();
  }
  await page.reload();
  await page.locator("a[data-openartifacts-share]").click();
  const again = await until("the Share frame", () => frameOf(page, X));
  await again.getByLabel("General access").waitFor();
  await again.getByText("Asked to open").first().waitFor();
  const rows = again.locator("main li");
  const ann = again.getByLabel("Access for ann@example.com").locator("xpath=ancestor::li");
  assert.equal(await ann.locator("b").innerText(), "Ann Lee");
  // This server has no email configured, so each invitee is told to be sent the link.
  assert.equal(await ann.locator("small").innerText(), "ann@example.com · Send them the link");
  assert.equal(await ann.locator(".av").innerText(), "AL");
  const bare = again.getByLabel("Access for ab@example.com").locator("xpath=ancestor::li");
  assert.equal(await bare.locator("b").innerText(), "ab@example.com");
  assert.equal(await bare.locator("small").innerText(), "Send them the link", "an address with no name has the address only, then the hint");
  assert.equal(await bare.locator(".av").innerText(), "A");
  assert.equal(await bare.locator(".av").getAttribute("aria-hidden"), "true");
  // Requests come first, in the same row style.
  const texts = await again.locator("main h2").allInnerTexts();
  assert.deepEqual(texts, ["Requests", "People with access", "General access"]);
  assert.equal(await again.locator("li.req").count(), 2);
  assert.equal(await rows.count(), 2 + 1 + 3);
  // The select offers the granted roles, a separator, then Remove access.
  assert.deepEqual(await again.getByLabel("Access for ann@example.com").locator("option").allInnerTexts(), ["Can view", "Can comment", "Remove access"]);
  assert.equal(await again.getByLabel("Access for ann@example.com").locator("hr").count(), 1);
  const listFit = await measure(again);
  console.log("people", listFit);
  assert.equal(listFit.overflowX <= 0, true, "no horizontal overflow");
  assert.equal(await again.locator("footer .status").innerText(), "Anyone with the link can view");
  await shoot(page, "owner-people");

  // A role change and Remove access go through the select; Approve and Decline stay buttons.
  await again.getByLabel("Access for ann@example.com").selectOption("view");
  await until("Ann's role to be saved", async () => (await people()).find((entry) => entry.email === "ann@example.com").role === "view");
  await again.getByLabel("Access for ab@example.com").selectOption("remove");
  await until("ab to be removed", async () => !(await people()).some((entry) => entry.email === "ab@example.com"));
  await again.getByRole("button", { name: "Approve" }).first().click();
  await until("wanda to be approved", async () => (await people()).some((entry) => entry.email === "wanda@example.com"));
  await again.getByRole("button", { name: "Decline" }).click();
  await until("the last request to be gone", async () => (await again.locator("li.req").count()) === 0);

  // 4. A private page with people on it.
  await again.getByLabel("General access").selectOption("invited");
  await again.getByText("Only people invited can open this link").waitFor();
  assert.equal(await again.getByLabel("General access").inputValue(), "invited");
  assert.equal((await again.locator("footer button").innerHTML()).includes("M6 11h12"), true, "Copy link carries a lock on a private page");
  assert.ok((await measure(again)).sentence < 24, "the longest sentence, people on a private page, is one line");

  // 5. Nothing jumps: the skeleton stood in the places the owner view fills, on a slow network, and no
  //    wrong state is painted on the way.
  const slow = await context.newPage();
  await slowAccess(slow, F);
  await slow.goto(docUrl(F));
  await slow.locator("a[data-openartifacts-share]").click();
  const slowFrame = await until("the Share frame", () => frameOf(slow, F));
  await slowFrame.locator("main .sk").first().waitFor();
  const standIn = await places(slowFrame);
  assert.equal(await slowFrame.locator("header .title .sk").count(), 1, "a muted bar where the title goes");
  assert.equal(await slowFrame.locator("header .title").evaluate((node) => node.textContent), "");
  await shoot(slow, "owner-skeleton");
  await slowFrame.getByLabel("General access").waitFor();
  assert.deepEqual(await places(slowFrame), standIn, "the owner view lands where the skeleton was");
  assert.deepEqual(await slowFrame.evaluate(() => window.__views), ["skeleton", "owner"]);
  assert.equal(await slowFrame.locator("header .title").innerText(), "A free owner's page");
  await slow.close();

  // 6. A free plan: the upgrade card stands where the invite field was, whole without a scrollbar, and
  //    going private is refused in place.
  await db.prepare("UPDATE accounts SET plan = 'free', plan_checked_at = ? WHERE id = ?").bind(Date.now(), OWNER_ACCOUNT).run();
  try {
    const freePage = await context.newPage();
    await freePage.goto(docUrl(F));
    await freePage.locator("a[data-openartifacts-share]").click();
    const free = await until("the Share frame", () => frameOf(freePage, F));
    await free.locator(".up").waitFor();
    assert.equal(await free.getByPlaceholder("Invite people by email").count(), 0);
    const freeFit = await measure(free);
    await shoot(freePage, "owner-free");
    console.log("free", freeFit);
    assert.ok(freeFit.main <= freeFit.room, "free plan: no scrollbar");
    assert.equal(freeFit.content, publicFit.content, "the upgrade row stands in the invite field's place at the same height");
    assert.equal((await free.locator(".up").boundingBox()).height, 36);
    assert.equal(await free.locator("footer .status").innerText(), "Anyone with the link can view");
    await free.getByLabel("General access").selectOption("invited");
    assert.equal(await free.getByLabel("General access").inputValue(), "anyone", "the select goes back");
    await free.locator(".up.nudge").waitFor();
    assert.equal(await free.locator(".up a.btn").count(), 1);
    assert.equal(await free.evaluate(() => document.activeElement.textContent), "Upgrade", "Upgrade takes focus");
    assert.equal((await (await api(`/api/v1/docs/${F}/access`)).json()).linkAccess, "anyone");
    await freePage.close();
  } finally {
    await db.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(OWNER_ACCOUNT).run();
  }
  await context.close();

  // 7. The narrowest popover, 304 px: long addresses are cut, nothing overflows, the footer holds.
  const phone = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 800 } });
  await phone.addCookies([sessionCookie(OWNER_ACCOUNT)]);
  const narrow = await ownerFrame(phone, X);
  await narrow.frame.getByText("Asked to open").count();
  const fit = await measure(narrow.frame);
  console.log("narrow", fit);
  assert.equal(fit.width, 304);
  assert.ok(fit.overflowX <= 0, "no horizontal overflow at 304 px");
  assert.equal(fit.footerBottom, fit.height);
  assert.equal(await narrow.frame.locator("li .who small").evaluateAll((nodes) => nodes.every((node) => node.scrollWidth >= node.clientWidth)), true);
  await shoot(narrow.page, "owner-narrow");
  await phone.close();
});

test("a reader sees the title and Copy link with no sentence", { timeout: 120_000 }, async () => {
  const X = await publish("Read only", "<p>Mine.</p>");
  const context = await newContext(accountId("e"));
  const page = await context.newPage();
  await page.goto(docUrl(X));
  await page.locator("a[data-openartifacts-share]").click();
  const frame = await until("the Share frame", () => frameOf(page, X));
  await Promise.all([context.waitForEvent("page"), frame.getByRole("button", { name: "Sign in to manage" }).click()]);
  await frame.getByText("Signed in as ann@example.com.").waitFor();
  assert.equal(await frame.locator("header .title").innerText(), "Read only");
  assert.equal(await frame.locator("footer .status").innerText(), "");
  assert.equal(await frame.getByRole("button", { name: "Copy link" }).count(), 1);
  await shoot(page, "popover-reader");
  await context.close();
});

test("an unlinked Copilot publisher sees the no-email notice in top-bar Share, then links to manage access", { timeout: 120_000 }, async () => {
  const key = "cplus_live_unlinked131";
  const owner = "unlinked-owner-131";
  const account = accountId("c");
  const now = Date.now();
  await db.prepare("INSERT INTO publishers (key_hash, plan, validated_at, owner) VALUES (?, 'believer', ?, ?)").bind(sha256Hex(key), now, owner).run();
  await db.prepare("INSERT INTO accounts (id, email, plan, created_at) VALUES (?, 'publisher131@example.com', 'pro', ?)").bind(account, now).run();
  const published = await api("/api/v1/docs", {
    method: "POST", headers: { authorization: `Bearer ${key}` },
    body: JSON.stringify({ title: "License-key page", html: html("License-key page") }),
  });
  assert.equal(published.status, 201);
  const { docId } = await published.json();
  const context = await newContext(null);
  const page = await context.newPage();
  try {
    await page.goto(docUrl(docId));
    await page.locator("a[data-openartifacts-share]").click();
    const frame = await until("the unlinked publisher's Share frame", () => frameOf(page, docId));
    const notice = frame.locator("p.hint");
    await notice.waitFor();
    for (const text of ["we have no email address for you", "Access requests and new comment threads cannot reach you by email", "invitations do not name you", `Link your Copilot account at ${wranglerVars().ACCOUNT_ACTION_URL}`, "After linking, sign in here to manage access"]) {
      assert.ok((await notice.innerText()).includes(text), text);
    }
    await shoot(page, "popover-unlinked-owner");
    assert.equal(await frame.getByRole("button", { name: "Copy link" }).count(), 1);
    // Signing into an unrelated browser account does not hide the guidance or reveal access lists.
    await context.addCookies([sessionCookie(account)]);
    await Promise.all([context.waitForEvent("page"), frame.getByRole("button", { name: "Sign in to manage" }).click()]);
    await frame.getByRole("button", { name: "Use another account" }).waitFor();
    assert.ok((await notice.innerText()).includes("we have no email address for you"));
    assert.equal(await frame.getByLabel("General access").count(), 0);
    // The existing verified-account linking flow establishes ownership; no Copilot UI adoption.
    await db.prepare("INSERT INTO owner_links (external_owner, account_id, created_at) VALUES (?, ?, ?)").bind(owner, account, now).run();
    await page.reload();
    await page.locator("a[data-openartifacts-share]").click();
    const linked = await until("the linked publisher's Share frame", () => frameOf(page, docId));
    await linked.getByLabel("General access").waitFor();
    assert.equal(await linked.getByText("we have no email address for you", { exact: false }).count(), 0);
  } finally {
    await context.close();
  }
});

/**
 * Every view the Share frames of `context` paint, in order, as `window.__views` in each frame. Sampled in
 * an animation-frame callback, which runs before each paint, so a view that is drawn for one frame is seen.
 */
const recordViews = (context) =>
  context.addInitScript(() => {
    if (!location.pathname.startsWith("/embed/share")) return;
    window.__views = [];
    const sample = () => {
      const main = document.querySelector("main");
      if (main && main.getClientRects().length > 0) {
        const text = main.innerText;
        const view = main.querySelector(".sk")
          ? "skeleton"
          : main.querySelector(".access")
            ? "owner"
            : text.includes("Sign in to manage")
              ? "guest"
              : text.includes("Only the owner can change who can open this")
                ? "reader"
                : `other: ${text.slice(0, 40)}`;
        if (window.__views[window.__views.length - 1] !== view) window.__views.push(view);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

/** Hold every GET of `docId`'s access for `ms` before it goes out, as a slow network would. */
const slowAccess = (page, docId, ms = 1500) =>
  page.route(`https://${API}/embed/api/docs/${docId}/access`, async (route) => {
    if (route.request().method() === "GET") await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });

test("an expired token goes from the skeleton to the signed-out view, and a signed-out visitor sees that view at once", { timeout: 180_000 }, async () => {
  const X = await publish("Expired token", "<p>Mine.</p>");
  const key = `openartifacts:share-token:${X}`;
  const context = await newContext(OWNER_ACCOUNT);
  await recordViews(context);
  // A token the frame believes in (it has a day left) and the server does not.
  const setup = await context.newPage();
  await setup.goto(docUrl(X));
  await setup.locator("a[data-openartifacts-share]").click();
  const setupFrame = await until("the Share frame", () => frameOf(setup, X));
  await setupFrame.evaluate((name) => window.localStorage.setItem(name, JSON.stringify({ token: "oas_expired", expiresAt: Date.now() + 86_400_000 })), key);
  await setup.close();

  const page = await context.newPage();
  await slowAccess(page, X);
  await page.goto(docUrl(X));
  await page.locator("a[data-openartifacts-share]").click();
  const frame = await until("the Share frame", () => frameOf(page, X));
  await frame.getByRole("button", { name: "Sign in to manage" }).waitFor();
  assert.deepEqual(await frame.evaluate(() => window.__views), ["skeleton", "guest"]);
  assert.equal(await frame.evaluate((name) => window.localStorage.getItem(name), key), null, "the refused token is dropped");
  await context.close();

  const bare = await newContext(null);
  await recordViews(bare);
  const visitor = await bare.newPage();
  await slowAccess(visitor, X);
  await visitor.goto(docUrl(X));
  await visitor.locator("a[data-openartifacts-share]").click();
  const guest = await until("the Share frame", () => frameOf(visitor, X));
  await guest.getByRole("button", { name: "Sign in to manage" }).waitFor();
  await visitor.waitForTimeout(300);
  assert.deepEqual(await guest.evaluate(() => window.__views), ["guest"]);
  await bare.close();
});

test("a stale frame whose pre-write read fails does not write", { timeout: 180_000 }, async () => {
  const X = await publish("Read fails", "<p>Mine.</p>");
  const embed = `<iframe src="https://${API}/embed/share?doc=${X}&origin=${encodeURIComponent(`https://${SERVING}`)}" style="width:380px;height:480px"></iframe>`;
  const Y = await publish("Hostile reader", embed);
  const invitee = "kept@example.com";
  assert.equal((await api(`/api/v1/docs/${X}/access/people/${encodeURIComponent(invitee)}`, { method: "PUT", body: "{}" })).status, 200);

  const context = await newContext(OWNER_ACCOUNT);
  await ownerFrame(context, X);
  const tab = await context.newPage();
  await tab.goto(docUrl(Y));
  const stale = await until("the hostile frame", () => frameOf(tab, X));
  await stale.getByLabel(`Access for ${invitee}`).waitFor();

  // X is private now; the hostile frame still shows the view it drew when public.
  assert.equal((await api(`/api/v1/docs/${X}/access`, { method: "PUT", body: JSON.stringify({ linkAccess: "invited" }) })).status, 200);
  const people = async () => (await (await api(`/api/v1/docs/${X}/access`)).json()).people.map((entry) => entry.email);

  // The read before the write fails in each way it can: an error status, a
  // body that is not the document's state, a dropped connection. No write runs.
  const failures = [
    ["a 500", (route) => route.fulfill({ status: 500, body: "boom" })],
    ["an unparsable 200", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "<html>" })],
    ["a dropped connection", (route) => route.abort()],
  ];
  const writes = [];
  tab.on("request", (request) => { if (request.method() !== "GET" && request.url().includes("/embed/api/")) writes.push(request.method()); });
  // A click that lands in the first moments after a new tab is shown can be lost
  // to the focus change, so let the page settle.
  await tab.waitForTimeout(1500);
  for (const [name, fail] of failures) {
    const url = `https://${API}/embed/api/docs/${X}/access`;
    const handler = (route) => (route.request().method() === "GET" ? fail(route) : route.continue());
    await tab.route(url, handler);
    await Promise.all([
      tab.waitForRequest((request) => request.method() === "GET" && request.url() === url),
      stale.getByLabel(`Access for ${invitee}`).selectOption("remove"),
    ]);
    await stale.getByText("Something went wrong. Nothing was changed.").waitFor();
    await tab.waitForTimeout(300);
    assert.deepEqual(await people(), [invitee], `${name}: nothing was removed`);
    assert.deepEqual(writes, [], `${name}: no write was sent`);
    await tab.unroute(url, handler);
    // The view is still the stale owner view, so the click is possible again.
    assert.equal(await stale.getByLabel(`Access for ${invitee}`).count(), 1);
    // Clear the message so the next failure shows its own.
    await stale.evaluate(() => { document.getElementById("oa-msg").textContent = ""; });
  }
  await context.close();
});

test("a read that resolves after the owner's own switch does not undo it", { timeout: 180_000 }, async () => {
  const X = await publish("Late read", "<p>Mine.</p>");
  const context = await newContext(OWNER_ACCOUNT);
  const { page, frame } = await ownerFrame(context, X);
  const key = `openartifacts:share-token:${X}`;
  const Y = await publish("Other page", `<iframe src="https://${API}/embed/share?doc=${X}&origin=${encodeURIComponent(`https://${SERVING}`)}" style="width:380px;height:480px"></iframe>`);
  const other = await context.newPage();
  await other.goto(docUrl(Y));
  const sibling = await until("the other page's frame", () => frameOf(other, X));
  await sibling.getByLabel("General access").waitFor();

  // Hold one GET: the server answers it now, with X public, and the browser gets
  // the answer only after the owner's write has landed.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let taken = false;
  const url = `https://${API}/embed/api/docs/${X}/access`;
  await page.route(url, async (route) => {
    const request = route.request();
    if (request.method() !== "GET" || taken) return route.continue();
    taken = true;
    const response = await route.fetch({ url: `https://127.0.0.1:${mfPort}/embed/api/docs/${X}/access`, headers: { ...request.headers(), host: API } });
    const body = await response.body();
    await held;
    await route.fulfill({ status: response.status(), headers: response.headers(), body });
  });
  // A token written by another page reaches the frame as a storage event and starts the read.
  await sibling.evaluate((name) => {
    const value = window.localStorage.getItem(name);
    window.localStorage.removeItem(name);
    window.localStorage.setItem(name, value);
  }, key);
  await until("the read to be held", () => taken);
  await frame.getByLabel("General access").selectOption("invited");
  await frame.getByText("Only you can open this link").waitFor();
  release();
  await page.waitForTimeout(500);
  assert.equal(await frame.getByLabel("General access").inputValue(), "invited");
  assert.equal(await frame.getByText("Only you can open this link").count(), 1);
  await context.close();
});

test("a pasted batch stops when the document goes private part way through", { timeout: 120_000 }, async () => {
  // The frame on a document's page is on the public origin, so each write in a
  // batch is checked against the document first, not just the first one.
  const X = await publish("Private mid-batch", "<p>Mine.</p>");
  const context = await newContext(OWNER_ACCOUNT);
  const { page, frame } = await ownerFrame(context, X);
  // Another tab makes the document private while the first address is on its
  // way, after the frame's check for it and before its check for the second.
  const puts = [];
  await page.route(`https://${API}/embed/api/docs/${X}/access/people/*`, async (route) => {
    puts.push(decodeURIComponent(route.request().url().split("/people/")[1]));
    if (puts.length === 1) {
      assert.equal((await api(`/api/v1/docs/${X}/access`, { method: "PUT", body: JSON.stringify({ linkAccess: "invited" }) })).status, 200);
    }
    await route.continue();
  });

  // Not fill(): it focuses the field inside this cross-site frame, then sends the
  // text through the top page, which can still hold focus and drop it.
  await frame.getByPlaceholder("Invite people by email").evaluate((input) => { input.value = "ann@example.com, bob@example.com, carol@example.com"; input.dispatchEvent(new Event("input")); });
  await frame.getByRole("button", { name: "Invite", exact: true }).click();
  await frame.getByText("Open Share from the document’s own page").waitFor();

  assert.deepEqual(puts, ["ann@example.com"]);
  assert.deepEqual((await (await api(`/api/v1/docs/${X}/access`)).json()).people.map((entry) => entry.email), ["ann@example.com"]);
  await context.close();
});

test("Home search opens owned pages by keyboard and click without filtering the list", { timeout: 120_000 }, async () => {
  const alpha = await publish("Home search alpha", "<p>Alpha</p>");
  const beta = await publish("Home search beta", "<p>Beta</p>");
  const context = await newContext(OWNER_ACCOUNT);
  const page = await context.newPage();
  await page.goto(`https://${API}/home`);
  const input = page.getByRole("combobox", { name: "Search your pages" });
  await input.waitFor();
  assert.equal(await page.locator(".cli-hint").innerText(), "Ask your agent to publish or unpublish any page with the OpenArtifacts CLI.");
  const rowCount = await page.locator(".pages > li").count();
  await input.fill("HOME SEARCH");
  const options = page.getByRole("option");
  await until("two Home suggestions", async () => (await options.count()) === 2);
  await shoot(page, "home-search-suggestions");
  assert.equal(await page.locator(".pages > li").count(), rowCount);
  const ids = await options.evaluateAll(nodes => nodes.map(node => node.id));
  await input.press("ArrowDown");
  assert.equal(await input.getAttribute("aria-activedescendant"), ids[0]);
  await input.press("ArrowDown");
  assert.equal(await input.getAttribute("aria-activedescendant"), ids[1]);
  await input.press("ArrowUp");
  assert.equal(await input.getAttribute("aria-activedescendant"), ids[0]);
  const firstUrl = await options.nth(0).evaluate(node => node.querySelector(".suggestion-url").textContent);
  const firstId = firstUrl.slice(3);
  await Promise.all([page.waitForURL(docUrl(firstId)), input.press("Enter")]);

  await page.goto(`https://${API}/home`);
  const search = page.getByRole("combobox", { name: "Search your pages" });
  await search.fill("HOME SEARCH");
  const matches = page.getByRole("option");
  await until("Home suggestions after Escape", async () => (await matches.count()) === 2);
  await search.press("Escape");
  assert.equal(await page.locator("#page-suggestions").isHidden(), true);
  assert.equal(await search.getAttribute("aria-expanded"), "false");
  assert.equal(await search.inputValue(), "HOME SEARCH");
  await search.fill("HOME SEARCH");
  await until("Home suggestions for click", async () => (await matches.count()) === 2);
  const otherId = firstId === alpha ? beta : alpha;
  await Promise.all([page.waitForURL(docUrl(otherId)), matches.filter({ hasText: otherId }).click()]);

  await page.goto(`https://${API}/home`);
  const finalSearch = page.getByRole("combobox", { name: "Search your pages" });
  const finalRows = await page.locator(".pages > li").count();
  await finalSearch.fill("unmatched Home query");
  await page.getByRole("status").getByText("No matching pages.").waitFor();
  await finalSearch.fill("");
  assert.equal(await page.locator("#page-suggestions").isHidden(), true);
  assert.equal(await page.locator(".pages > li").count(), finalRows);
  await shoot(page, "home-search-empty");
  await context.close();
});
