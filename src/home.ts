/**
 * Home: the page where a signed-in owner sees everything they have published.
 *
 * ```
 * GET /home[?cursor=…]   the account's live pages, newest first, 50 to a page
 * ```
 *
 * On the API host because the reader session lives there. It is the one address
 * every page's **Home** button leads to (`/embed/home`), so it lists whoever is
 * signed in and never the owner of the page the button was on. Signed out, it is
 * the sign-in page and comes back here.
 *
 * "My pages" is the same set `GET /api/v1/docs` lists for an account: the
 * account's owner scope, so a page published with a linked Copilot license key
 * is there too. It reads only D1 and the session, never the license server, so a
 * visit costs one list query: the people count rides in that query.
 *
 * Each row links to the page's own url (`publicDocUrl`), which sends a private
 * page through `/open`. There is nothing to act on here; **Share** on each page
 * and the CLI keep that. The **Account** button appears only where
 * `ACCOUNT_ACTION_URL` is configured, so a self-hosted server has none.
 */
import { actionUrl } from "./account.js";
import { decodeCursor, encodeCursor } from "./api/manage.js";
import type { Env } from "./config.js";
import { accountEmail, listPublisherDocs, type DocListRow } from "./db.js";
import { escapeHtml } from "./page.js";
import { HOME_PATH } from "./paths.js";
import { readerSecret } from "./reader-config.js";
import { READER_NOT_FOUND, readerResponse } from "./reader-pages.js";
import { FAVICON_LINK, NOINDEX_META, OPENARTIFACTS_MARK_SVG } from "./render.js";
import { signIn } from "./reader.js";
import { readSession } from "./session.js";
import { publicDocUrl } from "./urls.js";

const PAGE_SIZE = 50;

/**
 * A full page rather than the brand card the sign-in pages use: a list that
 * grows, and the search it will get, need the width.
 */
const HOME_STYLE = `<style>
:root{color-scheme:dark;font-family:Archivo,"Helvetica Neue",Helvetica,Arial,ui-sans-serif,system-ui,sans-serif}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:#e9ebee;background:#07080b}
header{display:flex;align-items:center;justify-content:space-between;height:56px;padding:0 clamp(1rem,4vw,2rem);border-bottom:1px solid #20242c}
.brand{display:flex;align-items:center;gap:.75rem;color:#8d94a0;font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;font-size:.7rem;font-weight:500;letter-spacing:.16em;text-transform:uppercase}
.mark{display:block;width:1.75rem;height:1.75rem}.mark svg{display:block;width:100%;height:100%}
.account{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#1d2027;border:1px solid #2c313b;color:#f4f5f7;font-size:.8rem;font-weight:600;text-decoration:none;text-transform:uppercase}
.account:hover{border-color:#f6ae52;color:#f9c47f}
main{max-width:64rem;margin:0 auto;padding:clamp(1.5rem,5vw,3rem) clamp(1rem,4vw,2rem)}
h1{margin:0 0 1.5rem;color:#f4f5f7;font-size:1.75rem;font-weight:700;letter-spacing:-.02em}
.empty{color:#8d94a0;line-height:1.7}
.cols,li a{display:grid;grid-template-columns:minmax(0,1fr) 11rem 7rem;align-items:baseline;gap:1rem;padding:.75rem}
.cols{padding-block:.5rem;border-bottom:1px solid #20242c;color:#5b626e;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase}
ul{margin:0;padding:0;list-style:none}
li a{border-bottom:1px solid #161a20;color:#f4f5f7;font-weight:500;text-decoration:none}
li a:hover{background:#0d0f14}li a:hover .t{color:#f9c47f}
.t{overflow-wrap:anywhere}.a,.d{color:#8d94a0;font-size:.875rem;font-weight:400}.d,.cols span:last-child{text-align:right}
.more{display:inline-block;margin-top:1.5rem;color:#f6ae52;font-weight:600}.more:hover{color:#f9c47f}
@media(max-width:40rem){.cols{display:none}li a{grid-template-columns:auto 1fr;gap:.2rem .3rem;padding-inline:0}.t{grid-column:1/-1}.d{text-align:left}.d::before{content:"·";margin-right:.3rem}}
</style>`;

/** `Oct 12, 2026`, in UTC so the page is the same bytes wherever it is read. */
const published = (atMs: number) =>
  new Date(atMs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function access(row: DocListRow): string {
  if (row.link_access === "anyone") return "Public";
  return row.people === 0 ? "Only you" : `Private · ${row.people} ${row.people === 1 ? "person" : "people"}`;
}

export async function handleHome(request: Request, url: URL, env: Env): Promise<Response> {
  const secret = readerSecret(env);
  if (request.method !== "GET" || secret === null) return READER_NOT_FOUND();

  const accountId = await readSession(request, secret, Date.now());
  const email = accountId === null ? null : await accountEmail(env.DB, accountId);
  if (accountId === null || email === null) return signIn(env, HOME_PATH);

  // A cursor that does not decode starts again from the top.
  const raw = url.searchParams.get("cursor");
  const after = raw === null ? null : decodeCursor(raw);
  const rows = await listPublisherDocs(env.DB, accountId, after, PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  const last = rows.length > PAGE_SIZE ? page.at(-1) : undefined;

  // A page whose first push never landed has nothing to open; `GET /api/v1/docs` is where it is cleaned up.
  const shown = page.filter((row) => row.version !== null);
  const list = shown
    .map(
      (row) =>
        `<li><a href="${escapeHtml(publicDocUrl(env, url, row.id))}"><span class="t"><bdi>${escapeHtml(row.title)}</bdi></span><span class="a">${access(row)}</span><span class="d">${published(row.updated_at)}</span></a></li>`,
    )
    .join("");
  const more = last === undefined ? "" : `<a class="more" href="${HOME_PATH}?cursor=${encodeCursor(last)}">Show more</a>`;

  let account: URL | null = null;
  try {
    account = actionUrl(env);
  } catch {
    // A misconfigured destination is the operator's to fix; the page just has no button.
  }
  const button =
    account === null
      ? ""
      : `<a class="account" href="${escapeHtml(account.toString())}" target="_blank" rel="noopener noreferrer" aria-label="Account">${escapeHtml(email.charAt(0))}</a>`;

  const body =
    shown.length === 0 && last === undefined
      ? '<p class="empty">Nothing published yet. Ask your agent to publish a page.</p>'
      : `<div class="cols" aria-hidden="true"><span>Title</span><span>Access</span><span>Updated</span></div><ul>${list}</ul>${more}`;
  const response = readerResponse(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${NOINDEX_META}
${FAVICON_LINK}
<title>Your pages · OpenArtifacts</title>
${HOME_STYLE}
</head>
<body>
<header><div class="brand"><span class="mark" aria-hidden="true">${OPENARTIFACTS_MARK_SVG}</span>OpenArtifacts</div>${button}</header>
<main aria-labelledby="page-title">
<h1 id="page-title">Your pages</h1>
${body}
</main>
</body>
</html>`,
    200,
  );
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
