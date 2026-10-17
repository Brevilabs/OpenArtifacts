/**
 * The front-end code this service ships: the first in the repo, and plain
 * strings on purpose. There is no bundler, no transpiler and no dependency, so
 * what is reviewed here is byte for byte what a browser runs.
 *
 * Rules for every script in this file, kept so a constant can be embedded
 * anywhere without escaping: plain ES2021, no backtick and no `${` inside (a
 * template literal here is `String.raw`, and either would end or interpolate
 * it), and no backslash (`String.raw` keeps it, but a reader should not have to
 * know that to read the script).
 */
import { PAGE_COMMENTS_SCRIPT } from "./comments-scripts.js";

/**
 * The script every served page loads, from `https://{API_HOST}/embed/page.js`
 * (`src/embed.ts`). It turns the top bar's **Share** link into a popover: a
 * frame on the API host, drawn under the button.
 *
 * It runs inside the publisher's page, so it is written as the least trusting
 * code on that page can be. It defines no global, binds only our own link, reads
 * no cookie and no storage, holds no credential, and sends the Share frame nothing.
 * The frame is the thing that holds a credential, and it is a frame precisely
 * because the credential that changes who can read a document must never be on
 * a page whose scripts the author writes.
 *
 * Behaviour this fixes:
 *
 * - The frame is created on the first sign of **intent**: the pointer entering
 *   Share, Share taking focus, or the click itself. It is built hidden, so the
 *   click usually finds it loaded, and a page view with no pointer or focus on
 *   Share costs no frame request. It is then hidden and shown, **never
 *   reloaded**. A mode switch made inside it can therefore not re-run the
 *   frame's `frame-ancestors` check against the page it is on.
 * - The popover lives in a closed shadow root, so author CSS such as
 *   `iframe { display: none }` and author code such as
 *   `querySelectorAll("iframe")` cannot reach it. It hangs off `<html>`, not
 *   `<body>`, so a transformed or flex body cannot move it.
 * - Modified clicks (a new tab, a new window) keep the plain link.
 * - If the frame never says `ready` within four seconds (an author `frame-src`
 *   policy, the network), the popover shows the plain share-page link instead.
 * - If the author's own CSP blocks this script, nothing runs and Share is the
 *   plain `target="_blank"` link the design requires.
 * - Messages are accepted only from that iframe's window and the API origin,
 *   and carry no credential in either direction.
 * - The popover is **one fixed height** for every viewer (320 px, less on a
 *   short viewport) and the frame scrolls inside it. 320 is the tallest form of
 *   the owner view with nobody added, plus a small margin: measured in Chrome at
 *   the popover's 360 px width, a free owner's plan line and refusal after a
 *   failed switch, with their Upgrade links, is 309 px (public and private 307,
 *   the plan line alone 259). So an owner who has added nobody sees everything
 *   without a scrollbar, and a list of people scrolls. A change to the owner
 *   view or `FRAME_CSS` that makes it taller fails the browser test that holds
 *   this. The frame never reports its size: on a public document any page on
 *   `openartifacts.site` can embed the same frame for any document it knows,
 *   and the height of what the frame draws (owner controls, a list of people, or
 *   just Copy link) would tell that page, with no click, whether its visitor
 *   manages the document.
 *
 * The URL it is served from is permanent: pinned `/v{n}` pages carry the tag for
 * a year. A fix to this script reaches them by the route's short cache, not by a
 * new address.
 *
 * **Comments are the second half** (`PAGE_COMMENTS_SCRIPT`, `src/comments-scripts.ts`,
 * joined here so both share `api`, `docId` and `link`). It is inert when the bar says
 * the document has no comments to show, and otherwise unless its threads resource answers, adds a Comments button to the bar and a
 * comments frame on the API host (a sidebar, or a bottom sheet), and holds no credential either: everything above about what
 * the page script holds is true of it too. It reads the Share half's `api`,
 * `docId`, `link` and `viewport` and changes none of them, and closes its own
 * sheet when Share is pressed.
 */
