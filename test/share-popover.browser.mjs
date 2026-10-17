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
 * `popover-owner.png`, `popover-private.png` and the `popover-pasted*.png` pair, which is how the screenshots in
 * a pull request are made.
 * It also saves `popover-roles.png` and `popover-plan-line.png`, for the role
 * dropdown and the free owner's plan line, `popover-loading.png`, the skeleton
 * a token holder sees while the access read is out, and `popover-crowded.png`.
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
      // The plan line and a plan refusal carry an Upgrade link in production, and the popover's height must hold them.
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

const newContext = (account, height = 800) =>
  browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height } }).then(async (context) => {
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
  // A short view is the row (link, Copy link, ×), the sentence under it, and the
  // account line pinned to the floor of the fixed-height popover.
  const mainBox = await frame.locator("main").boundingBox();
  const bottom = await frame.locator(".bottom").boundingBox();
  assert.ok(mainBox.y + mainBox.height - (bottom.y + bottom.height) < 32, "the account line and hint are pinned to the bottom");
  assert.ok(await frame.getByText("Published from Copilot?").isVisible(), "the guest view carries the Copilot hint");

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

  // Back on the first page: switching to private lands, and says nothing about copies.
  await invitedOnly.click();
  await frame.getByText("Only people you add can open this page.").waitFor();
  assert.equal(await invitedOnly.getAttribute("aria-checked"), "true");
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
  // A fourth hostile page, for a role's stale write.
  const tab4 = await context.newPage();
  await tab4.goto(docUrl(Y4));
  await until("the fourth hostile frame's owner view", () => frameOf(tab4, X).getByRole("radio", { name: "Only those invited" }).isVisible());
  hostile.push(tab4);

  // The owner makes X private from X's own page, whose frame made the switch.
  await invitedOnly.click();
  await frame.getByText("Only people you add can open this page.").waitFor();
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
  assert.equal(await refreshed.getByRole("radio", { name: "Anyone with the link" }).count(), 0);
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
  assert.equal(await invitedOnly.getAttribute("aria-checked"), "true");
  assert.equal(await frame.getByRole("button", { name: "Remove" }).count(), 0);
  // Nor a role, which the limited view leaves to the share page.
  assert.equal(await frame.getByLabel(`Access for ${invitee}`).count(), 0);
  assert.equal(await frame.getByText(invitee).count(), 1, "the list is still shown");
  assert.equal(await frame.getByPlaceholder("Emails, separated by commas").count(), 1);

  // Switching back to public from inside the frame brings the full view back.
  await frame.getByRole("radio", { name: "Anyone with the link" }).click();
  await until("the owner's frame to show the public document", async () =>
    (await frame.getByRole("radio", { name: "Anyone with the link" }).getAttribute("aria-checked")) === "true",
  );
  assert.equal((await (await api(`/api/v1/docs/${X}/access`)).json()).linkAccess, "anyone");
  assert.equal(await frame.getByRole("button", { name: "Remove" }).count(), 1, "the full view is back while the document is public");
  assert.equal(await frame.getByLabel(`Access for ${invitee}`).count(), 1, "and so is the role");
  await invitedOnly.click();
  await frame.getByText("Only people you add can open this page.").waitFor();

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
    (await frame.getByRole("radio", { name: "Anyone with the link" }).getAttribute("aria-checked")) === "true",
  );
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
    assert.ok((await page.locator(".field").innerText()).endsWith(`/d/${id}`), "the link field shows the id's canonical link");
    bare[name] = (await page.locator("main").innerText()).replaceAll(id, "ID"); // the link field names the id
    await page.close();
  }
  assert.equal(bare.open, bare.closed);
  assert.equal(bare.open, bare.unknown);
  assert.ok(!bare.open.includes("Open title") && !bare.open.includes("Closed title"), bare.open);

  // With a token for an account that cannot read the document: what an unknown
  // id shows, for an invited-only one too, and never a 403. An account that can
  // read a public document is told it is signed in, and still sees no title.
  const shown = {};
  for (const [name, id] of [["open", open], ["closed", closed], ["unknown", UNKNOWN_DOC]]) {
    const page = await context.newPage();
    await page.goto(`https://${API}/embed/share?doc=${id}`);
    const [popup] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Sign in to manage" }).click()]);
    await popup.waitForEvent("close").catch(() => {});
    await page.getByRole("button", { name: "Use another account" }).waitFor();
    shown[name] = (await page.locator("main").innerText()).replaceAll(id, "ID");
    await page.close();
  }
  assert.equal(shown.closed, shown.unknown);
  assert.ok(!shown.closed.includes("Closed title"), shown.closed);
  assert.ok(!shown.open.includes("Open title") && shown.open.includes("Signed in as stranger@example.com."), shown.open);
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
  // frame is narrow and below the fold, the document's title long (an earlier
  // owner view drew it, wrapped, and moved the buttons beside it), and the page's
  // `scrollY` is compared too.
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
  await Promise.all([context.waitForEvent("page"), frame.getByRole("button", { name: "Sign in to manage" }).click()]);
  await frame.getByRole("radio", { name: "Only those invited" }).waitFor();
  return { page, frame };
}

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
          : main.querySelector("[role=radiogroup]")
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

