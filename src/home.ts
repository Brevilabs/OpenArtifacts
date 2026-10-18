/**
 * Home: the page where a signed-in owner sees everything they have published.
 *
 * `GET /home[?cursor=…]` serves the account's live pages, newest first, 50 to a page.
 * `GET /home?q=…` searches that owner's live, landed pages and returns up to eight suggestions.
 *
 * On the API host because the reader session lives there. It is the one address
 * every page's **Home** button leads to (`/embed/home`), so it lists whoever is
 * signed in and never the owner of the page the button was on. Signed out, it is
 * the sign-in page and comes back to `/home`.
 *
 * Pages include the account's owner scope, so a page published with a linked
 * Copilot license key is there too. Home reads only D1 and the session, never the
 * license server. Each row links through `publicDocUrl`; private pages use `/open`.
 */
import { actionUrl } from "./account.js";
import { decodeCursor, encodeCursor } from "./api/manage.js";
import type { Env } from "./config.js";
import { accountEmail, listPublisherDocs, searchPublisherDocs, type DocListRow } from "./db.js";
import { scriptHashSource } from "./hash.js";
import { escapeHtml } from "./page.js";
import { HOME_PATH } from "./paths.js";
import { readerSecret } from "./reader-config.js";
import { READER_CSP, READER_NOT_FOUND, readerResponse } from "./reader-pages.js";
import { FAVICON_LINK, NOINDEX_META, OPENARTIFACTS_MARK_SVG } from "./render.js";
import { signIn } from "./reader.js";
import { readSession } from "./session.js";
import { publicDocUrl } from "./urls.js";

const PAGE_SIZE = 50;

// Mirrors apps/openartifacts/src/app/page.tsx and src/styles/globals.css; font stacks follow
// src/app/layout.tsx and tailwind.config.ts. The independently deployed Worker does not share them.
const HOME_FONT_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&amp;family=IBM+Plex+Mono:wght@400;500&amp;display=swap" referrerpolicy="no-referrer">';
const HOME_STYLE = `<style>
:root{color-scheme:dark;--bg-hsl:222 24% 4%;--line-hsl:219 16% 15%;--line-2-hsl:220 16% 10%;--text-hsl:214 12% 92%;--text-2-hsl:213 12% 64%;--text-3-hsl:216 9% 46%;--artifact-accent:#f6ae52;--artifact-accent-rgb:246 174 82;--bg:hsl(var(--bg-hsl));--text:hsl(var(--text-hsl));--shell:1060px;--font-archivo:"Archivo";--font-plex-mono:"IBM Plex Mono";--font-body:var(--font-archivo),ui-sans-serif,system-ui,sans-serif;--font-display:var(--font-archivo),"Helvetica Neue",Helvetica,Arial,sans-serif;--font-mono:var(--font-plex-mono),ui-monospace,monospace;--control-well:#0b0d10}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:var(--font-body);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}::selection{background:rgb(var(--artifact-accent-rgb)/.24);color:var(--text)}:focus-visible{outline:2px solid var(--artifact-accent);outline-offset:3px;border-radius:2px}
header{height:56px;border-bottom:1px solid hsl(var(--line-hsl))}.header-inner{height:100%;max-width:var(--shell);margin:auto;padding-inline:clamp(20px,5vw,48px);display:flex;align-items:center;justify-content:space-between}.brand{display:flex;align-items:center;gap:.75rem;color:var(--text);font-family:var(--font-display);font-size:18px;font-weight:700;letter-spacing:-.035em;text-decoration:none}.mark{display:block;width:1.75rem;height:1.75rem}.mark svg{display:block;width:100%;height:100%}.account{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:hsl(var(--line-2-hsl));border:1px solid hsl(var(--line-hsl));color:var(--text);font-size:.8rem;font-weight:600;text-decoration:none;text-transform:uppercase}.account:hover{border-color:var(--artifact-accent);color:var(--artifact-accent)}
main{width:100%;max-width:var(--shell);margin-inline:auto;padding:2rem clamp(20px,5vw,48px)}.home-search{width:min(100%,40rem);margin:0 auto}.search-control{position:relative}.home-search input{width:100%;height:48px;padding:12px;background:var(--control-well);border:1px solid hsl(var(--line-hsl));border-radius:3px;color:var(--text);font:inherit}.home-search input:focus{border-color:var(--artifact-accent)}.home-search input::-webkit-search-cancel-button{display:none}.cli-hint{width:max-content;max-width:calc(100vw - 2*clamp(20px,5vw,48px));margin:.75rem 0 0;color:hsl(var(--text-2-hsl));font-size:.8125rem;line-height:1.6}.pages-section{margin-top:2rem}h1{margin:0 0 1rem;color:var(--text);font-family:var(--font-display);font-size:1.25rem;font-weight:600;letter-spacing:-.02em}.empty{color:hsl(var(--text-2-hsl));line-height:1.7}
.cols,.pages li a{display:grid;grid-template-columns:minmax(0,1fr) 11rem 7rem;align-items:baseline;gap:1rem;padding:.75rem}.cols{padding-block:.5rem;border-bottom:1px solid hsl(var(--line-hsl));color:hsl(var(--text-3-hsl));font-family:var(--font-mono);font-size:.75rem;letter-spacing:.08em;text-transform:uppercase}.pages{margin:0;padding:0;list-style:none}.pages li a{border-bottom:1px solid hsl(var(--line-2-hsl));color:var(--text);font-weight:500;text-decoration:none}.pages li a:hover,.pages li a:focus-visible{background:rgb(var(--artifact-accent-rgb)/.06)}.pages li a:hover .t{color:var(--artifact-accent)}.t{overflow-wrap:anywhere}.a,.d{color:hsl(var(--text-2-hsl));font-size:.875rem;font-weight:400}.d,.cols span:last-child{text-align:right}.more{display:inline-block;margin-top:1.5rem;color:var(--artifact-accent);font-weight:600}.more:hover{color:var(--text)}
#page-suggestions{position:absolute;z-index:2;top:calc(100% + 2px);left:0;width:100%;margin:0;padding:0;list-style:none;background:var(--control-well);border:1px solid hsl(var(--line-hsl))}#page-suggestions[hidden]{display:none}#page-suggestions [role=option]{padding:.5rem .75rem;cursor:pointer;color:var(--text)}#page-suggestions [role=option][aria-selected=true]{background:rgb(var(--artifact-accent-rgb)/.12);outline:2px solid var(--artifact-accent);outline-offset:-2px}#page-suggestions .suggestion-url{display:block;color:hsl(var(--text-2-hsl));font-family:var(--font-mono);font-size:.75rem}.search-status{margin:.5rem 0 0;color:hsl(var(--text-2-hsl));font-size:.8125rem}
@media(max-width:40rem){.cols{display:none}.pages li a{grid-template-columns:auto 1fr;gap:.2rem .3rem;padding-inline:0}.t{grid-column:1/-1}.d{text-align:left}.d::before{content:"·";margin-right:.3rem}}
</style>`;

