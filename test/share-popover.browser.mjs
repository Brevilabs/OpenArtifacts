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
 * reached by name (the rule also maps `*.openartifacts.site`, but the test loads
 * only public documents on the apex; a document on its label host is covered by
 * `test/serve.test.ts` at the HTTP level only). Every request therefore goes
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
 * `popover-owner.png` and `popover-private.png`, which is how the screenshots in
 * a pull request are made.
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
const OTHER_ACCOUNT = accountId("b");
const UNKNOWN_DOC = "0123456789abcdef";

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
    .prepare("INSERT INTO accounts (id, email, plan, created_at) VALUES (?, 'stranger@example.com', 'pro', ?)")
    .bind(OTHER_ACCOUNT, now)
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
  assert.equal(await frame.evaluate(() => window.isSecureContext), true);
  await shoot(page, "popover-signed-out");
  // A short view is a compact panel: Copy link follows the last line of text
  // instead of being pushed to the bottom of the fixed-height popover.
  const sentence = await frame.getByText("Only the owner can change who can open this.").boundingBox();
  const copyLink = await frame.getByRole("button", { name: "Copy link" }).boundingBox();
  assert.ok(copyLink.y - (sentence.y + sentence.height) < 40, `Copy link sits ${copyLink.y - (sentence.y + sentence.height)}px below the line above it`);

  // 3. Sign in to manage opens the popup, which sees the owner's session through
  //    the browser's own Sec-Fetch-Site and cookie. A 400 here would mean the
  //    popup's binding refused it. Embedded in a document page the popup's opener
  //    is severed (see step 4), so the poll is what lands; the popup's posted
  //    message is covered by the second test.
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
  const invitedOnly = frame.getByRole("radio", { name: "Only those invited" });
  await invitedOnly.waitFor();
  assert.equal(await frame.getByRole("radio", { name: "Anyone with the link" }).getAttribute("aria-checked"), "true");
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
    frameOf(hostile, X).getByRole("radio", { name: "Only those invited" }).isVisible(),
  );
  await hostile.waitForTimeout(3000);
  const token = await frame.evaluate((key) => window.localStorage.getItem(key), `openartifacts:share-token:${X}`);
  assert.ok(token, "the frame holds the owner's token");
  assert.equal(
    await frameOf(hostile, X).evaluate((key) => window.localStorage.getItem(key), `openartifacts:share-token:${X}`),
    token,
    "a forged message replaced nothing",
  );
  assert.equal(await frameOf(hostile, X).getByRole("radio", { name: "Only those invited" }).isVisible(), true);
  assert.deepEqual(await hostile.evaluate(() => window.__messages), [
    { origin: `https://${API}`, data: { type: "openartifacts:share", event: "ready" } },
  ]);
  assert.equal(await hostile.evaluate(() => window.__focusMoved), undefined);
  await hostile.close();

  // Back on the first page: switching to private shows the notice and lands.
  await invitedOnly.click();
  await frame.getByText("People who opened it while it was public may have kept a copy.").waitFor();
  assert.equal(await invitedOnly.getAttribute("aria-checked"), "true");
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

  const context = await newContext(OWNER_ACCOUNT);
  const page = await context.newPage();
  await page.goto(docUrl(X));
  await page.locator("a[data-openartifacts-share]").click();
  const frame = await until("the Share frame", () => frameOf(page, X));
  const [popup] = await Promise.all([context.waitForEvent("page"), frame.getByRole("button", { name: "Sign in to manage" }).click()]);
  await popup.waitForEvent("close").catch(() => {});
  const invitedOnly = frame.getByRole("radio", { name: "Only those invited" });
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
    await until("the hostile frame's owner view", () => frameOf(tab, X).getByRole("radio", { name: "Only those invited" }).isVisible());
    hostile.push(tab);
  }

  // The owner makes X private from X's own page, whose frame made the switch.
  await invitedOnly.click();
  await frame.getByText("People who opened it while it was public may have kept a copy.").waitFor();
  assert.equal((await (await api(`/api/v1/docs/${X}/access`)).json()).linkAccess, "invited");

  // A click on the first hostile page's stale view is checked against the
  // document first and draws no controls, and does not turn X public again.
  const stale = frameOf(hostile[0], X);
  await stale.getByRole("radio", { name: "Only those invited" }).click();
  await stale.getByText("Open Share from the document’s own page").waitFor();
  assert.equal(await stale.getByRole("radio", { name: "Anyone with the link" }).count(), 0);
  assert.equal((await (await api(`/api/v1/docs/${X}/access`)).json()).linkAccess, "invited");

  // The stale view is checked before any write, not only the mode switch: a
  // Remove on the third hostile page's stale view removes no one.
  const stale2 = frameOf(hostile[2], X);
  await stale2.getByRole("button", { name: "Remove" }).click();
  await stale2.getByText("Open Share from the document’s own page").waitFor();
  assert.deepEqual(await people(), [invitee], "a stale Remove changed nothing");

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
  assert.equal(await refreshed.getByRole("radio", { name: "Anyone with the link" }).count(), 0);
  assert.equal(await refreshed.getByRole("button", { name: "Approve" }).count(), 0);

  // The owner's own frame keeps its view after a refresh of its own. A token
  // written by a hostile page's frame reaches it as a storage event while X is
  // private, which is the case the first write inside the owner's frame never
  // exercises. It keeps the mode control and the notice, but not the one-click
  // writes on the private document: a switch made in a frame is not proof that
  // the page around it is the owner's.
  await stale.evaluate((name) => {
    const value = window.localStorage.getItem(name);
    window.localStorage.removeItem(name);
    window.localStorage.setItem(name, value);
  }, key);
  await until("the owner's frame to redraw", async () => (await frame.getByText("To remove people or answer requests,").count()) > 0);
  assert.equal(await invitedOnly.getAttribute("aria-checked"), "true");
  await frame.getByText("People who opened it while it was public may have kept a copy.").waitFor();
  assert.equal(await frame.getByRole("button", { name: "Remove" }).count(), 0);
  assert.equal(await frame.getByText(invitee).count(), 1, "the list is still shown");
  assert.equal(await frame.getByPlaceholder("Add people by email").count(), 1);

  // Switching back to public from inside the frame ends the notice.
  await frame.getByRole("radio", { name: "Anyone with the link" }).click();
  await until("the owner's frame to show the public document", async () =>
    (await frame.getByRole("radio", { name: "Anyone with the link" }).getAttribute("aria-checked")) === "true",
  );
  assert.equal(await frame.getByText("People who opened it while it was public may have kept a copy.").count(), 0);
  assert.equal((await (await api(`/api/v1/docs/${X}/access`)).json()).linkAccess, "anyone");
  assert.equal(await frame.getByRole("button", { name: "Remove" }).count(), 1, "the full view is back while the document is public");
  await invitedOnly.click();
  await frame.getByText("People who opened it while it was public may have kept a copy.").waitFor();

  // Then X is made public again from elsewhere. The frame's notice is about a
  // switch to private and must not outlive it: the next refresh (a token written
  // by another page's frame) draws the public document without it.
  const reopened = await api(`/api/v1/docs/${X}/access`, { method: "PUT", body: JSON.stringify({ linkAccess: "anyone" }) });
  assert.equal(reopened.status, 200);
  await refreshed.evaluate((name) => {
    const value = window.localStorage.getItem(name);
    window.localStorage.removeItem(name);
    window.localStorage.setItem(name, value);
  }, key);
  await until("the owner's frame to show the public document", async () =>
    (await frame.getByRole("radio", { name: "Anyone with the link" }).getAttribute("aria-checked")) === "true",
  );
  assert.equal(await frame.getByText("People who opened it while it was public may have kept a copy.").count(), 0);
  await context.close();
});