export const PAGE_SCRIPT = String.raw`(() => {
  "use strict";
  const script = document.currentScript;
  const link = document.querySelector("a[data-openartifacts-share]");
  if (!script || !link || link.getAttribute("data-openartifacts-share") === "bound") return;
  let api, target;
  try { api = new URL(script.src).origin; target = new URL(link.href); } catch { return; }
  const parts = target.pathname.split("/");
  if (target.origin !== api || parts.length !== 3 || parts[1] !== "share" || !/^[0-9a-z]{16}$/.test(parts[2])) return;
  const docId = parts[2];
  link.setAttribute("data-openartifacts-share", "bound");
  link.setAttribute("aria-haspopup", "dialog");
  link.setAttribute("aria-expanded", "false");
  let host = null, frame = null, fallback = null, timer = 0, ready = false, open = false;
  // Set by the comment half: the owner just clicked in the popover (added a person, changed a role, or closed it).
  let commentsSwitched = null;
  // The layout viewport, which a classic scrollbar narrows (innerWidth and 100vw
  // include it). documentElement.clientWidth is the viewport only in standards
  // mode; in quirks mode (publisher HTML with no doctype) it is the <html> box
  // itself, and the viewport is <body>'s.
  const viewport = () => (document.compatMode === "BackCompat" && document.body ? document.body : document.documentElement);
  const place = () => {
    const box = link.getBoundingClientRect();
    const view = viewport();
    // 8 px clear of the bar when Share is on one (the bar's own hairline would
    // otherwise sit 2 px above the popover's ring), of Share itself otherwise.
    const bar = link.closest(".openartifacts-bar");
    const top = Math.round((bar ? bar.getBoundingClientRect() : box).bottom + 8);
    const width = Math.min(360, view.clientWidth - 16);
    // Anchored by the left edge to Share's right edge, then kept on screen, so it
    // opens in view wherever Share sits.
    host.style.width = width + "px";
    host.style.top = top + "px";
    host.style.left = Math.round(Math.max(8, Math.min(box.right - width, view.clientWidth - width - 8))) + "px";
    host.style.height = Math.max(120, Math.min(320, view.clientHeight - top - 8)) + "px";
  };
  const build = () => {
    host = document.createElement("div");
    host.className = "openartifacts-share-popover";
    host.setAttribute("style", "all:initial;position:fixed;z-index:2147483647;display:none;box-sizing:border-box;direction:ltr;border-radius:14px;background:#0d0f14;box-shadow:0 12px 32px rgba(0,0,0,.35),0 2px 6px rgba(0,0,0,.25),0 0 0 1px rgba(255,255,255,.14);overflow:hidden");
    const root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
    frame = document.createElement("iframe");
    frame.title = "Share";
    frame.setAttribute("allow", "clipboard-write");
    frame.setAttribute("style", "display:block;width:100%;height:100%;border:0;background:#0d0f14;color-scheme:dark");
    frame.src = api + "/embed/share?doc=" + docId + "&origin=" + encodeURIComponent(window.location.origin);
    fallback = document.createElement("a");
    fallback.href = link.href;
    fallback.target = "_blank";
    fallback.rel = "noopener noreferrer";
    fallback.textContent = "Open sharing settings";
    fallback.setAttribute("style", "display:none;padding:16px;font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f6ae52;text-underline-offset:3px");
    root.append(frame, fallback);
    document.documentElement.append(host);
  };
  const show = () => {
    if (host === null) build();
    open = true;
    place();
    host.style.display = "block";
    link.setAttribute("aria-expanded", "true");
    if (ready) frame.focus();
    else timer = window.setTimeout(() => { if (!ready) { frame.style.display = "none"; fallback.style.display = "block"; } }, 4000);
  };
  const hide = (refocus) => {
    if (!open) return;
    open = false;
    window.clearTimeout(timer);
    host.style.display = "none";
    link.setAttribute("aria-expanded", "false");
    if (refocus) link.focus();
  };
  // Intent to press Share (the pointer on it, or focus) builds the frame, hidden,
  // so the click finds it loaded. Once built, these do nothing.
  const intent = () => { if (host === null) build(); };
  link.addEventListener("pointerenter", intent);
  link.addEventListener("focus", intent);
  link.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (open) hide(false); else show();
  });
  window.addEventListener("message", (event) => {
    if (frame === null || event.source !== frame.contentWindow || event.origin !== api) return;
    const data = event.data;
    if (data === null || typeof data !== "object" || data.type !== "openartifacts:share") return;
    if (data.event === "ready") {
      ready = true;
      window.clearTimeout(timer);
      fallback.style.display = "none";
      frame.style.display = "block";
      if (open) frame.focus();
    } else if (data.event === "close") hide(true);
    else if (data.event === "people" && commentsSwitched) commentsSwitched();
  });
  document.addEventListener("keydown", (event) => { if (open && event.key === "Escape") hide(true); }, true);
  document.addEventListener("pointerdown", (event) => { if (open && event.target !== host && !link.contains(event.target)) hide(false); }, true);
  window.addEventListener("resize", () => { if (open) place(); });
` +
  PAGE_COMMENTS_SCRIPT +
  "})();\n";

/**
 * What the owner of a Copilot-published page sees when their license key is not
 * linked to a browser account: they can sign in to the popover, but the account
 * that signs in does not own the page. A constant sentence, so it says nothing
 * about the document. The frame receives it in a `data-` attribute rather than
 * holding its own copy.
 */
export const COPILOT_HINT =
  "Published from Copilot? Open the note in Copilot and run Publish file to OpenArtifacts to manage who can open it.";

/**
 * The popup's done page script (`popupDonePage`): when the popup still has its
 * opener, post the token to it, then close. A constant, named by its hash in
 * the page's policy; the token and the document id come from `data-` attributes
 * of one element, so nothing is interpolated into script.
 *
 * The target origin is this page's own, never `*`: the only frame that may act
 * on the message is the Share frame, which is on the API host, and it checks
 * the sender's window as well. Embedded in a document page there is no opener
 * to post to: the page around the frame sends no opener policy and this one
 * sends `same-origin`, so Chrome opens the popup in a new browsing context group
 * (and Google's sign-in pages, probably, cut the link the same way). The frame
 * collects its token from the server in that case, and this script costs
 * nothing. The message lands only when the frame is a top-level page, which
 * `test/share-popover.browser.mjs` checks alongside the poll.
 */
export const POPUP_DONE_SCRIPT = String.raw`(function () {
  var done = document.getElementById("oa-done");
  try {
    if (window.opener) {
      window.opener.postMessage({ type: "openartifacts:share-token", doc: done.dataset.doc, token: done.dataset.token, expiresAt: Number(done.dataset.expires) }, location.origin);
    }
  } catch (error) {}
  window.close();
})();`;