const HOME_SCRIPT = `(function(){const input=document.getElementById("page-search"),list=document.getElementById("page-suggestions"),status=document.getElementById("search-status");let timer=0,generation=0,pages=[],active=-1;function close(clearStatus){generation++;clearTimeout(timer);list.hidden=true;input.setAttribute("aria-expanded","false");input.removeAttribute("aria-activedescendant");pages=[];active=-1;list.replaceChildren();if(clearStatus)status.textContent=""}function select(index){if(!pages.length)return;active=(index+pages.length)%pages.length;Array.from(list.children).forEach((option,i)=>option.setAttribute("aria-selected",String(i===active)));input.setAttribute("aria-activedescendant",list.children[active].id);list.children[active].scrollIntoView({block:"nearest"})}function navigate(page){location.assign(page.url)}function render(results){pages=results;active=-1;list.replaceChildren();results.forEach((page,i)=>{const option=document.createElement("li");option.id="page-option-"+i;option.setAttribute("role","option");option.setAttribute("aria-selected","false");const title=document.createElement("span");title.textContent=page.title;const path=document.createElement("span");path.className="suggestion-url";path.textContent="/d/"+page.id;option.append(title,path);option.addEventListener("pointerdown",event=>event.preventDefault());option.addEventListener("click",()=>navigate(page));list.append(option)});list.hidden=results.length===0;input.setAttribute("aria-expanded",String(results.length>0));if(!results.length)status.textContent="No matching pages."}input.addEventListener("input",()=>{const current=++generation;clearTimeout(timer);list.replaceChildren();pages=[];active=-1;input.removeAttribute("aria-activedescendant");list.hidden=true;input.setAttribute("aria-expanded","false");status.textContent="";const query=input.value.trim();if(!query)return;timer=setTimeout(async()=>{try{const response=await fetch("/home?q="+encodeURIComponent(query),{credentials:"same-origin"});if(current!==generation)return;if(response.status===401){status.textContent="Sign in again to search.";return}if(!response.ok)throw new Error();const data=await response.json();if(current!==generation)return;render(data.pages)}catch{if(current===generation)status.textContent="Search unavailable. Try again."}},150)});input.addEventListener("keydown",event=>{if(event.key==="ArrowDown"&&pages.length){event.preventDefault();select(active<0?0:active+1)}else if(event.key==="ArrowUp"&&pages.length){event.preventDefault();select(active<0?pages.length-1:active-1)}else if(event.key==="Enter"&&pages.length){event.preventDefault();navigate(pages[active<0?0:active])}else if(event.key==="Escape"){event.preventDefault();close(true)}else if(event.key==="Tab"){close(true)}});document.addEventListener("pointerdown",event=>{if(!event.target.closest(".home-search"))close(true)});input.addEventListener("blur",()=>{setTimeout(()=>{if(!document.activeElement.closest?.(".home-search"))close(true)},0)})})();`;

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
  if (search) {
    const query = url.searchParams.get("q")!.trim();
    if (!query) return jsonResponse({ pages: [] });
    const rows = await searchPublisherDocs(env.DB, accountId, query);
    return jsonResponse({ pages: rows.map(row => ({ id: row.id, title: row.title, url: publicDocUrl(env, url, row.id) })) });
  }

  const raw = url.searchParams.get("cursor");
  const after = raw === null ? null : decodeCursor(raw);
  const rows = await listPublisherDocs(env.DB, accountId, after, PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  const last = rows.length > PAGE_SIZE ? page.at(-1) : undefined;
  const shown = page.filter((row) => row.version !== null);
  const list = shown.map((row) =>
    `<li><a href="${escapeHtml(publicDocUrl(env, url, row.id))}"><span class="t"><bdi>${escapeHtml(row.title)}</bdi></span><span class="a">${access(row)}</span><span class="d">${published(row.updated_at)}</span></a></li>`,
  ).join("");
  const more = last === undefined ? "" : `<a class="more" href="${HOME_PATH}?cursor=${encodeCursor(last)}">Show more</a>`;
  let account: URL | null = null;
  try { account = actionUrl(env); } catch { /* A misconfigured destination simply hides the button. */ }
  const button = account === null ? "" : `<a class="account" href="${escapeHtml(account.toString())}" target="_blank" rel="noopener noreferrer" aria-label="Account">${escapeHtml(email.charAt(0))}</a>`;
  const body = shown.length === 0 && last === undefined
    ? '<p class="empty">Nothing published yet. Ask your agent to publish a page.</p>'
    : `<div class="cols" aria-hidden="true"><span>Title</span><span>Access</span><span>Updated</span></div><ul class="pages">${list}</ul>${more}`;
  const csp = `${READER_CSP.replace("style-src 'unsafe-inline'", "style-src 'unsafe-inline' https://fonts.googleapis.com").replace("default-src 'none'", "default-src 'none'; font-src https://fonts.gstatic.com")}; script-src ${await scriptHashSource(HOME_SCRIPT)}; connect-src 'self'`;
  const response = readerResponse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${NOINDEX_META}${FAVICON_LINK}<title>Your pages · OpenArtifacts</title>${HOME_FONT_LINK}${HOME_STYLE}</head>
<body><header><div class="header-inner"><div class="brand"><span class="mark" aria-hidden="true">${OPENARTIFACTS_MARK_SVG}</span>OpenArtifacts</div>${button}</div></header>
<main><section class="home-search" role="search" aria-label="Your pages"><div class="search-control"><input id="page-search" type="search" role="combobox" aria-label="Search your pages" placeholder="Search your pages" aria-autocomplete="list" aria-expanded="false" aria-controls="page-suggestions" autocomplete="off" spellcheck="false"><ul id="page-suggestions" role="listbox" aria-label="Matching pages" hidden></ul></div><p id="search-status" role="status" class="search-status"></p><p class="cli-hint">Ask your agent to publish or unpublish any page with the OpenArtifacts CLI.</p></section>
<section class="pages-section" aria-labelledby="page-title"><h1 id="page-title">Your pages</h1>${body}</section></main><script>${HOME_SCRIPT}</script></body></html>`, 200, csp);
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
