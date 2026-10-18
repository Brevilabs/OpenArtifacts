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
import { READER_NOT_FOUND, readerPage } from "./reader-pages.js";
import { signIn } from "./reader.js";
import { readSession } from "./session.js";
import { publicDocUrl } from "./urls.js";

const PAGE_SIZE = 50;

const HOME_STYLE = `<style>
main{position:relative;width:min(100%,40rem)}h1{max-width:none;font-size:clamp(1.5rem,5vw,2.25rem);line-height:1.1}
.account{position:absolute;top:clamp(2rem,6vw,4rem);right:clamp(2rem,6vw,4rem);display:grid;place-items:center;width:28px;height:28px;margin:0;border-radius:50%;background:#1d2027;border:1px solid #2c313b;color:#f4f5f7;font-size:.8rem;font-weight:600;text-decoration:none;text-transform:uppercase}
.account:hover{border-color:#f6ae52;color:#f9c47f}
ul{margin:2rem 0 0;padding:0;list-style:none}
li a{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin:0;padding:.75rem 0;border-top:1px solid #20242c;color:#f4f5f7;font-weight:500;text-decoration:none}
li:last-child a{border-bottom:1px solid #20242c}li a:hover .t{color:#f9c47f}
.t{min-width:0;overflow-wrap:anywhere}.m{flex:none;color:#8d94a0;font-size:.85rem;font-weight:400;text-align:right}
.more{margin-top:1rem}
@media(max-width:30rem){li a{flex-direction:column;gap:.15rem}.m{text-align:left}}
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

  // A cursor this page did not issue starts again from the top.
  const raw = url.searchParams.get("cursor");
  const after = raw === null ? null : decodeCursor(raw);
  const rows = await listPublisherDocs(env.DB, accountId, after, PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  const last = rows.length > PAGE_SIZE ? page.at(-1) : undefined;

  const list = page
    .map(
      (row) =>
        `<li><a href="${escapeHtml(publicDocUrl(env, url, row.id))}"><span class="t"><bdi>${escapeHtml(row.title)}</bdi></span><span class="m">${access(row)} · ${published(row.updated_at)}</span></a></li>`,
    )
    .join("");
  const more = last === undefined ? "" : `<p class="more"><a href="${HOME_PATH}?cursor=${encodeCursor(last)}">Show more</a></p>`;

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

  const response = readerPage(
    {
      title: "Your pages",
      heading: "Your pages",
      message: page.length === 0 ? "Nothing published yet. Ask your agent to publish a page." : "",
      detail: `${HOME_STYLE}\n${button}${page.length === 0 ? "" : `<ul>${list}</ul>${more}`}`,
    },
    200,
  );
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