test("a popup that keeps its opener posts the token to the frame that opened it", { timeout: 120_000 }, async () => {
  // Embedded in a document page the popup loses its opener (the first test).
  // Loaded as a top-level page, as the share page's own sign-in could be, the
  // frame and the popup share an opener policy and the link survives: the popup
  // posts the token, from the API origin, and the frame takes it. The frame's
  // poll is running the whole time; the message must leave it working, and the
  // first test is the case where only the poll can land.
  const W = await publish("Kept opener", "<p>Mine.</p>");
  const context = await newContext(OWNER_ACCOUNT);
  const page = await context.newPage();
  await page.goto(`https://${API}/embed/share?doc=${W}`);
  await page.evaluate(() => {
    window.__tokens = [];
    window.addEventListener("message", (event) => {
      if (event.data && event.data.type === "openartifacts:share-token") window.__tokens.push({ origin: event.origin, doc: event.data.doc });
    });
  });

  const [popup] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Sign in to manage" }).click()]);
  await popup.waitForEvent("close").catch(() => {});
  await page.getByRole("radio", { name: "Only those invited" }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__tokens), [{ origin: `https://${API}`, doc: W }]);

  // A message from anywhere else does nothing: this window is not the popup.
  const before = await page.evaluate((key) => window.localStorage.getItem(key), `openartifacts:share-token:${W}`);
  await page.evaluate((doc) => window.postMessage({ type: "openartifacts:share-token", doc, token: "oas_forged", expiresAt: Date.now() + 86400000 }, location.origin), W);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate((key) => window.localStorage.getItem(key), `openartifacts:share-token:${W}`), before);
  assert.equal(await page.getByRole("radio", { name: "Only those invited" }).isVisible(), true);
  await context.close();
});

