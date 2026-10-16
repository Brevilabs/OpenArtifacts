/**
 * The front-end code for inline comments, in plain strings like
 * `src/embed-scripts.ts` and under the same rules: plain ES2021, no backtick and
 * no `${` inside (a template literal here is `String.raw`, and either would end
 * or interpolate it), and no backslash (a reader should not have to know that
 * `String.raw` keeps it). Where a pattern needs one (Unicode whitespace) the
 * script builds it with `String.fromCharCode`.
 *
 * Two scripts, one on each side of a cross-origin line:
 *
 * - `PAGE_COMMENTS_SCRIPT` runs inside the publisher's page, as the second half
 *   of `PAGE_SCRIPT` (`embed-scripts.ts` joins them, so both share the Share
 *   half's `api`, `docId` and `link`). It holds no credential.
 * - `COMMENTS_FRAME_SCRIPT` runs in the margin's frame on the API host and holds
 *   the reader's token.
 */

/**
 * The comment half of the page script: what the page does when its document has
 * comments on. Everything here is skipped by the Share half's own guards (no
 * Share link, no script) and wrapped so that a throw cannot touch Share.
 *
 * **Inert unless the threads resource answers, and it does not ask when the bar
 * says there is nothing to ask.** On the shared link the bar's Share link carries
 * `data-comments="on|off"`, the document's switch when the page was served: `off`
 * and the script makes no request at all. On `on`, or on a pinned `/v{n}` where
 * the attribute is absent (the page is immutable and must not freeze the switch),
 * its first act is `GET /d/{docId}/threads` on the page's own origin (`404` for
 * every document with comments off, or on a server without them), and on
 * anything but `200` it adds no button, no frame and no listener. The Share
 * popover tells it when its owner flips the switch (`comments` event), which
 * makes it ask again, so the margin appears or goes without a reload.
 *
 * **It paints, it never writes.** Highlights are `CSS.highlights` over Ranges,
 * styled by an adopted stylesheet, so a chart, a React island or a Pyodide cell
 * keeps every node it had. The only things added to the document are the
 * comments button inside our own bar and two hosts on `<html>`, each a closed
 * shadow root (the frame, and the floating **Comment** button).
 *
 * **Canonical text** is what `src/comments/anchor.ts` builds from the stored
 * HTML: the text of `<body>` in document order, with no separator between text
 * nodes, skipping `head`, `script`, `style`, `template` and `noscript` subtrees
 * and our own injections, each text node normalised to NFC with CRLF as LF.
 * Anchors are quotes in that text, and the same ladder (exact with context, then
 * whitespace-collapsed) finds each one again here.
 *
 * **Messages.** To the frame, `{type, event, …}` with the API origin as the
 * target: `threads`, `positions`, `draft`, `focus`, `mode`, `visible`. From it,
 * accepted only from that iframe's window and the API origin: `ready`, `viewer`,
 * `changed`, `focus`, `close`, and three that are layout only and reveal nothing
 * beyond `viewer`: `size` (the height the margin's stacked cards need), `height`
 * (the height of the overlay sheet's content) and `reveal` (where the focused
 * card sits). Nothing in either direction is a credential.
 *
 * **Margin or overlay.** If the author's content leaves 256px at the right of
 * the viewport (the real Copilot export, a 46rem column centred at 1280px, leaves
 * 272) the frame is a column there, as tall as the document or as its stacked
 * cards need if that is taller, so it scrolls with the page, and the cards sit at
 * the heights this script reports in document coordinates. Otherwise, or when the
 * window is not what scrolls the content, the frame is a bottom sheet that is
 * only as tall as its card, shown only for a tapped highlight or a new comment.
 */
