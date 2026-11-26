/**
 * Home: the page where a signed-in owner sees everything they have published.
 *
 * `GET /home[?cursor=…]` serves the account's live pages, newest first, 50 to a page.
 * `GET /home?q=…` searches that owner's live, landed pages and returns up to eight suggestions.
 *
 * On the app host because the reader session lives there. It is the one address
 * every page's **Home** button leads to, so it lists whoever is
 * signed in and never the owner of the page the button was on. Signed out, it is
 * the sign-in page and comes back to `/home`.
 *
 * Pages include the account's owner scope, so a page published with a linked
 * Copilot license key is there too. Home reads only D1 and the session, never the
 * license server. Each row links through `publicDocUrl`; private pages use `/open`.
 * While the account's custom domain is live, rows link to it instead.
 *
 * `GET` and `POST /home/domain` is where the owner adds, checks and removes that
 * domain (`src/custom-domains.ts`), and exists only while custom domains are on.
 */
import { actionUrl } from "./account.js";
import { withCurrentPlan } from "./api/access.js";
import { decodeCursor, encodeCursor } from "./api/manage.js";
import { readSmallForm } from "./approval/handler.js";
import type { Env } from "./config.js";
import {
  addDomain,
  checkDomain,
  cnameTarget,
  domainRow,
  removeDomain,
  TXT_PREFIX,
  type CheckOutcome,
  type DomainRow,
} from "./custom-domains.js";
import { accountEmail, listPublisherDocs, searchPublisherDocs, type DocListRow } from "./db.js";
import { accountPlan } from "./entitlement.js";
import { scriptHashSource } from "./hash.js";
import { sameOriginPost } from "./limits.js";
import { escapeHtml } from "./page.js";
import { HOME_DOMAIN_PATH, HOME_PATH } from "./paths.js";
import { planLimits, upgradeUrl } from "./plans.js";
import { customDomainsConfigured, readerSecret } from "./reader-config.js";
import { READER_CSP, READER_NOT_FOUND, readerResponse } from "./reader-pages.js";
import { FAVICON_LINK, NOINDEX_META, OPENARTIFACTS_MARK_SVG } from "./render.js";
import { signIn } from "./reader.js";
import { readSession } from "./session.js";
import { customDocUrl, publicDocUrl } from "./urls.js";

const PAGE_SIZE = 50;