/** The boxes of the row every view starts with: the link field, Copy link and ×. */
const topRow = (frame) =>
  Promise.all([frame.locator(".field"), frame.getByRole("button", { name: "Copy link" }), frame.getByRole("button", { name: "Close" })].map((locator) => locator.boundingBox()));

/** How tall `main`'s content is against the room it has, and what marks its edges. */
const scrollState = (frame) =>
  frame.evaluate(() => {
    const main = document.querySelector("main");
    const fade = document.querySelector(".fade");
    return {
      scrollHeight: main.scrollHeight,
      clientHeight: main.clientHeight,
      divider: getComputedStyle(document.querySelector("header")).boxShadow !== "none",
      fade: fade !== null && getComputedStyle(fade).opacity === "1",
    };
  });

test("Share builds its frame on intent, a hover or a focus, and never on a bare page view", { timeout: 120_000 }, async () => {
  const X = await publish("Intent", "<p>Mine.</p>");
  const context = await newContext(null);
  const page = await context.newPage();
  const loads = [];
  context.on("request", (request) => { if (frameUrl(X).test(request.url())) loads.push(request.url()); });
  await page.goto(docUrl(X));
  const share = page.locator("a[data-openartifacts-share]");
  await share.waitFor();
  await page.waitForTimeout(1000);
  assert.deepEqual(loads, [], "a page view makes no frame request");

  // The pointer on Share builds the frame, hidden, so the click finds it loaded.
  await share.hover();
  const frame = await until("the frame a hover built", () => frameOf(page, X));
  // Loaded and drawn, though nothing of it is visible yet.
  await frame.locator("main:not([hidden]) #oa-account button").waitFor({ state: "attached" });
  assert.equal(await page.locator(".openartifacts-share-popover").isVisible(), false, "a hover opens nothing");
  await share.click();
  await page.locator(".openartifacts-share-popover").waitFor();
  await frame.getByRole("button", { name: "Sign in to manage" }).waitFor();
  assert.equal(loads.length, 1, "the click uses the frame the hover built");

  // So does keyboard focus.
  const keyboard = await context.newPage();
  await keyboard.goto(docUrl(X));
  await keyboard.locator("a[data-openartifacts-share]").focus();
  await until("the frame a focus built", () => frameOf(keyboard, X));
  assert.equal(await keyboard.locator(".openartifacts-share-popover").isVisible(), false, "a focus opens nothing");
  assert.equal(loads.length, 2);
  await context.close();
});

