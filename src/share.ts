/**
 * The share page: where an owner manages who can open one document.
 *
 * ```
 * GET  /share/{docId}   the dialog, for a signed-in owner
 * POST /share/{docId}   one write: op=link | add | remove | decline
 * ```
 *
 * It is the dialog Copilot renders, served by the Worker, so it exists for
 * whoever published the document and for self-hosters. It lives on the API
 * host because the reader session does, and it is reached from the constant
 * **Manage** link in every served page's footer, from the request email, and
 * from `share` output. The document's origin can never see the owner's session,
 * so the page cannot know on the document whether its viewer is the owner; the
 * link is therefore the same for everyone, and a reader who follows it gets
 * sign-in and then the same not-available page `/open` shows.
 *
 * **It writes through the same operations as `/api/v1`** (`api/access.ts`), with
 * the session account as the principal, so the plan gate, the invite email,
 * idempotency and the `document_access_changed` event cannot differ between the
 * two. Approving a request is `op=add`; declining is `op=decline`.
 *
 * **A write rides a cookie, so it is held to the strictest origin check**
 * (`sameOriginPost`). `GET` never writes and no query parameter changes state:
 * `?notice=private` only selects a constant line of copy.
 *
 * There is no role control. Every person is added with the default role and the
 * page neither shows nor changes it.
 */
import type { AnalyticsSink } from "./analytics.js";
import {
  addPerson,
  declineRequest,
  getAccess,
  planRefusal,
  removePerson,
  setMode,
  type AccessResult,
  type AccessState,
} from "./api/access.js";
import { readSmallForm } from "./approval/handler.js";
import type { Publisher } from "./auth.js";
import { MAX_INVITES_PER_DOC, type Env } from "./config.js";
import { accountEmail } from "./db.js";
import { emailConfigured } from "./email.js";
import { accountPlan } from "./entitlement.js";
import { sameOriginPost } from "./limits.js";
import { escapeHtml } from "./page.js";
import { readerSecret } from "./reader-config.js";
import {
  hidden,
  notAvailablePage,
  READER_CSP,
  READER_NOT_FOUND,
  readerPage,
  SHARE_PREFIX,
} from "./reader-pages.js";
import { signIn } from "./reader.js";
import { parseDocPath } from "./serve.js";
import { readSession } from "./session.js";
import { publicDocUrl } from "./urls.js";

/** The one line shown after a public document is switched to invited-only. */
const COPY_NOTICE = "People who opened it while it was public may have kept a copy.";

/**
 * The Copy button's script, small enough to read in full. The page's policy
 * names its hash instead of allowing inline script, so this exact text is the
 * only script the page can run. Without it the page still works: the link is
 * selectable in a read-only field.
 */
const COPY_SCRIPT =
  'document.getElementById("copy").addEventListener("click",function(){' +
  'var field=document.getElementById("link");field.select();' +
  "var done=function(){document.getElementById(\"copy\").textContent=\"Copied\"};" +
  "if(navigator.clipboard){navigator.clipboard.writeText(field.value).then(done,function(){document.execCommand(\"copy\");done()})}" +
  'else{document.execCommand("copy");done()}});';

let scriptPolicy: Promise<string> | undefined;

/** The share page's policy: the reader pages' closed one, plus `COPY_SCRIPT` by hash. */
function sharePolicy(): Promise<string> {
  scriptPolicy ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(COPY_SCRIPT))
    .then((digest) => {
      const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
      return `${READER_CSP}; script-src 'sha256-${hash}'; form-action 'self'`;
    });
  return scriptPolicy;
}

/** `/share/{docId}`, or null for any other path: no version, no extra segment. */
function shareRoute(pathname: string): string | null {
  const route = parseDocPath(pathname, SHARE_PREFIX);
  return route !== null && route.pinned === null ? route.docId : null;
}