// Mirrors apps/openartifacts/src/app/page.tsx and src/styles/globals.css; font stacks follow
// src/app/layout.tsx and tailwind.config.ts. The independently deployed Worker does not share them.
// The fonts are named, not loaded, as on the brand pages (`page.ts`): a page on the app host fetches no third party.
const HOME_STYLE = `<style>
:root{color-scheme:dark;--bg-hsl:222 24% 4%;--line-hsl:219 16% 15%;--line-2-hsl:220 16% 10%;--text-hsl:214 12% 92%;--text-2-hsl:213 12% 64%;--text-3-hsl:216 9% 46%;--artifact-accent:#f6ae52;--artifact-accent-rgb:246 174 82;--bg:hsl(var(--bg-hsl));--text:hsl(var(--text-hsl));--shell:1060px;--font-archivo:"Archivo";--font-plex-mono:"IBM Plex Mono";--font-body:var(--font-archivo),ui-sans-serif,system-ui,sans-serif;--font-display:var(--font-archivo),"Helvetica Neue",Helvetica,Arial,sans-serif;--font-mono:var(--font-plex-mono),ui-monospace,Menlo,Consolas,monospace;--control-well:#0b0d10}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:var(--font-body);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}::selection{background:rgb(var(--artifact-accent-rgb)/.24);color:var(--text)}:focus-visible{outline:2px solid var(--artifact-accent);outline-offset:3px;border-radius:2px}
header{height:56px;border-bottom:1px solid hsl(var(--line-hsl))}.header-inner{height:100%;max-width:var(--shell);margin:auto;padding-inline:clamp(20px,5vw,48px);display:flex;align-items:center;justify-content:space-between}.brand{display:flex;align-items:center;gap:.75rem;color:var(--text);font-family:var(--font-display);font-size:18px;font-weight:700;letter-spacing:-.035em;text-decoration:none}.mark{display:block;width:1.75rem;height:1.75rem}.mark svg{display:block;width:100%;height:100%}.account{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:hsl(var(--line-2-hsl));border:1px solid hsl(var(--line-hsl));color:var(--text);font-size:.8rem;font-weight:600;text-decoration:none;text-transform:uppercase}.account:hover{border-color:var(--artifact-accent);color:var(--artifact-accent)}
main{width:100%;max-width:var(--shell);margin-inline:auto;padding:2rem clamp(20px,5vw,48px)}.home-search{width:min(100%,40rem);margin:0 auto}.search-control{position:relative}.home-search input{width:100%;height:48px;padding:12px;background:var(--control-well);border:1px solid hsl(var(--line-hsl));border-radius:3px;color:var(--text);font:inherit}.home-search input:focus{border-color:var(--artifact-accent)}.home-search input::-webkit-search-cancel-button{display:none}.cli-hint,.domain-hint{width:max-content;max-width:calc(100vw - 2*clamp(20px,5vw,48px));margin:.75rem 0 0;color:hsl(var(--text-2-hsl));font-size:.8125rem;line-height:1.6}.pages-section{margin-top:2rem}h1{margin:0 0 1rem;color:var(--text);font-family:var(--font-display);font-size:1.25rem;font-weight:600;letter-spacing:-.02em}.empty{color:hsl(var(--text-2-hsl));line-height:1.7}
.cols,.pages li a{display:grid;grid-template-columns:minmax(0,1fr) 11rem 7rem;align-items:baseline;gap:1rem;padding:.75rem}.cols{padding-block:.5rem;border-bottom:1px solid hsl(var(--line-hsl));color:hsl(var(--text-3-hsl));font-family:var(--font-mono);font-size:.75rem;letter-spacing:.08em;text-transform:uppercase}.pages{margin:0;padding:0;list-style:none}.pages li a{border-bottom:1px solid hsl(var(--line-2-hsl));color:var(--text);font-weight:500;text-decoration:none}.pages li a:hover,.pages li a:focus-visible{background:rgb(var(--artifact-accent-rgb)/.06)}.pages li a:hover .t{color:var(--artifact-accent)}.t{overflow-wrap:anywhere}.a,.d{color:hsl(var(--text-2-hsl));font-size:.875rem;font-weight:400}.d,.cols span:last-child{text-align:right}.more{display:inline-block;margin-top:1.5rem;color:var(--artifact-accent);font-weight:600}.more:hover{color:var(--text)}
#page-suggestions{position:absolute;z-index:2;top:calc(100% + 2px);left:0;width:100%;margin:0;padding:0;list-style:none;background:var(--control-well);border:1px solid hsl(var(--line-hsl))}#page-suggestions[hidden]{display:none}#page-suggestions [role=option]{padding:.5rem .75rem;cursor:pointer;color:var(--text)}#page-suggestions [role=option][aria-selected=true]{background:rgb(var(--artifact-accent-rgb)/.12);outline:2px solid var(--artifact-accent);outline-offset:-2px}#page-suggestions .suggestion-url{display:block;color:hsl(var(--text-2-hsl));font-family:var(--font-mono);font-size:.75rem}.search-status{margin:.5rem 0 0;color:hsl(var(--text-2-hsl));font-size:.8125rem}
.domain-hint a,.domain a{color:var(--artifact-accent);font-weight:600}.domain{max-width:40rem}.domain p{color:hsl(var(--text-2-hsl))}.domain table{width:100%;border-collapse:collapse;margin:1rem 0;font-size:.875rem}.domain th,.domain td{padding:.5rem;border-bottom:1px solid hsl(var(--line-hsl));text-align:left;overflow-wrap:anywhere}.domain code{font-family:var(--font-mono)}.domain input{height:40px;padding:8px;background:var(--control-well);border:1px solid hsl(var(--line-hsl));border-radius:3px;color:var(--text);font:inherit}.domain button,.domain summary{padding:6px 12px;background:none;border:1px solid hsl(var(--line-hsl));border-radius:3px;color:var(--text);font:inherit;cursor:pointer}.domain form{display:flex;gap:.5rem;margin:1rem 0}.domain details{margin-top:1.5rem}.domain summary{display:inline-block;list-style:none}.err{color:#f08b7d}
@media(max-width:40rem){.cols{display:none}.pages li a{grid-template-columns:auto 1fr;gap:.2rem .3rem;padding-inline:0}.t{grid-column:1/-1}.d{text-align:left}.d::before{content:"·";margin-right:.3rem}}
</style>`;