export const PAGE_COMMENTS_SCRIPT = String.raw`
  // Comments. See src/comments-scripts.ts.
  try {
  (() => {
    const NS = "openartifacts:comments";
    const WS = new RegExp(String.fromCharCode(92) + "s");
    const CRLF = String.fromCharCode(13, 10), LF = String.fromCharCode(10);
    const FONT = "font:500 13px/1.25 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    const pin = /^[/]d[/][0-9a-z]{16}[/]v([1-9][0-9]{0,8})[/]?$/.exec(location.pathname);
    const painting = typeof Highlight === "function" && window.CSS && CSS.highlights;
    // The version on screen: the path names it on a pinned url, the bar on the shared link. A shared page served before the bar carried it asks the newest.
    let version = pin ? Number(pin[1]) : Number(link.getAttribute("data-version")) || 0;
    let data = null, active = false, shown = true, canComment = false, mode = "margin";
    let mhost = null, mframe = null, ready = false, sheet = false, button = null, tipHost = null, tip = null;
    let canon = null, dirty = true, ranges = new Map(), lost = [], draft = null, draftRange = null, focusId = "", timer = 0;
    let need = 0, sheetH = 0, refreshSeq = 0;
    const out = {};
    const flag = link.getAttribute("data-comments");

    // ---- canonical text ---------------------------------------------------
    const SKIP = ["head", "script", "style", "template", "noscript"];
    const OURS = ["openartifacts-bar", "openartifacts-bar-spacer", "openartifacts-header", "openartifacts-footer"];
    const skipped = (el) => SKIP.includes(el.localName) || OURS.some((name) => el.classList.contains(name));
    // The outermost skipped element at or above a node (below <body>), or null.
    const outermost = (node) => {
      let hit = null;
      for (let n = node; n && n !== document.body; n = n.parentNode) if (n.nodeType === 1 && skipped(n)) hit = n;
      return hit;
    };
    const normalize = (text) => text.split(CRLF).join(LF).normalize("NFC");
    const build = () => {
      let text = "";
      const nodes = [], map = new Map();
      const walker = document.createTreeWalker(document.body, 5, (n) => (n.nodeType === 3 ? 1 : skipped(n) ? 2 : 3));
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType !== 3) continue;
        const raw = n.data, norm = normalize(raw);
        if (norm === "") continue;
        const entry = { node: n, start: text.length, end: text.length + norm.length, raw: raw, same: raw === norm };
        nodes.push(entry);
        map.set(n, entry);
        text += norm;
      }
      canon = { text: text, nodes: nodes, map: map, flat: null };
      dirty = false;
    };
    const normOff = (e, k) => (e.same ? k : normalize(e.raw.slice(0, k)).length);
    const rawOff = (e, k) => {
      if (e.same) return k;
      // The smallest raw prefix whose normalised length reaches k; that length never shrinks as the prefix grows, so a search finds it in n log n, not n squared.
      let lo = 0, hi = e.raw.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (normalize(e.raw.slice(0, mid)).length < k) lo = mid + 1; else hi = mid;
      }
      return lo;
    };
    // The entry holding offset off, or with atEnd the one that ends at or after it.
    const entryAt = (off, atEnd) => {
      let lo = 0, hi = canon.nodes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1, e = canon.nodes[mid];
        if (atEnd ? e.end < off : e.end <= off) lo = mid + 1; else hi = mid;
      }
      return canon.nodes[lo] || null;
    };
    const toRange = (a, b) => {
      const s = entryAt(a, false), e = entryAt(b, true);
      if (!s || !e) return null;
      const range = document.createRange();
      range.setStart(s.node, rawOff(s, a - s.start));
      range.setEnd(e.node, rawOff(e, b - e.start));
      return range;
    };
    // A DOM boundary as an offset in the canonical text, -1 for text that is not the author's.
    const boundary = (c, k) => {
      if (c.nodeType === 3) {
        const e = canon.map.get(c);
        return e ? e.start + normOff(e, k) : -1;
      }
      const probe = document.createRange();
      probe.setStart(c, k);
      probe.collapse(true);
      let lo = 0, hi = canon.nodes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (probe.comparePoint(canon.nodes[mid].node, 0) < 0) lo = mid + 1; else hi = mid;
      }
      return lo < canon.nodes.length ? canon.nodes[lo].start : canon.text.length;
    };

    // ---- the ladder of src/comments/anchor.ts, over the live text -----------
    const occ = (hay, needle) => {
      const found = [];
      if (!needle) return found;
      for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) found.push(i);
      return found;
    };
    const collapse = (t) => {
      let text = "";
      const starts = [], ends = [];
      for (let i = 0; i < t.length;) {
        let j = i + 1;
        if (WS.test(t[i])) { while (j < t.length && WS.test(t[j])) j++; text += " "; } else text += t[i];
        starts.push(i);
        ends.push(j);
        i = j;
      }
      return { text: text, starts: starts, ends: ends };
    };
    const agree = (a, b, fromEnd) => {
      let n = 0;
      while (n < a.length && n < b.length && (fromEnd ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n++;
      return n;
    };
    const inSection = (off, id) => {
      const e = entryAt(off, false);
      for (let el = e && e.node.parentElement; el && el !== document.body; el = el.parentElement) if (el.id === id) return true;
      return false;
    };
    const pick = (text, len, starts, anchor, pre, suf, origin) => {
      if (starts.length < 2) return starts.length ? starts[0] : -1;
      let best = [], top = -1;
      for (const s of starts) {
        const score = agree(text.slice(Math.max(0, s - 32), s), pre, true) + agree(text.slice(s + len, s + len + 32), suf, false);
        if (score > top) { top = score; best = [s]; } else if (score === top) best.push(s);
      }
      if (best.length === 1) return best[0];
      const inside = anchor.section ? best.filter((s) => inSection(origin(s), anchor.section)) : [];
      return inside.length === 1 ? inside[0] : -1;
    };
    const find = (thread, needle) => {
      const anchor = thread.anchor, pre = anchor.prefix || "", suf = anchor.suffix || "";
      const hits = occ(canon.text, needle);
      if (hits.length) {
        const s = pick(canon.text, needle.length, hits, anchor, pre, suf, (i) => i);
        return s < 0 ? null : toRange(s, s + needle.length);
      }
      canon.flat = canon.flat || collapse(canon.text);
      const flat = canon.flat, loose = collapse(needle).text;
      const s = pick(flat.text, loose.length, occ(flat.text, loose), anchor, collapse(pre).text, collapse(suf).text, (i) => flat.starts[i]);
      return s < 0 ? null : toRange(flat.starts[s], flat.ends[s + loose.length - 1]);
    };
    const locate = (thread) => (thread.matchedText && find(thread, thread.matchedText)) || find(thread, thread.anchor.exact);

    // ---- selection ----------------------------------------------------------
    const capture = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      const live = sel.getRangeAt(0);
      const range = live.cloneRange();
      if (!document.body.contains(range.commonAncestorContainer)) return null;
      // A drag that starts in a byline or overshoots into the footer, or a triple-click on the last paragraph (which ends at the footer's start), is clamped to the author's side. A selection wholly inside one skipped subtree, or one that still covers our bar (select-all), is refused. Skipped scripts and styles need no refusal: boundary() already maps both ends onto the canonical text, which leaves them out.
      const cs = outermost(range.startContainer), ce = outermost(range.endContainer);
      if (cs && cs === ce) return null;
      if (cs) range.setStartAfter(cs);
      if (ce) range.setEndBefore(ce);
      if (range.collapsed) return null;
      if (Array.from(document.body.children).some((el) => OURS.some((name) => el.classList.contains(name)) && range.intersectsNode(el))) return null;
      if (dirty || !canon) build();
      let a = boundary(range.startContainer, range.startOffset), b = boundary(range.endContainer, range.endOffset);
      if (a < 0 || b < 0) return null;
      const text = canon.text;
      while (a < b && WS.test(text[a])) a++;
      while (b > a && WS.test(text[b - 1])) b--;
      b = Math.min(b, a + 1000);
      if (b <= a) return null;
      const anchor = { exact: text.slice(a, b), prefix: text.slice(Math.max(0, a - 32), a), suffix: text.slice(b, b + 32) };
      const first = entryAt(a, false);
      for (let el = first && first.node.parentElement; el && el !== document.body; el = el.parentElement) {
        if (el.id && el.id.length <= 128) { anchor.section = el.id; break; }
      }
      return { a: a, b: b, anchor: anchor, rect: live.getClientRects()[live.getClientRects().length - 1] || live.getBoundingClientRect() };
    };

    // ---- the frame ----------------------------------------------------------
    const deliver = (msg) => { if (ready && mframe.contentWindow) mframe.contentWindow.postMessage(Object.assign({ type: NS }, msg), api); };
    const send = (msg) => { out[msg.event] = msg; deliver(msg); };
    const base = "all:initial;direction:ltr;box-sizing:border-box;z-index:2147483000;";
    const rootOf = (el) => (el.attachShadow ? el.attachShadow({ mode: "closed" }) : el);
    const hostOnly = (root, css) => {
      const style = document.createElement("style");
      style.textContent = css;
      root.append(style);
    };
    const buildHost = () => {
      mhost = document.createElement("div");
      mhost.className = "openartifacts-comments";
      mhost.setAttribute("style", base + "display:none");
      const root = rootOf(mhost);
      hostOnly(root, "@media print{:host{display:none!important}}");
      mframe = document.createElement("iframe");
      mframe.title = "Comments";
      mframe.setAttribute("style", "display:block;width:100%;height:100%;border:0;background:transparent;color-scheme:light");
      mframe.src = api + "/embed/comments?doc=" + docId + "&origin=" + encodeURIComponent(window.location.origin) + "&v=" + version;
      root.append(mframe);
      document.documentElement.append(mhost);
    };
    const contentRight = () => {
      let right = 0;
      const vw = viewport().clientWidth;
      for (const el of document.body.children) {
        if (skipped(el)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none") continue;
        const r = el.getBoundingClientRect();
        // A fixed bar across the whole width says nothing about the column; any other fixed box (a contents list, a sidebar) is content the margin must not cover.
        if (cs.position === "fixed" && r.left <= 1 && r.right >= vw - 1) continue;
        if (r.width > 0 || r.height > 0) right = Math.max(right, r.right);
      }
      // A fixed or sticky box nested in the author's column wrapper (a contents list, a sidebar) is content too.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, (n) => (skipped(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT));
      for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        if (el.parentElement === document.body) continue;
        const cs = getComputedStyle(el);
        if ((cs.position !== "fixed" && cs.position !== "sticky") || cs.display === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.left <= 1 && r.right >= vw - 1) continue;
        if (r.width > 0 && r.height > 0) right = Math.max(right, r.right);
      }
      return right;
    };
    // When the window is not what scrolls the content (an inner overflow container), a passage can be out of the viewport while the window has nothing to scroll: document coordinates mean nothing there.
    const innerScrolled = () => {
      const se = document.scrollingElement || document.documentElement;
      if (se.scrollHeight > window.innerHeight + 1) return false;
      for (const range of ranges.values()) {
        const r = range.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) return true;
      }
      return false;
    };
    let visible = null;
    const layout = () => {
      // Measure the page without our own margin column: its height counts toward scrollHeight and would hide an inner scroller.
      // Collapse it, never hide it: a display:none host takes the frame out of rendering, and Chrome then drops the keystroke, or the focus, of a reader typing in a card.
      mhost.style.height = "0";
      const vw = viewport().clientWidth, right = contentRight();
      const next = vw - right >= 256 && !innerScrolled() ? "margin" : "overlay";
      if (next !== mode) { mode = next; need = 0; sheetH = 0; send({ event: "mode", mode: mode }); if (button) label(); }
      // The host is a child of <html>, so an html{zoom} would multiply every length written below; cancel it.
      const z = document.documentElement.currentCSSZoom || 1;
      const flat = base + (z !== 1 ? "zoom:" + 1 / z + ";" : "");
      if (!active || !shown) {
        mhost.style.display = "none";
        if (visible !== false) { visible = false; send({ event: "visible", shown: false }); }
        return;
      }
      const now = mode === "margin" || sheet;
      if (now !== visible) { visible = now; send({ event: "visible", shown: now }); }
      if (mode === "margin") {
        // The cards may need more than the document is tall; the host then extends the page, so they can be reached by scrolling it.
        const height = Math.round(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) * z);
        mhost.setAttribute("style", flat + "display:block;position:absolute;top:0;left:" + Math.round(right + 16 + window.pageXOffset) + "px;width:" + Math.round(Math.min(320, vw - right - 24)) + "px;height:" + Math.max(height, need) + "px");
      } else {
        const phone = vw <= 600;
        mhost.setAttribute("style", flat + "position:fixed;bottom:0;height:" + (sheetH ? "min(" + sheetH + "px,55vh,560px)" : "min(55vh,560px)") + ";opacity:" + (unsure && !sheetH ? "0" : "1") + ";display:" + (sheet ? "block" : "none") +
          ";border-radius:18px 18px 0 0;overflow:hidden;background:#f6f2e9;box-shadow:0 -8px 32px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.08);" +
          (phone ? "left:0;right:0" : "right:16px;width:420px;max-width:calc(100vw - 32px);border-radius:18px 18px 0 0"));
      }
    };
    const measure = () => {
      timer = 0;
      if (!active) return;
      if (dirty || !canon) { locateAll(); if (button) label(); }
      layout();
      if (mode === "margin" && shown) {
        const top = mhost.getBoundingClientRect().top + window.pageYOffset, tops = {}, none = lost.slice();
        ranges.forEach((range, id) => {
          const rects = range.getClientRects();
          if (rects.length) tops[id] = Math.round(rects[0].top + window.pageYOffset - top); else none.push(id);
        });
        send({ event: "positions", tops: tops, lost: none, height: Math.round(mhost.getBoundingClientRect().height) });
      }
    };
    const schedule = () => { if (!timer) timer = window.setTimeout(measure, 80); };

    // ---- highlights ---------------------------------------------------------
    const byId = (id) => (data ? data.threads.find((t) => t.threadId === id) : undefined);
    const paint = () => {
      if (!painting) return;
      const groups = { "openartifacts-open": [], "openartifacts-resolved": [], "openartifacts-focus": [], "openartifacts-draft": [] };
      if (active && shown) {
        ranges.forEach((range, id) => groups[byId(id).state === "resolved" ? "openartifacts-resolved" : "openartifacts-open"].push(range));
        if (focusId && ranges.has(focusId)) groups["openartifacts-focus"].push(ranges.get(focusId));
        if (draftRange) groups["openartifacts-draft"].push(draftRange);
      }
      Object.keys(groups).forEach((name, i) => {
        if (!groups[name].length) { CSS.highlights.delete(name); return; }
        const h = new Highlight(...groups[name]);
        h.priority = i;
        CSS.highlights.set(name, h);
      });
    };
    const locateAll = () => {
      if (dirty || !canon) build();
      ranges = new Map();
      lost = [];
      for (const thread of data ? data.threads : []) {
        if (thread.anchorStatus !== "anchored") continue;
        const range = locate(thread);
        if (range) ranges.set(thread.threadId, range); else lost.push(thread.threadId);
      }
    };

    // ---- the bar's button ---------------------------------------------------
    const label = () => {
      // What this mode can show: the bottom sheet opens only from a highlight, so a thread whose text is gone is not counted there.
      const n = data ? data.threads.filter((t) => t.state === "open" && (mode !== "overlay" || ranges.has(t.threadId))).length : 0;
      button.textContent = String.fromCodePoint(0x1F4AC) + " " + n;
      button.setAttribute("aria-label", "Comments, " + n + " open");
      button.setAttribute("aria-pressed", String(shown));
      button.title = shown ? "Hide comments" : "Show comments";
      // Pressed is Share's own pill (#1d2027), released the strip's own colour
      // (#0b0c10), painted rather than transparent: page.js is short-cached but a
      // pinned /v{n} is immutable for a year, so this button also lands on bars
      // rendered before the dark strip (light, #fbfbfa) and must read there too.
      button.style.background = shown ? "#1d2027" : "#0b0c10";
      button.style.color = shown ? "#f4f5f7" : "#c9ced6";
    };
    const makeButton = () => {
      button = document.createElement("button");
      button.type = "button";
      // A pill beside Share's, in its shape and edge: 34px, fully rounded, a hairline
      // border, Share's 14px type. Hover and focus are OPENARTIFACTS_BAR_STYLE's
      // (src/render.ts), keyed on the class.
      button.className = "openartifacts-comments-button";
      button.setAttribute("style", "all:initial;flex:none;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 14px;margin-left:auto;border:1px solid rgba(255,255,255,0.08);border-radius:999px;color:#c9ced6;cursor:pointer;white-space:nowrap;-webkit-font-smoothing:antialiased;" + FONT.replace("13px/1.25", "14px/1"));
      button.addEventListener("click", () => {
        shown = !shown;
        if (!shown) { sheet = false; hideTip(); }
        label();
        paint();
        measure();
      });
      link.parentNode.insertBefore(button, link);
    };

    // ---- the Comment button on a selection ----------------------------------
    const hideTip = () => { if (tipHost) tipHost.style.display = "none"; };
    const refreshTip = () => {
      if (!active || !shown || !canComment) { hideTip(); return; }
      const cap = capture();
      if (!cap) { hideTip(); return; }
      if (!tipHost) {
        tipHost = document.createElement("div");
        tipHost.className = "openartifacts-comment-tip";
        tipHost.setAttribute("style", "all:initial;position:fixed;z-index:2147483646;display:none");
        const root = rootOf(tipHost);
        hostOnly(root, "@media print{:host{display:none!important}}");
        tip = document.createElement("button");
        tip.type = "button";
        tip.textContent = "Comment";
        tip.setAttribute("style", "all:initial;box-sizing:border-box;display:block;padding:7px 12px;border-radius:9px;background:#18191d;color:#fff;cursor:pointer;user-select:none;box-shadow:0 4px 14px rgba(0,0,0,.3);" + FONT);
        tip.addEventListener("mousedown", (event) => event.preventDefault());
        tip.addEventListener("click", startDraft);
        root.append(tip);
        document.documentElement.append(tipHost);
      }
      const r = cap.rect;
      const above = r.top - 40 >= 48;
      // The tip is a child of <html>: under html{zoom} its lengths are multiplied, so convert viewport px to zoomed px.
      const z = document.documentElement.currentCSSZoom || 1;
      tipHost.style.left = Math.round(Math.max(8, Math.min(r.right - 40, viewport().clientWidth * z - 100)) / z) + "px";
      tipHost.style.top = Math.round((above ? r.top - 40 : r.bottom + 8) / z) + "px";
      tipHost.style.display = "block";
    };
    const startDraft = () => {
      const cap = capture();
      if (!cap) return;
      draftRange = toRange(cap.a, cap.b);
      draft = cap.anchor;
      hideTip();
      window.getSelection().removeAllRanges();
      const top = draftRange.getClientRects()[0] || draftRange.getBoundingClientRect();
      send({ event: "draft", anchor: draft, top: Math.round(top.top + window.pageYOffset - (mhost.getBoundingClientRect().top + window.pageYOffset)) });
      if (mode === "overlay") { openSheet(); reveal(draftRange); }
      paint();
    };
    const endDraft = () => { draft = null; draftRange = null; send({ event: "draft", anchor: null, top: 0 }); paint(); };

    // ---- the overlay sheet --------------------------------------------------
    // The sheet is invisible until the frame has said how tall its card is (or 300ms have passed), so it opens at its size and does not shrink under the reader's finger.
    let unsure = false;
    const openSheet = () => {
      if (!sheet && !sheetH) { unsure = true; window.setTimeout(() => { unsure = false; if (sheet) layout(); }, 300); }
      sheet = true;
      layout();
    };
    // Scroll the passage out from under the sheet, unless it is already clear of it. Call after openSheet, whose layout sets the height this reads.
    const reveal = (range) => {
      if (mode !== "overlay" || !range) return;
      const rect = range.getBoundingClientRect();
      const limit = window.innerHeight - mhost.getBoundingClientRect().height - 8;
      if (rect.top >= 48 && rect.bottom <= limit) return;
      window.scrollTo({ top: Math.max(0, rect.top + window.pageYOffset - window.innerHeight * 0.15), behavior: "smooth" });
    };
    const closeSheet = () => {
      if (!sheet) return;
      sheet = false;
      sheetH = 0;
      focusId = "";
      send({ event: "focus", threadId: "" });
      layout();
      paint();
    };

    // ---- data ---------------------------------------------------------------
    const refresh = async () => {
      const mine = ++refreshSeq;
      let response, body;
      try {
        response = await fetch("/d/" + docId + "/threads" + (version ? "?v=" + version : ""), { credentials: "same-origin", cache: "no-store" });
        body = response.status === 200 ? await response.json() : null;
      } catch (error) { return; }
      // A poll that overlaps the read after a write can answer last: only the newest read may paint, as in the frame's load.
      if (mine !== refreshSeq) return;
      if (response.status === 404 || response.status === 410) { if (active) deactivate(); return; }
      if (!body || !Array.isArray(body.threads)) return;
      if (!version) version = body.version;
      data = body;
      if (!active) activate();
      locateAll();
      label();
      button.style.display = "inline-flex";
      send({ event: "threads", data: data, version: version });
      paint();
      measure();
    };
    const deactivate = () => {
      active = false;
      button.style.display = "none";
      mhost.style.display = "none";
      hideTip();
      paint();
    };
    const activate = () => {
      active = true;
      if (button) return;
      makeButton();
      buildHost();
      window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 30000);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
      window.addEventListener("resize", schedule);
      window.addEventListener("load", schedule);
      window.addEventListener("scroll", () => { if (tipHost && tipHost.style.display === "block") refreshTip(); }, { passive: true });
      // With html,body{height:100%} the body's own box never changes, so the author's top-level boxes are watched too; a <details> opening, a late image and a class or style flip move text without touching the body.
      if (window.ResizeObserver) {
        const watch = new ResizeObserver(schedule);
        watch.observe(document.body);
        watch.observe(document.documentElement);
        for (const el of document.body.children) if (!skipped(el)) watch.observe(el);
      }
      if (window.MutationObserver) {
        new MutationObserver((records) => {
          const theirs = records.filter((r) => !link.parentNode.contains(r.target));
          if (!theirs.length) return;
          if (theirs.some((r) => r.type !== "attributes")) dirty = true;
          schedule();
        }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open", "hidden", "class", "style"] });
      }
      document.addEventListener("toggle", schedule, true);
      document.addEventListener("load", schedule, true);
      document.addEventListener("scroll", (event) => { if (event.target !== document) schedule(); }, { capture: true, passive: true });
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
      let settle = 0;
      document.addEventListener("selectionchange", () => { window.clearTimeout(settle); settle = window.setTimeout(refreshTip, 150); });
      link.addEventListener("click", closeSheet);
      document.addEventListener("keydown", (event) => { if (sheet && event.key === "Escape") { endDraft(); closeSheet(); } }, true);
      document.addEventListener("pointerdown", (event) => {
        // A draft is the reader's own words and the sheet covers half the page: a touch on the page above it (to scroll back to the passage) must not throw them away. Cancel, the close button, Escape and a post end it.
        if (sheet && !draft && event.target !== mhost && event.target !== tipHost) closeSheet();
      }, true);
      document.addEventListener("click", (event) => {
        if (!active || !shown || event.button !== 0 || ranges.size === 0) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        let node, offset;
        if (document.caretPositionFromPoint) {
          const p = document.caretPositionFromPoint(event.clientX, event.clientY);
          if (p) { node = p.offsetNode; offset = p.offset; }
        } else if (document.caretRangeFromPoint) {
          const r = document.caretRangeFromPoint(event.clientX, event.clientY);
          if (r) { node = r.startContainer; offset = r.startOffset; }
        }
        if (!node || node.nodeType !== 3) return;
        for (const [id, range] of ranges) {
          if (range.isPointInRange(node, offset)) {
            if (draft) endDraft();
            focusId = id;
            send({ event: "focus", threadId: id });
            if (mode === "overlay") { openSheet(); reveal(range); }
            paint();
            return;
          }
        }
      });
      window.addEventListener("message", (event) => {
        if (!mframe || event.source !== mframe.contentWindow || event.origin !== api) return;
        const msg = event.data;
        if (msg === null || typeof msg !== "object" || msg.type !== NS) return;
        if (msg.event === "ready") {
          ready = true;
          schedule();
          ["mode", "visible", "threads", "positions", "draft", "focus"].forEach((name) => { if (out[name]) deliver(out[name]); });
        } else if (msg.event === "viewer") {
          canComment = msg.canComment !== false;
          if (!canComment) hideTip();
        } else if (msg.event === "changed") {
          if (draft) endDraft();
          refresh();
        } else if (msg.event === "focus" && typeof msg.threadId === "string") {
          focusId = msg.threadId;
          send({ event: "focus", threadId: focusId });
          if (mode === "overlay") { openSheet(); reveal(ranges.get(focusId)); }
          paint();
        } else if (msg.event === "size" && Number.isFinite(msg.height)) {
          const n = Math.max(0, Math.min(Math.round(msg.height), 1000000));
          if (mode === "margin" && n !== need) { need = n; schedule(); }
        } else if (msg.event === "height" && Number.isFinite(msg.px)) {
          const n = Math.max(80, Math.min(Math.round(msg.px), 4000));
          if (n !== sheetH || unsure) { sheetH = n; unsure = false; if (sheet) layout(); }
        } else if (msg.event === "reveal" && Number.isFinite(msg.top) && Number.isFinite(msg.height)) {
          if (mode !== "margin" || !shown) return;
          const t = mhost.getBoundingClientRect().top + msg.top;
          if (t < 48 || t + msg.height > window.innerHeight) window.scrollTo({ top: Math.max(0, t + window.pageYOffset - window.innerHeight * 0.15), behavior: "smooth" });
        } else if (msg.event === "close") {
          if (draft) endDraft();
          focusId = "";
          send({ event: "focus", threadId: "" });
          if (mode === "overlay") closeSheet();
          paint();
        }
      });
      if (painting) {
        try {
          const sheetCss = new CSSStyleSheet();
          sheetCss.replaceSync("::highlight(openartifacts-open){background-color:rgba(94,200,160,.28);text-decoration:underline;text-decoration-color:#16786a;text-decoration-thickness:2px}" +
            "::highlight(openartifacts-resolved){background-color:rgba(140,140,140,.18);text-decoration:underline;text-decoration-color:rgba(110,110,110,.7)}" +
            "::highlight(openartifacts-focus){background-color:rgba(94,200,160,.5)}" +
            "::highlight(openartifacts-draft){background-color:rgba(255,179,138,.45)}");
          document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheetCss]);
        } catch (error) {}
      }
    };
    commentsSwitched = () => { refresh(); };
    if (flag !== "off") refresh();
  })();
  } catch (error) {}
`;

