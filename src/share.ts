/**
 * The share page: where an owner manages who can open one document.
 *
 * ```
 * GET  /share/{docId}   the dialog for a signed-in owner; Copy link for any other reader
 * POST /share/{docId}   one write: op=link | add | remove | decline
 * ```
 *
 * It is the dialog Copilot renders, served by the Worker, so it exists for
 * whoever published the document and for self-hosters. It lives on the API
 * host because the reader session does, and it is reached from the constant
 * **Share** link in every served page's top bar (the popover's fallback when
 * scripts do not run), from the request email, and from `share` output. The
 * document's origin can never see the owner's session, so the page cannot know
 * on the document whether its viewer is the owner; the link is therefore the
 * same for everyone, and the page decides who is looking.
 *
 * **Who sees what.** The owner gets the dialog. Anyone else who may already read
 * the document gets its title, a sentence saying only the owner can change who
 * can open it, and **Copy link**: a visitor with no session to a public document
 * (the title and url are what anyone holding the link has), and a signed-in
 * reader of a public or invited-only one. A visitor to anything else, whether
 * invited-only, unknown or deleted, gets the manage sign-in page, the same bytes
 * for all three, so the page tells a stranger nothing about an id. A signed-in
 * account that can neither manage nor read gets the not-available page `/open`
 * shows, never `403`. `?signin` asks a visitor to a public document for the
 * sign-in page, which is where **Is this your page? Sign in to manage** leads;
 * it only selects a page.
 *
 * **It writes through the same operations as `/api/v1`** (`api/access.ts`), with
 * the session account as the principal, so the plan gate, the invite email,
 * idempotency and the `document_access_changed` event cannot differ between the
 * two. Approving a request is `op=add`; declining is `op=decline`.
 *
 * **A write rides a cookie, so it is held to the strictest origin check**
 * (`sameOriginPost`). `GET` never writes and no query parameter changes state.
 *
 * **Roles.** Each person has a role from the ladder (`roles.ts`). The dialog
 * draws **Add people** only for an owner whose plan grants some role
 * (`grantableRoles`, the same list `Access.roles` carries), a select with an
 * **Update** button beside each person when it grants two or more (`op=role`,
 * the same `addPerson` with a role), and the role as plain text when it grants
 * none. A server without comments (`roles` undefined) draws no role at all.
 */
import { parseAddresses } from "./addresses.js";
import type { AnalyticsSink } from "./analytics.js";
import {
  addPerson,
  addWithoutManifest,
  declineRequest,
  getAccess,
  grantableRoles,
  type InviteDelivery,
  planRefusal,
  removePerson,
  setMode,
  withCurrentPlan,
  type AccessResult,
  type AccessState,
} from "./api/access.js";
import { readSmallForm } from "./approval/handler.js";
import type { Publisher } from "./auth.js";
import { MAX_INVITES_PER_DOC, MAX_NEW_INVITES_PER_OWNER_PER_DAY, type Env } from "./config.js";
import { accountEmail, findReadableDoc } from "./db.js";
import { COPILOT_HINT } from "./embed-scripts.js";
import { accountPlan } from "./entitlement.js";
import { sameOriginPost } from "./limits.js";
import { writeManifest } from "./manifest.js";
import { escapeHtml } from "./page.js";
import { upgradeUrl } from "./plans.js";
import { parseInviteRole } from "./roles.js";
import { SHARE_PREFIX, parseDocPath } from "./paths.js";
import { readerSecret } from "./reader-config.js";
import {
  hidden,
  notAvailablePage,
  READER_CSP,
  READER_NOT_FOUND,
  readerPage,
  useAnotherAccount,
} from "./reader-pages.js";
import { signIn } from "./reader.js";
import { readSession } from "./session.js";
import { publicDocUrl } from "./urls.js";

/**
 * Room for the longest list the page can be asked to add. At worst that is
 * `MAX_INVITES_PER_DOC` addresses of 254 characters each, every character a
 * three-byte one that form encoding turns into nine bytes: about 229 KB. The
 * rest is for separators and the names a mail client copies.
 */
const SHARE_FORM_BYTES = 256 * 1024;