/**
 * The search box's typeahead: after a 150 ms pause, ask `/home?q=` and list up
 * to eight matches. Arrow keys move through them, Enter opens one, Escape and
 * Tab close the list. `generation` drops answers that arrive after the query
 * changed. Built with `textContent`, never markup.
 */
const HOME_SCRIPT = String.raw`(function () {
  const input = document.getElementById("page-search");
  const list = document.getElementById("page-suggestions");
  const status = document.getElementById("search-status");
  let timer = 0, generation = 0, pages = [], active = -1;

  function close(clearStatus) {
    generation++;
    clearTimeout(timer);
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    pages = [];
    active = -1;
    list.replaceChildren();
    if (clearStatus) status.textContent = "";
  }
  function select(index) {
    if (!pages.length) return;
    active = (index + pages.length) % pages.length;
    Array.from(list.children).forEach((option, i) => option.setAttribute("aria-selected", String(i === active)));
    input.setAttribute("aria-activedescendant", list.children[active].id);
    list.children[active].scrollIntoView({ block: "nearest" });
  }
  function navigate(page) { location.assign(page.url); }
  function render(results) {
    pages = results;
    active = -1;
    list.replaceChildren();
    results.forEach((page, i) => {
      const option = document.createElement("li");
      option.id = "page-option-" + i;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      const title = document.createElement("span");
      title.textContent = page.title;
      const path = document.createElement("span");
      path.className = "suggestion-url";
      path.textContent = "/d/" + page.id;
      option.append(title, path);
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("click", () => navigate(page));
      list.append(option);
    });
    list.hidden = results.length === 0;
    input.setAttribute("aria-expanded", String(results.length > 0));
    if (!results.length) status.textContent = "No matching pages.";
  }

  input.addEventListener("input", () => {
    const current = ++generation;
    clearTimeout(timer);
    list.replaceChildren();
    pages = [];
    active = -1;
    input.removeAttribute("aria-activedescendant");
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    status.textContent = "";
    const query = input.value.trim();
    if (!query) return;
    timer = setTimeout(async () => {
      try {
        const response = await fetch("/home?q=" + encodeURIComponent(query), { credentials: "same-origin" });
        if (current !== generation) return;
        if (response.status === 401) { status.textContent = "Sign in again to search."; return; }
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (current !== generation) return;
        render(data.pages);
      } catch {
        if (current === generation) status.textContent = "Search unavailable. Try again.";
      }
    }, 150);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && pages.length) { event.preventDefault(); select(active < 0 ? 0 : active + 1); }
    else if (event.key === "ArrowUp" && pages.length) { event.preventDefault(); select(active < 0 ? pages.length - 1 : active - 1); }
    else if (event.key === "Enter" && pages.length) { event.preventDefault(); navigate(pages[active < 0 ? 0 : active]); }
    else if (event.key === "Escape") { event.preventDefault(); close(true); }
    else if (event.key === "Tab") close(true);
  });
  document.addEventListener("pointerdown", (event) => { if (!event.target.closest(".home-search")) close(true); });
  input.addEventListener("blur", () => {
    setTimeout(() => { if (!document.activeElement.closest?.(".home-search")) close(true); }, 0);
  });
})();
`;