/**
 * The popover frame's stylesheet (`src/embed.ts` puts it in the shell). The
 * frame fills the popover's fixed height, whatever it shows: nothing here sizes
 * the popover to its content.
 *
 * **Layout.** Two parts, the same in every view. The `header` is the row every
 * view starts with: the link field, **Copy link** and the × close button. It is
 * the primary action, so it never scrolls away, and it is part of the shell, not
 * of any view, so nothing a view draws can move it. `main` under it is the one
 * scroll region; nothing inside it scrolls on its own. The row gets its hairline
 * divider only while content is scrolled under it (`body.scrolled`), and the
 * `.fade` over the foot of the frame shows only while there is more below
 * (`body.more`), both set by the frame script. There is no title row.
 *
 * **The link field** always shows the end of the link, `/d/{id}`, and as much
 * of the host before it as fits: its text runs right to left inside an LTR
 * isolate (`<bdi>`), so the ellipsis takes the start of the host, and a click
 * still selects the whole link. Copy link is an icon, with its label kept for
 * assistive technology, because with a worded button the id alone would not fit
 * at the popover's 360 px width, let alone 304.
 *
 * **Height.** One for every viewer (see `PAGE_SCRIPT`), set so that the owner
 * view with nobody added, in each of its forms (public, private, a free
 * owner's plan line, the refusal after a failed switch), shows whole without a
 * scrollbar; a list of people scrolls. The short views (signed out, a reader,
 * not found) pin `.bottom` (the account line and the hint) to the floor above a
 * divider, so the room between reads as layout.
 *
 * **Loading.** `main` is `hidden` in the shell until the script has chosen the
 * first view, so a token holder's frame never paints the signed-out markup.
 * The skeleton (`.sk`) holds the owner view's places with muted blocks and pulses,
 * except under reduced motion. The helper line (`.help`) holds two lines in both,
 * since the public one wraps to two, so nothing under it moves when the owner
 * view lands (a free owner's plan line, which takes its place, still does).
 *
 * Flex items do not collapse margins, so spacing is set in the margins, not the
 * structure. Children of `main` never shrink: an item with its own overflow rule
 * has no content minimum, so it would squash to a line instead of `main`
 * scrolling.
 *
 * Dark only, in the reader pages' palette (`src/page.ts`): surface `#0d0f14`,
 * wells `#07080b`, borders `#20242c` and `#2c313b`, text `#e9ebee`, muted
 * `#8d94a0` (6.2:1 on the surface), accent `#f6ae52`. System fonts: the frame
 * fetches nothing, and its policy would not let it.
 */
export const FRAME_CSS = `:root{color-scheme:dark;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#e9ebee;background:#0d0f14;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;display:flex;flex-direction:column}
body::before{content:"";position:fixed;top:0;left:0;right:0;height:1px;background:rgba(255,255,255,.06);z-index:3;pointer-events:none}
header{flex:none;position:relative;z-index:2;display:flex;align-items:center;gap:8px;padding:16px 12px 12px 16px;background:#0d0f14}
body.scrolled header{box-shadow:0 1px 0 #20242c,0 8px 10px -6px rgba(0,0,0,.6)}
main{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;padding:4px 16px 16px;scrollbar-color:#2c313b transparent;scrollbar-width:thin}
main[hidden]{display:none}
main>*{flex-shrink:0}main>:first-child{margin-top:0}
.fade{position:fixed;left:0;right:0;bottom:0;z-index:1;height:28px;background:linear-gradient(to bottom,rgba(13,15,20,0),#0d0f14 85%);pointer-events:none;opacity:0}
body.more .fade{opacity:1}
:focus-visible{outline:2px solid #f6ae52;outline-offset:2px}
h2{margin:16px 0 2px;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#8d94a0}
p{margin:8px 0 0}
.muted{color:#8d94a0}.help{min-height:3em}.err{margin-top:8px;color:#ff8a80}.err.warn{color:#f6ae52}.err:empty{display:none}
a{color:#f6ae52;text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px}
button{font:inherit;font-size:13px;font-weight:500;line-height:1;cursor:pointer;height:28px;padding:0 12px;border:1px solid #2c313b;border-radius:8px;background:transparent;color:#e9ebee;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
button:hover{border-color:#3a404b;background:rgba(255,255,255,.04)}
button:disabled{cursor:default;opacity:.5}button:disabled:hover{border-color:#2c313b;background:transparent}
button.primary{background:#f4f5f7;border-color:#f4f5f7;color:#0b0c10;font-weight:600}
button.primary:hover{background:#fff;border-color:#fff}
.row input:placeholder-shown+button.primary{background:transparent;border-color:#2c313b;color:#e9ebee}
.row input:placeholder-shown+button.primary:hover{background:rgba(255,255,255,.04);border-color:#3a404b}
button.tall{height:36px;padding:0 14px;border-radius:10px;font-size:14px}
button.link{display:inline;height:auto;padding:0;border:0;background:none;color:#f6ae52;font-size:inherit;font-weight:inherit;line-height:inherit;white-space:normal}
button.link.block{display:block;margin-top:2px}
button.link:hover{background:none;text-decoration:underline;text-underline-offset:3px}
header button.primary{width:36px;padding:0}header button.primary span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
header .x{flex:none;width:28px;padding:0;border:0;font-size:20px;font-weight:400;color:#8d94a0}
header .x:hover{background:rgba(255,255,255,.06);color:#f4f5f7}
header svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.field{flex:1;min-width:0;display:flex;align-items:center;height:36px;padding:0 12px;border:1px solid #20242c;border-radius:10px;background:#07080b;color:#c9ced6;font:12.5px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.field>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:all;direction:rtl;text-align:left}
select{font:inherit;font-size:13px;height:28px;padding:0 6px;border:1px solid #2c313b;border-radius:8px;background:#07080b;color:#e9ebee;cursor:pointer}
select:hover{border-color:#3a404b}
input{font:inherit;flex:1;min-width:0;height:36px;padding:0 12px;border:1px solid #20242c;border-radius:10px;background:#07080b;color:#e9ebee}
input::placeholder{color:#5b626e}
input:focus-visible{outline:0;border-color:#f6ae52;box-shadow:0 0 0 3px rgba(246,174,82,.18)}
.row{display:flex;gap:8px;align-items:center}main>.row{margin-top:12px}
.seg{display:flex;gap:2px;height:36px;padding:3px;border:1px solid #20242c;border-radius:10px;background:#07080b}
.seg button{flex:1;height:28px;border:0;border-radius:7px;color:#8d94a0;background:transparent}
.seg button:hover{color:#e9ebee;background:transparent}
.seg button[aria-checked="true"]{background:#20242c;color:#f4f5f7}
.seg button:focus-visible{outline-offset:0}
ul{list-style:none;margin:0;padding:0}
li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid #1a1d24}
h2+ul>li:first-child{border-top:0}
li span{flex:1;min-width:0;overflow-wrap:anywhere}li .row{margin-left:auto;flex:none}li small{display:block;font-size:12px;color:#8d94a0}
li button.link{font-size:12px;color:#8d94a0}li button.link:hover{color:#e9ebee}
.sk{border-color:transparent;background:#171a21;animation:pulse 1.6s ease-in-out infinite}
i.sk{display:inline-block;height:10px;border-radius:5px;vertical-align:middle}
.sk-in{flex:1;height:36px;border-radius:10px}.sk-add{width:58px;height:36px;border-radius:10px}
@keyframes pulse{50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){.sk{animation:none}}
.bottom{margin-top:auto;padding-top:12px;border-top:1px solid #20242c;font-size:13px;overflow-wrap:anywhere}
.bottom p{margin:0}.bottom .err{margin:0 0 8px}.bottom .hint{margin-top:8px;font-size:12.5px}
`;

