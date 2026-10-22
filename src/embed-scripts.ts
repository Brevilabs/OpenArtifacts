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
 *   Share costs no frame request. Hidden is `visibility: hidden`, not
 *   `display: none`: the frame is laid out in place, at its width, so one that
 *   reports its size has done so before it is first shown, while it can be
 *   neither seen, clicked nor tabbed into. It is then hidden and shown, **never
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
 * - **Height.** On the shared serving origin (`openartifacts.site`, a public
 *   document's page) the popover is **one fixed height** for every viewer
 *   (360 px, less on a short viewport) and the frame scrolls inside it. 360 is
 *   the tallest form of the owner view with nobody added, plus a margin:
 *   measured in Chrome at the popover's 400 px width (the 56 px header and the
 *   61 px footer around the content), the public, the private and the free
 *   owner's view are all 345 px, because the upgrade row is the invite field's
 *   height. So
 *   an owner who has added nobody sees everything without a scrollbar, and a
 *   list of people scrolls. There the frame
 *   never reports its size: any page on that origin can embed the same frame
 *   for any document it knows, and the height of what the frame draws (owner
 *   controls, a list of people, or just Copy link) would tell that page, with
 *   no click, whether its visitor manages the document.
 *   On a private document's page (its publisher's own `{code}.openartifacts.site`)
 *   the owner view reports the height of its content (`size`), and the popover
 *   takes it, up to 720 px and the viewport below the bar less 8 px; past that
 *   the frame scrolls inside it as above. Every other view, and the time before
 *   the first report, is the fixed height; `size` 0 says so. Which views report,
 *   and why that tells no page anything it may not know, is `FRAME_SCRIPT`'s.
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
  // The height of the frame's content, once it has said: only the owner view, on a private document's own origin,
  // does. 0 is the fixed height, which the frame says when it leaves the owner view.
  let size = 0;
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
    const width = Math.min(400, view.clientWidth - 16);
    // Anchored by the left edge to Share's right edge, then kept on screen, so it
    // opens in view wherever Share sits.
    host.style.width = width + "px";
    host.style.top = top + "px";
    host.style.left = Math.round(Math.max(8, Math.min(box.right - width, view.clientWidth - width - 8))) + "px";
    const room = Math.max(120, view.clientHeight - top - 8);
    host.style.height = (size > 0 ? Math.min(size, 720, room) : Math.min(360, room)) + "px";
  };
  const build = () => {
    host = document.createElement("div");
    host.className = "openartifacts-share-popover";
    host.setAttribute("style", "all:initial;position:fixed;z-index:2147483647;display:block;visibility:hidden;box-sizing:border-box;direction:ltr;border-radius:14px;background:#0d0f14;box-shadow:0 12px 32px rgba(0,0,0,.35),0 2px 6px rgba(0,0,0,.25),0 0 0 1px rgba(255,255,255,.14);overflow:hidden");
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
    place();
  };
  const show = () => {
    if (host === null) build();
    open = true;
    place();
    host.style.visibility = "visible";
    link.setAttribute("aria-expanded", "true");
    if (ready) frame.focus();
    else timer = window.setTimeout(() => { if (!ready) { frame.style.display = "none"; fallback.style.display = "block"; } }, 4000);
  };
  const hide = (refocus) => {
    if (!open) return;
    open = false;
    window.clearTimeout(timer);
    host.style.visibility = "hidden";
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
    } else if (data.event === "size" && typeof data.height === "number" && data.height >= 0) {
      size = Math.ceil(data.height);
      place();
    } else if (data.event === "close") hide(true);
    else if (data.event === "people" && commentsSwitched) commentsSwitched();
    // The owner's click made this page public, so this origin no longer serves it: go to the apex.
    else if (data.event === "moved") window.location.reload();
  });
  document.addEventListener("keydown", (event) => { if (open && event.key === "Escape") hide(true); }, true);
  document.addEventListener("pointerdown", (event) => { if (open && event.target !== host && !link.contains(event.target)) hide(false); }, true);
  window.addEventListener("resize", () => { if (host !== null) place(); });