test("the frame shows the same to anyone who cannot read, whatever the id", { timeout: 120_000 }, async () => {
  const open = await publish("Open title", "<p>Open.</p>");
  const closed = await publish("Closed title", "<p>Closed.</p>", "private-docs");

  // No token: the same text for a public, an invited-only and an unknown id,
  // and no title in any of them.
  const context = await newContext(OTHER_ACCOUNT);
  const bare = {};
  for (const [name, id] of [["open", open], ["closed", closed], ["unknown", UNKNOWN_DOC]]) {
    const page = await context.newPage();
    await page.goto(`https://${API}/embed/share?doc=${id}`);
    await page.getByRole("button", { name: "Sign in to manage" }).waitFor();
    bare[name] = await page.locator("main").innerText();
    await page.close();
  }
  assert.equal(bare.open, bare.closed);
  assert.equal(bare.open, bare.unknown);
  assert.ok(!bare.open.includes("Open title") && !bare.open.includes("Closed title"), bare.open);

  // With a token for an account that cannot read the document: what an unknown
  // id shows, for an invited-only one too, and never a 403. An account that can
  // read a public document sees its title, which is the one thing a token adds.
  const shown = {};
  for (const [name, id] of [["open", open], ["closed", closed], ["unknown", UNKNOWN_DOC]]) {
    const page = await context.newPage();
    await page.goto(`https://${API}/embed/share?doc=${id}`);
    const [popup] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Sign in to manage" }).click()]);
    await popup.waitForEvent("close").catch(() => {});
    await page.getByRole("button", { name: "Use another account" }).waitFor();
    shown[name] = await page.locator("main").innerText();
    await page.close();
  }
  assert.equal(shown.closed, shown.unknown);
  assert.ok(!shown.closed.includes("Closed title"), shown.closed);
  assert.ok(shown.open.includes("Open title"), shown.open);
  await context.close();
});