/**
 * The Share popover frame's script (`GET /embed/share`). The frame is on the API
 * host, inside a page whose scripts the author writes, so it is written as the
 * least trusting code can be: DOM built only with `createElement` and
 * `textContent` (never `innerHTML` with data), no `<form>` elements, Enter
 * handled in script.
 *
 * **What it holds.** A per-document token (`oas_…`, 24 hours) in the frame's own
 * `localStorage`, obtained from a popup. Frames live where cookies are blocked
 * or partitioned, so the credential is a bearer header on same-origin `fetch`
 * with `credentials: "omit"`, accepted only by `/embed/api/docs/{docId}/access…`.
 *
 * **What it tells the page around it.** Only `ready`, once, before it touches
 * storage, `close`, only from a user action in the frame (the × button or
 * Escape), and `people`, only after the owner's own click inside the owner view
 * (an add, a role change, or × / Escape, the last only where the plan grants Can
 * comment): it says this visitor is the owner, so it
 * is never sent when a view is drawn. Nothing the frame sends, and nothing it does that an embedding page
 * can observe (a size change, a focus move), depends on what is in storage. On a
 * public document any page on `openartifacts.site` can embed this frame for any
 * document it knows, and the stored token lives in the partition that page
 * shares, so anything token-dependent would tell it, with no click, whether its
 * visitor manages that document. So there is no size report (the popover is one
 * fixed height), no `ResizeObserver`, no `autofocus`, and no `focus()` except
 * inside a handler for a user action.
 *
 * **Its first view** is chosen synchronously, before `main` (hidden in the
 * shell) is shown: no stored token is the signed-out view, a stored token is the
 * skeleton, which only the access read's answer replaces (the owner, reader or
 * not-found view, or the signed-out view after a `401`). A token that arrives
 * while the signed-out view is up (a sign-in completing) shows the skeleton too.
 * So a token holder never sees the signed-out view first, and the skeleton,
 * which has no focusable element, changes nothing the embedding page can see.
 *
 * **Its one inbound channel** is a single `message` listener for the token the
 * sign-in popup may post. It acts only on a message from the window its own
 * `window.open` returned, from this origin, for this document; a message from
 * the embedding page or any other window does nothing.
 *
 * **Signing in.** Before opening the popup it makes a random nonce only it
 * knows and puts the nonce's SHA-256 in the popup's address. The popup, once it
 * has a session, stores a one-minute, one-use handoff under that hash on the
 * server. The frame claims it with the nonce itself (`POST /embed/token`), by
 * polling, and also when its tab becomes visible again. Polling is the path that
 * always works, because every API-host page sends a cross-origin opener policy
 * and the popup's link to the frame is usually severed. When that link survives,
 * the popup also posts the token, and the frame accepts it through the listener
 * above, but only from the window it opened.
 */