/** `Oct 12, 2026`, in UTC so the page is the same wherever it is read. */
const published = (atMs: number) =>
  new Date(atMs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function access(row: DocListRow): string {
  if (row.link_access === "anyone") return "Public";
  return row.people === 0 ? "Only you" : `Private · ${row.people} ${row.people === 1 ? "person" : "people"}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  } });
}

export async function handleHome(request: Request, url: URL, env: Env): Promise<Response> {
  const secret = readerSecret(env);
  if (request.method !== "GET" || secret === null) return READER_NOT_FOUND();
  const search = url.searchParams.has("q");
  const accountId = await readSession(request, secret, Date.now());
  const email = accountId === null ? null : await accountEmail(env.DB, accountId);
  if (search && (accountId === null || email === null)) return jsonResponse({ error: "sign_in_required" }, 401);
  if (accountId === null || email === null) return signIn(env, HOME_PATH);
  // The account's own domain, read once: rows open on it while it is live.
  const domain = customDomainsConfigured(env) ? await domainRow(env.DB, accountId) : null;
  const live = domain?.active_at != null ? domain.hostname : null;
  const pageUrl = (id: string) => customDocUrl(env, live, id) ?? publicDocUrl(env, url, id);
  if (search) {
    const query = url.searchParams.get("q")!.trim();
    if (!query) return jsonResponse({ pages: [] });
    const rows = await searchPublisherDocs(env.DB, accountId, query);
    return jsonResponse({ pages: rows.map(row => ({ id: row.id, title: row.title, url: pageUrl(row.id) })) });
  }

  const raw = url.searchParams.get("cursor");
  const after = raw === null ? null : decodeCursor(raw);
  const rows = await listPublisherDocs(env.DB, accountId, after, PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  const last = rows.length > PAGE_SIZE ? page.at(-1) : undefined;
  const shown = page.filter((row) => row.version !== null);
  const list = shown.map((row) =>
    `<li><a href="${escapeHtml(pageUrl(row.id))}"><span class="t"><bdi>${escapeHtml(row.title)}</bdi></span><span class="a">${access(row)}</span><span class="d">${published(row.updated_at)}</span></a></li>`,
  ).join("");
  const more = last === undefined ? "" : `<a class="more" href="${HOME_PATH}?cursor=${encodeCursor(last)}">Show more</a>`;
  const domainLine = !customDomainsConfigured(env)
    ? ""
    : domain === null
      ? `<p class="domain-hint">Use your own domain for your pages. <a href="${HOME_DOMAIN_PATH}">Set up a custom domain</a></p>`
      : live !== null
        ? `<p class="domain-hint">Your pages open on ${escapeHtml(live)}. <a href="${HOME_DOMAIN_PATH}">Manage</a></p>`
        : `<p class="domain-hint">${escapeHtml(domain.hostname)} is not live. <a href="${HOME_DOMAIN_PATH}">Finish setup</a></p>`;
  const body = shown.length === 0 && last === undefined
    ? '<p class="empty">Nothing published yet. Ask your agent to publish a page.</p>'
    : `<div class="cols" aria-hidden="true"><span>Title</span><span>Access</span><span>Updated</span></div><ul class="pages">${list}</ul>${more}`;
  return await homeShell(env, email, "Your pages", `<section class="home-search" role="search" aria-label="Your pages"><div class="search-control"><input id="page-search" type="search" role="combobox" aria-label="Search your pages" placeholder="Search your pages" aria-autocomplete="list" aria-expanded="false" aria-controls="page-suggestions" autocomplete="off" spellcheck="false"><ul id="page-suggestions" role="listbox" aria-label="Matching pages" hidden></ul></div><p id="search-status" role="status" class="search-status"></p><p class="cli-hint">Ask your agent to publish or unpublish any page with the OpenArtifacts CLI.</p>${domainLine}</section>
<section class="pages-section" aria-labelledby="page-title"><h1 id="page-title">Your pages</h1>${body}</section>`, HOME_SCRIPT, "; connect-src 'self'");
}

/** Home's page around `main`: the header with the Account button, and `script` by hash. */
async function homeShell(env: Env, email: string, title: string, main: string, script: string, extraCsp = ""): Promise<Response> {
  let account: URL | null = null;
  try { account = actionUrl(env); } catch { /* A misconfigured destination simply hides the button. */ }
  const button = account === null ? "" : `<a class="account" href="${escapeHtml(account.toString())}" target="_blank" rel="noopener noreferrer" aria-label="Account">${escapeHtml(email.charAt(0))}</a>`;
  const csp = `${READER_CSP}; script-src ${await scriptHashSource(script)}${extraCsp}`;
  const response = readerResponse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${NOINDEX_META}${FAVICON_LINK}<title>${escapeHtml(title)} · OpenArtifacts</title>${HOME_STYLE}</head>
<body><header><div class="header-inner"><div class="brand"><span class="mark" aria-hidden="true">${OPENARTIFACTS_MARK_SVG}</span>OpenArtifacts</div>${button}</div></header>
<main>${main}</main><script>${script}</script></body></html>`, 200, csp);
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

/** Each record's **Copy**. */
const DOMAIN_SCRIPT = String.raw`document.querySelectorAll("button[data-copy]").forEach(function (button) {
  button.addEventListener("click", function () {
    navigator.clipboard.writeText(button.dataset.copy).then(function () { button.textContent = "Copied"; });
  });
});
`;

/** What **Check now** says for each outcome but `live`, which draws the live page. */
function checkNote(env: Env, hostname: string, outcome: CheckOutcome): string | null {
  const host = escapeHtml(hostname);
  switch (outcome) {
    case "limited": return "Wait a minute, then press Check now again.";
    case "unavailable": return "We can’t check the domain right now. Try again in a minute.";
    case "no_txt": return "We can’t find the TXT record yet.";
    case "no_cname": return `${host} doesn’t point to ${escapeHtml(cnameTarget(env))} yet.`;
    case "certificate": return `Getting a certificate for ${host}. This usually takes a few minutes. Press <b>Check now</b> again.`;
    case "caa": return "A CAA record on your domain blocks the certificate. Allow letsencrypt.org, pki.goog and ssl.com.";
    case "blocked": return "This domain can’t be connected.";
    case "none":
    case "live": return null;
  }
}

const BAD_DOMAIN = "Enter a subdomain you own, like docs.example.com.";

/**
 * `GET` and `POST /home/domain`: the account's custom domain. The ops are `add`,
 * `check` and `remove`; a write is a strict same-origin form post. Only `add`
 * checks the plan, read as the Share popover's owner view reads it: a domain
 * outlives a lapse, and its owner can always check or remove it. Signed out, it
 * is the Home sign-in.
 */
export async function handleDomainPage(request: Request, url: URL, env: Env): Promise<Response> {
  const secret = readerSecret(env);
  const writing = request.method === "POST";
  if (!customDomainsConfigured(env) || secret === null || (request.method !== "GET" && !writing)) return READER_NOT_FOUND();
  if (writing && !sameOriginPost(request, url, true)) return READER_NOT_FOUND();
  const now = Date.now();
  const accountId = await readSession(request, secret, now);
  const email = accountId === null ? null : await accountEmail(env.DB, accountId);
  if (accountId === null || email === null) return signIn(env, HOME_PATH);

  const owner = await withCurrentPlan(env, {
    owner: accountId,
    plan: (await accountPlan(env, accountId, { skipAccountRefresh: true })).plan,
    authKind: "account",
  });
  const mayAdd = planLimits(env, owner.plan).customDomain === true;

  let checked: CheckOutcome | null = null;
  let refused = false;
  if (writing) {
    const form = await readSmallForm(request);
    const op = form?.get("op");
    if (op === "check") {
      checked = await checkDomain(env, accountId, now);
    } else if (op === "add" || op === "remove") {
      if (op === "remove") await removeDomain(env, accountId);
      else refused = !mayAdd || !(await addDomain(env, accountId, form!.get("domain") ?? "", now));
      // Post, redirect, get, unless there is something to say.
      if (!refused) {
        return new Response(null, { status: 303, headers: { location: HOME_DOMAIN_PATH, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
      }
    } else {
      return READER_NOT_FOUND();
    }
  }

  const row = await domainRow(env.DB, accountId);
  const note = refused ? BAD_DOMAIN : row !== null && checked !== null ? checkNote(env, row.hostname, checked) : null;
  return await homeShell(env, email, "Custom domain", `<section class="domain"><h1>Custom domain</h1>${domainBody(env, row, mayAdd, note)}<p><a href="${HOME_PATH}">Back to your pages</a></p></section>`, DOMAIN_SCRIPT);
}

/** The page in its states: no domain (or no plan for one), pending with its two records, and live. */
function domainBody(env: Env, row: DomainRow | null, mayAdd: boolean, note: string | null): string {
  const form = (op: string, body: string) => `<form method="post" action="${HOME_DOMAIN_PATH}"><input type="hidden" name="op" value="${op}">${body}</form>`;
  const said = note === null ? "" : `<p class="err" role="alert">${note}</p>`;
  if (row === null) {
    if (!mayAdd) {
      const upgrade = upgradeUrl(env);
      let account: URL | null = null;
      try { account = actionUrl(env); } catch { /* No link, as on Home. */ }
      return `<p>Custom domains need a paid plan.${upgrade === undefined ? "" : ` <a href="${escapeHtml(upgrade)}">Upgrade</a>`}</p>` +
        (account === null ? "" : `<p>Published from Copilot? <a href="${escapeHtml(account.toString())}" target="_blank" rel="noopener noreferrer">Link your account</a> first</p>`);
    }
    return `<p>Serve your pages from a subdomain you own, like docs.yourcompany.com. Links you already shared keep working.</p>${said}` +
      form("add", `<input name="domain" aria-label="Domain" placeholder="docs.example.com" autocomplete="off" spellcheck="false" required><button type="submit">Add domain</button>`);
  }
  const host = escapeHtml(row.hostname);
  const serving = escapeHtml(env.SERVING_HOST?.trim() ?? "");
  const remove = `<details><summary>Remove domain</summary><p>Remove ${host}? Links on ${host} stop working at once. Links on ${serving} keep working.</p>${form("remove", `<button type="submit">Remove</button>`)}</details>`;
  if (row.active_at !== null) {
    return `<p><b>${host} is live.</b> Your pages open at https://${host}/d/…, and the links you copy use it. Links you shared before keep working.</p>` +
      (mayAdd ? "" : `<p>Your plan doesn’t include custom domains now. ${host} still works.</p>`) +
      `<p>Keep both DNS records. Before you stop using this domain, press <b>Remove domain</b>.</p>${remove}`;
  }
  const record = (type: string, name: string, value: string) =>
    `<tr><td>${type}</td><td><code>${escapeHtml(name)}</code></td><td><code>${escapeHtml(value)}</code> <button type="button" data-copy="${escapeHtml(value)}">Copy</button></td></tr>`;
  return `<p>Add these two records at your DNS provider. Then press <b>Check now</b>.</p>` +
    `<table><thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead><tbody>${record("CNAME", row.hostname, cnameTarget(env))}${record("TXT", `${TXT_PREFIX}.${row.hostname}`, row.token)}</tbody></table>` +
    `<p>Keep both records. If your DNS is on Cloudflare, set the CNAME to DNS only. A new record can take up to an hour to show.</p>${said}` +
    `${form("check", `<button type="submit">Check now</button>`)}${remove}`;
}