test("a page that embeds the frame cannot tell from a fragment navigation whether its visitor holds a token", { timeout: 180_000 }, async () => {
  // Scrolling to a fragment focuses the target when it exists and can take focus,
  // and a focus change inside the frame shows on the embedding page as a blur and
  // as `activeElement` becoming the iframe. A same-document navigation does not
  // reload the frame, so it keeps the view it drew from storage. No focusable
  // element may therefore have an id in any view, or the page learns what is in storage
  // without a click. Run the same probes with and without a token and compare.
  //
  // Focus is not the only tell: the browser scrolls the embedding page to the
  // element it focuses, by an amount that follows where the element sits. So the
  // frame is narrow, the document's title long (it wraps in the owner view and not
  // in the signed-out one, which moves a button that is vertically centred against
  // it), and the frame is below the fold, and the page's `scrollY` is compared too.
  const X = await publish("Fragment oracle with a title long enough to wrap in a narrow frame", "<p>Mine.</p>");
  const Y = await publish(
    "Fragment prober",
    `<div style="height:1500px"></div><iframe id="f" src="https://${API}/embed/share?doc=${X}&origin=${encodeURIComponent(`https://${SERVING}`)}" style="width:120px;height:480px"></iframe><div style="height:1500px"></div>`,
  );

  // The ids drawn in a view.
  const idsIn = (frame) => frame.evaluate(() => Array.from(document.querySelectorAll("[id]"), (element) => element.id));
  // The ids a fragment could focus: every focusable element must be anonymous.
  // <main> counts: it scrolls, and Chrome lets a scroll container take focus when
  // its content overflows, which in a narrow frame only some views do.
  const focusableIdsIn = (frame) =>
    frame.evaluate(() =>
      Array.from(document.querySelectorAll("[id]"))
        .filter((element) => element.matches("main,a[href],button,input,select,textarea,summary,[tabindex],[contenteditable]"))
        .map((element) => element.id),
    );

  // `expected` waits for the view the context should draw, so the probe never runs
  // against the signed-out shell that every context starts from.
  const probe = async (context, id, expected, expectedIds) => {
    const page = await context.newPage();
    await page.goto(docUrl(Y));
    const frame = await until("the prober's frame", () => frameOf(page, X));
    await expected(frame).waitFor();
    assert.deepEqual(await idsIn(frame), expectedIds, "the frame drew the view this context should see");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.__blurred = false;
      window.addEventListener("blur", () => { window.__blurred = true; });
    });
    await page.evaluate((fragment) => {
      const element = document.getElementById("f");
      element.src = element.src.split("#")[0] + "#" + fragment;
    }, id);
    await page.waitForTimeout(600);
    const seen = await page.evaluate(() => ({
      focused: document.activeElement === document.getElementById("f"),
      blurred: window.__blurred,
      scrollY: window.scrollY,
    }));
    await page.close();
    return seen;
  };
  const signedOutView = (frame) => frame.getByRole("button", { name: "Sign in to manage" });
  const ownerView = (frame) => frame.getByRole("radio", { name: "Only those invited" });

  // Signed out: the frame draws the signed-out view.
  const bare = await newContext(null);
  const bareProbe = await bare.newPage();
  await bareProbe.goto(docUrl(Y));
  const bareFrame = await until("the signed-out frame", () => frameOf(bareProbe, X));
  await bareFrame.getByRole("button", { name: "Sign in to manage" }).waitFor();
  const signedOutIds = await idsIn(bareFrame);
  const signedOutFocusable = await focusableIdsIn(bareFrame);
  await bareProbe.close();

  // With a token: the owner signs in through the popover, as in the first test.
  const owner = await newContext(OWNER_ACCOUNT);
  const page = await owner.newPage();
  await page.goto(docUrl(X));
  await page.locator("a[data-openartifacts-share]").click();
  const frame = await until("the Share frame", () => frameOf(page, X));
  const [popup] = await Promise.all([owner.waitForEvent("page"), frame.getByRole("button", { name: "Sign in to manage" }).click()]);
  await popup.waitForEvent("close").catch(() => {});
  await frame.getByRole("radio", { name: "Only those invited" }).waitFor();
  const ownerIds = await idsIn(frame);
  const ownerFocusable = await focusableIdsIn(frame);

  // No focusable element in any view has an id, so no fragment reaches one.
  assert.deepEqual(signedOutFocusable, [], "signed-out view: a focusable element has an id");
  assert.deepEqual(ownerFocusable, [], "owner view: a focusable element has an id");

  // The names a page could try: every id either view has, plus the ones earlier
  // versions carried on buttons, which must now match nothing in either view.
  const ids = [...new Set([...signedOutIds, ...ownerIds, "oa-close", "oa-copy", "oa-signin"])];
  assert.ok(!signedOutIds.includes("oa-close") && !ownerIds.includes("oa-close"), `ids probed: ${ids}`);
  assert.ok(!signedOutIds.includes("oa-copy") && !signedOutIds.includes("oa-signin"), `signed-out ids: ${signedOutIds}`);
  for (const id of ids) {
    const withToken = await probe(owner, id, ownerView, ownerIds);
    const withoutToken = await probe(bare, id, signedOutView, signedOutIds);
    assert.deepEqual(withToken, withoutToken, `#${id} behaves the same with and without a token`);
  }
  await owner.close();
  await bare.close();
});