export const FRAME_SCRIPT = String.raw`(() => {
  "use strict";
  // No id on <main>: it scrolls (overflow:auto), and a scroll container is
  // focusable, but only when its content overflows, which differs by view.
  const main = document.querySelector("main");
  // The row above main gets its divider only while content is under it, and the
  // fade at the foot shows only while there is more below. Every view is drawn
  // into main, so its content changing, a scroll and a resize (the popover shown)
  // are all that move either edge.
  const edges = () => {
    document.body.classList.toggle("scrolled", main.scrollTop > 0);
    document.body.classList.toggle("more", main.scrollTop + main.clientHeight < main.scrollHeight - 1);
  };
  main.addEventListener("scroll", edges);
  window.addEventListener("resize", edges);
  new MutationObserver(edges).observe(main, { childList: true, subtree: true, characterData: true });
  const doc = main.dataset.doc;
  const link = main.dataset.link;
  const parentOrigin = main.dataset.origin;
  // Where a public document is served. A frame embedded there while the document
  // is public is one any page on that origin could have embedded.
  let publicOrigin = "";
  try { publicOrigin = new URL(link).origin; } catch (error) {}
  const hint = main.dataset.hint;
  const KEY = "openartifacts:share-token:" + doc;
  const SIGNIN_WINDOW_MS = 10 * 60 * 1000;
  const SENTENCE = "Only the owner can change who can open this.";

  const post = (event) => {
    if (parentOrigin && window.parent !== window) window.parent.postMessage({ type: "openartifacts:share", event: event }, parentOrigin);
  };
  post("ready");

  const node = (tag, attrs, kids) => {
    const element = document.createElement(tag);
    for (const name of Object.keys(attrs || {})) {
      const value = attrs[name];
      if (value === null) continue;
      if (name.startsWith("on")) element.addEventListener(name.slice(2), value);
      else element.setAttribute(name, value);
    }
    for (const kid of kids || []) element.append(kid);
    return element;
  };
  const button = (label, onclick, cls) => node("button", { type: "button", class: cls || "", onclick: onclick }, [label]);

  let memory = null;
  const readToken = () => {
    let raw;
    try { raw = window.localStorage.getItem(KEY); } catch (error) { raw = memory; }
    if (raw === null || raw === undefined) return null;
    try {
      const value = JSON.parse(raw);
      if (value && typeof value.token === "string" && typeof value.expiresAt === "number" && value.expiresAt - Date.now() >= 60000) return value;
    } catch (error) {}
    return null;
  };
  const writeToken = (value) => {
    memory = value === null ? null : JSON.stringify(value);
    try {
      if (value === null) window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, memory);
    } catch (error) {}
  };

  const bytesToBase64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const bytesToHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  // Icons are built with createElementNS, never from markup. Their look (size,
  // stroke) is in the stylesheet, so the shell's static copy and these match.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const LINK_ICON = ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"];
  const CHECK_ICON = ["M20 6 9 17l-5-5"];
  const icon = (paths) => {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  };
  const copyLabel = (target, paths, text) => target.replaceChildren(icon(paths), node("span", {}, [text]));
  const copyLink = (target) => {
    const done = () => {
      copyLabel(target, CHECK_ICON, "Copied");
      window.setTimeout(() => copyLabel(target, LINK_ICON, "Copy link"), 2000);
    };
    const fallback = () => {
      const area = node("textarea", { readonly: "", style: "position:fixed;opacity:0" });
      area.value = link;
      document.body.append(area);
      area.select();
      try { if (document.execCommand("copy")) done(); } catch (error) {}
      area.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, fallback);
    else fallback();
  };
  // The owner view is the only one with the Link access control. Leaving it is a click or a key inside
  // the frame, so it may say that this visitor is the owner (see the header comment), but only an
  // owner whose plan grants Can comment: a free owner's page has no comments to bring up. Leaving
  // any other view says nothing more than close.
  let grantsComment = false;
  // The owner view is showing the plan line: coming back to the tab reads it again.
  let upgradeShown = false;
  const leave = () => { post("close"); if (grantsComment && main.querySelector("[role=radiogroup]")) post("people"); };
  const closeButton = (target) => target.addEventListener("click", leave);
  const copyButton = (target) => target.addEventListener("click", () => copyLink(target));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") leave(); });

  const guest = Array.from(main.children);
  const account = document.getElementById("oa-account");
  // Found by position, not by id. An id a view has and another lacks is a fragment
  // an embedding page can navigate the frame to (a URL fragment), and whether the
  // browser then focuses something shows as a blur on that page: a read of
  // storage it has no right to. A focusable element carries no id at all, even one
  // every view has: where it sits can differ by view, and a focus move scrolls
  // the embedding page by that difference.
  const signInButton = account.querySelector("button");
  const guestMessage = document.getElementById("oa-msg");
  // The row above main (the link, Copy link and ×) is the shell's, the same in
  // every view, so it is wired once and never redrawn.
  closeButton(document.querySelector("header .x"));
  copyButton(document.querySelector("header .primary"));

  let prepared = null;
  let opened = null;
  let generation = 0;
  let wake = null;
  let writing = false;
  // Whether this frame made the document private. See exposed().
  let switched = false;
  let latest = null;
  let message = null;
  // Orders reads against writes. Each refresh takes a number and is applied only
  // if no later refresh or write has started, so an older GET resolving after a
  // write cannot redraw the document as it was. A refresh asked for while a write
  // is in flight waits for it (deferred), because it could read from before the
  // write lands.
  let seq = 0;
  let deferred = false;

  const prepare = () => {
    const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce)).then((digest) => {
      prepared = { nonce: nonce, h: bytesToHex(new Uint8Array(digest)) };
      signInButton.disabled = false;
    });
  };

  const showGuest = (text, waiting) => {
    main.replaceChildren(...guest);
    // The button stays while waiting: the popup may have been closed, the done page
    // reached after the handoff row expired, or an overlapping sign-in may have
    // failed at the login binding, and pressing it again is the way out of each.
    // It starts a new poll, which replaces this one.
    account.replaceChildren(...(waiting ? ["Complete sign-in in the window that opened. ", signInButton] : ["Is this your page? ", signInButton]));
    signInButton.disabled = prepared === null;
    guestMessage.replaceChildren(...(text ? [text] : []));
  };

  const accept = (token, expiresAt) => {
    generation += 1;
    wake = null;
    writeToken({ token: token, expiresAt: expiresAt });
    refresh();
  };

  const claim = async (nonce, mine) => {
    try {
      const response = await fetch("/embed/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: doc, nonce: nonce }), credentials: "omit", cache: "no-store" });
      if (mine !== generation || response.status !== 200) return false;
      const body = await response.json();
      if (typeof body.token !== "string" || typeof body.expiresAt !== "number") return false;
      accept(body.token, body.expiresAt);
      return true;
    } catch (error) {
      return false;
    }
  };

  const poll = (nonce) => {
    generation += 1;
    const mine = generation;
    const deadline = Date.now() + SIGNIN_WINDOW_MS;
    let timer = 0;
    let busy = false;
    const tick = async () => {
      if (busy || mine !== generation) return;
      window.clearTimeout(timer);
      if (Date.now() > deadline) {
        wake = null;
        // A token that arrived another way has already replaced this view.
        if (readToken() === null) showGuest("", false);
        return;
      }
      busy = true;
      const found = await claim(nonce, mine);
      busy = false;
      if (!found && mine === generation) timer = window.setTimeout(tick, 2000);
    };
    timer = window.setTimeout(tick, 1000);
    wake = () => { if (mine === generation && document.visibilityState === "visible") tick(); };
  };
  // Back on this tab after the Upgrade link's checkout in another: an owner shown the plan line reads the view again.
  document.addEventListener("visibilitychange", () => {
    if (wake) wake();
    else if (upgradeShown && document.visibilityState === "visible") refresh();
  });
  window.addEventListener("focus", () => { if (wake) wake(); });

  const signIn = (fresh) => {
    const taken = prepared;
    if (taken === null) return;
    prepared = null;
    signInButton.disabled = true;
    prepare();
    if (fresh) writeToken(null);
    const popup = window.open("/embed/sign-in?doc=" + doc + "&h=" + taken.h + (fresh ? "&switch=1" : ""), "_blank", "popup,width=480,height=720");
    opened = popup;
    if (popup === null) {
      showGuest("", false);
      guestMessage.replaceChildren("Your browser blocked the sign-in window. Allow pop-ups for this page, or ", node("a", { href: location.origin + "/share/" + doc, target: "_blank", rel: "noopener noreferrer" }, ["open the share page"]), ".");
      return;
    }
    showGuest("", true);
    poll(taken.nonce);
  };
  signInButton.addEventListener("click", () => signIn(false));

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (opened === null || event.source !== opened || event.origin !== location.origin) return;
    if (data === null || typeof data !== "object" || data.type !== "openartifacts:share-token" || data.doc !== doc) return;
    if (typeof data.token !== "string" || typeof data.expiresAt !== "number") return;
    accept(data.token, data.expiresAt);
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    // A token written by another tab ends this frame's own poll, which would
    // otherwise keep claiming for the rest of its window.
    if (readToken() !== null) { generation += 1; wake = null; }
    refresh();
  });

  const call = (method, path, body) => {
    const stored = readToken();
    if (stored === null) return Promise.resolve(null);
    const headers = { authorization: "Bearer " + stored.token };
    if (body) headers["content-type"] = "application/json";
    return fetch("/embed/api/docs/" + doc + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: "omit", cache: "no-store" });
  };

  const muted = (kids) => node("p", { class: "muted" }, kids);
  const bottom = (kids) => node("div", { class: "bottom" }, kids);
  const anotherAccount = (lead, stacked) => muted([lead, button("Use another account", () => signIn(true), stacked ? "link block" : "link")]);
  const hintLine = () => node("p", { class: "muted hint" }, [hint]);

  const showReader = (body) => {
    main.replaceChildren(muted([SENTENCE]), bottom([anotherAccount("Signed in as " + body.account + ".", true), hintLine()]));
  };
  const showNone = () => {
    main.replaceChildren(muted([SENTENCE]), bottom([anotherAccount("Is this your page? "), hintLine()]));
  };
  // While a stored token's read is out: the owner view's places, held by muted
  // blocks, under the real row. Only the answer replaces it (owner, reader, not
  // found, or the signed-out view after a 401), never the signed-out view first.
  const showSkeleton = () => {
    const bar = (width) => node("i", { class: "sk", style: "width:" + width });
    main.replaceChildren(
      node("div", { class: "seg sk" }),
      node("div", { class: "row" }, [node("div", { class: "sk sk-in" }), node("div", { class: "sk sk-add" })]),
      node("p", { class: "help" }, [bar("85%")]),
      node("h2", {}, [bar("96px")]),
      node("ul", {}, [node("li", {}, [node("span", {}, [bar("32px"), node("small", {}, [bar("48px")])])])]),
    );
  };

  const fail = (target, response, body, what) => {
    if (response.status === 402) {
      const kids = [(what || "Private sharing needs a paid plan.") + " Nothing was changed."];
      const upgrade = body && body.error ? body.error.upgrade_url : undefined;
      if (typeof upgrade === "string" && upgrade.startsWith("https://")) kids.push(" ", node("a", { href: upgrade, target: "_blank", rel: "noopener noreferrer" }, ["Upgrade"]));
      target.replaceChildren(...kids);
    } else if (response.status === 400 || response.status === 429) {
      target.textContent = body && body.error && typeof body.error.message === "string" ? body.error.message : "Something went wrong. Nothing was changed.";
    } else {
      target.textContent = "Something went wrong. Nothing was changed.";
    }
  };

  // The document's frame-ancestors is checked once, when this frame loads, so a
  // page that embedded the frame while the document was public keeps it alive
  // after the document goes private, and the owner's token in this origin's
  // storage would draw controls under that page. A frame on the public serving
  // origin therefore never draws the full owner view of an invited-only document.
  // Any such frame draws a constant line, never a reload, which the embedding page
  // could see, except one that switched the document itself, which draws the
  // limited view (see limited()).
  //
  // Having switched is not proof that the owner's own page is the embedder: a
  // hostile public page can lay this frame invisibly over its content and trick
  // the owner into one click on "Only those invited", and the switch is then made
  // in the hostile page's frame. The switch is vouched for by a click inside the
  // frame, not by the page around it. So the limited view offers only what the
  // owner needs right after a switch and nothing that is a single click against
  // the private document.
  const onPublicOrigin = parentOrigin !== "" && parentOrigin === publicOrigin;
  const exposed = () => onPublicOrigin && !switched;
  const limited = (body) => onPublicOrigin && switched && body.linkAccess === "invited";
  const showMoved = () => {
    latest = null;
    main.replaceChildren(muted(["Open Share from the document’s own page to manage who can open it."]));
  };
  // A view drawn while the document was public may be stale, and a click on it
  // is a write. Ask first, and write only on a clear answer: any failure to read
  // stops the write. Returns true when the write may go ahead; otherwise it has
  // already drawn why. The window left between this read and the write is the
  // round trip, and a click lands in it only by luck.
  const stillPublic = async () => {
    if (!exposed()) return true;
    let response;
    let current = null;
    try {
      response = await call("GET", "/access");
      if (response === null) return true;
      if (response.status === 200) current = await response.json();
    } catch (error) {
      response = undefined;
    }
    if (response === undefined) { message.textContent = "Something went wrong. Nothing was changed."; return false; }
    if (response.status === 401) { writeToken(null); showGuest("", false); return false; }
    if (response.status === 404) { showNone(); return false; }
    if (response.status !== 200 || !current || (current.viewer !== "owner" && current.viewer !== "reader")) {
      message.textContent = "Something went wrong. Nothing was changed.";
      return false;
    }
    if (current.viewer === "reader") { showReader(current); return false; }
    if (current.linkAccess === "invited") { showMoved(); return false; }
    return true;
  };
  const present = (body) => {
    if (body.linkAccess === "invited" && exposed()) showMoved();
    else showOwner(body);
  };

  // One write at a time, checked first. The write itself is run.
  const guarded = async (run) => {
    if (writing) return;
    writing = true;
    seq += 1;
    try {
      if (!(await stillPublic())) return;
      await run();
    } catch (error) {
      message.textContent = "Something went wrong. Nothing was changed.";
    } finally {
      writing = false;
      if (deferred) { deferred = false; refresh(); }
    }
  };

  const write = (method, path, body, modeAfter) => guarded(async () => {
    const response = await call(method, path, body);
    if (response === null) { showGuest("", false); return; }
    let parsed = null;
    try { parsed = await response.json(); } catch (error) {}
    if (response.status === 200 && parsed && parsed.viewer === "owner") {
      // Only a write that changed the mode counts, so a repeat of "Only those
      // invited" on a stale view does not vouch for the frame.
      if (modeAfter && parsed.changed && parsed.linkAccess === "invited") switched = true;
      present(parsed);
      // An add, an approval or a role change the owner just made with a click: the page may now have
      // someone who can comment, and the owner is looking.
      if (method === "PUT" && path.startsWith("/access/people/")) post("people");
    } else if (response.status === 401) {
      writeToken(null);
      showGuest("", false);
    } else if (response.status === 404) {
      showNone();
    } else {
      fail(message, response, parsed, path.startsWith("/access/people/") ? "Adding people needs a paid plan." : undefined);
    }
  });

  // The addresses in what the owner pasted, one PUT each, in order. The first
  // refusal that applies to every address (the plan, the daily quota, a full
  // list) stops the batch, and those already added stay added. A lone address is
  // the plain single write, so it reads exactly as it always has. Copy of
  // parseAddresses in src/addresses.ts: change both together.
  const parseAddresses = (text) => {
    const emails = [];
    const bad = [];
    const seen = new Set();
    const gap = String.fromCharCode(9, 10, 11, 12, 13, 32, 160);
    for (const token of text.split(new RegExp('[,;<>"' + gap + "]+"))) {
      const key = token.toLowerCase();
      if (!token.includes("@") || seen.has(key)) continue;
      seen.add(key);
      if (/^[^@]+@[^@]+$/.test(token)) emails.push(key);
      else bad.push(token);
    }
    return { emails: emails, bad: bad };
  };
  const addMany = (text) => {
    const found = parseAddresses(text);
    // One entry, or nothing with an "@" in it (the server then says what is
    // wrong), is the plain single write.
    const count = found.emails.length + found.bad.length;
    if (count <= 1) {
      const lone = count === 1 ? found.emails.concat(found.bad)[0] : text.trim();
      return lone === "" ? undefined : write("PUT", "/access/people/" + encodeURIComponent(lone));
    }
    return guarded(async () => {
      let added = 0;
      let last = null;
      let stop = null;
      let crashed = false;
      for (const [index, address] of found.emails.entries()) {
        // A batch spans many round trips, so the check guarded() made before the
        // first write is made again before each later one. If it drew another
        // view (the document went private, or was deleted), that is the answer.
        if (index > 0 && !(await stillPublic())) {
          if (!message.isConnected) return;
          crashed = true;
          break;
        }
        let response;
        let parsed = null;
        try {
          response = await call("PUT", "/access/people/" + encodeURIComponent(address));
          if (response !== null) parsed = await response.json().catch(() => null);
        } catch (error) { crashed = true; break; }
        if (response === null) { showGuest("", false); return; }
        if (response.status === 200 && parsed && parsed.viewer === "owner") { added += 1; last = parsed; continue; }
        if (response.status === 401) { writeToken(null); showGuest("", false); return; }
        if (response.status === 404) { showNone(); return; }
        stop = [response, parsed];
        break;
      }
      const done = [];
      if (added > 0) done.push("Added " + added + (added === 1 ? " person." : " people."));
      if (found.bad.length > 0) done.push("Not added: " + found.bad.map((entry) => entry + " (not an email address)").join(", ") + ".");
      if (last !== null) present(last);
      if (added > 0) post("people");
      if (stop !== null) {
        fail(message, stop[0], stop[1]);
        if (done.length > 0) {
          // "Nothing was changed" is not true of a batch that got part way.
          message.firstChild.textContent = message.firstChild.textContent.replace(" Nothing was changed.", "");
          message.prepend(done.join(" ") + " Stopped: ");
        }
      } else {
        message.textContent = done.concat(crashed ? ["Stopped: Something went wrong."] : []).join(" ");
        // Everyone was added: that is not an error, so it is not drawn as one.
        if (found.bad.length === 0 && !crashed) message.className = "muted";
      }
      // Some went in and some did not: amber, like the share page, not a failure.
      if (added > 0 && message.className === "err") message.className = "err warn";
    });
  };

  const showOwner = (body) => {
    latest = body;
    if (body.linkAccess !== "invited") switched = false;
    message = node("p", { id: "oa-msg", class: "err", role: "alert" });
    // The roles this owner may grant now, in ladder order. Absent where the comments object is not bound
    // (no role is drawn, and people are added as before); empty on a plan that grants none (no way to add).
    const roles = Array.isArray(body.roles) ? body.roles : null;
    const mayAdd = roles === null || roles.length > 0;
    grantsComment = roles !== null && roles.includes("comment");
    upgradeShown = roles !== null && roles.length === 0;
    const input = node("input", { type: "text", inputmode: "email", placeholder: "Emails, separated by commas", "aria-label": "Add people by email, separated by commas", autocomplete: "off" });
    const add = () => addMany(input.value);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") add(); });
    // A text field drops line breaks from what it is given, which would glue a
    // pasted column into one address. Turn them into separators first.
    input.addEventListener("paste", (event) => {
      const pasted = event.clipboardData ? event.clipboardData.getData("text") : "";
      const lines = pasted.split(new RegExp("[" + String.fromCharCode(13, 10) + "]+")).map((line) => line.trim()).filter((line) => line !== "");
      if (lines.length < 2) return;
      event.preventDefault();
      input.setRangeText(lines.join(", "), input.selectionStart, input.selectionEnd, "end");
    });
    const choice = (value, label) => node("button", { type: "button", role: "radio", "aria-checked": String(body.linkAccess === value), onclick: () => { if (body.linkAccess !== value) write("PUT", "/access", { linkAccess: value }, true); } }, [label]);
    const narrow = limited(body);
    const roleLabel = (role) => "Can " + role;
    const roleControl = (entry) => {
      if (roles === null) return null;
      // The stored role is selected exactly. One this script does not offer stays as its own option, so it is never
      // rewritten, and one the plan no longer grants can still be lowered to one it does.
      const offered = roles.includes(entry.role) ? roles : roles.concat([entry.role]);
      if (offered.length < 2) return node("span", { class: "muted" }, [roleLabel(entry.role)]);
      const select = node("select", { "aria-label": "Access for " + entry.email }, offered.map((role) => node("option", { value: role }, [roleLabel(role)])));
      select.value = entry.role;
      // A select shows its new value before the write lands. A write that lands redraws the view with a new select; one that fails, or that another write turned away, leaves this one showing a role nobody has, so it goes back.
      select.addEventListener("change", () => {
        if (select.value === entry.role) return;
        write("PUT", "/access/people/" + encodeURIComponent(entry.email), { role: select.value }).then(() => { select.value = entry.role; });
      });
      return select;
    };
    const person = (address, detail, buttons) => node("li", {}, [node("span", {}, [address, node("small", {}, [detail])]), node("div", { class: "row" }, buttons)]);
    // No section labels where the control says what it is: the two choices, and an
    // address field beside Add.
    const kids = [node("div", { class: "seg", role: "radiogroup", "aria-label": "Link access" }, [choice("anyone", "Anyone with the link"), choice("invited", "Only those invited")])];
    if (roles !== null && roles.length === 0) {
      const upgrade = typeof body.upgradeUrl === "string" && body.upgradeUrl.startsWith("https://") ? body.upgradeUrl : null;
      kids.push(muted(["Private pages and comments need a paid plan."].concat(upgrade === null ? [] : [" ", node("a", { href: upgrade, target: "_blank", rel: "noopener noreferrer" }, ["Upgrade"])])));
    }
    if (mayAdd) {
      kids.push(node("div", { class: "row" }, [input, button("Add", add, "primary tall")]));
      if (roles !== null && roles.includes("comment")) {
        kids.push(node("p", { class: "muted help" }, [body.linkAccess === "anyone" ? "Anyone with the link can view. Only people you add can comment." : "Only people you add can open this page."]));
      }
    }
    kids.push(message);
    if (body.requests.length > 0) {
      kids.push(node("h2", {}, ["Requests"]), node("ul", {}, body.requests.map((request) => person(request.email, "Asked to open it", narrow ? [] : [
        mayAdd ? button("Approve", () => write("PUT", "/access/people/" + encodeURIComponent(request.email)), "primary") : null,
        button("Decline", () => write("DELETE", "/access/requests/" + encodeURIComponent(request.email))),
      ].filter((kid) => kid !== null)))));
    }
    const invitationLabel = body.email ? "Invited" : "Invited · send them the link";
    kids.push(node("h2", {}, ["Who has access"]), node("ul", {}, [person("You", "Owner", [])].concat(body.people.map((entry) => person(entry.email, invitationLabel, narrow ? [] : [
      roleControl(entry),
      button("Remove", () => write("DELETE", "/access/people/" + encodeURIComponent(entry.email)), "link"),
    ].filter((kid) => kid !== null))))));
    // Both lines are about people on the list, so they wait for someone to be on it.
    const listed = body.people.length > 0 || body.requests.length > 0;
    if (body.email && mayAdd && body.people.length > 0) kids.push(muted(["OpenArtifacts emails each invitation. If someone doesn’t get it, send them the link."]));
    // Approve, Decline and Remove are one click on a private document, and this
    // frame is on the public origin. See exposed().
    if (narrow && listed) kids.push(muted(["To remove people or answer requests, ", node("a", { href: location.origin + "/share/" + doc, target: "_blank", rel: "noopener noreferrer" }, ["open the share page"]), "."]));
    main.replaceChildren(...kids);
  };

  const refresh = async () => {
    if (writing) { deferred = true; return; }
    const mine = ++seq;
    const stored = readToken();
    if (stored === null) { showGuest("", false); return; }
    // Nothing drawn yet came from a token (the shell, or a sign-in just
    // completed): hold the places instead of leaving the signed-out view up.
    if (account.isConnected) showSkeleton();
    let response;
    try { response = await call("GET", "/access"); } catch (error) { if (mine === seq) showGuest("Couldn’t load the sharing settings. Try again.", false); return; }
    if (response === null) { if (mine === seq) showGuest("", false); return; }
    let body = null;
    try { body = await response.json(); } catch (error) {}
    if (mine !== seq) return;
    if (response.status === 200 && body && body.viewer === "owner") present(body);
    else if (response.status === 200 && body && body.viewer === "reader") showReader(body);
    else if (response.status === 401) { writeToken(null); showGuest("", false); }
    else if (response.status === 404) showNone();
    else showGuest("Couldn’t load the sharing settings. Try again.", false);
  };

  try { prepare().catch(() => {}); } catch (error) {}
  // The first view is chosen before main is shown: with a stored token, refresh()
  // draws the skeleton synchronously, before its first await.
  if (readToken() !== null) refresh();
  main.hidden = false;
  edges();
})();
`;