` +
  PAGE_COMMENTS_SCRIPT +
  "})();\n";

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
 * nothing. The message lands only when the frame is a top-level page.
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
 * frame fills the popover, whatever it shows. Only the owner view of a frame that
 * reports its size (`body.fit`, see `FRAME_SCRIPT`) lets `main` take its
 * content's height instead of the room left, so what it measures is the content.
 *
 * **Layout.** Three parts, the same in every view, on the layout of Google Docs'
 * and Claude's share popovers. The `header` is the document's title (one line,
 * cut with an ellipsis) and the × close button. The `footer` is pinned under
 * `main`: a sentence about who can open the link, and **Copy link**, the primary
 * action, so neither scrolls away. Both are part of the shell, not of any view,
 * so nothing a view draws can move them. `main` between them is the one scroll
 * region; nothing inside it scrolls on its own. The header gets its hairline
 * divider only while content is scrolled under it (`body.scrolled`), and the
 * `.fade` over the foot of `main` shows only while there is more below
 * (`body.more`), both set by the frame script. The footer has its hairline
 * always.
 *
 * **Rows.** People (the owner, each invitee, each request) are one row: a 32 px
 * initials avatar (`.av`), a name line and a muted line under it (`.who`), and a
 * control at the right. The control is a borderless menu button with a chevron
 * that opens a small listbox drawn in the frame (`.pop`), not a native `select`:
 * a closed select commits on a single keystroke, and a choice here is a write.
 * Only a click, Enter or Space on an option commits. General access is the same shape
 * with a 36 px icon circle (`.circle`). The invite field is one input with the
 * **Invite** button laid over its right edge (`.invite`, absolutely positioned and
 * `hidden` until the field has text), so the field never reflows when the button
 * appears.
 *
 * **Height.** On the shared serving origin, one for every viewer (see
 * `PAGE_SCRIPT`), set so that the owner view with nobody added, in each of its
 * forms (public, private, a free owner's upgrade card), shows whole without a scrollbar; a list of people scrolls. The short
 * views (signed out, a reader, not found) pin the Copilot line (`.hint`) to the
 * floor of `main`, with the account action in the footer, so the room between
 * reads as layout.
 * On a private document's own origin the owner view's popover is its content's
 * height, up to a maximum, and `main` scrolls past it; every other view keeps
 * the fixed height and its pinned Copilot line.
 *
 * **Loading.** `main` is `hidden` in the shell until the script has chosen the
 * first view, so a token holder's frame never paints the signed-out markup.
 * The skeleton (`.sk`) holds the owner view's places with muted blocks, in the
 * same sizes as the rows they stand for, and pulses, except under reduced
 * motion; the title is a muted bar in it. The invite field and the owner's row
 * are in the same place in both, and a free owner's upgrade row, which takes the
 * field's place, is the same height, so nothing under it moves.
 *
 * **Upgrade card** (`.up`). A plan that grants no role has neither private
 * sharing nor comments, so one row (the invite field's height, 36 px) says both
 * with a lock, and an accent **Upgrade** link where the API gives one, in the
 * invite field's place. On that plan **Only people
 * invited** in General access is refused: nothing is sent, the row's border
 * pulses (`.nudge`, a steady accent border under reduced motion) and Upgrade is
 * focused.
 *
 * **Busy.** While a write is out, the control it came from shows a spinner
 * (`.busy`) in place of its label, and every
 * control in `main` is disabled or read-only (`FRAME_SCRIPT`'s `hold`).
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
header{flex:none;position:relative;z-index:2;display:flex;align-items:center;gap:8px;min-height:56px;padding:16px 12px 8px 20px;background:#0d0f14}
body.scrolled header{box-shadow:0 1px 0 #20242c,0 8px 10px -6px rgba(0,0,0,.6)}
.title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;line-height:24px;font-weight:600;color:#f4f5f7}
main{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;padding:0 20px 16px;scrollbar-color:#2c313b transparent;scrollbar-width:thin}
main[hidden],button[hidden]{display:none}body.fit main{flex:0 1 auto}
main>*{flex-shrink:0}main>:first-child{margin-top:0}
footer{flex:none;position:relative;z-index:2;display:flex;align-items:center;gap:12px;min-height:61px;padding:12px 16px 12px 20px;border-top:1px solid #20242c;background:#0d0f14}
.status{flex:1;min-width:0;margin:0;font-size:13px;line-height:1.35;color:#8d94a0}.status button.link{font-size:13px}
footer button{flex:none;margin-left:auto;height:36px;padding:0 14px;border-radius:10px;font-size:14px}
.fade{flex:none;position:relative;z-index:1;height:0;pointer-events:none}
.fade::before{content:"";position:absolute;left:0;right:0;bottom:0;height:28px;background:linear-gradient(to bottom,rgba(13,15,20,0),#0d0f14 85%);opacity:0}
body.more .fade::before{opacity:1}
:focus-visible{outline:2px solid #f6ae52;outline-offset:2px}
h2{margin:16px 0 4px;font-size:13px;line-height:20px;font-weight:600;color:#f4f5f7}
p{margin:8px 0 0}
.muted{color:#8d94a0}.err{margin-top:8px;color:#ff8a80}.err.warn{color:#f6ae52}.err:empty{display:none}
a{color:#f6ae52;text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px}
button{font:inherit;font-size:13px;font-weight:500;line-height:1;cursor:pointer;height:28px;padding:0 12px;border:1px solid #2c313b;border-radius:8px;background:transparent;color:#e9ebee;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
button:hover{border-color:#3a404b;background:rgba(255,255,255,.04)}
button:disabled{cursor:default;opacity:.5}button:disabled:not(.busy):hover{border-color:#2c313b;background:transparent}
button.busy{position:relative;color:transparent!important}button.busy:disabled{opacity:1}
button.busy::after{content:"";position:absolute;inset:0;margin:auto;width:14px;height:14px;border:2px solid #e9ebee;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
button.primary.busy::after{border-color:#0b0c10;border-right-color:transparent}
@keyframes spin{to{transform:rotate(1turn)}}
button.primary{background:#f4f5f7;border-color:#f4f5f7;color:#0b0c10;font-weight:600}
button.primary:hover{background:#fff;border-color:#fff}
button.link{display:inline;height:auto;padding:0;border:0;background:none;color:#f6ae52;font-size:inherit;font-weight:inherit;line-height:inherit;white-space:normal}
button.link:hover{background:none;text-decoration:underline;text-underline-offset:3px}
header .x{flex:none;width:28px;padding:0;border:0;font-size:20px;font-weight:400;color:#8d94a0}
header .x:hover{background:rgba(255,255,255,.06);color:#f4f5f7}
svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
button.menu{height:32px;max-width:100%;padding:0 6px 0 8px;border:0;border-radius:8px;gap:4px;font-weight:400;color:#e9ebee}
button.menu:hover{border:0;background:rgba(255,255,255,.06)}
button.menu span{overflow:hidden;text-overflow:ellipsis}
button.menu svg{width:14px;height:14px;color:#8d94a0}button.menu.busy svg{visibility:hidden}
.pop{position:fixed;z-index:5;overflow:auto;padding:4px;border:1px solid #2c313b;border-radius:10px;background:#171a21;box-shadow:0 8px 24px rgba(0,0,0,.45)}
.pop button{display:flex;width:100%;height:32px;justify-content:flex-start;gap:8px;padding:0 12px 0 6px;border:0;border-radius:6px;font-weight:400}
.pop button:hover,.pop button:focus-visible{border:0;background:rgba(255,255,255,.08);outline:0}
.pop .tick{flex:none;width:16px;height:16px}.pop .tick svg{width:14px;height:14px}.pop .danger{color:#ff8a80}
.pop hr{margin:4px 0;border:0;border-top:1px solid #2c313b}
.ico{flex:none;width:16px;height:16px}
input{font:inherit;width:100%;min-width:0;height:36px;padding:0 12px;border:1px solid #20242c;border-radius:10px;background:#07080b;color:#e9ebee}
input::placeholder{color:#5b626e}
input:focus-visible{outline:0;border-color:#f6ae52;box-shadow:0 0 0 3px rgba(246,174,82,.18)}
.invite{position:relative;margin-top:4px}.invite input{padding-right:84px}
.invite button{position:absolute;top:4px;right:4px;height:28px;border-radius:7px}
.invite button.busy{position:absolute}
.row{display:flex;gap:8px;align-items:center}
.up{display:flex;align-items:center;gap:8px;min-height:36px;margin-top:4px;padding:3px 4px 3px 12px;border:1px solid #20242c;border-radius:10px;background:#07080b;font-size:12.5px;line-height:1.3;color:#8d94a0}
.up svg{width:13px;height:13px;color:#f6ae52}.up span{flex:1;min-width:0}
a.btn{flex:none;display:inline-flex;align-items:center;height:28px;margin-left:auto;padding:0 12px;border-radius:8px;font-size:13px;font-weight:600;background:#f6ae52;color:#0b0c10}
a.btn:hover{text-decoration:none;background:#f8bd6e}
.up.nudge{animation:nudge 1s ease-out}
@keyframes nudge{0%,30%{border-color:#f6ae52;box-shadow:0 0 0 3px rgba(246,174,82,.18)}}
ul{list-style:none;margin:0;padding:0}
li{display:flex;align-items:center;gap:12px;padding:6px 0}
.av{flex:none;display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;font-size:12px;font-weight:600;color:#e9ebee;user-select:none}
.circle{flex:none;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:#171a21;color:#c9ced6}.circle svg{width:18px;height:18px}
.who{flex:1;min-width:0}
.who b,.who small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.who b{font-weight:500;line-height:20px}.who b i{font-style:normal;font-weight:400;color:#8d94a0}
.who small{font-size:12px;line-height:16px;color:#8d94a0}
li .row,.role{flex:none;margin-left:auto}.role{font-size:13px;color:#8d94a0}
.access{display:flex;align-items:center;gap:12px;padding:6px 0}.access .menu{height:36px;font-size:14px;font-weight:500}
.sk{border-color:transparent;background:#171a21;animation:pulse 1.6s ease-in-out infinite}
i.sk{display:inline-block;height:10px;border-radius:5px;vertical-align:middle}
.sk-in{height:36px;border-radius:10px}
@keyframes pulse{50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){.sk,.up.nudge{animation:none}.up.nudge{border-color:#f6ae52}}
@media (max-width:340px){li.req{flex-wrap:wrap}li.req .row{flex-basis:100%;margin-left:0;padding-left:44px}}
.hint{margin-top:auto;padding-top:12px;font-size:12.5px;overflow-wrap:anywhere}
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
 * **What it tells the page around it.** `ready`, once, before it touches
 * storage; `close`, only from a user action in the frame (the × button or
 * Escape); `people`, only after the owner's own click inside the owner view
 * (an add, a role change, or × / Escape, the last only where the plan grants Can
 * comment): it says this visitor is the owner, so it is never sent when a view
 * is drawn; `moved`, only on the publisher's origin (where the frame `fits`), only after the
 * owner's own click made the page public, so the page around it goes to the apex at once; and `size`, only from the owner view where the frame `fits` (below). Embedded by the
 * shared serving origin, nothing the frame sends, and nothing it does that an
 * embedding page can observe (a size change, a focus move), depends on what is
 * in storage. Any page on `openartifacts.site` can embed this frame for any
 * public document it knows, and the stored token lives in the partition that
 * page shares, so anything token-dependent would tell it, with no click,
 * whether its visitor manages that document. So there it sends no size, and
 * nowhere is there a `ResizeObserver`, an `autofocus`, or a `focus()` except
 * inside a handler for a user action.
 *
 * **Where it reports its size.** Only from the owner view, and only in a frame
 * that `fits`. `data-origin`, the only target of its `postMessage`, is the
 * embedder's origin only when that equals the document's serving origin as the
 * frame loads, and `frame-ancestors` then admits that origin alone
 * (`frameContext`, `src/frame-shell.ts`). For a public document that is the
 * shared origin; for an invited-only one it is its publisher's
 * `{code}.openartifacts.site`, which serves only that publisher's documents and
 * so runs only that publisher's scripts (`src/private.ts`). So a frame `fits`
 * (an origin is set, and it is not the shared one) only when every page around
 * it is that publisher's own. The owner view's height tells those scripts
 * nothing their author cannot already know: the visitor is the publisher. No
 * other view reports, there or anywhere: signed out, a reader, not found and the
 * skeleton keep the one fixed height and post nothing. The page is the
 * publisher's and its visitor may be an invitee, and the reader view's "Signed
 * in as {email}." wraps by address, so its height would tell the publisher which
 * invitee is looking, and any report from a view but the signed-out one would
 * tell that the visitor has signed in to Share. While the owner view is drawn,
 * `main` takes its content's height (`body.fit`) and the frame posts `size`, the
 * header above `main`, all of `main` and the footer under it, whenever that changes (a line added, a
 * resize); leaving it posts `size` 0, the fixed height, which follows only from
 * the owner's own view. Nothing is posted while the frame has no width
 * (`innerWidth` 0): Chrome may run it before the page has laid it out, and its
 * content measured at no width is thousands of pixels tall; the resize that
 * gives it its width reports. Whether it `fits` is fixed when the frame loads,
 * because the frame is never reloaded (`PAGE_SCRIPT`): one loaded on the shared
 * origin stays silent after the document goes private, and one loaded on the
 * code origin keeps reporting its owner view after the document goes public,
 * still to the publisher's own page. A fresh load for a public document under a
 * code origin is refused by `frame-ancestors`.
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
  const doc = main.dataset.doc;
  const link = main.dataset.link;
  const parentOrigin = main.dataset.origin;
  // Where a public document is served. A frame embedded there while the document
  // is public is one any page on that origin could have embedded.
  let publicOrigin = "";
  try { publicOrigin = new URL(link).origin; } catch (error) {}
  // Embedded by a private document's own origin: only its publisher's pages are around it, so its owner
  // view may report its size (see the header comment). Decided once, as the frame loads.
  const fits = parentOrigin !== "" && parentOrigin !== publicOrigin && window.parent !== window;
  const KEY = "openartifacts:share-token:" + doc;
  const SIGNIN_WINDOW_MS = 10 * 60 * 1000;
  const SENTENCE = "Only the owner can change who can open this.";

  const post = (event, fields) => {
    if (parentOrigin && window.parent !== window) window.parent.postMessage(Object.assign({ type: "openartifacts:share", event: event }, fields), parentOrigin);
  };
  post("ready");

  // The header gets its divider only while content is under it, and the
  // fade at the foot of main shows only while there is more below. Every view is drawn
  // into main, so its content changing, a scroll and a resize (the popover shown)
  // are all that move either edge, or the height the owner view reports.
  const header = document.querySelector("header");
  const footer = document.querySelector("footer");
  // Whether the owner view is drawn: only it reports a size, and only where the frame fits.
  let ownerDrawn = false;
  // The last height posted; 0 is the fixed height, which every other view has and posts nothing for.
  let reported = 0;
  const edges = () => {
    document.body.classList.toggle("scrolled", main.scrollTop > 0);
    document.body.classList.toggle("more", main.scrollTop + main.clientHeight < main.scrollHeight - 1);
    // A frame the page has not laid out yet has no width, and its content measured at none is far
    // taller than it will be. The resize that gives it its width reports.
    if (window.innerWidth === 0) return;
    const height = fits && ownerDrawn ? Math.ceil(header.getBoundingClientRect().height + main.scrollHeight + footer.getBoundingClientRect().height) : 0;
    // Leaving the owner view posts 0, so the popover goes back to the fixed height.
    if (height !== reported) { reported = height; post("size", { height: height }); }
  };
  main.addEventListener("scroll", edges);
  window.addEventListener("resize", edges);
  new MutationObserver(edges).observe(main, { childList: true, subtree: true, characterData: true });
  // The header's title is the word the shell carries ("Share", the same bytes for every document) until
  // the owner or reader view lands; the footer's sentence is empty until the owner view says who can open the link.
  const titleBar = header.querySelector(".title");
  const SHARE = titleBar.textContent;
  const status = footer.querySelector(".status");
  const setTitle = (text) => { titleBar.textContent = text || SHARE; };
  // Every view is drawn through here, so the one flag that lets a view report is set with it. A view that
  // knows the title or the footer's sentence sets them after.
  const draw = (kids, owner) => {
    ownerDrawn = owner === true;
    document.body.classList.toggle("fit", fits && ownerDrawn);
    main.replaceChildren(...kids);
    setTitle("");
    setFooter([], LINK_ICON);
    closeMenu(false);
  };

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
  const CHEVRON_ICON = ["m6 9 6 6 6-6"];
  const GLOBE_ICON = ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "M2 12h20", "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"];
  const LOCK_ICON = ["M6 11h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z", "M8 11V7a4 4 0 0 1 8 0v4"];
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
  // A null icon leaves its place empty, so the label does not move when the icon arrives.
  const copyLabel = (target, paths, text) => target.replaceChildren(paths === null ? node("span", { class: "ico" }) : icon(paths), node("span", {}, [text]));
  // Copy link is the footer's, in every view. Its icon is a lock while the page is invited-only, empty
  // while the owner view loads, and "Copied" holds for two seconds whatever the view does meanwhile.
  const copyButton = footer.querySelector("button.primary");
  let linkIcon = LINK_ICON;
  let copied = 0;
  const idleCopy = () => copyLabel(copyButton, linkIcon, "Copy link");
  // The footer's left side (a sentence, or an account action) and Copy link's icon follow the view.
  const setFooter = (kids, paths) => {
    status.replaceChildren(...kids);
    linkIcon = paths;
    if (copied === 0) idleCopy();
  };
  const copyLink = () => {
    const done = () => {
      copyLabel(copyButton, CHECK_ICON, "Copied");
      window.clearTimeout(copied);
      copied = window.setTimeout(() => { copied = 0; idleCopy(); }, 2000);
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
  copyButton.addEventListener("click", copyLink);
  // The owner view is the only one with the General access control. Leaving it is a click or a key inside
  // the frame, so it may say that this visitor is the owner (see the header comment), but only an
  // owner whose plan grants Can comment: a free owner's page has no comments to bring up. Leaving
  // any other view says nothing more than close.
  let grantsComment = false;
  // The owner view is showing the upgrade card: coming back to the tab reads it again.
  let upgradeShown = false;
  const leave = () => { post("close"); if (grantsComment && ownerDrawn) post("people"); };
  const closeButton = (target) => target.addEventListener("click", leave);
  // Escape in an open menu closes the menu and nothing else (its handler prevents the default).
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !event.defaultPrevented) leave(); });

  const guest = Array.from(main.children);
  // Found by position, not by id. An id a view has and another lacks is a fragment
  // an embedding page can navigate the frame to (a URL fragment), and whether the
  // browser then focuses something shows as a blur on that page: a read of
  // storage it has no right to. A focusable element carries no id at all, even one
  // every view has: where it sits can differ by view, and a focus move scrolls
  // the embedding page by that difference.
  const signInButton = status.querySelector("button");
  const hintNode = main.querySelector(".hint");
  const guestMessage = document.getElementById("oa-msg");
  // The header (title and ×) and the footer (sentence and Copy link) are the shell's,
  // the same in every view, so they are wired once and never redrawn.
  closeButton(header.querySelector(".x"));

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
    draw(guest);
    // The button stays while waiting: the popup may have been closed, the done page
    // reached after the handoff row expired, or an overlapping sign-in may have
    // failed at the login binding, and pressing it again is the way out of each.
    // It starts a new poll, which replaces this one.
    setFooter(waiting ? ["Complete sign-in in the window that opened. ", signInButton] : ["Is this your page? ", signInButton], LINK_ICON);
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
  // Back on this tab after the Upgrade link's checkout in another: an owner shown the upgrade card reads the view again.
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
  const roleLabel = (role) => "Can " + role;
  // The same Copilot line as the shell's, for the views that replace it.
  const hintLine = () => hintNode.cloneNode(true);
  const anotherAccount = (lead) => [lead, button("Use another account", () => signIn(true), "link")];

  // A reader's one row, in the owner view's row style: who they are, and what they may do. The footer
  // offers another account.
  const showReader = (body) => {
    draw([node("ul", {}, [person(body.account, null, null, node("span", { class: "role" }, [roleLabel(body.role)]), "", true)]), muted([SENTENCE]), hintLine()]);
    setTitle(body.title);
    setFooter(anotherAccount(""), LINK_ICON);
  };
  const showNone = () => {
    draw([muted([SENTENCE]), hintLine()]);
    setFooter(anotherAccount("Is this your page? "), LINK_ICON);
  };
  // While a stored token's read is out: the owner view's places, held by muted
  // blocks of the sizes they stand for, with a muted bar where the title goes and
  // nothing yet in the footer, whose lock is not known. Only the answer replaces it
  // (owner, reader, not found, or the signed-out view after a 401), never the
  // signed-out view first.
  const showSkeleton = () => {
    const bar = (width) => node("i", { class: "sk", style: "width:" + width });
    draw([
      node("div", { class: "invite" }, [node("div", { class: "sk sk-in" })]),
      node("h2", {}, [bar("110px")]),
      node("ul", {}, [node("li", {}, [node("span", { class: "av sk" }), node("div", { class: "who" }, [node("b", {}, [bar("96px")]), node("small", {}, [bar("150px")])])])]),
      node("h2", {}, [bar("96px")]),
      node("div", { class: "access" }, [node("span", { class: "circle sk" }), bar("150px")]),
    ]);
    titleBar.replaceChildren(bar("160px"));
    setFooter([], null);
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
    draw([muted(["Open Share from the document’s own page to manage who can open it."])]);
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

  // While a write is out, the control it came from shows a spinner, and every control in main
  // is held, so nothing looks stuck and nothing is sent twice. The answer usually draws a new
  // view, which replaces them all; the returned function gives back the ones a view that stays
  // (a refusal, a failure) still shows.
  const hold = (control) => {
    const held = Array.from(main.querySelectorAll("button, input")).filter((element) => !element.disabled && !element.readOnly);
    const set = (on) => { for (const element of held) { if (element.tagName === "INPUT") element.readOnly = on; else element.disabled = on; } };
    set(true);
    if (control) { control.classList.add("busy"); control.setAttribute("aria-busy", "true"); }
    return () => {
      set(false);
      if (control) { control.classList.remove("busy"); control.removeAttribute("aria-busy"); }
    };
  };

  // One write at a time, checked first. The write itself is run.
  const guarded = async (run, control) => {
    if (writing) return;
    writing = true;
    seq += 1;
    const release = hold(control);
    try {
      if (!(await stillPublic())) return;
      await run();
    } catch (error) {
      message.textContent = "Something went wrong. Nothing was changed.";
    } finally {
      writing = false;
      release();
      if (deferred) { deferred = false; refresh(); }
    }
  };

  const write = (method, path, body, modeAfter, control) => guarded(async () => {
    const response = await call(method, path, body);
    if (response === null) { showGuest("", false); return; }
    let parsed = null;
    try { parsed = await response.json(); } catch (error) {}
    if (response.status === 200 && parsed && parsed.viewer === "owner") {
      // Only a write that changed the mode counts, so a repeat of "Only those
      // invited" on a stale view does not vouch for the frame.
      if (modeAfter && parsed.changed && parsed.linkAccess === "invited") switched = true;
      // The owner's own click left the page public (whether this write or a concurrent one changed it): its url is the apex now, and a tab on the code host is on the wrong origin.
      if (modeAfter && parsed.linkAccess === "anyone" && fits) post("moved");
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
  }, control);

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
  const addMany = (text, control) => {
    const found = parseAddresses(text);
    // One entry, or nothing with an "@" in it (the server then says what is
    // wrong), is the plain single write.
    const count = found.emails.length + found.bad.length;
    if (count <= 1) {
      const lone = count === 1 ? found.emails.concat(found.bad)[0] : text.trim();
      return lone === "" ? undefined : write("PUT", "/access/people/" + encodeURIComponent(lone), undefined, false, control);
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
    }, control);
  };

  // A menu button and its listbox, in place of a native select: a closed select commits a choice on
  // a single keystroke (a letter picks the option it starts, and on some platforms an arrow key
  // does), and a choice here is a write. The popup is drawn in the frame's body so no scroll
  // region clips it, and flips upward where there is no room below. Arrow keys, Home, End and a
  // typed letter only move the highlight (the focus, which is a real button each); Enter, Space or a
  // click on an option commits, and Escape, Tab or a click elsewhere closes it without a write.
  // Moving focus in and out happens inside the handlers of a user action, so it is not observable.
  let openMenu = null;
  const closeMenu = (refocus) => {
    if (openMenu === null) return;
    const shown = openMenu;
    openMenu = null;
    shown.pop.remove();
    shown.trigger.setAttribute("aria-expanded", "false");
    if (refocus) shown.trigger.focus();
  };
  document.addEventListener("pointerdown", (event) => {
    if (openMenu !== null && !openMenu.pop.contains(event.target) && !openMenu.trigger.contains(event.target)) closeMenu(false);
  }, true);
  window.addEventListener("blur", () => closeMenu(false));
  // The popup is fixed in the frame, so it would stay put while its button moves. Only a move counts:
  // focusing a button scrolls it into view a frame before the scroll event, and a menu opened in
  // between is already drawn where the button now is.
  window.addEventListener("resize", () => closeMenu(false));
  main.addEventListener("scroll", () => { if (openMenu !== null && openMenu.trigger.getBoundingClientRect().top !== openMenu.top) closeMenu(false); });
  // The options are a list of {value, label, danger}, with null for a separator; pick gets the value chosen.
  const menu = (ariaLabel, options, current, pick) => {
    const shown = options.find((option) => option !== null && option.value === current);
    const trigger = node("button", { type: "button", class: "menu", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": ariaLabel }, [node("span", {}, [shown ? shown.label : ""]), icon(CHEVRON_ICON)]);
    const open = () => {
      closeMenu(false);
      const pop = node("div", { class: "pop", role: "listbox", "aria-label": ariaLabel });
      const items = [];
      for (const option of options) {
        if (option === null) { pop.append(node("hr")); continue; }
        const chosen = option.value === current;
        const item = node("button", { type: "button", role: "option", class: option.danger ? "danger" : "", "aria-selected": String(chosen) }, [node("span", { class: "tick" }, chosen ? [icon(CHECK_ICON)] : []), option.label]);
        item.addEventListener("click", () => { closeMenu(true); pick(option.value); });
        items.push(item);
        pop.append(item);
      }
      pop.addEventListener("keydown", (event) => {
        const at = items.indexOf(document.activeElement);
        if (event.key === "Escape") { event.preventDefault(); closeMenu(true); }
        else if (event.key === "Tab") closeMenu(true);
        else if (event.key === "ArrowDown") { event.preventDefault(); items[Math.min(items.length - 1, at + 1)].focus(); }
        else if (event.key === "ArrowUp") { event.preventDefault(); items[Math.max(0, at - 1)].focus(); }
        else if (event.key === "Home") { event.preventDefault(); items[0].focus(); }
        else if (event.key === "End") { event.preventDefault(); items[items.length - 1].focus(); }
        else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const typed = event.key.toLowerCase();
          const next = items.slice(at + 1).concat(items.slice(0, at + 1)).find((item) => item.textContent.toLowerCase().startsWith(typed));
          if (next) next.focus();
        }
      });
      document.body.append(pop);
      const box = trigger.getBoundingClientRect();
      const below = window.innerHeight - box.bottom - 12;
      const above = box.top - 12;
      const flip = pop.offsetHeight > below && above > below;
      pop.style.minWidth = Math.round(box.width) + "px";
      pop.style.maxHeight = Math.max(96, flip ? above : below) + "px";
      pop.style.top = Math.round(flip ? box.top - 4 - pop.offsetHeight : box.bottom + 4) + "px";
      pop.style.left = Math.round(Math.max(8, Math.min(box.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8))) + "px";
      trigger.setAttribute("aria-expanded", "true");
      openMenu = { trigger: trigger, pop: pop, top: box.top };
      (items.find((item) => item.getAttribute("aria-selected") === "true") || items[0]).focus();
    };
    trigger.addEventListener("click", () => { if (openMenu !== null && openMenu.trigger === trigger) closeMenu(true); else open(); });
    trigger.addEventListener("keydown", (event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(); } });
    return trigger;
  };

  // Initials in a muted circle: the first letters of the first two words of the name, else the first
  // letter of the address. The colour is a fixed palette picked by a hash of the address.
  const AVATARS = ["#3d4f6b", "#4b3f6b", "#2f5f55", "#6b4f3a", "#6b3f4f", "#4f5f2f"];
  const first = (text) => Array.from(text)[0] || "";
  const avatar = (address, name) => {
    const words = (name || "").split(" ").filter((word) => word !== "");
    const letters = words.length > 0 ? words.slice(0, 2).map(first).join("") : first(address);
    let hash = 0;
    for (const char of address) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return node("span", { class: "av", style: "background:" + AVATARS[hash % AVATARS.length], "aria-hidden": "true" }, [letters.toUpperCase()]);
  };
  // A person's row: avatar, a name line (the address when there is no name) and a muted line under it, and a control.
  const person = (address, name, detail, control, cls, you) => node("li", { class: cls || "" }, [
    avatar(address, name),
    node("div", { class: "who" }, [node("b", {}, [name || address].concat(you ? [node("i", {}, [" (you)"])] : []))].concat(detail ? [node("small", {}, [detail])] : [])),
  ].concat(control ? [control] : []));

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
    const input = node("input", { type: "text", inputmode: "email", placeholder: "Invite people by email", "aria-label": "Invite people by email", autocomplete: "off" });
    // Enter in the field is a press of Invite, and shows on Invite. The button sits inside the field's right
    // edge and is there only while the field has text.
    const addButton = button("Invite", () => addMany(input.value, addButton), "primary");
    addButton.hidden = true;
    const typed = () => { addButton.hidden = input.value.trim() === ""; };
    input.addEventListener("input", typed);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") addMany(input.value, addButton); });
    // A text field drops line breaks from what it is given, which would glue a
    // pasted column into one address. Turn them into separators first.
    input.addEventListener("paste", (event) => {
      const pasted = event.clipboardData ? event.clipboardData.getData("text") : "";
      const lines = pasted.split(new RegExp("[" + String.fromCharCode(13, 10) + "]+")).map((line) => line.trim()).filter((line) => line !== "");
      if (lines.length < 2) return;
      event.preventDefault();
      input.setRangeText(lines.join(", "), input.selectionStart, input.selectionEnd, "end");
      typed();
    });
    // A plan that grants no role has neither private sharing nor comments: one row says so, with Upgrade.
    const upsell = roles !== null && roles.length === 0;
    const upgrade = upsell && typeof body.upgradeUrl === "string" && body.upgradeUrl.startsWith("https://") ? node("a", { class: "btn", href: body.upgradeUrl, target: "_blank", rel: "noopener noreferrer" }, ["Upgrade"]) : null;
    const card = upsell ? node("div", { class: "up" }, [icon(LOCK_ICON), node("span", {}, ["Private sharing and comments"])].concat(upgrade === null ? [] : [upgrade])) : null;
    // Going private is the paid half, so on that plan it is refused: nothing is sent, and the row is pointed at.
    const locked = (value) => upsell && value === "invited" && body.linkAccess !== value;
    const nudge = () => {
      card.classList.remove("nudge");
      void card.offsetWidth;
      card.classList.add("nudge");
      if (upgrade !== null) upgrade.focus();
    };
    const narrow = limited(body);
    // The control at the right of an invitee's row: the roles the plan grants, then Remove access. The stored
    // role is selected exactly. One this script does not offer stays as its own option, so it is never
    // rewritten, and one the plan no longer grants can still be lowered to one it does. Where the server has no
    // comments there is no role to choose, and the current one is the only label.
    // With no comments on this server a stored role is not something anyone can do, so a person is just invited.
    const listedLabel = (role) => (roles === null ? "Invited" : roleLabel(role));
    const accessMenu = (entry) => {
      const offered = roles === null ? [entry.role] : roles.includes(entry.role) ? roles : roles.concat([entry.role]);
      const address = "/access/people/" + encodeURIComponent(entry.email);
      const options = offered.map((role) => ({ value: role, label: listedLabel(role) })).concat([null, { value: "remove", label: "Remove access", danger: true }]);
      const trigger = menu("Access for " + entry.email, options, entry.role, (chosen) => {
        if (chosen === entry.role) return;
        if (chosen === "remove") write("DELETE", address, undefined, false, trigger);
        else write("PUT", address, { role: chosen }, false, trigger);
      });
      return trigger;
    };
    const modeMenu = menu("General access", [{ value: "invited", label: "Only people invited" }, { value: "anyone", label: "Anyone with the link" }], body.linkAccess, (chosen) => {
      if (chosen === body.linkAccess) return;
      if (locked(chosen)) nudge();
      else write("PUT", "/access", { linkAccess: chosen }, true, modeMenu);
    });

    const kids = [];
    if (mayAdd) kids.push(node("div", { class: "invite" }, [input, addButton]));
    else kids.push(card);
    kids.push(message);
    if (body.requests.length > 0) {
      kids.push(node("h2", {}, ["Requests"]), node("ul", {}, body.requests.map((request) => person(request.email, null, "Asked to open", narrow ? null : node("div", { class: "row" }, [
        mayAdd ? button("Approve", (event) => write("PUT", "/access/people/" + encodeURIComponent(request.email), undefined, false, event.currentTarget), "primary") : null,
        button("Decline", (event) => write("DELETE", "/access/requests/" + encodeURIComponent(request.email), undefined, false, event.currentTarget)),
      ].filter((kid) => kid !== null)), "req"))));
    }
    const ownerName = typeof body.name === "string" && body.name !== "" ? body.name : body.account;
    const invitees = body.people.map((entry) => person(entry.email, null, body.email ? null : "Send them the link", narrow ? node("span", { class: "role" }, [listedLabel(entry.role)]) : accessMenu(entry)));
    kids.push(node("h2", {}, ["People with access"]), node("ul", {}, [person(body.account, ownerName, body.account, node("span", { class: "role" }, ["Owner"]), "", true)].concat(invitees)));
    // Both lines are about people on the list, so they wait for someone to be on it.
    const listed = body.people.length > 0 || body.requests.length > 0;
    if (body.email && mayAdd && body.people.length > 0) kids.push(muted(["OpenArtifacts emails each invitation. If someone doesn’t get it, send them the link."]));
    // Approve, Decline and Remove access are one click on a private document, and this
    // frame is on the public origin. See exposed().
    if (narrow && listed) kids.push(muted(["To remove people or answer requests, ", node("a", { href: location.origin + "/share/" + doc, target: "_blank", rel: "noopener noreferrer" }, ["open the share page"]), "."]));
    kids.push(node("h2", {}, ["General access"]), node("div", { class: "access" }, [node("span", { class: "circle" }, [icon(body.linkAccess === "invited" ? LOCK_ICON : GLOBE_ICON)]), modeMenu]));
    draw(kids, true);
    setTitle(body.title);
    const invitedOnly = body.linkAccess === "invited";
    setFooter([invitedOnly ? (body.people.length === 0 ? "Only you can open this link" : "Only people invited can open this link") : "Anyone with the link can view"], invitedOnly ? LOCK_ICON : LINK_ICON);
  };

  const refresh = async () => {
    if (writing) { deferred = true; return; }
    const mine = ++seq;
    const stored = readToken();
    if (stored === null) { showGuest("", false); return; }
    // Nothing drawn yet came from a token (the shell, or a sign-in just
    // completed): hold the places instead of leaving the signed-out view up.
    if (signInButton.isConnected) showSkeleton();
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