test("Sign in to manage stays available while a sign-in is pending, and pressing it again starts a new one", { timeout: 120_000 }, async () => {
  // No session: the popup stops at the sign-in page and the frame waits. The
  // popup may be closed, or the handoff row may expire before the person is back,
  // and the frame cannot tell, so the way out must not wait for its own deadline.
  const X = await publish("Pending sign-in", "<p>Mine.</p>");
  const context = await newContext(null);
  const page = await context.newPage();
  await page.goto(`https://${API}/embed/share?doc=${X}`);
  const signIn = page.getByRole("button", { name: "Sign in to manage" });
  const [first] = await Promise.all([context.waitForEvent("page"), signIn.click()]);
  await page.getByText("Complete sign-in in the window that opened.").waitFor();
  // The button is in the waiting view, and enabled once the next nonce is ready.
  await signIn.waitFor();
  await until("Sign in to manage to be enabled again", () => signIn.isEnabled());
  assert.equal(await page.evaluate(() => document.querySelectorAll("#oa-account button").length), 1);
  await first.close();
  const [second] = await Promise.all([context.waitForEvent("page"), signIn.click()]);
  assert.match(second.url(), /\/embed\/sign-in\?/);
  assert.notEqual(new URL(second.url()).searchParams.get("h"), new URL(first.url()).searchParams.get("h"));
  await context.close();
});

test("the popover opens inside the viewport whatever the page does to its root, its direction or its scrollbar", { timeout: 120_000 }, async () => {
  // The popover is placed in script from Share's box and the layout viewport.
  // Pages that break the obvious ways of measuring that: no doctype (quirks mode,
  // where documentElement.clientWidth is the <html> box, not the viewport), a wide
  // or narrow <html>, dir=rtl (the bar mirrors unless it fixes its direction), and a
  // classic scrollbar that 100vw and innerWidth both count.
  const publishRaw = async (title, page) => {
    const response = await api("/api/v1/docs", { method: "POST", body: JSON.stringify({ title, html: page }) });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).docId;
  };
  const cases = [
    ["a wide <html> with no doctype", `<html style="min-width:1200px"><head><meta charset="utf-8"><title>Wide</title></head><body><p>Wide.</p></body></html>`],
    ["a narrow <html> with no doctype", `<html style="max-width:70ch;margin:auto"><head><meta charset="utf-8"><title>Narrow</title></head><body><p>Narrow.</p></body></html>`],
    ["a right-to-left page", `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>RTL</title></head><body><p>RTL.</p></body></html>`],
    ["a page wider than the window", `<!doctype html><html><head><meta charset="utf-8"><title>Overflow</title></head><body><p style="width:2000px">Overflow.</p></body></html>`],
  ];
  const context = await newContext(null);
  for (const width of [380, 1280]) {
    for (const [name, source] of cases) {
      const id = await publishRaw(name, source);
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 600 });
      await page.goto(docUrl(id));
      await page.locator("a[data-openartifacts-share]").click();
      const popover = page.locator(".openartifacts-share-popover");
      await popover.waitFor();
      const box = await popover.boundingBox();
      const viewportWidth = await page.evaluate(() => (document.compatMode === "BackCompat" ? document.body : document.documentElement).clientWidth);
      assert.ok(box.x >= 0 && box.x + box.width <= viewportWidth, `${name} at ${width}px: popover x ${box.x}..${box.x + box.width} in a ${viewportWidth}px viewport`);
      const share = await page.locator("a[data-openartifacts-share]").boundingBox();
      assert.ok(share.x > viewportWidth / 2, `${name} at ${width}px: Share sits at the right edge (x ${share.x})`);
      await page.close();
    }
  }
  await context.close();
});