export async function handleShare(
  request: Request,
  url: URL,
  env: Env,
  analytics: AnalyticsSink,
): Promise<Response> {
  const docId = shareRoute(url.pathname);
  const secret = readerSecret(env);
  const writing = request.method === "POST";
  if (docId === null || secret === null || (request.method !== "GET" && !writing)) return READER_NOT_FOUND();
  // Before the body or the session is read: a cross-site form changes nothing.
  if (writing && !sameOriginPost(request, url, true)) return READER_NOT_FOUND();

  const next = `${SHARE_PREFIX}/${docId}`;
  const accountId = await readSession(request, secret, Date.now());
  if (accountId === null) return signIn(env, next);
  const email = await accountEmail(env.DB, accountId);
  if (email === null) return signIn(env, next);

  // The session account as a publisher: its documents are everything in its
  // owner scope. A write asks for its current plan, refreshed like a bearer
  // write, because the gate depends on it; showing the page needs no plan, so a
  // visit makes no call to the license server.
  const principal: Publisher = {
    owner: accountId,
    plan: (await accountPlan(env, accountId, { skipAccountRefresh: !writing })).plan,
    authKind: "account",
  };
  const unavailable = () => notAvailablePage(email, docId, next);

  if (!writing) {
    const result = await getAccess(env, principal, docId);
    return result.ok
      ? await dialog(env, url, principal, docId, result.state, {
          notice: url.searchParams.get("notice") === "private",
        })
      : unavailable();
  }

  const form = await readSmallForm(request);
  if (form === null) return READER_NOT_FOUND();
  const result = await write(env, url, principal, docId, form, analytics);
  if (result === null) return READER_NOT_FOUND();
  if (result.ok) {
    // Post, redirect, get: a reload shows the page and repeats nothing.
    const switchedToPrivate = result.changed && form.get("op") === "link" && form.get("linkAccess") === "invited";
    return new Response(null, {
      status: 303,
      headers: {
        location: switchedToPrivate ? `${next}?notice=private` : next,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }
  if (result.refusal === "not_found") return unavailable();

  const state = await getAccess(env, principal, docId);
  if (!state.ok) return unavailable();
  return await dialog(env, url, principal, docId, state.state, { error: result.refusal });
}

/** Run the one operation a form names, or null when it names none. */
async function write(
  env: Env,
  url: URL,
  principal: Publisher,
  docId: string,
  form: URLSearchParams,
  analytics: AnalyticsSink,
): Promise<AccessResult | null> {
  const op = form.get("op");
  const address = form.get("email") ?? "";
  if (op === "link") {
    const mode = form.get("linkAccess");
    return mode === "anyone" || mode === "invited" ? await setMode(env, principal, docId, mode, analytics) : null;
  }
  if (op === "add") return await addPerson(env, url, principal, docId, address, undefined, analytics);
  if (op === "remove") return await removePerson(env, principal, docId, address, analytics);
  if (op === "decline") return await declineRequest(env, principal, docId, address);
  return null;
}

/** Why a write did not happen, in the words the page shows. */
type DialogError = Exclude<Extract<AccessResult, { ok: false }>["refusal"], "not_found">;

async function dialog(
  env: Env,
  requestUrl: URL,
  principal: Publisher,
  docId: string,
  state: AccessState,
  shown: { notice?: boolean; error?: DialogError },
): Promise<Response> {
  const action = `${SHARE_PREFIX}/${docId}`;
  const form = (op: string, fields: Record<string, string>, body: string, cls = "") =>
    `<form method="post" action="${action}"${cls ? ` class="${cls}"` : ""}>${hidden("op", op)}${Object.entries(fields)
      .map(([name, value]) => hidden(name, value))
      .join("")}${body}</form>`;
  const emailSent = emailConfigured(env);
  const mode = (value: "anyone" | "invited", label: string, hint: string) =>
    `<label class="choice"><input type="radio" name="linkAccess" value="${value}"${state.link_access === value ? " checked" : ""}><span><b>${label}</b><small>${hint}</small></span></label>`;

  const people = state.people
    .map(
      (person) =>
        `<li><span><b><bdi>${escapeHtml(person.email)}</bdi></b><small>${emailSent ? "Invited · email sent" : "Invited · send them the link"}</small></span>${form("remove", { email: person.email }, `<button type="submit">Remove</button>`)}</li>`,
    )
    .join("");
  const requests = state.requests.length
    ? `<section><h2>Requests</h2><ul>${state.requests
        .map(
          (request) =>
            `<li><span><b><bdi>${escapeHtml(request.email)}</bdi></b><small>Asked to open it</small></span><span class="pair">${form("add", { email: request.email }, `<button type="submit">Approve</button>`)}${form("decline", { email: request.email }, `<button type="submit">Decline</button>`)}</span></li>`,
        )
        .join("")}</ul></section>`
    : "";

  const message = await errorMessage(env, principal, shown.error);
  const url = publicDocUrl(env, requestUrl, docId);
  const detail = `<style>
main{width:min(100%,40rem)}h1{max-width:none;font-size:clamp(1.5rem,5vw,2.25rem);line-height:1.1}
section{margin-top:2rem}h2{margin:0 0 .75rem;color:#f4f5f7;font-size:1rem}
.err{color:#f6ae52}.err a{display:inline;margin:0}
ul{margin:0;padding:0;list-style:none}li{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.65rem 0;border-top:1px solid #20242c}
li span{display:flex;flex-direction:column}li .pair{flex-direction:row;gap:.5rem}small{display:block;color:#8d94a0}
form{margin:0}.choice{display:flex;gap:.75rem;align-items:flex-start;margin:0 0 .75rem;color:#e9ebee}.choice input{margin-top:.3rem;accent-color:#f6ae52}
button,input[type=email],input[readonly]{padding:.6rem 1rem;border:1px solid #2c313b;border-radius:.65rem;background:#07080b;color:#f4f5f7;font:inherit;cursor:pointer}
button:hover{border-color:#f6ae52;color:#f9c47f}input[type=email],input[readonly]{flex:1;min-width:0;cursor:text}
.row{display:flex;gap:.5rem}
</style>
${message === null ? "" : `<p class="err" role="alert">${message}</p>`}
${shown.notice === true ? `<p>${COPY_NOTICE}</p>` : ""}
<section><h2>Link access</h2>${form(
    "link",
    {},
    `${mode("anyone", "Anyone with the link", "Exactly today's public page. No sign-in.")}${mode("invited", "Only those invited", "Only people you add can open it. They sign in once.")}<button type="submit">Save</button>`,
  )}</section>
<section><h2>Add people</h2>${form(
    "add",
    {},
    `<div class="row"><input type="email" name="email" placeholder="Email address" aria-label="Email address" autocomplete="off" required><button type="submit">Add</button></div>`,
  )}</section>
${requests}
<section><h2>Who has access</h2><ul><li><span><b>You</b><small>Owner</small></span></li>${people}</ul></section>
<section><h2>Copy link</h2><div class="row"><input id="link" type="text" readonly value="${escapeHtml(url)}" aria-label="Link"><button id="copy" type="button">Copy</button></div></section>
<script>${COPY_SCRIPT}</script>`;

  return readerPage(
    {
      title: "Manage document",
      heading: `Manage “${escapeHtml(state.title)}”`,
      message: "Choose who can open it. The link never changes.",
      detail,
    },
    shown.error === undefined ? 200 : shown.error === "plan" ? 402 : 400,
    await sharePolicy(),
  );
}

/** The sentence for a refused write, with the upgrade link when the plan is why. */
async function errorMessage(env: Env, principal: Publisher, error: DialogError | undefined): Promise<string | null> {
  switch (error) {
    case undefined:
      return null;
    case "bad_email":
      return "That is not an email address.";
    case "full":
      return `A document can be shared with at most ${MAX_INVITES_PER_DOC} people.`;
    case "plan": {
      // The upgrade link the API's own `402` carries, already stripped of what
      // must not reach a checkout.
      const refusal = (await planRefusal(env, principal).json()) as { error?: { upgrade_url?: string } };
      const upgrade = refusal.error?.upgrade_url;
      return `Private sharing needs a paid plan. Nothing was changed.${
        upgrade === undefined ? "" : ` <a href="${escapeHtml(upgrade)}">Upgrade</a>`
      }`;
    }
  }
}