/**
 * The Copy button's script and the Add people box's Enter key, small enough to
 * read in full. The page's policy
 * names its hash instead of allowing inline script, so this exact text is the
 * only script the page can run. Without it the page still works: the link is
 * selectable in a read-only field.
 */
const COPY_SCRIPT =
  'document.getElementById("copy").addEventListener("click",function(){' +
  'var field=document.getElementById("link");field.select();' +
  "var done=function(){document.getElementById(\"copy\").textContent=\"Copied\"};" +
  "if(navigator.clipboard){navigator.clipboard.writeText(field.value).then(done,function(){document.execCommand(\"copy\");done()})}" +
  'else{document.execCommand("copy");done()}});' +
  // Enter submits the Add people box, as it did when that was one line; Shift+Enter breaks the line.
  'var people=document.getElementById("people");if(people)people.addEventListener("keydown",function(e){' +
  'if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();people.form.requestSubmit()}});';

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

/**
 * The page's styles, shared by the owner's dialog and the reader's view so the
 * Copy link section looks the same on both. The dialog-only rules (lists,
 * radio choices, the add row) cost the reader view a few unused bytes.
 */
const SHARE_STYLE = `<style>
main{width:min(100%,40rem)}h1{max-width:none;font-size:clamp(1.5rem,5vw,2.25rem);line-height:1.1}
section{margin-top:2rem}h2{margin:0 0 .75rem;color:#f4f5f7;font-size:1rem}
.err{color:#f6ae52}.err a{display:inline;margin:0}
ul{margin:0;padding:0;list-style:none}li{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.65rem 0;border-top:1px solid #20242c}
li span{display:flex;flex-direction:column;min-width:0}li b{overflow-wrap:anywhere}li .pair{flex-direction:row;flex-shrink:0;gap:.5rem}small{display:block;color:#8d94a0}
form{margin:0}.choice{display:flex;gap:.75rem;align-items:flex-start;margin:0 0 .75rem;color:#e9ebee}.choice input{margin-top:.3rem;accent-color:#f6ae52}
form.pair{display:flex;gap:.5rem;align-items:center}select{padding:.6rem .5rem;border:1px solid #2c313b;border-radius:.65rem;background:#07080b;color:#f4f5f7;font:inherit}
button,textarea,input[readonly]{padding:.6rem 1rem;border:1px solid #2c313b;border-radius:.65rem;background:#07080b;color:#f4f5f7;font:inherit;cursor:pointer}
button:hover{border-color:#f6ae52;color:#f9c47f}textarea,input[readonly]{flex:1;min-width:0;cursor:text}textarea{resize:vertical}
.row{display:flex;gap:.5rem;align-items:flex-start}.hint{margin-top:1rem;font-size:.9rem}
</style>`;

/**
 * The Copy link section and the script that powers its button. Both views of
 * the page end with it, which is why the page's policy names that script's hash.
 */