/** The owner signs in to the Share frame of `docId` on its own page, through the popup. */
async function ownerFrame(context, docId) {
  const page = await context.newPage();
  await page.goto(docUrl(docId));
  await page.locator("a[data-openartifacts-share]").click();
  const frame = await until("the Share frame", () => frameOf(page, docId));
  const [popup] = await Promise.all([context.waitForEvent("page"), frame.getByRole("button", { name: "Sign in to manage" }).click()]);
  await popup.waitForEvent("close").catch(() => {});
  await frame.getByRole("radio", { name: "Only those invited" }).waitFor();
  return { page, frame };
}

test("an owner view taller than the popover scrolls instead of squashing its controls", { timeout: 120_000 }, async () => {
  // The frame is a fixed 480px tall. With a request and a dozen invitees the owner
  // view is far taller, and `main` has to scroll: flex children that shrink would
  // flatten the Link access control to a line and clip Copy link off the bottom.
  const X = await publish("Crowded", "<p>Mine.</p>");
  for (let n = 0; n < 12; n++) {
    assert.equal((await api(`/api/v1/docs/${X}/access/people/${encodeURIComponent(`person${n}@example.com`)}`, { method: "PUT", body: "{}" })).status, 200);
  }
  await db.prepare("INSERT INTO doc_access_requests (doc_id, email, created_at) VALUES (?, 'carol@example.org', ?)").bind(X, Date.now()).run();

  const context = await newContext(OWNER_ACCOUNT);
  const { page, frame } = await ownerFrame(context, X);
  await frame.getByText("carol@example.org").waitFor();
  await shoot(page, "popover-crowded");
  const radios = frame.getByRole("radio", { name: "Only those invited" });
  const group = frame.getByRole("radiogroup", { name: "Link access" });
  const groupBox = await group.boundingBox();
  const radioBox = await radios.boundingBox();
  assert.ok(groupBox.height > 20 && groupBox.height >= radioBox.height, `Link access is ${groupBox.height}px tall beside buttons ${radioBox.height}px tall`);

  const main = await frame.evaluate(() => {
    const element = document.querySelector("main");
    return { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  });
  assert.ok(main.scrollHeight > main.clientHeight, `main overflows (${main.scrollHeight} > ${main.clientHeight}) and so has to scroll`);

  const copy = frame.getByRole("button", { name: "Copy link" });
  await copy.evaluate((element) => element.scrollIntoView({ block: "end" }));
  const copyBox = await copy.boundingBox();
  const view = await frame.evaluate(() => ({ height: window.innerHeight }));
  const frameBox = await (await frame.frameElement()).boundingBox();
  assert.ok(
    copyBox.y >= frameBox.y && copyBox.y + copyBox.height <= frameBox.y + view.height + 1,
    `Copy link (y ${copyBox.y}..${copyBox.y + copyBox.height}) is inside the frame (y ${frameBox.y}..${frameBox.y + view.height}) once main is scrolled to the bottom`,
  );
  await context.close();
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
  await stale.getByRole("button", { name: "Remove" }).waitFor();

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
      stale.getByRole("button", { name: "Remove" }).click(),
    ]);
    await stale.getByText("Something went wrong. Nothing was changed.").waitFor();
    await tab.waitForTimeout(300);
    assert.deepEqual(await people(), [invitee], `${name}: nothing was removed`);
    assert.deepEqual(writes, [], `${name}: no write was sent`);
    await tab.unroute(url, handler);
    // The view is still the stale owner view, so the click is possible again.
    assert.equal(await stale.getByRole("button", { name: "Remove" }).count(), 1);
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
  await sibling.getByRole("radio", { name: "Only those invited" }).waitFor();

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
  await frame.getByRole("radio", { name: "Only those invited" }).click();
  await frame.getByText("People who opened it while it was public may have kept a copy.").waitFor();
  release();
  await page.waitForTimeout(500);
  assert.equal(await frame.getByRole("radio", { name: "Only those invited" }).getAttribute("aria-checked"), "true");
  assert.equal(await frame.getByText("People who opened it while it was public may have kept a copy.").count(), 1);
  await context.close();
});