/**
 * The margin frame's stylesheet (`src/comments/frame.ts` puts it in the shell).
 * Two layouts of the same cards, chosen by a class on `<main>` that the page
 * script's `mode` message sets: `margin`, where `.cards` is as tall as the
 * document and every card is absolutely positioned by the script at the height
 * of its passage, and `overlay`, a bottom sheet with one card in normal flow.
 * The frame's own background is transparent in the margin, so the page shows
 * through between cards; the colours are the design mockups' (green for open
 * and for the focused card, a violet badge for an agent, grey for resolved).
 */
export const COMMENTS_FRAME_CSS = `:root{color-scheme:light;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#18191d;background:transparent}
*{box-sizing:border-box}html,body{height:100%;margin:0;background:transparent}
[hidden]{display:none!important}
html:has(main.margin),html:has(main.margin) body{overflow:hidden}
main.margin{min-height:100%}
main.overlay{background:#f6f2e9;padding:6px 14px 18px}
.cards{position:relative}
.card{background:#fffdf8;border:1px solid #cbbfa8;border-radius:12px;padding:10px 12px;box-shadow:0 1px 2px rgba(40,30,10,.12),0 14px 28px -20px rgba(40,30,10,.4)}
.margin .card,.margin .heading{position:absolute;left:4px;right:10px}
.card.focus{border-color:#16786a;box-shadow:0 0 0 3px #dcf0ea,0 1px 2px rgba(40,30,10,.12)}
.card.muted{background:#f4f1ea;border-color:#ddd5c4}
.card.muted .quote{color:#8f8a7e;border-left-color:#ddd5c4}
.card.resolved{background:#f4f1ea;border-color:#ddd5c4}
.heading{font:10px/1.4 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:.1em;text-transform:uppercase;color:#6d6a62;background:#fffdf8;border:1px solid #ddd5c4;border-radius:6px;padding:2px 6px}
.margin .heading{right:auto}
.grab{display:flex;align-items:center;justify-content:center;position:relative;height:22px}
.grab i{width:36px;height:4px;border-radius:2px;background:#cbbfa8}
.grab .x{position:absolute;right:0;top:0;border:0;background:none;font-size:20px;line-height:1;color:#6d6a62;cursor:pointer;padding:0 6px}
.quote{font-size:11.5px;color:#6d6a62;border-left:2px solid #cbbfa8;padding-left:7px;margin:0 0 8px;font-style:italic;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.where{font-size:11.5px;color:#6d6a62;margin:0 0 6px}
.who{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;font-weight:700;font-size:12.5px;min-width:0}
.who small{font-weight:400;color:#6d6a62;white-space:nowrap}
.av{width:20px;height:20px;border-radius:50%;display:inline-grid;place-items:center;font-size:10px;font-weight:700;color:#1b1b1b;background:#9fd6c9;flex:none}
.av.agent{background:#c9b8f0}
.badge{font:9.5px/1.4 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:.05em;text-transform:uppercase;padding:1px 6px;border-radius:999px;font-weight:600;background:#fbe3d8;color:#b03d1b}
.badge{white-space:nowrap}
.badge.done{background:#ece7da;color:#6d6a62;border:1px solid #ddd5c4}
.badge.open{background:#dcf0ea;color:#16786a}
.txt{margin:3px 0 8px 26px;white-space:pre-wrap;overflow-wrap:anywhere}
.acts{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:0 0 6px;font-size:11.5px;color:#6d6a62}
.acts button,button.link{border:0;background:none;padding:0;font:inherit;color:inherit;cursor:pointer}
.acts button:hover,button.link:hover{color:#18191d;text-decoration:underline}
.acts button.danger{color:#b4342b;font-weight:600}
.who button.link{margin-left:auto;font-weight:400;font-size:11.5px;color:#6d6a62}
.line{display:flex;align-items:center;gap:6px;width:100%;border:0;background:none;padding:0;font:inherit;font-size:12px;color:#6d6a62;cursor:pointer;text-align:left}
.line span{min-width:0;overflow-wrap:anywhere}
.line .badge{flex:none}
textarea,input{width:100%;font:inherit;border:1px solid #cbbfa8;border-radius:9px;padding:8px 10px;background:#f7f4ec;color:inherit}
textarea{resize:vertical;min-height:34px}
textarea:focus,input:focus{outline:2px solid #16786a;outline-offset:-1px;background:#fff}
.btns{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
button.b{font:inherit;font-size:12px;font-weight:650;padding:5px 11px;border-radius:8px;border:1px solid #cbbfa8;background:#fffdf8;color:#18191d;cursor:pointer}
button.b:hover{border-color:#8f8670}button.b:disabled{cursor:default;opacity:.55}
button.b.primary{background:#18191d;border-color:#18191d;color:#fff}
.muted-text{font-size:11.5px;color:#6d6a62;margin:6px 0 0}
.err{font-size:11.5px;color:#b4342b;margin:6px 0 0}.err:empty{display:none}
.ask{font-size:12px;margin:0 0 6px}
.signin{margin-top:6px}
`;