test("a token holder sees a skeleton of the owner view, never the signed-out view, while the access read is slow", { timeout: 180_000 }, async () => {
  const X = await publish("Slow read", "<p>Mine.</p>");
  const context = await newContext(OWNER_ACCOUNT);
  await recordViews(context);
  const first = await ownerFrame(context, X);
  await first.page.close();

  const page = await context.newPage();
  await slowAccess(page, X);
  await page.goto(docUrl(X));
  await page.locator("a[data-openartifacts-share]").click();
  const frame = await until("the Share frame", () => frameOf(page, X));
  await frame.locator(".sk").first().waitFor();
  await shoot(page, "popover-loading");
  const skeletonRow = await topRow(frame);
  await frame.getByRole("radio", { name: "Only those invited" }).waitFor();
  assert.deepEqual(await frame.evaluate(() => window.__views), ["skeleton", "owner"]);
  // Nothing above the skeleton moves when the owner view lands.
  assert.deepEqual(await topRow(frame), skeletonRow);
  // The link is known without a request, so Copy link works while the read is out.
  assert.equal(await frame.locator(".field").innerText(), `${SERVING}/d/${X}`);
  await context.close();
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

test("the popover is one row and one scroll region, and an owner with nobody added sees all of it without scrolling", { timeout: 180_000 }, async () => {
  // A title long enough to wrap: no view draws one, so it can move nothing.
  const X = await publish("A document whose title is long enough to wrap onto several lines in a narrow popover heading", "<p>Mine.</p>");

  // Signed out: the row (link, Copy link, ×) and then the sentence, with no title anywhere.
  const bare = await newContext(null);
  const visitor = await bare.newPage();
  await visitor.goto(docUrl(X));
  await visitor.locator("a[data-openartifacts-share]").click();
  const guest = await until("the Share frame", () => frameOf(visitor, X));
  await guest.getByRole("button", { name: "Sign in to manage" }).waitFor();
  const guestRow = await topRow(guest);
  const [field, copy, close] = guestRow;
  assert.ok(Math.abs(field.y + field.height / 2 - (copy.y + copy.height / 2)) < 1 && Math.abs(copy.y + copy.height / 2 - (close.y + close.height / 2)) < 1, "the link, Copy link and × share one row");
  assert.ok(field.x + field.width <= copy.x && copy.x + copy.width <= close.x, "in that order");
  const sentence = await guest.getByText("Only the owner can change who can open this.").boundingBox();
  assert.ok(sentence.y >= field.y + field.height, "the sentence follows the row");
  assert.equal(await guest.locator("h1").count(), 0, "no title row");
  const guestState = await scrollState(guest);
  assert.equal(guestState.divider, false, "no divider at rest");
  assert.equal(guestState.fade, false, "no fade with nothing below");
  await bare.close();

  // The owner, in each form the view takes with nobody added: all of it is in view, nothing scrolls.
  const context = await newContext(OWNER_ACCOUNT);
  // Production emails invitations, and this harness has no mail binding, so the owner's access answers say
  // it does. Only this route's own path is touched: the popup's requests still reach the network stack.
  await context.route(`https://${API}/embed/api/docs/${X}/access`, async (route) => {
    const response = await route.fetch({ url: `https://127.0.0.1:${mfPort}/embed/api/docs/${X}/access`, headers: { ...route.request().headers(), host: API } });
    const body = await response.json().catch(() => null);
    await route.fulfill(body && body.viewer === "owner" ? { response, json: { ...body, email: true } } : { response });
  });
  const { frame } = await ownerFrame(context, X);
  assert.deepEqual(await topRow(frame), guestRow, "the row is where the signed-out view has it");
  assert.equal(await frame.locator("h1").count(), 0, "no title row");
  const fits = async (form) => {
    const state = await scrollState(frame);
    assert.ok(state.scrollHeight <= state.clientHeight, `${form}: no scroll (${state.scrollHeight} > ${state.clientHeight})`);
    assert.equal(state.divider, false, `${form}: no divider at rest`);
    assert.equal(state.fade, false, `${form}: no fade with nothing below`);
    // Both lines are about people on the list, and there is nobody on it.
    assert.equal(await frame.getByText("OpenArtifacts emails each invitation").count(), 0, `${form}: no invitation line`);
    assert.equal(await frame.getByText("To remove people or answer requests").count(), 0, `${form}: no share-page line`);
  };
  await frame.getByText("Anyone with the link can view. Only people you add can comment.").waitFor();
  await fits("public");
  await frame.getByRole("radio", { name: "Only those invited" }).click();
  await frame.getByText("Only people you add can open this page.").waitFor();
  await fits("private");
  await db.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(OWNER_ACCOUNT).run();
  try {
    await frame.getByRole("radio", { name: "Anyone with the link" }).click();
    await frame.getByText("Private pages and comments need a paid plan.").waitFor();
    await fits("a free owner's plan line");
    await frame.getByRole("radio", { name: "Only those invited" }).click();
    await frame.getByText("Private sharing needs a paid plan. Nothing was changed.").waitFor();
    await fits("the refusal after a failed switch");
  } finally {
    await db.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(OWNER_ACCOUNT).run();
  }
  await context.close();
});

test("an owner view taller than the popover scrolls under the row instead of squashing its controls", { timeout: 120_000 }, async () => {
  // The frame has one fixed height. With a request and a dozen invitees the owner
  // view is far taller, and `main` has to scroll: flex children that shrink would
  // flatten the Link access control to a line.
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

  // One scroll region: main overflows, and nothing inside it scrolls on its own.
  const atRest = await scrollState(frame);
  assert.ok(atRest.scrollHeight > atRest.clientHeight, `main overflows (${atRest.scrollHeight} > ${atRest.clientHeight}) and so has to scroll`);
  assert.equal(
    await frame.evaluate(() => Array.from(document.querySelectorAll("main *")).filter((element) => /auto|scroll/.test(getComputedStyle(element).overflowY)).length),
    0,
    "no nested scroll box",
  );
  // At rest: the fade says there is more below, and no divider under the row yet.
  assert.equal(atRest.fade, true, "the fade shows while there is more below");
  assert.equal(atRest.divider, false, "no divider before anything has scrolled under the row");

  // Scrolled to the end: the row has not moved, has its divider, and the fade is gone.
  const row = await topRow(frame);
  await frame.locator("main").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await until("the end of the list", async () => (await scrollState(frame)).fade === false);
  assert.equal((await scrollState(frame)).divider, true, "the divider shows once content is under the row");
  assert.deepEqual(await topRow(frame), row, "the row stays put");
  await frame.getByText("person11@example.com").waitFor();
  await context.close();
});

test("the owner view with nobody added fits the popover without a scrollbar, and a crowded one scrolls", { timeout: 180_000 }, async () => {
  // The popover is one fixed height, so its tallest owner view with nobody added has to fit it: the private page's
  // helper line wrapping, the copy notice, and the free owner's plan line.
  const X = await publish("Roomy", "<p>Mine.</p>");
  const context = await newContext(OWNER_ACCOUNT, 900);
  const { page, frame } = await ownerFrame(context, X);
  const sizes = async () => frame.evaluate(() => {
    const element = document.querySelector("main");
    return { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  });
  const fits = async (label) => {
    const main = await until(label, async () => {
      const size = await sizes();
      return size.clientHeight > 0 ? size : null;
    });
    assert.ok(main.scrollHeight <= main.clientHeight, `${label}: main needs ${main.scrollHeight}px in ${main.clientHeight}px`);
  };
  await fits("public, nobody added");

  await frame.getByRole("radio", { name: "Only those invited" }).click();
  await frame.getByText("Only people you add can open this page.").waitFor();
  assert.equal(await frame.getByText("may have kept a copy").count(), 0);
  await fits("private with the helper line");
  await shoot(page, "popover-owner-nobody");

  await db.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(OWNER_ACCOUNT).run();
  try {
    await frame.getByRole("radio", { name: "Anyone with the link" }).click();
    await until("the free owner view", async () => (await frame.getByText("Private pages and comments need a paid plan.").count()) > 0);
    await fits("free owner, plan line");
    await frame.getByRole("radio", { name: "Only those invited" }).click();
    await frame.getByText("Private sharing needs a paid plan. Nothing was changed.").waitFor();
    await fits("free owner, plan line and refusal");
  } finally {
    await db.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(OWNER_ACCOUNT).run();
  }
  await context.close();

  const Y = await publish("Eight", "<p>Mine.</p>");
  for (let n = 0; n < 8; n++) {
    assert.equal((await api(`/api/v1/docs/${Y}/access/people/${encodeURIComponent(`person${n}@example.com`)}`, { method: "PUT", body: "{}" })).status, 200);
  }
  const other = await newContext(OWNER_ACCOUNT, 900);
  const crowded = await ownerFrame(other, Y);
  await crowded.frame.getByText("person7@example.com").waitFor();
  const main = await crowded.frame.evaluate(() => {
    const element = document.querySelector("main");
    return { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  });
  assert.ok(main.scrollHeight > main.clientHeight, `eight people scroll (${main.scrollHeight} > ${main.clientHeight})`);
  await other.close();
});

test("an owner pastes a column of addresses and adds them all at once", { timeout: 120_000 }, async () => {
  const X = await publish("Pasted", "<p>Mine.</p>");
  const context = await newContext(OWNER_ACCOUNT);
  const { page, frame } = await ownerFrame(context, X);
  const puts = [];
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().includes("/access/people/")) puts.push(decodeURIComponent(request.url().split("/people/")[1])); });

  // A text field drops line breaks from a paste and would glue the column into
  // one address; the frame turns them into separators first.
  const field = frame.getByPlaceholder("Emails, separated by commas");
  await field.click();
  await field.evaluate((input) => {
    const data = new DataTransfer();
    data.setData("text", "ann@example.com\r\nBob <bob@example.com>\r\nbob@\r\ncarol@example.com\r\n");
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  assert.equal(await field.inputValue(), "ann@example.com, Bob <bob@example.com>, bob@, carol@example.com");
  await shoot(page, "popover-pasted");

  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await frame.getByText("Not added: bob@ (not an email address).").waitFor();
  await shoot(page, "popover-pasted-added");
  assert.match(await frame.locator("#oa-msg").innerText(), /^Added 3 people\. Not added: bob@ \(not an email address\)\.$/);
  // Some went in and some did not: amber, not the red of a failure.
  assert.equal(await frame.locator("#oa-msg").evaluate((node) => getComputedStyle(node).color), "rgb(246, 174, 82)");
  for (const address of ["ann@example.com", "bob@example.com", "carol@example.com"]) {
    assert.equal(await frame.getByText(address).count(), 1, address);
  }
  assert.equal(await frame.getByRole("button", { name: "Remove" }).count(), 3);
  // One request per address that is one, and none for the one that is not.
  assert.deepEqual(puts, ["ann@example.com", "bob@example.com", "carol@example.com"]);
  assert.deepEqual((await (await api(`/api/v1/docs/${X}/access`)).json()).people.map((entry) => entry.email).sort(), puts);
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
  await frame.getByText("Only people you add can open this page.").waitFor();
  release();
  await page.waitForTimeout(500);
  assert.equal(await frame.getByRole("radio", { name: "Only those invited" }).getAttribute("aria-checked"), "true");
  assert.equal(await frame.getByText("Only people you add can open this page.").count(), 1);
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
  await frame.getByPlaceholder("Emails, separated by commas").evaluate((input) => { input.value = "ann@example.com, bob@example.com, carol@example.com"; });
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await frame.getByText("Open Share from the document’s own page").waitFor();

  assert.deepEqual(puts, ["ann@example.com"]);
  assert.deepEqual((await (await api(`/api/v1/docs/${X}/access`)).json()).people.map((entry) => entry.email), ["ann@example.com"]);
  await context.close();
});

test("the owner sets a role from the popover: no Comments switch, the options come from Access.roles, and the helper line follows the link access", { timeout: 180_000 }, async () => {
  const X = await publish("Review me", "<p>Mine.</p>");
  const invitee = "reviewer@example.com";
  assert.equal((await api(`/api/v1/docs/${X}/access/people/${encodeURIComponent(invitee)}`, { method: "PUT", body: "{}" })).status, 200);
  const state = async () => (await api(`/api/v1/docs/${X}/access`)).json();
  const roleOf = async () => (await state()).people.find((entry) => entry.email === invitee).role;

  const context = await newContext(OWNER_ACCOUNT);
  const { page, frame } = await ownerFrame(context, X);
  await frame.getByRole("radio", { name: "Only those invited" }).waitFor();
  // The roles are the only control: no switch, no On or Off.
  const body = await state();
  assert.deepEqual(body.roles, ["view", "comment"]);
  assert.equal("comments" in body, false);
  assert.equal(await frame.getByText("Comments", { exact: true }).count(), 0);
  assert.equal(await frame.getByRole("radio", { name: "On", exact: true }).count(), 0);
  await frame.getByText("Anyone with the link can view. Only people you add can comment.").waitFor();
  await shoot(page, "popover-roles");

  // The role sits on the person's row, inside the panel.
  const email = await frame.getByText(invitee).boundingBox();
  const roleBox = await frame.getByLabel(`Access for ${invitee}`).boundingBox();
  assert.ok(Math.abs(email.y - roleBox.y) < 30, "the role sits beside the address");
  const mainBox = await frame.locator("main").boundingBox();
  assert.equal(await frame.locator("li").evaluateAll((rows) => rows.every((row) => row.scrollWidth <= row.clientWidth + 1)), true, "no row is cut at the side");
  assert.ok(roleBox.x + roleBox.width <= mainBox.x + mainBox.width - 16, "the role select sits inside the panel's padding");

  // The select's options are exactly the roles the plan grants.
  assert.deepEqual(await frame.getByLabel(`Access for ${invitee}`).locator("option").allTextContents(), ["Can view", "Can comment"]);

  // The person's role: Can comment is what an invite has, and it moves both ways.
  const select = frame.getByLabel(`Access for ${invitee}`);
  assert.equal(await select.inputValue(), "comment");
  await select.selectOption("view");
  await until("the role to land", async () => (await roleOf()) === "view");
  assert.equal(await frame.getByLabel(`Access for ${invitee}`).inputValue(), "view");
  await frame.getByLabel(`Access for ${invitee}`).selectOption("comment");
  await until("the role to return", async () => (await roleOf()) === "comment");

  // The helper line follows the link access.
  await frame.getByRole("radio", { name: "Only those invited" }).click();
  await frame.getByText("Only people you add can open this page.").waitFor();
  assert.equal(await frame.getByText("Anyone with the link can view.").count(), 0);

  // On a plan with no roles: the plan line replaces Add people, and each role is plain text.
  await db.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(OWNER_ACCOUNT).run();
  try {
    await frame.getByRole("radio", { name: "Anyone with the link" }).click();
    await until("the free owner view", async () => (await frame.getByText("Private pages and comments need a paid plan.").count()) > 0);
    assert.equal(await frame.getByPlaceholder("Emails, separated by commas").count(), 0);
    assert.equal(await frame.getByLabel(`Access for ${invitee}`).count(), 0);
    await frame.getByText("Can comment", { exact: true }).waitFor();
    assert.equal(await frame.getByRole("button", { name: "Remove" }).count(), 1, "Remove stays");
    // Pressing Only those invited is refused, with the plan's words, and nothing changes.
    await frame.getByRole("radio", { name: "Only those invited" }).click();
    await frame.getByText("Private sharing needs a paid plan. Nothing was changed.").waitFor();
    assert.equal((await state()).linkAccess, "anyone");
    await shoot(page, "popover-plan-line");
  } finally {
    await db.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(OWNER_ACCOUNT).run();
  }
  await context.close();
});

test("the popover tells the page its owner is looking only from a click inside it: never when the view is drawn", { timeout: 180_000 }, async () => {
  const X = await publish("Quiet owner", "<p>Mine.</p>");
  const context = await newContext(OWNER_ACCOUNT);
  // Every message the Share frame posts to the page around it.
  await context.addInitScript(() => {
    window.__shareEvents = [];
    window.addEventListener("message", (event) => {
      if (event.data && event.data.type === "openartifacts:share") window.__shareEvents.push(event.data.event);
    });
  });
  const events = (page) => page.evaluate(() => window.__shareEvents.slice());
  const { page, frame } = await ownerFrame(context, X);

  // The owner view is drawn (after the sign-in popup): the page has been told "ready" and nothing about its viewer.
  await frame.getByPlaceholder("Emails, separated by commas").waitFor();
  assert.deepEqual(await events(page), ["ready"]);
  // Reading and redrawing the view is not a click either.
  await frame.evaluate((key) => { const v = window.localStorage.getItem(key); window.localStorage.removeItem(key); window.localStorage.setItem(key, v); }, `openartifacts:share-token:${X}`);
  await frame.getByPlaceholder("Emails, separated by commas").waitFor();
  assert.deepEqual(await events(page), ["ready"]);

  // An add is a click: it says people. The value is set rather than typed: fill() into this cross-site
  // frame just after the popup closes can send its text to the top page instead.
  await frame.getByPlaceholder("Emails, separated by commas").evaluate((input) => { input.value = "sam@example.com"; });
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await until("people after an add", async () => (await events(page)).includes("people"));
  const afterAdd = await events(page);
  assert.equal(afterAdd.filter((name) => name === "people").length, 1);

  // A role change is a click.
  await frame.getByLabel("Access for sam@example.com").selectOption("view");
  await until("people after a role change", async () => (await events(page)).filter((name) => name === "people").length === 2);

  // Removing someone says nothing more, and neither does a refused write.
  await frame.getByRole("button", { name: "Remove" }).click();
  await until("the removal", async () => (await frame.getByText("sam@example.com").count()) === 0);
  assert.equal((await events(page)).filter((name) => name === "people").length, 2);

  // Closing the owner view with × says people after close; so does Escape.
  await frame.getByRole("button", { name: "Close" }).click();
  await until("people after ×", async () => (await events(page)).filter((name) => name === "people").length === 3);
  assert.equal((await events(page)).includes("close"), true);
  await page.locator("a[data-openartifacts-share]").click();
  await frame.getByPlaceholder("Emails, separated by commas").waitFor();
  await frame.locator("main").press("Escape");
  await until("people after Escape", async () => (await events(page)).filter((name) => name === "people").length === 4);

  // A free owner's page has no comments to bring up: closing their owner view says only close.
  await db.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(OWNER_ACCOUNT).run();
  try {
    const free = await context.newPage();
    await free.goto(docUrl(X));
    await free.locator("a[data-openartifacts-share]").click();
    const freeFrame = await until("the Share frame", () => frameOf(free, X));
    await freeFrame.getByText("Private pages and comments need a paid plan.").waitFor();
    await freeFrame.getByRole("button", { name: "Close" }).click();
    await until("the close", async () => (await events(free)).includes("close"));
    assert.deepEqual((await events(free)).filter((name) => name === "people"), []);
  } finally {
    await db.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(OWNER_ACCOUNT).run();
  }
  await context.close();
});

test("a role change the server refuses puts the select back on the role the person has", { timeout: 120_000 }, async () => {
  const X = await publish("Role refused", "<p>Mine.</p>");
  const invitee = "refused@example.com";
  assert.equal((await api(`/api/v1/docs/${X}/access/people/${encodeURIComponent(invitee)}`, { method: "PUT", body: "{}" })).status, 200);
  const roleOf = async () => (await (await api(`/api/v1/docs/${X}/access`)).json()).people.find((entry) => entry.email === invitee).role;
  const context = await newContext(OWNER_ACCOUNT);
  const { page, frame } = await ownerFrame(context, X);
  const select = frame.getByLabel(`Access for ${invitee}`);
  await select.waitFor();
  assert.equal(await select.inputValue(), "comment");

  const url = `https://${API}/embed/api/docs/${X}/access/people/${encodeURIComponent(invitee)}`;
  for (const refuse of [(route) => route.fulfill({ status: 500, body: "" }), (route) => route.abort()]) {
    const handler = (route) => (route.request().method() === "PUT" ? refuse(route) : route.continue());
    await page.route(url, handler);
    await select.selectOption("view");
    await frame.getByText("Something went wrong. Nothing was changed.").waitFor();
    await until("the select to go back", async () => (await select.inputValue()) === "comment");
    assert.equal(await roleOf(), "comment");
    await page.unroute(url, handler);
  }
  // Unrefused, the same change lands and stays.
  await select.selectOption("view");
  await until("the role to land", async () => (await roleOf()) === "view");
  assert.equal(await frame.getByLabel(`Access for ${invitee}`).inputValue(), "view");
  await context.close();
});

test("an owner shown the plan line who comes back to the tab after upgrading sees Add people", { timeout: 120_000 }, async () => {
  const X = await publish("Upgraded", "<p>Mine.</p>");
  await db.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(OWNER_ACCOUNT).run();
  try {
    const context = await newContext(OWNER_ACCOUNT);
    const { frame } = await ownerFrame(context, X);
    await frame.getByText(/Private pages and comments need a paid plan/).waitFor();
    assert.equal(await frame.getByPlaceholder("Emails, separated by commas").count(), 0);
    // Paid in the checkout tab; this tab becomes visible again.
    await db.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(OWNER_ACCOUNT).run();
    await frame.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await frame.getByPlaceholder("Emails, separated by commas").waitFor();
    await context.close();
  } finally {
    await db.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(OWNER_ACCOUNT).run();
  }
});

test("a role the plan no longer grants stays as its own option, so the owner can lower the person", { timeout: 120_000 }, async () => {
  const X = await publish("Lapsed comments", "<p>Mine.</p>");
  const invitee = "kept@example.com";
  assert.equal((await api(`/api/v1/docs/${X}/access/people/${encodeURIComponent(invitee)}`, { method: "PUT", body: JSON.stringify({ role: "comment" }) })).status, 200);
  const context = await newContext(OWNER_ACCOUNT);
  const page = await context.newPage();
  // A plan with private sharing but not comments: its Access grants only view, and the person is still at comment.
  await page.route(`https://${API}/embed/api/docs/${X}/access`, async (route) => {
    if (route.request().method() !== "GET" || route.request().headers().authorization === undefined) return route.continue();
    const body = await (await api(`/api/v1/docs/${X}/access`)).json();
    await route.fulfill({ json: { ...body, viewer: "owner", roles: ["view"] } });
  });
  await page.goto(docUrl(X));
  await page.locator("a[data-openartifacts-share]").click();
  const frame = await until("the Share frame", () => frameOf(page, X));
  const [popup] = await Promise.all([context.waitForEvent("page"), frame.getByRole("button", { name: "Sign in to manage" }).click()]);
  await popup.waitForEvent("close").catch(() => {});
  const select = frame.getByLabel(`Access for ${invitee}`);
  await select.waitFor();
  assert.equal(await select.inputValue(), "comment");
  assert.deepEqual(await select.locator("option").allInnerTexts(), ["Can view", "Can comment"]);
  await select.selectOption("view");
  await until("the role lowered", async () => (await (await api(`/api/v1/docs/${X}/access`)).json()).people.some((p) => p.email === invitee && p.role === "view"));
  await context.close();
});

test("a role this Worker does not know is shown as its own option and is never written back", { timeout: 120_000 }, async () => {
  const X = await publish("Future role", "<p>Mine.</p>");
  const invitee = "future@example.com";
  assert.equal((await api(`/api/v1/docs/${X}/access/people/${encodeURIComponent(invitee)}`, { method: "PUT", body: "{}" })).status, 200);
  const context = await newContext(OWNER_ACCOUNT);
  const page = await context.newPage();
  // The server a newer Worker would be: its Access lists the person at a role this script has never heard of.
  const writes = [];
  // A fulfilled answer never reaches the server, so the owner's own read (through the API) stands in for it.
  await page.route(`https://${API}/embed/api/docs/${X}/access`, async (route) => {
    if (route.request().method() !== "GET" || route.request().headers().authorization === undefined) return route.continue();
    const body = await (await api(`/api/v1/docs/${X}/access`)).json();
    for (const entry of body.people) entry.role = "edit";
    await route.fulfill({ json: { ...body, viewer: "owner" } });
  });
  page.on("request", (request) => { if (request.method() !== "GET" && request.url().includes("/access/people/")) writes.push(request.url()); });
  await page.goto(docUrl(X));
  await page.locator("a[data-openartifacts-share]").click();
  const frame = await until("the Share frame", () => frameOf(page, X));
  const [popup] = await Promise.all([context.waitForEvent("page"), frame.getByRole("button", { name: "Sign in to manage" }).click()]);
  await popup.waitForEvent("close").catch(() => {});
  const select = frame.getByLabel(`Access for ${invitee}`);
  await select.waitFor();
  assert.equal(await select.inputValue(), "edit");
  assert.equal(await select.locator("option:checked").innerText(), "Can edit");
  // Looking, and leaving, writes nothing.
  await page.keyboard.press("Escape");
  assert.deepEqual(writes, []);
  await context.close();
});
