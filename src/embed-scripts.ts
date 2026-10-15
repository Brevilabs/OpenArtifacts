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

/**
 * The script every served page loads, from `https://{API_HOST}/embed/page.js`
 * (`src/embed.ts`). It turns the top bar's **Share** link into a popover: a
 * frame on the API host, drawn under the button.
 *
 * It runs inside the publisher's page, so it is written as the least trusting
 * code on that page can be. It defines no global, binds only our own link, reads
 * no cookie and no storage, holds no credential, and sends the frame nothing.
 * The frame is the thing that holds a credential, and it is a frame precisely
 * because the credential that changes who can read a document must never be on
 * a page whose scripts the author writes.
 *
 * Behaviour this fixes:
 *
 * - The frame is created on the **first** Share click only, so a page view
 *   costs no frame request, and is then hidden and shown, **never reloaded**.
 *   A mode switch made inside it can therefore not re-run the frame's
 *   `frame-ancestors` check against the page it is on.
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
 * - The popover is **one fixed height** (at most 480 px, less on a short
 *   viewport) and the frame scrolls inside it. The frame never reports its
 *   size: on a public document any page on `openartifacts.site` can embed the
 *   same frame for any document it knows, and the height of what the frame
 *   draws (owner controls, a list of people, or just Copy link) would tell that
 *   page, with no click, whether its visitor manages the document.
 *
 * The URL it is served from is permanent: pinned `/v{n}` pages carry the tag for
 * a year. A fix to this script reaches them by the route's short cache, not by a
 * new address.
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
  const place = () => {
    const box = link.getBoundingClientRect();
    const top = Math.round(box.bottom + 8);
    host.style.top = top + "px";
    host.style.right = Math.max(8, Math.round(window.innerWidth - box.right)) + "px";
    host.style.height = Math.max(120, Math.min(480, window.innerHeight - top - 8)) + "px";
  };
  const build = () => {
    host = document.createElement("div");
    host.className = "openartifacts-share-popover";
    host.setAttribute("style", "all:initial;position:fixed;z-index:2147483647;display:none;box-sizing:border-box;width:min(380px,calc(100vw - 16px));border-radius:12px;background:#fff;box-shadow:0 12px 32px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.08);overflow:hidden");
    const root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
    frame = document.createElement("iframe");
    frame.title = "Share";
    frame.setAttribute("allow", "clipboard-write");
    frame.setAttribute("style", "display:block;width:100%;height:100%;border:0;background:#fff");
    frame.src = api + "/embed/share?doc=" + docId + "&origin=" + encodeURIComponent(window.location.origin);
    fallback = document.createElement("a");
    fallback.href = link.href;
    fallback.target = "_blank";
    fallback.rel = "noopener noreferrer";
    fallback.textContent = "Open sharing settings";
    fallback.setAttribute("style", "display:none;padding:16px;font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f1f1f");
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
  });
  document.addEventListener("keydown", (event) => { if (open && event.key === "Escape") hide(true); }, true);
  document.addEventListener("pointerdown", (event) => { if (open && event.target !== host && !link.contains(event.target)) hide(false); }, true);
  window.addEventListener("resize", () => { if (open) place(); });
})();
`;