/**
 * The margin frame's script (`GET /embed/comments`). It draws the cards, holds
 * the reader's token and does the writing, so it is written as the least
 * trusting code can be, like the Share popover's: DOM built only with
 * `createElement` and `textContent` (never `innerHTML`, so a comment is only
 * ever text), no `<form>`, and no `id` on any element it draws (an id is a
 * fragment an embedding page can navigate the frame to, and whether the browser
 * then focuses something would show that page which view this is).
 *
 * **Where it gets cards.** From `/embed/api/docs/{doc}/threads` with its token,
 * which also tells it who is looking (`viewer`, `canResolve`, `mine`). With no
 * token it reads the same resource anonymously (a public document answers), and
 * that read is also its own. Only when it has neither (a private document, for a
 * reader who has not signed in to the API host) does it draw the `threads` JSON
 * the page relays from the serving origin, read-only, and then without any
 * author's name or agent badge and with a line saying to sign in for them: the
 * page is the author's, so what it relays could be invented, and must not appear
 * under real names beside our Sign in button. An own read always replaces it.
 * Relayed data is only ever drawn as text; the title shown above a new comment
 * is the server's whenever the frame has a token, and nothing a page sends can
 * post: every write goes to `/embed/api` for this one document.
 *
 * **What it tells the page.** `ready`, once, before it touches storage; `viewer`
 * with `{canComment}` after every read (true when signed out, so Comment is
 * offered and asks to sign in); `changed` after its own
 * write; `focus` when a card is pressed; `close` from a user action. Nothing
 * else about the viewer.
 *
 * **Signing in** is the Share popover's own handshake, copied: a nonce only this
 * frame knows, its hash in the popup's address, collected by polling
 * `POST /embed/token`. The token is stored under the Share frame's key, so one
 * sign-in serves both.
 */