const copyLinkSection = (url: string) =>
  `<section><h2>Copy link</h2><div class="row"><input id="link" type="text" readonly value="${escapeHtml(url)}" aria-label="Link"><button id="copy" type="button">Copy</button></div></section>
<script>${COPY_SCRIPT}</script>`;

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
  const email = accountId === null ? null : await accountEmail(env.DB, accountId);
  if (accountId === null || email === null) {
    // No one is signed in. A live public document shows Copy link, because
    // nothing on the page is more than its url and title, which anyone holds;
    // everything else, and anyone who asked to sign in, gets sign-in, the same
    // page for an invited-only, an unknown and a deleted id.
    if (!writing && !url.searchParams.has("signin")) {
      const found = await findReadableDoc(env.DB, docId, null, "");
      if (found !== null && found.deleted_at === null && found.link_access === "anyone") {
        return await readerView(env, url, docId, found.title, null);
      }
    }
    return signIn(env, next);
  }

  // The session account as a publisher: its documents are everything in its
  // owner scope. A visit reads the cached plan; the owner's view and every write
  // go by the current one (`withCurrentPlan`), so a reader never costs a
  // license-server call and the owner sees what the write gate will say.
  const cached: Publisher = {
    owner: accountId,
    plan: (await accountPlan(env, accountId, { skipAccountRefresh: true })).plan,
    authKind: "account",
  };
  const principal = writing ? await withCurrentPlan(env, cached) : cached;
  const unavailable = () => notAvailablePage(email, docId, next);

  if (!writing) {
    const result = await getAccess(env, principal, docId);
    if (result.ok) {
      return await dialog(env, url, await withCurrentPlan(env, principal), docId, result.state, {});
    }
    // Not the owner. A reader who may open the document sees its link, nothing
    // more; anyone else sees what `/open` shows them.
    const found = await findReadableDoc(env.DB, docId, null, accountId);
    return found !== null && found.deleted_at === null && found.allowed
      ? readerView(env, url, docId, found.title, email)
      : unavailable();
  }

  // Room for a pasted list as long as a document's people list may be.
  const form = await readSmallForm(request, SHARE_FORM_BYTES);
  if (form === null) return READER_NOT_FOUND();
  const found = form.get("op") === "add" ? parseAddresses(form.get("email") ?? "") : null;
  if (found !== null && found.emails.length + found.bad.length > 1) {
    return (await addMany(env, url, principal, docId, found, analytics)) ?? unavailable();
  }
  const result = await write(env, url, principal, docId, form, analytics);
  if (result === null) return READER_NOT_FOUND();
  if (result.ok) {
    if (result.state.inviteDelivery !== undefined) return await dialog(env, url, principal, docId, result.state, {});
    // Post, redirect, get: a reload shows the page and repeats nothing.
    return new Response(null, {
      status: 303,
      headers: {
        location: next,
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

/**
 * What a reader who is not the owner sees: the title, who can change access, and
 * **Copy link** (`publicDocUrl`, the canonical url whichever host the reader
 * came from). `email` is the signed-in reader, or null for a visitor to a public
 * document. A visitor is offered sign-in to manage; a signed-in reader is told
 * how to manage from Copilot, because an owner who published with a license key
 * that is not linked to a browser account looks like any other reader here, and
 * offered **Use another account** in case this one is the wrong one. It lists no
 * people, no mode and no requests.
 */
async function readerView(
  env: Env,
  requestUrl: URL,
  docId: string,
  title: string,
  email: string | null,
): Promise<Response> {
  const next = `${SHARE_PREFIX}/${docId}`;
  const actions =
    email === null
      ? `<div class="actions"><a href="${next}?signin">Is this your page? Sign in to manage</a></div>`
      // Back to the sign-in page, not the visitor view a public document
      // would otherwise show a reader who has just signed out.
      : `<div class="actions">${useAnotherAccount(`${next}?signin`)}</div>\n<p class="hint">${escapeHtml(COPILOT_HINT)}</p>`;
  return readerPage(
    {
      title: "Share document",
      heading: `Share “${escapeHtml(title)}”`,
      message: "Only the owner can change who can open this.",
      detail: `${SHARE_STYLE}\n${copyLinkSection(publicDocUrl(env, requestUrl, docId))}`,
      actions,
    },
    200,
    await sharePolicy(),
  );
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
  const raw = form.get("email") ?? "";
  // A lone address may arrive as `Name <a@x.com>`; the rest is `addMany`'s.
  const only = parseAddresses(raw);
  const address = op === "add" ? (only.emails[0] ?? only.bad[0] ?? "") : raw;
  if (op === "link") {
    const mode = form.get("linkAccess");
    return mode === "anyone" || mode === "invited" ? await setMode(env, principal, docId, mode, analytics) : null;
  }
  if (op === "add") return await addPerson(env, url, principal, docId, address, undefined, analytics);
  if (op === "role") {
    // A role this Worker does not know parses to null and changes nothing: it is never rewritten.
    const role = parseInviteRole(form.get("role"));
    return role === null ? null : await addPerson(env, url, principal, docId, address, role, analytics);
  }
  if (op === "remove") return await removePerson(env, principal, docId, address, analytics);
  if (op === "decline") return await declineRequest(env, principal, docId, address);
  return null;
}

/** Why a write did not happen, in the words the page shows. */
type DialogError = Exclude<Extract<AccessResult, { ok: false }>["refusal"], "not_found">;

/**
 * Several addresses pasted at once: `addWithoutManifest` for each, in order, inside the
 * one POST. A refusal that applies to every address (`plan`, `invite_quota`,
 * `full`) stops the batch and those already added stay added. Answers with the
 * dialog and one report instead of a redirect, because a redirect has no room
 * to say which addresses were not added; repeating the POST repeats nothing,
 * since an address already listed is fine. Null when the document is not the
 * session's to manage.
 */
async function addMany(
  env: Env,
  url: URL,
  principal: Publisher,
  docId: string,
  found: ReturnType<typeof parseAddresses>,
  analytics: AnalyticsSink,
): Promise<Response | null> {
  let added = 0;
  const sending: Promise<InviteDelivery>[] = [];
  let stop: DialogError | undefined;
  for (const address of found.emails) {
    // The batch snapshots the manifest once, after the loop.
    const result = await addWithoutManifest(env, url, principal, docId, address, undefined, analytics);
    if (result.ok) {
      added += 1;
      if (result.sending) sending.push(result.sending);
    }
    else if (result.refusal === "not_found") {
      await Promise.all(sending);
      return null;
    } else {
      stop = result.refusal;
      break;
    }
  }
  // Before the manifest, as for one person: a failed put cannot swallow them.
  const deliveries = await Promise.all(sending);
  if (added > 0) await writeManifest(env, docId);
  const state = await getAccess(env, principal, docId);
  if (!state.ok) return null;
  state.state.inviteDelivery = deliveries;
  const done = [
    ...(added > 0 ? [`Added ${added} ${added === 1 ? "person" : "people"}.`] : []),
    ...(found.bad.length > 0 ? [`Not added: ${found.bad.map((entry) => `${entry} (not an email address)`).join(", ")}.`] : []),
  ].map(escapeHtml);
  const why = stop === undefined ? null : await errorMessage(env, principal, stop);
  // "Nothing was changed" is not true of a batch that got part way.
  const report = [...done, ...(why === null ? [] : [done.length > 0 ? `Stopped: ${why.replace(" Nothing was changed.", "")}` : why])];
  return await dialog(env, url, principal, docId, state.state, { error: stop, report: report.join(" "), quiet: stop === undefined && found.bad.length === 0 });
}

async function dialog(
  env: Env,
  requestUrl: URL,
  principal: Publisher,
  docId: string,
  state: AccessState,
  shown: { error?: DialogError; report?: string; quiet?: boolean },
): Promise<Response> {
  const action = `${SHARE_PREFIX}/${docId}`;
  const form = (op: string, fields: Record<string, string>, body: string, cls = "") =>
    `<form method="post" action="${action}"${cls ? ` class="${cls}"` : ""}>${hidden("op", op)}${Object.entries(fields)
      .map(([name, value]) => hidden(name, value))
      .join("")}${body}</form>`;
  const mode = (value: "anyone" | "invited", label: string, hint: string) =>
    `<label class="choice"><input type="radio" name="linkAccess" value="${value}"${state.link_access === value ? " checked" : ""}><span><b>${label}</b><small>${hint}</small></span></label>`;

  // The roles this owner may grant now: undefined where the server has no comments (no role is drawn),
  // empty for a free or lapsed plan (roles as text, nobody can be added), else the options.
  const roles = grantableRoles(env, principal);
  const roleText = (role: string) => `Can ${escapeHtml(role)}`;
  const roleForm = (person: { email: string; role: string }) => {
    if (roles === undefined) return "";
    // A role the plan no longer grants is kept as its own option, so the owner can lower the person to one it
    // does. A role this Worker does not know, such as one a newer Worker stored, is text: it never writes it.
    const offered = parseInviteRole(person.role) === null ? [] : roles.some((role) => role === person.role) ? roles : [...roles, person.role];
    if (offered.length < 2) return `<span class="role">${roleText(person.role)}</span>`;
    return form(
      "role",
      { email: person.email },
      `<select name="role" aria-label="Access for ${escapeHtml(person.email)}">${offered
        .map((role) => `<option value="${escapeHtml(role)}"${role === person.role ? " selected" : ""}>${roleText(role)}</option>`)
        .join("")}</select><button type="submit">Update</button>`,
      "pair",
    );
  };
  const upgrade = upgradeUrl(env);
  const planLine =
    roles !== undefined && roles.length === 0
      ? `<p>Private pages and comments need a paid plan.${upgrade === undefined ? "" : ` <a href="${escapeHtml(upgrade)}">Upgrade</a>`}</p>`
      : "";
  const helper = roles?.includes("comment")
    ? `<p class="hint">${state.link_access === "anyone" ? "Anyone can view. Invitees can comment." : "Only people you add can open this page."}</p>`
    : "";
  // A lapsed or free owner adds nobody, and approving a request adds a person.
  const mayAdd = roles === undefined || roles.length > 0;

  const people = state.people
    .map(
      (person) =>
        `<li><span><b><bdi>${escapeHtml(person.email)}</bdi></b><small>${state.inviteDelivery?.find((d) => d.email === person.email)?.outcome === "sent" ? "Invite email sent" : state.inviteDelivery?.some((d) => d.email === person.email) ? "Invite email not sent · copy the link and send it yourself" : "Has access"}</small></span><span class="pair">${roleForm(person)}${form("remove", { email: person.email }, `<button type="submit">Remove</button>`)}</span></li>`,
    )
    .join("");
  const requests = state.requests.length
    ? `<section><h2>Requests</h2><ul>${state.requests
        .map(
          (request) =>
            `<li><span><b><bdi>${escapeHtml(request.email)}</bdi></b><small>Asked to open it</small></span><span class="pair">${mayAdd ? form("add", { email: request.email }, `<button type="submit">Approve</button>`) : ""}${form("decline", { email: request.email }, `<button type="submit">Decline</button>`)}</span></li>`,
        )
        .join("")}</ul></section>`
    : "";

  const message = shown.report ?? (await errorMessage(env, principal, shown.error));
  const url = publicDocUrl(env, requestUrl, docId);
  const detail = `${SHARE_STYLE}
${message === null ? "" : `<p${shown.quiet === true ? "" : ' class="err"'} role="alert">${message}</p>`}
<section><h2>Link access</h2>${form(
    "link",
    {},
    `${mode("anyone", "Anyone with the link", "Exactly today's public page. No sign-in.")}${mode("invited", "Only those invited", "Only people you add can open it. They sign in once.")}<button type="submit">Save</button>`,
  )}</section>
${planLine}
${mayAdd ? `<section><h2>Add people</h2>${form(
    "add",
    {},
    `<div class="row"><textarea id="people" name="email" rows="2" placeholder="Emails, separated by commas" aria-label="Email addresses" autocomplete="off" required></textarea><button type="submit">Add</button></div>`,
  )}${helper}</section>` : ""}
${requests}
<section><h2>Who has access</h2><ul><li><span><b>You</b><small>Owner</small></span></li>${people}</ul></section>
${copyLinkSection(url)}`;

  return readerPage(
    {
      title: "Manage document",
      heading: `Manage “${escapeHtml(state.title)}”`,
      message: "Choose who can open it. The link never changes.",
      detail,
    },
    shown.error === undefined ? 200 : shown.error === "plan" || shown.error === "plan_people" || shown.error === "plan_comments" ? 402 : shown.error === "invite_quota" ? 429 : 400,
    await sharePolicy(),
  );
}

/**
 * A plan refusal as a sentence with its upgrade link: the one the API's own
 * `402` carries, already stripped of what must not reach a checkout.
 */
async function upgradeSentence(lead: string, refusal: Response): Promise<string> {
  const upgrade = ((await refusal.json()) as { error?: { upgrade_url?: string } }).error?.upgrade_url;
  return `${lead} Nothing was changed.${upgrade === undefined ? "" : ` <a href="${escapeHtml(upgrade)}">Upgrade</a>`}`;
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
    case "invite_quota":
      return `You have added ${MAX_NEW_INVITES_PER_OWNER_PER_DAY} new people in the last 24 hours. Try again later. Nothing was changed.`;
    // The page offers neither to a plan that lacks them; this is a stale form or a forged one.
    case "plan_people":
    case "plan":
      return upgradeSentence("Private sharing needs a paid plan.", planRefusal(env, principal));
    case "plan_comments":
      return upgradeSentence("Letting people comment needs a paid plan.", planRefusal(env, principal, "Letting people comment", "comments"));
  }
}