export const COMMENTS_FRAME_SCRIPT = String.raw`(() => {
  "use strict";
  const main = document.querySelector("main");
  const cards = main.firstElementChild;
  const doc = main.dataset.doc;
  const parentOrigin = main.dataset.origin;
  const NS = "openartifacts:comments";
  const KEY = "openartifacts:share-token:" + doc;
  const SIGNIN_WINDOW_MS = 10 * 60 * 1000;
  const wanted = new URLSearchParams(location.search).get("v") || "";
  const pinned = /^[1-9][0-9]{0,8}$/.test(wanted) ? Number(wanted) : 0;

  const post = (msg) => {
    if (parentOrigin && window.parent !== window) window.parent.postMessage(Object.assign({ type: NS }, msg), parentOrigin);
  };
  post({ event: "ready" });

  const node = (tag, attrs, kids) => {
    const element = document.createElement(tag);
    for (const name of Object.keys(attrs || {})) {
      const value = attrs[name];
      if (value === null || value === undefined) continue;
      if (name.startsWith("on")) element.addEventListener(name.slice(2), value);
      else element.setAttribute(name, value);
    }
    for (const kid of kids || []) element.append(kid);
    return element;
  };
  const button = (label, onclick, cls) => node("button", { type: "button", class: cls || "b", onclick: onclick }, [label]);

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

  let mode = "margin", shown = true, relayed = null, own = null, anon = null, loaded = false, tops = null, lostIds = [], height = 0;
  let draft = null, draftTop = 0, focusId = "", loadSeq = 0, lastViewer = null, positionsKey = "";
  let signState = "", prepared = null, opened = null, generation = 0, wake = null;
  let confirming = "", needName = "", nameText = "", pending = null;
  let modelKey = "", inFlight = false, lastLoad = 0, composing = false, owed = false, stacked = [], sentNeed = -1;
  const expanded = new Set(), texts = {}, errors = {}, busy = {};

  // Its own read (a token's, else the anonymous one a public document answers) wins; the page's relay is drawn only when neither answered, and then without names.
  const model = () => own || anon || (loaded ? relayed : null);
  const relayedOnly = () => own === null && anon === null;
  const viewer = () => (own && own.viewer) || null;
  const titleOf = () => { const m = model(); return m && typeof m.title === "string" ? m.title : ""; };
  const versionOf = () => { const m = model(); return m && typeof m.version === "number" ? m.version : 0; };
  const text = (value) => (typeof value === "string" ? value : "");
  // The top bar is fixed over the first 48px of the document, so no card starts above it.
  const BAR = 48;

  // ---- the token and the sign-in handshake (the Share frame's, copied) ----
  const prepare = () => {
    const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce)).then((digest) => {
      prepared = { nonce: nonce, h: bytesToHex(new Uint8Array(digest)) };
      render();
    });
  };
  const accept = (token, expiresAt) => {
    generation += 1;
    wake = null;
    signState = "";
    writeToken({ token: token, expiresAt: expiresAt });
    load();
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
    let working = false;
    const tick = async () => {
      if (working || mine !== generation) return;
      window.clearTimeout(timer);
      if (Date.now() > deadline) { wake = null; signState = ""; render(); return; }
      working = true;
      const found = await claim(nonce, mine);
      working = false;
      if (!found && mine === generation) timer = window.setTimeout(tick, 2000);
    };
    timer = window.setTimeout(tick, 1000);
    wake = () => { if (mine === generation && document.visibilityState === "visible") tick(); };
  };
  document.addEventListener("visibilitychange", () => { if (wake) wake(); });
  window.addEventListener("focus", () => { if (wake) wake(); });
  const signIn = () => {
    const taken = prepared;
    if (taken === null) return;
    prepared = null;
    prepare();
    opened = window.open("/embed/sign-in?doc=" + doc + "&h=" + taken.h, "_blank", "popup,width=480,height=720");
    if (opened === null) { signState = "blocked"; render(); return; }
    signState = "waiting";
    render();
    poll(taken.nonce);
  };
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (opened === null || event.source !== opened || event.origin !== location.origin) return;
    if (data === null || typeof data !== "object" || data.type !== "openartifacts:share-token" || data.doc !== doc) return;
    if (typeof data.token !== "string" || typeof data.expiresAt !== "number") return;
    accept(data.token, data.expiresAt);
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    if (readToken() !== null) { generation += 1; wake = null; signState = ""; }
    load();
  });

  // ---- the API ----
  const call = async (method, path, body) => {
    const stored = readToken();
    if (stored === null) return { status: 401, body: null };
    const headers = { authorization: "Bearer " + stored.token };
    if (body) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: "omit", cache: "no-store" });
    } catch (error) {
      return { status: 0, body: null };
    }
    let parsed = null;
    try { parsed = response.status === 204 ? null : await response.json(); } catch (error) {}
    if (response.status === 401) { writeToken(null); own = null; }
    return { status: response.status, body: parsed };
  };
  const docPath = (suffix) => "/embed/api/docs/" + doc + suffix;
  const failure = (result) => {
    const error = result.body && result.body.error;
    if (result.status === 401) return "Sign in again to comment.";
    if (result.status === 404) return "This page can’t be commented on.";
    if (error && error.code === "anchor_not_found") return "That text isn’t in the document itself, perhaps because the page draws it with a script. Select text from the page’s own content. Nothing was posted.";
    return error && typeof error.message === "string" ? error.message : "Something went wrong. Nothing was posted.";
  };
  // Always tells the page: signed out it offers Comment (pressing it asks to sign in), signed in it follows the server's word.
  const reportViewer = () => {
    const v = viewer();
    const can = v ? v.canComment === true : readToken() === null;
    if (can !== lastViewer) {
      lastViewer = can;
      post({ event: "viewer", canComment: can });
    }
  };
  // Draws only when the data changed: a poll that finds nothing new must not rebuild the box someone is typing in.
  const refreshView = () => {
    const key = (own ? "own" : anon ? "anon" : "relay") + JSON.stringify(model());
    if (key === modelKey) return;
    modelKey = key;
    render();
  };
  const threadsQuery = pinned ? "?v=" + pinned : "";
  const readAnonymous = async () => {
    try {
      const response = await fetch(docPath("/threads" + threadsQuery), { credentials: "omit", cache: "no-store" });
      const body = response.status === 200 ? await response.json() : null;
      return body && Array.isArray(body.threads) ? body : null;
    } catch (error) {
      return null;
    }
  };
  const load = async () => {
    const mine = ++loadSeq;
    inFlight = true;
    lastLoad = Date.now();
    const result = readToken() === null ? null : await call("GET", docPath("/threads" + threadsQuery));
    const nextOwn = result && result.status === 200 && result.body && Array.isArray(result.body.threads) ? result.body : null;
    // No own read (no token, or one that was refused): the anonymous read a public document answers.
    const nextAnon = nextOwn === null ? await readAnonymous() : null;
    if (mine !== loadSeq) return;
    inFlight = false;
    own = nextOwn;
    anon = nextAnon;
    loaded = true;
    reportViewer();
    refreshView();
  };

  // Runs one write, then reloads the cards and tells the page. A human who has no display name yet is asked for it once and the write is retried.
  const act = async (key, request, done) => {
    if (busy[key]) return;
    busy[key] = true;
    errors[key] = "";
    render();
    const result = await request();
    busy[key] = false;
    if (result.status >= 200 && result.status < 300) {
      if (done) done(result.body);
      await load();
      render();
      post({ event: "changed" });
      if (focusId) post({ event: "focus", threadId: focusId });
      return;
    }
    const error = result.body && result.body.error;
    if (result.status === 409 && error && error.code === "name_required") {
      needName = key;
      pending = () => act(key, request, done);
    } else errors[key] = failure(result);
    render();
  };
  const saveName = async () => {
    const name = nameText.trim();
    const key = needName;
    if (name === "" || name.length > 64) { errors[key] = "Enter a name of up to 64 characters."; render(); return; }
    const result = await call("PUT", "/embed/api/account", { displayName: name });
    if (result.status !== 200) { errors[key] = failure(result); render(); return; }
    const retry = pending;
    needName = "";
    pending = null;
    if (retry) await retry();
  };

  // ---- drawing ----
  const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " m";
    if (s < 86400) return Math.floor(s / 3600) + " h";
    return Math.floor(s / 86400) + " d";
  };
  const muted = (value) => node("p", { class: "muted-text" }, [value]);
  const errorLine = (key) => node("p", { class: "err", role: "alert" }, errors[key] ? [errors[key]] : []);
  // Relayed data is the page's word, so under it nobody has a name or a badge: a page can make up a comment, not a commenter.
  const authorOf = (a) => (relayedOnly() ? { name: "A commenter", agent: false } : { name: text(a && a.name) || "Someone", agent: !!a && a.kind === "agent" });
  const who = (author, at) => {
    const a = authorOf(author);
    const kids = [node("span", { class: a.agent ? "av agent" : "av" }, [(a.name.trim()[0] || "?").toUpperCase()]), a.name];
    if (a.agent) kids.push(node("span", { class: "badge" }, ["agent"]));
    if (typeof at === "number") kids.push(node("small", {}, [ago(at)]));
    return node("div", { class: "who" }, kids);
  };

  const signInBlock = () => {
    const kids = [button("Sign in to comment", signIn, "b primary")];
    kids[0].disabled = prepared === null;
    if (signState === "waiting") kids.push(muted("Complete sign-in in the window that opened."));
    if (signState === "blocked") kids.push(node("p", { class: "err" }, ["Your browser blocked the sign-in window. Allow pop-ups for this page and try again."]));
    return node("div", { class: "signin" }, kids);
  };

  // The box a person writes in: a textarea and its buttons, the name field a first comment may ask for, or the reason there is none.
  const writer = (key, placeholder, submit, cancel) => {
    if (readToken() === null) return [signInBlock()];
    const v = viewer();
    if (v === null) return [];
    if (!v.canComment) return [muted("You can view this page.")];
    if (needName === key) {
      const input = node("input", { type: "text", maxlength: "64", placeholder: "Your name", "aria-label": "Your name", "data-key": key + ":name", autocomplete: "name" });
      input.value = nameText;
      input.addEventListener("input", () => { nameText = input.value; });
      input.addEventListener("keydown", (event) => { if (event.key === "Enter") saveName(); });
      const back = () => { needName = ""; pending = null; nameText = ""; errors[key] = ""; render(); };
      input.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.stopPropagation(); back(); } });
      return [node("p", { class: "ask" }, ["Add your name so people know who is commenting."]), input, node("div", { class: "btns" }, [button("Cancel", back), button("Save and post", saveName, "b primary")]), errorLine(key)];
    }
    const area = node("textarea", { rows: cancel ? "3" : "1", maxlength: "4000", placeholder: placeholder, "aria-label": placeholder, "data-key": key });
    area.value = texts[key] || "";
    const send = button("Post", submit, "b primary");
    const actions = node("div", { class: "btns" }, cancel ? [button("Cancel", cancel), send] : [send]);
    // The box's height changes when the buttons appear; the card observer re-stacks. Posting takes a click on Post: a keystroke that lands in this frame some other way must never send.
    const sync = () => { send.disabled = area.value.trim() === "" || !!busy[key]; actions.hidden = !cancel && area.value === ""; };
    area.addEventListener("input", () => { texts[key] = area.value; sync(); });
    area.addEventListener("compositionstart", () => { composing = true; });
    area.addEventListener("compositionend", () => { composing = false; if (owed) { owed = false; render(); } });
    sync();
    return [area, actions, errorLine(key)];
  };

  const focusThread = (id) => {
    if (focusId === id) return;
    focusId = id;
    for (const element of cards.querySelectorAll("[data-thread]")) element.classList.toggle("focus", element.dataset.thread === id);
    post({ event: "focus", threadId: id });
  };

  // One comment: who and when (a reply's Delete sits there, after the time), then its text. A first comment's Delete belongs to the thread's action row.
  const commentRow = (thread, comment, index) => {
    const w = who(comment.author, comment.createdAt);
    if (index === 0 && thread.state !== "resolved") w.insertBefore(node("span", { class: "badge open" }, ["open"]), w.querySelector("small"));
    const id = text(comment.commentId);
    const kids = [w];
    // Only the authenticated read may enable a write control: relayed data is the page's, and the page is not trusted.
    if (own !== null && comment.mine && index > 0) {
      w.append(button("Delete", () => act("c:" + id, () => call("DELETE", docPath("/comments/" + encodeURIComponent(id))), null), "link"));
    }
    kids.push(node("div", { class: "txt" }, [text(comment.body)]));
    if (index > 0 && errors["c:" + id]) kids.push(errorLine("c:" + id));
    return kids;
  };

  const threadCard = (thread, orphan, alone) => {
    const id = text(thread.threadId);
    const resolved = thread.state === "resolved";
    const res = resolved && thread.resolution ? thread.resolution : null;
    const by = res ? authorOf(res.by).name : "";
    // Typed, not concatenated: a relayed atVersion is the page's, and a string there could write its own "by" into the summary.
    const at = res && Number.isInteger(res.atVersion) && res.atVersion > 0 ? res.atVersion : 0;
    const resolvedIn = at ? "Resolved in v" + at : "Resolved";
    const summary = res ? resolvedIn + (relayedOnly() ? "" : " by " + by) : "Resolved";
    const card = node("div", { class: "card" + (resolved ? " resolved" : "") + (orphan ? " muted" : "") + (focusId === id ? " focus" : ""), "data-thread": id });
    card.addEventListener("mousedown", () => focusThread(id));
    if (resolved && !expanded.has(id) && !alone) {
      card.append(button("", () => { expanded.add(id); render(); }, "line"));
      card.firstChild.replaceChildren(node("span", { class: "badge done" }, ["✓"]), node("span", {}, [summary]));
      return card;
    }
    const quote = text(thread.anchor && thread.anchor.exact);
    card.append(node("div", { class: "quote" }, [quote]));
    const comments = Array.isArray(thread.comments) ? thread.comments : [];
    comments.forEach((comment, index) => card.append(...commentRow(thread, comment, index)));
    const first = comments[0];
    const firstId = first ? text(first.commentId) : "";
    const canDelete = own !== null && !!first && first.mine === true;
    const canResolve = own !== null && thread.canResolve === true;
    const acts = [];
    if (canDelete && confirming === firstId) {
      acts.push("Delete this thread?",
        button("Delete", () => { confirming = ""; act("c:" + firstId, () => call("DELETE", docPath("/comments/" + encodeURIComponent(firstId))), null); }, "link danger"),
        button("Keep", () => { confirming = ""; render(); }, "link"));
    } else {
      if (resolved) {
        acts.push(node("span", { class: "badge done" }, [resolvedIn]));
        if (canResolve) acts.push(button("Reopen", () => act("t:" + id, () => call("POST", docPath("/threads/" + encodeURIComponent(id) + "/reopen"), { version: versionOf() || undefined }), null), "link"));
        if (!alone) acts.push(button("Hide", () => { expanded.delete(id); render(); }, "link"));
      } else if (canResolve) {
        acts.push(button("Resolve", () => act("t:" + id, () => call("POST", docPath("/threads/" + encodeURIComponent(id) + "/resolve"), { version: versionOf() || undefined }), null), "link"));
      }
      if (canDelete) acts.push(button("Delete", () => { confirming = firstId; render(); }, "link"));
    }
    if (relayedOnly()) card.append(muted("Sign in to see who wrote these comments."));
    if (acts.length) card.append(node("div", { class: "acts" }, acts));
    if (errors["t:" + id]) card.append(errorLine("t:" + id));
    if (firstId && errors["c:" + firstId]) card.append(errorLine("c:" + firstId));
    if (!resolved) {
      const reply = () => {
        const body = (texts["r:" + id] || "").trim();
        if (body) act("r:" + id, () => call("POST", docPath("/threads/" + encodeURIComponent(id) + "/comments"), { body: body, version: versionOf() || undefined }), () => { texts["r:" + id] = ""; });
      };
      card.append(...writer("r:" + id, "Reply…", reply, null));
    }
    return card;
  };

  const cancelDraft = () => {
    draft = null;
    texts.draft = "";
    errors.draft = "";
    needName = needName === "draft" ? "" : needName;
    render();
    post({ event: "close" });
  };
  const draftCard = () => {
    const card = node("div", { class: "card focus", "data-thread": "" });
    const name = titleOf();
    card.append(node("p", { class: "where" }, [name ? "Comment on “" + name + "”" : "New comment"]));
    const v = viewer();
    if (v && text(v.name) !== "") card.append(who({ name: v.name, kind: "human" }));
    card.append(node("div", { class: "quote" }, [text(draft.exact)]));
    const submit = () => {
      const body = (texts.draft || "").trim();
      const snapshot = draft;
      if (!body || !snapshot) return;
      const request = { anchor: snapshot, body: body };
      if (pinned) request.version = pinned;
      act("draft", () => call("POST", docPath("/threads"), request), (result) => {
        draft = null;
        texts.draft = "";
        if (result && typeof result.threadId === "string") focusId = result.threadId;
      });
    };
    card.append(...writer("draft", "Add a comment…", submit, cancelDraft));
    return card;
  };

  const threadsOf = () => {
    const m = model();
    return m && Array.isArray(m.threads) ? m.threads.filter((t) => t && typeof t === "object" && typeof t.threadId === "string") : [];
  };

  const renderMargin = () => {
    const items = [];
    const threads = threadsOf();
    const lost = new Set(lostIds);
    const orphans = threads.filter((t) => t.anchorStatus !== "anchored" || lost.has(t.threadId));
    if (orphans.length) {
      items.push({ el: node("div", { class: "heading" }, ["On text that changed in v" + versionOf()]), want: BAR, gap: 4 });
      for (const t of orphans) items.push({ el: threadCard(t, true), want: 0, gap: 8 });
    }
    const flow = [];
    if (tops !== null) {
      for (const t of threads) {
        if (t.anchorStatus === "anchored" && !lost.has(t.threadId) && typeof tops[t.threadId] === "number") flow.push({ el: threadCard(t, false), want: tops[t.threadId], gap: 8 });
      }
    }
    if (draft) flow.push({ el: draftCard(), want: draftTop, gap: 8 });
    flow.sort((a, b) => a.want - b.want);
    const all = items.concat(flow);
    cards.replaceChildren(...all.map((item) => item.el));
    stacked = all;
    restack();
    for (const item of all) sizes.observe(item.el);
  };

  // Lay the cards out by their wants, each pushed below the one before it, and tell the page how tall that needs the column to be (it can then extend the document, so the last card is reached by scrolling the page, never the frame). Run again whenever a card's height changes: a reply box dragged taller, the Post row appearing on the first keystroke.
  const restack = () => {
    let floor = BAR;
    for (const item of stacked) {
      const top = Math.max(item.want, floor);
      item.el.style.top = top + "px";
      floor = top + item.el.offsetHeight + item.gap;
    }
    cards.style.height = Math.max(height, floor) + "px";
    const need = Math.ceil(floor);
    if (need !== sentNeed) { sentNeed = need; post({ event: "size", height: need }); }
  };
  const sizes = new ResizeObserver(() => {
    if (mode === "margin" && stacked.length) restack();
    else if (mode === "overlay") reportSheet();
  });
  // The sheet is as tall as its card, up to the page's cap, so it reports the content's height.
  const reportSheet = () => post({ event: "height", px: Math.ceil(main.scrollHeight) });

  const renderOverlay = () => {
    const close = button("×", () => { if (draft) cancelDraft(); else post({ event: "close" }); }, "x");
    close.setAttribute("aria-label", "Close");
    const kids = [node("div", { class: "grab" }, [node("i"), close])];
    if (draft) kids.push(draftCard());
    else {
      const thread = threadsOf().find((t) => t.threadId === focusId);
      if (thread) kids.push(threadCard(thread, thread.anchorStatus !== "anchored", true));
    }
    cards.replaceChildren(...kids);
    cards.style.height = "";
  };

  const render = () => {
    const active = document.activeElement;
    const key = active && active.dataset ? active.dataset.key : undefined;
    const from = key !== undefined && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    if (composing) { owed = true; return; }
    main.className = mode;
    sizes.disconnect();
    stacked = [];
    try {
      if (!shown || (mode === "overlay" && !draft && !focusId)) cards.replaceChildren();
      else if (mode === "overlay") renderOverlay();
      else renderMargin();
    } catch (error) {
      cards.replaceChildren();
    }
    if (key !== undefined) {
      const again = Array.from(cards.querySelectorAll("[data-key]")).find((element) => element.dataset.key === key);
      if (again) { again.focus({ preventScroll: true }); if (from) again.setSelectionRange(from[0], from[1]); }
    }
    if (mode === "overlay" && cards.firstChild) {
      sizes.observe(main);
      reportSheet();
    }
  };

  // ---- the page ----
  const listed = (value) => Array.isArray(value) && value.every((x) => typeof x === "string");
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!parentOrigin || event.source !== window.parent || event.origin !== parentOrigin) return;
    if (msg === null || typeof msg !== "object" || msg.type !== NS) return;
    if (msg.event === "mode") {
      mode = msg.mode === "overlay" ? "overlay" : "margin";
      sentNeed = -1;
      render();
    } else if (msg.event === "visible") {
      shown = msg.shown !== false;
      render();
    } else if (msg.event === "threads") {
      relayed = msg.data && typeof msg.data === "object" && Array.isArray(msg.data.threads) ? msg.data : null;
      // The page is not trusted to trigger reads: a flood of these is one read at most every few seconds, and none while one is under way.
      if (!inFlight && Date.now() - lastLoad > 5000) load();
      else if (loaded) refreshView();
    } else if (msg.event === "positions") {
      const next = msg.tops && typeof msg.tops === "object" ? msg.tops : {};
      const nextHeight = typeof msg.height === "number" ? msg.height : 0;
      const key = JSON.stringify([next, msg.lost]);
      if (key === positionsKey) {
        // Only the host's height moved (often in answer to our own size message): re-lay the cards, never rebuild them, or a reply box being dragged is replaced under the pointer.
        if (nextHeight !== height) {
          height = nextHeight;
          if (mode === "margin" && stacked.length) restack();
          else if (mode === "margin") cards.style.height = height + "px";
        }
        return;
      }
      positionsKey = key;
      tops = next;
      lostIds = listed(msg.lost) ? msg.lost : [];
      height = nextHeight;
      render();
    } else if (msg.event === "draft") {
      const a = msg.anchor;
      if (a && typeof a === "object" && typeof a.exact === "string" && a.exact !== "") {
        draft = { exact: a.exact };
        for (const field of ["prefix", "suffix", "section"]) if (typeof a[field] === "string") draft[field] = a[field];
        draftTop = typeof msg.top === "number" ? msg.top : 0;
        texts.draft = "";
        errors.draft = "";
        // No focus() here: a page message must never move focus into this frame, or any page on the shared serving origin could capture the reader's keystrokes. The reader clicks into the box.
        render();
      } else if (draft) {
        draft = null;
        render();
      }
    } else if (msg.event === "focus") {
      focusId = typeof msg.threadId === "string" ? msg.threadId : "";
      if (mode === "overlay") render();
      else {
        let target = null;
        for (const element of cards.querySelectorAll("[data-thread]")) {
          const on = element.dataset.thread === focusId && focusId !== "";
          element.classList.toggle("focus", on);
          if (on) target = element;
        }
        if (target) post({ event: "reveal", top: target.offsetTop, height: target.offsetHeight });
      }
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (draft) cancelDraft();
    else if (mode === "overlay") post({ event: "close" });
  });

  try { prepare().catch(() => {}); } catch (error) {}
  load();
})();
`;
