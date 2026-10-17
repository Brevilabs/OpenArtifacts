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
 * - `COMMENTS_FRAME_SCRIPT` runs in the comments frame on the API host (the
 *   sidebar, or the bottom sheet) and holds the reader's token.
 */

/**
 * The comment half of the page script: what the page does when its document has
 * comments on. Everything here is skipped by the Share half's own guards (no
 * Share link, no script) and wrapped so that a throw cannot touch Share.
 *
 * **Inert unless the threads resource answers, and it does not ask when the bar
 * says there is nothing to ask.** On the shared link the bar's Share link carries
 * `data-comments="on|off"`, whether the page had comments to show when it was
 * served (a thread, or a person who can comment): `off` and the script makes no
 * request at all. On `on`, or on a pinned `/v{n}` where the attribute is absent
 * (the page is immutable and must not freeze it), its first act is
 * `GET /d/{docId}/threads` on the page's own origin, and unless that answers
 * `200` with a thread or `commentable: true` it adds no button, no frame and no
 * listener. A page with nobody to comment stays inert until the first
 * selection of the author's text: then, once per page load, the script builds the
 * comments frame hidden and waits for its `viewer` message, and only a yes
 * (the owner, signed in to the frame) makes it active and shows Comment. The Share popover tells it when its owner adds a person, changes a
 * role or closes it (`people` event), which makes it ask again, so the Comments
 * button appears without a reload; after that event the page treats its viewer as the
 * owner for the rest of the tab and stays active even with no thread and
 * `commentable: false`.
 *
 * **It paints, it never writes.** Highlights are `CSS.highlights` over Ranges,
 * styled by an adopted stylesheet, so a chart, a React island or a Pyodide cell
 * keeps every node it had. The only things added to the document are the
 * Comments button inside our own bar and two hosts on `<html>`, each a closed
 * shadow root (the frame, and the floating **Comment** button). Every open thread
 * whose passage it finds is painted one translucent yellow whether or not the
 * comments are open, the active thread and the draft a stronger one.
 *
 * **Canonical text** is what `src/comments/anchor.ts` builds from the stored
 * HTML: the text of `<body>` in document order, with no separator between text
 * nodes, skipping `head`, `script`, `style`, `template` and `noscript` subtrees
 * and our own injections, each text node normalised to NFC with CRLF as LF.
 * Anchors are quotes in that text, and the same ladder (exact with context, then
 * whitespace-collapsed) finds each one again here.
 *
 * **Messages.** To the frame, `{type, event, …}` with the API origin as the
 * target: `mode`, `theme` (whether the page's own background is dark), `visible`,
 * `threads`, `positions`, `draft`, `focus`, `hover` (the thread whose card lifts:
 * its passage or its card is under the pointer), `dismiss`.
 * From it, accepted only from that iframe's window and the API origin: `ready`,
 * `viewer`, `changed`, `focus`, `hover` (the card under the pointer), `cancel`
 * (an empty draft was dropped), `close`
 * (the reader closed the comments), and three that are layout only and reveal
 * nothing beyond `viewer`: `size` (the height the sidebar's stacked cards need),
 * `height` (the height of the sheet's content) and `reveal` (where the active
 * card sits). Nothing in either direction is a credential.
 *
 * **Sidebar or sheet.** The Comments button opens and closes them; they are
 * closed on every page load, and a highlight or the Comment button opens them
 * too. Where the viewport is at least `WIDE` and the window is what scrolls the
 * page (`innerScrolled`), it is a sidebar: while it is open an adopted
 * stylesheet pads `<html>` by `COLUMN` on the right, the author's layout reflows
 * into what is left (the text the reader was looking at stays where it was on
 * screen), and the frame is that column, as tall as the document (or as
 * its stacked cards need, if that is taller), so it scrolls with the page. The
 * page re-measures each passage whenever the geometry can change (opening, a
 * resize, fonts and images loading, a resize of the document or of a card) and
 * reports the tops in document coordinates; the frame lays the cards out level
 * with them. Elsewhere it is a bottom sheet that is only as tall as its content:
 * the list of open threads, one thread, or a draft. Nothing else ever changes the
 * page's width.
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
    // The sidebar's column, and the narrowest viewport that has one beside the page; narrower, the comments are a bottom sheet.
    const COLUMN = 320, WIDE = 880;
    // The shortcut that opens the composer on a selection, as in Google Docs: ⌘⌥M on a Mac, Ctrl+Alt+M elsewhere.
    const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
    let data = null, active = false, open = false, canComment = false, mode = "margin";
    let mhost = null, mframe = null, ready = false, button = null, words = null, tipHost = null, tip = null;
    let canon = null, dirty = true, ranges = new Map(), lost = [], draft = null, draftRange = null, focusId = "", timer = 0;
    let need = 0, sheetH = 0, refreshSeq = 0, ownerHere = false, hoverPage = "", hoverFrame = "";
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
    // The live selection, or a Range held from it: a Range follows the page's edits, so offsets are always read from the current text.
    const capture = (held) => {
      let live = held;
      if (!live) {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        live = sel.getRangeAt(0);
      }
      if (live.collapsed) return null;
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
      return { a: a, b: b, anchor: anchor, box: live.getBoundingClientRect(), rect: live.getClientRects()[live.getClientRects().length - 1] || live.getBoundingClientRect(), first: live.getClientRects()[0] || live.getBoundingClientRect() };
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
      listen();
    };
    // When the window is not what scrolls the content (an inner overflow container), a passage can be out of the viewport while the window has nothing to scroll: document coordinates mean nothing there.
    const innerScrolled = () => {
      const se = document.scrollingElement || document.documentElement;
      if (se.scrollHeight > window.innerHeight + 1) return false;
      // The draft's passage counts too: on a page with no thread yet it is the only one.
      for (const range of draftRange ? [draftRange, ...ranges.values()] : ranges.values()) {
        const r = range.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) return true;
      }
      return false;
    };
    // The text at a point of the viewport, as a collapsed Range.
    const caretAt = (x, y) => {
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (!p) return null;
        const range = document.createRange();
        range.setStart(p.offsetNode, p.offset);
        return range;
      }
      return document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    };
    // The column the open sidebar takes from the page: an adopted stylesheet pads <html> on the right (and sizes it auto, or a reset's html{width:100%} would widen it instead), so the author's own layout (a centred column, a full-width page) reflows into what is left, and the canvas, which carries the page's own background, fills the column. Nothing in the author's DOM changes, and nothing else ever changes the page's width.
    let narrow = null, narrowed = "";
    const setNarrow = (px) => {
      const css = px ? ":root{padding-right:" + px + "px!important;width:auto!important}" : "";
      if (css === narrowed) return;
      narrowed = css;
      // A padding change on <html> turns the browser's scroll anchoring off, and the reflow would move the text out from under the reader. So the place is kept by hand: the passage being commented on, else the active thread's, else the text in the middle of the window, stays where it was on screen.
      const anchor = draftRange || ranges.get(focusId) || caretAt(window.innerWidth / 2, window.innerHeight / 2);
      const topOf = () => { const r = anchor && anchor.getClientRects()[0]; return r ? r.top : null; };
      const before = topOf();
      try {
        if (!narrow) { narrow = new CSSStyleSheet(); document.adoptedStyleSheets = document.adoptedStyleSheets.concat([narrow]); }
        narrow.replaceSync(css);
      } catch (error) {}
      const after = topOf();
      if (before !== null && after !== null) window.scrollBy({ top: after - before, behavior: "instant" });
    };
    // A computed colour in any syntax (rgb(), Tailwind's oklch(), color(display-p3 …)) as sRGB [r, g, b, a] from 0 to 255: painted on a detached 1×1 canvas and read back, so the browser does the conversion.
    let swatch = null;
    const srgb = (css) => {
      if (!swatch) { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1; swatch = canvas.getContext("2d", { willReadFrequently: true }); }
      swatch.clearRect(0, 0, 1, 1);
      swatch.fillStyle = css;
      swatch.fillRect(0, 0, 1, 1);
      return Array.from(swatch.getImageData(0, 0, 1, 1).data);
    };
    // The page's own background: <body>'s, else <html>'s (the canvas takes it from them in that order), else, when both are transparent, what paints the page's left edge halfway down the window (a wrapper that fills the page). Our own hosts and bar are not the page. A wrapper's colour is returned as fill too: the canvas behind the column is white, so the column paints it itself.
    const backdrop = () => {
      const ours = (el) => el === mhost || el === tipHost || link.parentNode.contains(el);
      const stack = [document.body, document.documentElement].concat(document.elementsFromPoint(0, window.innerHeight / 2).filter((el) => !ours(el)));
      for (const el of stack) {
        const css = getComputedStyle(el).backgroundColor;
        const c = srgb(css);
        if (c[3] !== 0) return { rgb: c, fill: el === document.body || el === document.documentElement ? "" : css };
      }
      return null;
    };
    // Whether that background is dark. The frame draws its cards in the matching theme.
    let dark = null, fill = "";
    const isDark = (c) => {
      const lin = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
      return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]) < 0.179;
    };
    let visible = null;
    const layout = () => {
      // Measure the page without our own column: its height counts toward scrollHeight and would hide an inner scroller.
      // Collapse it, never hide it: a display:none host takes the frame out of rendering, and Chrome then drops the keystroke, or the focus, of a reader typing in a card.
      mhost.style.height = "0";
      const vw = viewport().clientWidth;
      const next = vw >= WIDE && !innerScrolled() ? "margin" : "overlay";
      if (next !== mode) { mode = next; need = 0; sheetH = 0; send({ event: "mode", mode: mode }); }
      const back = backdrop();
      const d = back ? isDark(back.rgb) : false;
      fill = back ? back.fill : "";
      if (d !== dark) { dark = d; send({ event: "theme", dark: d }); }
      if (button) label();
      // The host is a child of <html>, so an html{zoom} would multiply every length written below; cancel it.
      const z = document.documentElement.currentCSSZoom || 1;
      const flat = base + (z !== 1 ? "zoom:" + 1 / z + ";" : "");
      const now = active && open;
      setNarrow(now && mode === "margin" ? Math.round(COLUMN / z) : 0);
      if (now !== visible) { visible = now; send({ event: "visible", shown: now }); }
      if (!now) { mhost.style.display = "none"; return; }
      if (mode === "margin") {
        // As tall as the document, so the cards scroll with the page; the cards may need more, and the host then extends the page, so they can be reached by scrolling it.
        const height = Math.round(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) * z);
        mhost.setAttribute("style", flat + "display:block;position:absolute;top:0;left:" + Math.round(vw - COLUMN + window.pageXOffset) + "px;width:" + COLUMN + "px;height:" + Math.max(height, need) + "px" + (fill ? ";background:" + fill : ""));
      } else {
        const phone = vw <= 600;
        mhost.setAttribute("style", flat + "display:block;position:fixed;bottom:0;height:" + (sheetH ? "min(" + sheetH + "px,55vh,560px)" : "min(55vh,560px)") + ";opacity:" + (unsure && !sheetH ? "0" : "1") +
          ";border-radius:18px 18px 0 0;overflow:hidden;background:" + (dark ? "#1f2023" : "#f7f7f8") + ";box-shadow:0 -8px 32px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.08);" +
          (phone ? "left:0;right:0" : "right:16px;width:420px;max-width:calc(100vw - 32px)"));
      }
    };
    const measure = () => {
      timer = 0;
      if (!active) return;
      if (dirty || !canon) { locateAll(); if (button) label(); }
      layout();
      if (mode === "margin" && open) {
        const top = mhost.getBoundingClientRect().top + window.pageYOffset, tops = {}, none = lost.slice();
        // In passage order, so the frame stacks the cards of passages that share a line as the text reads.
        const placed = Array.from(ranges).sort((a, b) => a[1].compareBoundaryPoints(Range.START_TO_START, b[1]));
        for (const [id, range] of placed) {
          const rects = range.getClientRects();
          if (rects.length) tops[id] = rects[0].top + window.pageYOffset - top; else none.push(id);
        }
        send({ event: "positions", tops: tops, lost: none, height: Math.round(mhost.getBoundingClientRect().height) });
      }
    };
    const schedule = () => { if (!timer) timer = window.setTimeout(measure, 80); };

    // ---- highlights ---------------------------------------------------------
    // Painted whenever the page has open threads, whether or not the sidebar is open: the passages are what invite a reader in.
    const paint = () => {
      if (!painting) return;
      const groups = { "openartifacts-open": [], "openartifacts-focus": [], "openartifacts-draft": [] };
      if (active) {
        ranges.forEach((range) => groups["openartifacts-open"].push(range));
        if (focusId && ranges.has(focusId)) groups["openartifacts-focus"].push(ranges.get(focusId));
        // The passage under the pointer, or of the card under it, takes the active yellow while it is there.
        const hovered = hoverFrame || hoverPage;
        if (hovered && hovered !== focusId && ranges.has(hovered)) groups["openartifacts-focus"].push(ranges.get(hovered));
        if (draftRange) groups["openartifacts-draft"].push(draftRange);
      }
      Object.keys(groups).forEach((name, i) => {
        if (!groups[name].length) { CSS.highlights.delete(name); return; }
        const h = new Highlight(...groups[name]);
        h.priority = i;
        CSS.highlights.set(name, h);
      });
    };
    // A passage and its card are linked while either is under the pointer: the passage takes the active yellow (paint) and the frame lifts the card. The page decides both, so a card is never left lifted by a pointer the frame did not see go.
    let hoverSent = "";
    const hover = () => {
      const h = hoverFrame || hoverPage;
      if (h !== hoverSent) { hoverSent = h; send({ event: "hover", threadId: h }); }
      paint();
    };
    const locateAll = () => {
      if (dirty || !canon) build();
      ranges = new Map();
      lost = [];
      // A resolved thread is off the page: no highlight, no card beside it; the frame lists it behind its count.
      for (const thread of data ? data.threads : []) {
        if (thread.anchorStatus !== "anchored" || thread.state === "resolved") continue;
        const range = locate(thread);
        if (range) ranges.set(thread.threadId, range); else lost.push(thread.threadId);
      }
    };

    // ---- the bar's button ---------------------------------------------------
    // A speech bubble, painted by a mask in the button's own ink, as Share's glyph is (src/render.ts): no <svg> near the top of the author's body.
    const BUBBLE = "url(data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.7-.8L3 21l1.9-5.1A8.4 8.4 0 0 1 3 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z"/></svg>') + ") center/contain no-repeat";
    const label = () => {
      const n = data ? data.threads.filter((t) => t.state === "open").length : 0;
      // At phone width the word goes and the bubble and the count stay.
      const text = viewport().clientWidth < 600 ? (n ? String(n) : "") : "Comments" + (n ? " " + n : "");
      if (words.textContent !== text) words.textContent = text;
      words.style.display = text ? "block" : "none";
      button.setAttribute("aria-label", n ? "Comments, " + n + " open" : "Comments");
      button.setAttribute("aria-pressed", String(open));
      button.title = open ? "Hide comments" : "Show comments";
      // Released it is Share's own pill; pressed, a step lighter with a brighter edge, so it reads as held down.
      button.style.background = open ? "#343a46" : "#1d2027";
      button.style.borderColor = open ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.08)";
    };
    const makeButton = () => {
      button = document.createElement("button");
      button.type = "button";
      // Share's pill: 34px, fully rounded, a hairline border, Share's 14px type and
      // ink, painted rather than transparent so that it also reads on a bar rendered
      // before the dark strip (a pinned /v{n} is immutable for a year). Hover and
      // focus are OPENARTIFACTS_BAR_STYLE's (src/render.ts), keyed on the class.
      button.className = "openartifacts-comments-button";
      button.setAttribute("style", "all:initial;flex:none;box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 16px 0 14px;margin-left:auto;border:1px solid rgba(255,255,255,0.08);border-radius:999px;background:#1d2027;color:#f4f5f7;cursor:pointer;white-space:nowrap;-webkit-font-smoothing:antialiased;" + FONT.replace("13px/1.25", "14px/1"));
      const glyph = document.createElement("span");
      glyph.setAttribute("aria-hidden", "true");
      glyph.setAttribute("style", "all:initial;display:block;flex:none;width:16px;height:16px;background-color:#f4f5f7;-webkit-mask:" + BUBBLE + ";mask:" + BUBBLE);
      words = document.createElement("span");
      words.setAttribute("style", "all:initial;display:block;font:inherit;color:inherit;white-space:nowrap");
      button.append(glyph, words);
      button.addEventListener("click", () => {
        if (open) { closePanel(); return; }
        // Opened from the bar, nothing is active: on a phone the sheet lists the open comments, whose rows scroll to their passages.
        focusId = "";
        send({ event: "focus", threadId: "" });
        openPanel();
      });
      link.parentNode.insertBefore(button, link);
    };

    // ---- the Comment button on a selection ----------------------------------
    const hideTip = () => { if (tipHost) tipHost.style.display = "none"; };
    const refreshTip = () => {
      if (!active || !canComment) { hideTip(); return; }
      const cap = capture();
      if (!cap) { hideTip(); return; }
      if (!tipHost) {
        tipHost = document.createElement("div");
        tipHost.className = "openartifacts-comment-tip";
        tipHost.setAttribute("style", "all:initial;position:fixed;z-index:2147483646;display:none");
        const root = rootOf(tipHost);
        hostOnly(root, "@media print{:host{display:none!important}}");
        hostOnly(root, ".t{all:initial;box-sizing:border-box;display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 14px 0 12px;border-radius:11px;background:#1f2024;color:#fff;border:1px solid rgba(255,255,255,.14);box-shadow:0 6px 18px rgba(0,0,0,.28),0 1px 3px rgba(0,0,0,.2);cursor:pointer;user-select:none;white-space:nowrap;font:500 14px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}.t.tall{height:44px}.t:hover{background:#2c2d33}.t:focus-visible{outline:2px solid #7cc4ff;outline-offset:2px}.t svg{flex:none}");
        tip = document.createElement("button");
        tip.type = "button";
        tip.className = "t";
        const svgns = "http://www.w3.org/2000/svg";
        const icon = document.createElementNS(svgns, "svg");
        for (const [name, value] of [["viewBox", "0 0 24 24"], ["width", "16"], ["height", "16"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]]) icon.setAttribute(name, value);
        const bubble = document.createElementNS(svgns, "path");
        bubble.setAttribute("d", "M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.7-.8L3 21l1.9-5.1A8.4 8.4 0 0 1 3 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z");
        icon.append(bubble);
        tip.append(icon, document.createTextNode("Comment"));
        tip.title = "Comment (" + (MAC ? "⌘⌥M" : "Ctrl+Alt+M") + ")";
        tip.setAttribute("aria-keyshortcuts", MAC ? "Meta+Alt+M" : "Control+Alt+M");
        tip.addEventListener("mousedown", (event) => event.preventDefault());
        root.append(tip);
        document.documentElement.append(tipHost);
      }
      // The button belongs to this passage even if the browser clears its native selection before click.
      const held = window.getSelection().getRangeAt(0).cloneRange();
      tip.onclick = () => startDraft(held);
      // Centred over the selection, above its first line when there is room, else below the last: never over the text itself.
      // On a phone the system's own menu (Copy, Look Up) goes just above or just below the selection, wherever it finds room, so no place beside the selection is safe: the button docks at the bottom centre of what is visible, above the sheet when it is open, 44px tall to be a touch target. A selection that ends near that dock would put the menu, or its own handle, under the button, so it then docks at the top, below the bar.
      const first = cap.first, last = cap.rect;
      const phone = mode === "overlay";
      tip.classList.toggle("tall", phone);
      // The tip is a child of <html>: under html{zoom} its lengths are multiplied, so convert viewport px to zoomed px.
      const z = document.documentElement.currentCSSZoom || 1;
      tipHost.style.display = "block";
      const wide = tipHost.offsetWidth * z, high = tipHost.offsetHeight * z;
      if (phone) {
        // The visual viewport, not the window: a pinch zoom shows only part of the page, and the button stays on the part shown.
        const vv = window.visualViewport;
        const floor = Math.min(vv ? vv.offsetTop + vv.height : window.innerHeight, open ? mhost.getBoundingClientRect().top : Infinity) - 12 - high;
        tipHost.style.left = Math.round(((vv ? vv.offsetLeft + vv.width / 2 : window.innerWidth / 2) - wide / 2) / z) + "px";
        if (last.bottom > floor - 100) {
          const bar = link.closest(".openartifacts-bar");
          tipHost.style.top = Math.round((Math.max(vv ? vv.offsetTop : 0, bar ? bar.getBoundingClientRect().bottom : 0) + 12) / z) + "px";
        } else tipHost.style.top = "calc(" + Math.round(floor / z) + "px - env(safe-area-inset-bottom, 0px))";
        return;
      }
      const x = (cap.box.left + cap.box.right) / 2 - wide / 2;
      tipHost.style.left = Math.round(Math.max(8, Math.min(x, viewport().clientWidth * z - wide - 8)) / z) + "px";
      tipHost.style.top = Math.round((first.top - 44 >= 48 ? first.top - 44 : last.bottom + 8) / z) + "px";
    };
    const startDraft = (held) => {
      const cap = capture() || (held ? capture(held) : null);
      if (!cap) return;
      draftRange = toRange(cap.a, cap.b);
      draft = cap.anchor;
      hideTip();
      window.getSelection().removeAllRanges();
      if (focusId) { focusId = ""; send({ event: "focus", threadId: "" }); }
      // Opened before the draft is measured: the sidebar narrows the page and its text reflows. And the frame is told it is shown before the draft arrives: a frame that is not shown draws nothing, so a draft that came first found no field to focus.
      openPanel();
      reveal(draftRange);
      const top = draftRange.getClientRects()[0] || draftRange.getBoundingClientRect();
      send({ event: "draft", focus: true, anchor: draft, top: top.top - mhost.getBoundingClientRect().top });
      paint();
    };
    const endDraft = () => { draft = null; draftRange = null; send({ event: "draft", anchor: null, top: 0 }); paint(); };

    // ---- opening and closing --------------------------------------------------
    // The sheet is invisible until the frame has said how tall its content is (or 300ms have passed), so it opens at its size and does not shrink under the reader's finger.
    let unsure = false;
    const openPanel = () => {
      if (open) return;
      if (mode === "overlay" && !sheetH) { unsure = true; window.setTimeout(() => { unsure = false; layout(); }, 300); }
      open = true;
      // At once, not on the next tick: what opens next (a draft, a focused card) is placed against the page as it reflowed.
      measure();
      paint();
    };
    // On a phone, scroll the passage out from under the sheet, unless it is already clear of it. Call after openPanel, whose layout sets the height this reads.
    const reveal = (range) => {
      if (mode !== "overlay" || !range) return;
      const rect = range.getBoundingClientRect();
      const limit = window.innerHeight - mhost.getBoundingClientRect().height - 8;
      if (rect.top >= 48 && rect.bottom <= limit) return;
      window.scrollTo({ top: Math.max(0, rect.top + window.pageYOffset - window.innerHeight * 0.15), behavior: "smooth" });
    };
    // Closing ends a draft, lets go of the active thread and gives the page its width back.
    const closePanel = () => {
      if (!open) return;
      open = false;
      sheetH = 0;
      if (draft) endDraft();
      focusId = "";
      send({ event: "focus", threadId: "" });
      layout();
      paint();
    };

    // The frame's messages. Registered when the frame is built, which is at the first activation or at the probe, so a message that comes before the page is active is not lost.
    const listen = () => {
    window.addEventListener("message", (event) => {
      if (!mframe || event.source !== mframe.contentWindow || event.origin !== api) return;
      const msg = event.data;
      if (msg === null || typeof msg !== "object" || msg.type !== NS) return;
      if (msg.event === "ready") {
        ready = true;
        schedule();
        ["mode", "theme", "visible", "threads", "positions", "draft", "focus"].forEach((name) => { if (out[name]) deliver(out[name]); });
      } else if (msg.event === "viewer") {
        canComment = msg.canComment !== false;
        // A selection made before this answer (before signing in, say) gets its Comment button now, not on the next selection.
        refreshTip();
        // An inert page has nobody else who may comment, so a yes here is its owner's (the selection probe's answer): the page is theirs to comment on, as after the Share popover's event.
        if (!active && canComment) { ownerHere = true; refresh().then(refreshTip); }
      } else if (msg.event === "changed") {
        // The draft's passage stays marked until the read that draws its thread has landed, so a sent comment is never nowhere.
        const mine = draft;
        refresh().then(() => { if (mine && draft === mine) endDraft(); });
      } else if (msg.event === "focus" && typeof msg.threadId === "string") {
        focusId = msg.threadId;
        send({ event: "focus", threadId: focusId });
        reveal(ranges.get(focusId));
        paint();
      } else if (msg.event === "size" && Number.isFinite(msg.height)) {
        const n = Math.max(0, Math.min(Math.round(msg.height), 1000000));
        if (mode === "margin" && n !== need) { need = n; schedule(); }
      } else if (msg.event === "height" && Number.isFinite(msg.px)) {
        // A height while the sheet is closed would linger as sheetH and open the next sheet at the wrong height.
        if (!open || mode !== "overlay") return;
        const n = Math.max(80, Math.min(Math.round(msg.px), 4000));
        if (n !== sheetH || unsure) { sheetH = n; unsure = false; layout(); }
      } else if (msg.event === "reveal" && Number.isFinite(msg.top) && Number.isFinite(msg.height)) {
        if (mode !== "margin" || !open) return;
        const t = mhost.getBoundingClientRect().top + msg.top;
        if (t < 48 || t + msg.height > window.innerHeight) window.scrollTo({ top: Math.max(0, t + window.pageYOffset - window.innerHeight * 0.15), behavior: "smooth" });
      } else if (msg.event === "hover" && typeof msg.threadId === "string") {
        if (msg.threadId !== hoverFrame) { hoverFrame = msg.threadId; hover(); }
      } else if (msg.event === "cancel") {
        // The frame dropped an empty draft. The sheet was showing only that draft; the sidebar stays.
        if (draft) endDraft();
        if (mode === "overlay") closePanel();
      } else if (msg.event === "close") {
        closePanel();
      }
    });
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
      // The resource answers 200 for every page; one with no thread, nobody who can comment and no sign that its viewer is the owner has nothing to show.
      if (body.threads.length === 0 && body.commentable !== true && !ownerHere) { if (active) deactivate(); return; }
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
      open = false;
      button.style.display = "none";
      layout();
      hideTip();
      paint();
    };
    const activate = () => {
      active = true;
      if (button) return;
      makeButton();
      if (!mhost) buildHost();
      window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 30000);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
      window.addEventListener("resize", schedule);
      window.addEventListener("load", schedule);
      const follow = () => { if (tipHost && tipHost.style.display === "block") refreshTip(); };
      window.addEventListener("scroll", follow, { passive: true });
      // A pinch zoom, or Safari's toolbar showing and hiding, moves the visible part of the page, and a phone's button with it.
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", follow);
        window.visualViewport.addEventListener("scroll", follow);
      }
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
      // A page that follows the system's dark mode changes its background with no resize; the cards follow it.
      if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule);
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(schedule);
        document.fonts.addEventListener("loadingdone", schedule);
      }
      let settle = 0;
      document.addEventListener("selectionchange", () => { window.clearTimeout(settle); settle = window.setTimeout(refreshTip, 150); });
      link.addEventListener("click", () => { if (mode === "overlay") closePanel(); });
      // A draft is the frame's to end (it knows whether words are in it); a sheet without one closes. The sidebar stays open until its reader closes it.
      document.addEventListener("keydown", (event) => { if (open && event.key === "Escape") { if (draft) send({ event: "dismiss" }); else if (mode === "overlay") closePanel(); } }, true);
      // The passage under the pointer, measured against the passages' own boxes (not the nearest caret, so the space beside a line is not the line). A move on the page also means the pointer is not over the frame, whether or not the frame saw it leave a card.
      document.addEventListener("pointermove", (event) => {
        if (!active || event.pointerType === "touch") return;
        const x = event.clientX, y = event.clientY;
        // Over our own Comment button or bar, the pointer is on them, not on the passage beneath.
        const hit = event.target === tipHost || link.parentNode.contains(event.target) ? null : Array.from(ranges).find((entry) => Array.from(entry[1].getClientRects()).some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom));
        const next = hit ? hit[0] : "";
        if (next !== hoverPage || hoverFrame) { hoverPage = next; hoverFrame = ""; hover(); }
      }, { passive: true });
      // Into the frame or out of the window: nothing on the page is under the pointer.
      document.addEventListener("pointerout", (event) => { if (!event.relatedTarget && hoverPage) { hoverPage = ""; hover(); } });
      // ⌘⌥M (Ctrl+Alt+M elsewhere) opens the composer on the selection, as the Comment button does. It only opens it: posting still takes a click on Send.
      document.addEventListener("keydown", (event) => {
        if (event.code !== "KeyM" || !event.altKey || event.shiftKey || (MAC ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return;
        if (!active || !canComment || !capture()) return;
        event.preventDefault();
        startDraft();
      });
      document.addEventListener("pointerdown", (event) => {
        const ours = event.target === mhost || event.target === tipHost || button.contains(event.target);
        // A click on the page itself closes a draft that has nothing typed in it (the frame decides); on a phone a touch is how the reader scrolls back to the passage.
        if (draft && mode === "margin" && !ours) send({ event: "dismiss" });
        // A draft is the reader's own words and the sheet covers half the page: a touch on the page above it (to scroll back to the passage) must not throw them away. Cancel, the close button, Escape and a post end it.
        if (open && mode === "overlay" && !draft && !ours) closePanel();
      }, true);
      document.addEventListener("click", (event) => {
        // A press on the Comment button is the button's: the passage under it (the line above the selection) is not what was clicked. Nor is anything in our bar.
        if (!active || event.button !== 0 || event.target === tipHost || link.parentNode.contains(event.target)) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        const caret = caretAt(event.clientX, event.clientY);
        const hit = caret && caret.startContainer.nodeType === 3 ? Array.from(ranges).find((entry) => entry[1].isPointInRange(caret.startContainer, caret.startOffset)) : null;
        if (hit) {
          // A highlight opens the comments on its thread, closed or not. The frame learns the thread before it is shown, so its first drawing is that thread (a sheet drawn as the list first would resize under the reader's finger).
          if (draft) endDraft();
          focusId = hit[0];
          send({ event: "focus", threadId: focusId });
          openPanel();
          reveal(hit[1]);
          paint();
        } else if (focusId && mode === "margin") {
          // A click on the page away from every highlight lets go of the active card, as in a document editor.
          focusId = "";
          send({ event: "focus", threadId: "" });
          paint();
        }
      });
      if (painting) {
        try {
          const sheetCss = new CSSStyleSheet();
          // One translucent yellow for every thread, which reads on a light page and a dark one, and no underline, which reads as a link; stronger for the active thread and the draft.
          sheetCss.replaceSync("::highlight(openartifacts-open){background-color:rgba(255,200,0,.28)}" +
            "::highlight(openartifacts-focus){background-color:rgba(255,200,0,.5)}" +
            "::highlight(openartifacts-draft){background-color:rgba(255,184,0,.5)}");
          document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheetCss]);
        } catch (error) {}
      }
    };
    // The Share popover's click (embed-scripts accepts the event only from its own frame and the API origin): its viewer is the owner, for the rest of this tab.
    commentsSwitched = () => { ownerHere = true; refresh(); };
    // While the page is inert, the first selection of the author's text asks the comments frame, once, whether this viewer may comment. The frame (built once; a page that went inert keeps its own) is built hidden for it and nothing shows unless the answer is yes; the page load itself asks nothing.
    document.addEventListener("selectionchange", () => {
      if (active || mhost) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      for (const n of [sel.anchorNode, sel.focusNode]) if (!n || !document.body.contains(n) || outermost(n)) return;
      buildHost();
    });
    if (flag !== "off") refresh();
  })();
  } catch (error) {}
`;

/**
 * The comments frame's stylesheet (`src/comments/frame.ts` puts it in the shell).
 * Two layouts of the same cards, chosen by a class on `<main>` that the page
 * script's `mode` message sets: `margin`, the sidebar, where `.cards` is as tall as the
 * document and the header and every card are absolutely positioned by the
 * script, the cards level with their passages, and `overlay`, a bottom sheet in
 * normal flow under a sticky header. The frame's own background is transparent
 * in the sidebar, so the page's own background shows through between cards.
 *
 * **Two themes, one set of tokens.** The page tells the frame whether its own
 * background is dark (`theme`), and `main.dark` swaps every colour the cards
 * use: light is white cards with dark text, a hairline border and a soft
 * shadow; dark is a dark-grey card that stands off the page, with light text.
 * Green marks the focused card, a badge marks an agent, a sunken grey a resolved
 * or orphaned card. The frame's `color-scheme` stays light in both, as the
 * iframe's does: a frame whose scheme differs from its element's is painted
 * opaque, and the page's background would no longer show between cards.
 */
export const COMMENTS_FRAME_CSS = `:root{color-scheme:light;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:transparent}
*{box-sizing:border-box}html,body{height:100%;margin:0;background:transparent}
[hidden]{display:none!important}
main{--card:#fff;--ink:#18191d;--muted:#5f6368;--line:rgba(0,0,0,.12);--edge:rgba(0,0,0,.22);--shadow:0 1px 2px rgba(0,0,0,.08),0 4px 14px -4px rgba(0,0,0,.14);--lift:0 2px 4px rgba(0,0,0,.1),0 10px 28px -6px rgba(0,0,0,.28);--sunk:#f5f5f6;--hover:rgba(0,0,0,.06);--field:#fff;--accent:#16786a;--ring:rgba(22,120,106,.2);--send:#18191d;--send-ink:#fff;--send-off:#d4d5d8;--danger:#b4342b;--badge:#fbe3d8;--badge-ink:#b03d1b;--sheet:#f7f7f8;color:var(--ink)}
main.dark{--card:#2a2b2f;--ink:#e8e9ec;--muted:#a3a7ae;--line:rgba(255,255,255,.12);--edge:rgba(255,255,255,.24);--shadow:0 1px 2px rgba(0,0,0,.5),0 6px 18px -6px rgba(0,0,0,.6);--lift:0 2px 6px rgba(0,0,0,.55),0 12px 32px -6px rgba(0,0,0,.75);--sunk:#232427;--hover:rgba(255,255,255,.08);--field:#1f2023;--accent:#5fc4b0;--ring:rgba(95,196,176,.25);--send:#e8e9ec;--send-ink:#18191d;--send-off:#45474d;--danger:#ff8a80;--badge:rgba(255,138,101,.18);--badge-ink:#ffab91;--sheet:#1f2023}
html:has(main.margin),html:has(main.margin) body{overflow:hidden}
main.margin{min-height:100%}
main.overlay{background:var(--sheet);padding:0 14px 18px}
.cards{position:relative}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;box-shadow:var(--shadow)}
.margin .card,.margin .heading,.margin .head,.margin .line{position:absolute;left:8px;right:16px}
.card[data-thread]{transition:box-shadow .15s}
.card.hover{box-shadow:var(--lift)}
.card.focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--ring),var(--shadow)}
.card.focus.hover{box-shadow:0 0 0 3px var(--ring),var(--lift)}
.card.muted,.card.resolved{background:var(--sunk)}
.heading{font:10px/1.4 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:2px 6px}
.margin .heading{right:auto}
.head{display:flex;align-items:center;gap:10px}
.head .title{font-weight:700;font-size:14px}
.head button.ic{margin-left:auto}
.margin .head{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px 4px 4px 12px;box-shadow:var(--shadow)}
.overlay .head{position:sticky;top:0;z-index:2;background:var(--sheet);padding:8px 0 6px}
.quote{font-size:11.5px;color:var(--muted);border-left:2px solid var(--edge);padding-left:7px;margin:0 0 8px;font-style:italic;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.where{font-size:11.5px;color:var(--muted);margin:0 0 6px}
.who{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;font-weight:700;font-size:12.5px;min-width:0}
.who small{font-weight:400;color:var(--muted);white-space:nowrap}
.av{width:20px;height:20px;border-radius:50%;display:inline-grid;place-items:center;font-size:10px;font-weight:700;color:#fff;flex:none}
.av.c0{background:#3b6fd4}.av.c1{background:#c2410c}.av.c2{background:#15803d}.av.c3{background:#7c3aed}.av.c4{background:#0e7490}.av.c5{background:#be185d}.av.c6{background:#a16207}.av.c7{background:#4f46e5}
.badge{font:9.5px/1.4 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:.05em;text-transform:uppercase;padding:1px 6px;border-radius:999px;font-weight:600;background:var(--badge);color:var(--badge-ink);white-space:nowrap}
.txt{margin:3px 0 8px 26px;white-space:pre-wrap;overflow-wrap:anywhere}
.acts{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:0 0 6px;font-size:11.5px;color:var(--muted)}
.acts button,button.link{border:0;background:none;padding:0;font:inherit;color:inherit;cursor:pointer}
.acts button:hover,button.link:hover{color:var(--ink);text-decoration:underline}
.acts button.danger{color:var(--danger);font-weight:600}
.who{position:relative}
.tools{margin-left:auto;display:inline-flex;align-items:center;gap:2px}
button.ic{display:grid;place-items:center;min-width:26px;height:26px;padding:0;border:0;border-radius:50%;background:none;color:var(--muted);font:inherit;font-size:16px;line-height:1;cursor:pointer}
button.ic:hover{background:var(--hover);color:var(--ink)}
button.ic:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.menu{position:absolute;right:0;top:100%;z-index:3;min-width:150px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:4px;box-shadow:var(--lift)}
.menu .item{display:block;width:100%;text-align:left;border:0;background:none;padding:7px 10px;border-radius:7px;font:inherit;font-size:12.5px;font-weight:400;color:var(--danger);cursor:pointer}
.menu .item:hover,.menu .item:focus-visible{background:var(--hover);outline:0}
.card:not(.focus) .replybox{display:none}
.card:focus-visible{outline:0}
button.chip{display:inline-flex;align-items:center;gap:3px;height:24px;padding:0 8px 0 10px;border:1px solid var(--edge);border-radius:999px;background:none;color:var(--ink);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
button.chip:hover{background:var(--hover)}
button.chip svg{width:14px;height:14px;transition:transform .15s}
button.chip[aria-expanded="true"] svg{transform:rotate(180deg)}
button.chip.primary{padding:0 12px;border-color:var(--send);background:var(--send);color:var(--send-ink)}
button.chip.primary:hover{opacity:.85}
button.link:focus-visible,button.row:focus-visible,button.b:focus-visible,button.chip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.head .done{font-size:12px;color:var(--muted)}
.composer{display:flex;align-items:flex-end;gap:6px;border:1px solid var(--edge);border-radius:20px;background:var(--field);padding:3px 3px 3px 14px}
.composer:focus-within{border-color:var(--accent);box-shadow:0 0 0 2px var(--ring)}
.composer textarea{flex:1;min-width:0;font:inherit;color:inherit;border:0;border-radius:0;background:transparent;padding:6px 0;min-height:22px;max-height:160px;overflow-y:auto;resize:none;line-height:1.45}
.composer textarea:focus{outline:0}
.composer textarea::placeholder{color:var(--muted);opacity:1}
button.send{flex:none;display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:50%;background:var(--send);color:var(--send-ink);cursor:pointer}
button.send:disabled{background:var(--send-off);color:var(--card);cursor:default}
button.send.busy{background:var(--send);cursor:default}
button.send.busy svg{display:none}
button.send.busy::after{content:"";width:14px;height:14px;border:2px solid var(--send-ink);border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
button.send:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.card.draft{padding:0;border:0;background:transparent;box-shadow:none}
.card.draft .composer{box-shadow:var(--lift)}
.list{display:grid;gap:6px;margin-top:6px}
button.row{display:grid;gap:2px;width:100%;text-align:left;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);font:inherit;color:inherit;cursor:pointer;min-height:44px}
button.row .rq{overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
button.row .rw{font-size:11.5px;color:var(--muted)}
button.b{font:inherit;font-size:12px;font-weight:650;padding:5px 11px;border-radius:8px;border:1px solid var(--edge);background:var(--card);color:var(--ink);cursor:pointer}
button.b:hover{border-color:var(--muted)}button.b:disabled{cursor:default;opacity:.55}
button.b.primary{background:var(--send);border-color:var(--send);color:var(--send-ink)}
.muted-text{font-size:11.5px;color:var(--muted);margin:6px 0 0}
.err{font-size:11.5px;color:var(--danger);margin:6px 0 0}.err:empty{display:none}
.line{padding:2px 4px}.line .muted-text{margin:0}.line>*+*{margin-top:6px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
`;

/**
 * The comments frame's script (`GET /embed/comments`). It draws the cards, holds
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
 * The plain line under the header (`lineCard`) follows the same split: "Invited to
 * comment? Sign in." only on its own anonymous read's `commentable`, "Continue to
 * see names and comment." over relayed cards, "Select text to comment." for a
 * viewer who may, after "No comments yet." (or "No open comments." when every
 * thread is resolved) when nothing is open. Beside cards (the sidebar's placed
 * cards, the sheet's one thread) only the way to sign in, so the line never pushes
 * the cards at the top of the page below their passages.
 * Relayed data is only ever drawn as text; the title shown above a new comment
 * is the server's whenever the frame has a token, and nothing a page sends can
 * post: every write goes to `/embed/api` for this one document.
 *
 * **What it tells the page.** `ready`, once, before it touches storage; `viewer`
 * with `{canComment}` after every read (false until the server says a signed-in
 * viewer may, so no one is offered Comment only to be refused); `changed` after its own
 * write; `focus` when a card is pressed; `hover` while the pointer is over a
 * card; `cancel` when an empty draft is dropped; `close` from the header's close
 * button (or Escape on the sheet). Nothing else about the viewer.
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
  const button = (label, onclick, cls) => node("button", { type: "button", class: cls, onclick: onclick }, [label]);
  const icon = (d, stroke) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of [["viewBox", "0 0 24 24"], ["width", "16"], ["height", "16"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", stroke], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]]) svg.setAttribute(name, value);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  };

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

  let mode = "margin", dark = false, shown = true, relayed = null, own = null, anon = null, loaded = false, tops = null, lostIds = [], height = 0;
  let draft = null, draftTop = 0, focusId = "", loadSeq = 0, lastViewer = null, positionsKey = "";
  let signState = "", prepared = null, opened = null, generation = 0, wake = null;
  let confirming = "";
  let showResolved = false, undoId = "", undoTimer = 0, menuId = "", posted = null, focusKey = "", hoverId = "";
  let modelKey = "", inFlight = false, lastLoad = 0, composing = false, owed = false, stacked = { head: [], flow: [] }, sentNeed = -1, revealOwed = false;
  const texts = {}, errors = {}, busy = {};

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
  // Tells the page false until the frame's own read says the signed-in viewer may comment.
  const reportViewer = () => {
    const v = viewer();
    const can = v !== null && v.canComment === true;
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

  // Runs one write, then reloads the cards and tells the page.
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
    errors[key] = failure(result);
    render();
  };

  // ---- drawing ----
  // As the major editors put it: now, 5m, 3h, 2d, then the date (with the year when it is not this one).
  const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    if (s < 7 * 86400) return Math.floor(s / 86400) + "d";
    const at = new Date(ms);
    return at.toLocaleDateString(undefined, at.getFullYear() === new Date().getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  };
  // One colour per person, from their name, in a palette that reads on both themes.
  const tint = (name) => {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 997;
    return "c" + (h % 8);
  };
  const muted = (value) => node("p", { class: "muted-text" }, [value]);
  // Read out by a screen reader without moving anything: a new child each time, so a second post is announced too.
  const live = node("div", { class: "sr", role: "status", "aria-live": "polite" });
  main.append(live);
  const announce = (words) => live.replaceChildren(node("span", {}, [words]));
  const errorLine = (key) => node("p", { class: "err", role: "alert" }, errors[key] ? [errors[key]] : []);
  // Relayed data is the page's word, so under it nobody has a name or a badge: a page can make up a comment, not a commenter.
  const authorOf = (a) => (relayedOnly() ? { name: "A commenter", agent: false } : { name: text(a && a.name) || "Someone", agent: !!a && a.kind === "agent" });
  const who = (author, at) => {
    const a = authorOf(author);
    const kids = [node("span", { class: "av " + tint(a.name), "aria-hidden": "true" }, [(a.name.trim()[0] || "?").toUpperCase()]), a.name];
    if (a.agent) kids.push(node("span", { class: "badge" }, ["agent"]));
    if (typeof at === "number") kids.push(node("small", { title: new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) }, [ago(at)]));
    return node("div", { class: "who" }, kids);
  };

  const signInBlock = (label) => {
    const kids = [button(label, signIn, "b primary")];
    kids[0].disabled = prepared === null;
    if (signState === "waiting") kids.push(muted("Complete sign-in in the window that opened."));
    if (signState === "blocked") kids.push(node("p", { class: "err" }, ["Your browser blocked the sign-in window. Allow pop-ups for this page and try again."]));
    return node("div", { class: "signin" }, kids);
  };

  // The way to sign in, drawn only where it can lead somewhere: an invitation when its own anonymous read says someone can comment, and the way on when the cards are the page's relayed ones (a private page before the token).
  const signInLine = () => {
    if (!loaded || own !== null) return null;
    if (anon !== null) return anon.commentable === true ? signInBlock("Invited to comment? Sign in.") : null;
    return relayed ? signInBlock("Continue to see names and comment.") : null;
  };
  const resolvedOf = () => threadsOf().filter((t) => t.state === "resolved");
  // The line under the header, plain text rather than a card: "No comments yet." when nothing is open (so an open sidebar or list is never blank), the instruction to a viewer who may comment, and the way to sign in. Beside cards (the sidebar's placed cards, the sheet's one thread) only the way to sign in: the line would push the cards at the top of the page below their passages.
  const lineCard = (besideCards) => {
    const words = [];
    if (!besideCards && loaded && !draft && !threadsOf().some((t) => t.state !== "resolved")) words.push(threadsOf().length ? "No open comments." : "No comments yet.");
    if (!besideCards && viewer() && viewer().canComment) words.push("Select text to comment.");
    const kids = words.length ? [muted(words.join(" "))] : [];
    const way = signInLine();
    if (way) kids.push(way);
    return kids.length ? node("div", { class: "line" }, kids) : null;
  };
  // The title, the resolved threads (off the page, waiting behind their count, a button whose chevron turns when open; for a few seconds after a resolve, "Resolved" and an Undo button in its place) and the close button, in the sidebar and the sheet alike. Undo lives in this row, no taller than the close button, so it never pushes the cards down.
  const header = () => {
    const n = loaded ? resolvedOf().length : 0;
    const kids = [node("span", { class: "title" }, ["Comments"])];
    if (undoId) kids.push(node("span", { class: "done" }, ["Resolved"]), button("Undo", () => reopenThread(undoId), "chip primary"));
    else if (n) kids.push(node("button", { type: "button", class: "chip", "aria-expanded": String(showResolved), onclick: () => { showResolved = !showResolved; render(); } }, [n + " resolved", icon("M6 9l6 6 6-6", "2.2")]));
    kids.push(iconButton("Close comments", "M6 6l12 12M18 6L6 18", () => post({ event: "close" })));
    return node("div", { class: "head" }, kids);
  };

  // The box a person writes in: a textarea and its Send button, or the reason there is none.
  const writer = (key, placeholder, submit) => {
    const v = viewer();
    if (v === null) return [];
    if (!v.canComment) return [muted("You can view this page.")];
    const sending = !!busy[key];
    const area = node("textarea", { rows: "1", maxlength: "4000", placeholder: placeholder, "aria-label": placeholder, "data-key": key });
    area.value = texts[key] || "";
    area.readOnly = sending;
    // Posting takes a click on Send: a keystroke that lands in this frame some other way must never send, so Enter is a newline.
    const send = node("button", { type: "button", class: "send" + (sending ? " busy" : ""), "aria-label": "Send", onclick: submit });
    send.append(icon("M12 19V5M5 12l7-7 7 7", "2.5"));
    const sync = () => { send.disabled = area.value.trim() === "" || !!busy[key]; fit(area); };
    area.addEventListener("input", () => { texts[key] = area.value; sync(); });
    area.addEventListener("compositionstart", () => { composing = true; });
    area.addEventListener("compositionend", () => { composing = false; if (owed) { owed = false; render(); } });
    send.disabled = area.value.trim() === "" || sending;
    return [node("div", { class: "composer" }, [area, send]), errorLine(key)];
  };
  // The field is one line and grows with what is typed, up to the cap, then scrolls.
  const fit = (area) => {
    area.style.height = "auto";
    area.style.height = Math.min(area.scrollHeight, 160) + "px";
  };
  const fitAll = () => { for (const area of cards.querySelectorAll("textarea")) fit(area); };

  // Marks the focused card; in the sidebar it is the active one, so the column is laid out again around it and the page is asked to bring it into view.
  const markFocus = () => {
    for (const element of cards.querySelectorAll("[data-thread]")) element.classList.toggle("focus", focusId !== "" && element.dataset.thread === focusId);
    // The focused card's reply box was hidden, so it was fitted at no height.
    fitAll();
    revealOwed = focusId !== "";
    restack();
  };
  const focusThread = (id) => {
    if (focusId === id) return;
    focusId = id;
    markFocus();
    post({ event: "focus", threadId: id });
  };

  const resolveThread = (id) => act("t:" + id, () => call("POST", docPath("/threads/" + encodeURIComponent(id) + "/resolve"), { version: versionOf() || undefined }), () => {
    undoId = id;
    window.clearTimeout(undoTimer);
    undoTimer = window.setTimeout(() => { undoId = ""; render(); }, 6000);
    if (focusId === id) { focusId = ""; post({ event: "focus", threadId: "" }); }
  });
  const reopenThread = (id) => act("t:" + id, () => call("POST", docPath("/threads/" + encodeURIComponent(id) + "/reopen"), { version: versionOf() || undefined }), () => { if (undoId === id) undoId = ""; });

  // One comment: who and when, then its text. The first comment of a thread you may resolve carries the check at the right; a comment of yours carries a menu with its Delete, named for what it deletes, and asks first.
  const commentRow = (thread, comment, index, mayResolve) => {
    const w = who(comment.author, comment.createdAt);
    const id = text(comment.commentId);
    const what = index === 0 ? "thread" : "comment";
    const kids = [w];
    // Only the authenticated read may enable a write control: relayed data is the page's, and the page is not trusted.
    if (own !== null) {
      const tools = node("span", { class: "tools" });
      if (mayResolve) tools.append(iconButton("Resolve", "M5 12.5l4.5 4.5L19 7.5", () => resolveThread(text(thread.threadId))));
      if (comment.mine === true) {
        tools.append(node("button", { type: "button", class: "ic more", "aria-label": "More actions", title: "More actions", "aria-haspopup": "menu", "aria-expanded": String(menuId === id), onclick: () => { menuId = menuId === id ? "" : id; render(); } }, ["⋯"]));
        if (menuId === id) w.append(node("div", { class: "menu", role: "menu" }, [node("button", { type: "button", role: "menuitem", class: "item", onclick: () => { menuId = ""; confirming = id; render(); } }, ["Delete " + what])]));
      }
      if (tools.firstChild) w.append(tools);
      if (comment.mine === true && confirming === id) {
        const del = button("Delete", () => { confirming = ""; act("c:" + id, () => call("DELETE", docPath("/comments/" + encodeURIComponent(id))), null); }, "link danger");
        del.setAttribute("aria-label", "Delete " + what);
        kids.push(node("div", { class: "acts" }, ["Delete this " + what + "?", del, button("Keep", () => { confirming = ""; render(); }, "link")]));
      }
    }
    kids.push(node("div", { class: "txt" }, [text(comment.body)]));
    if (index > 0 && errors["c:" + id]) kids.push(errorLine("c:" + id));
    return kids;
  };
  const iconButton = (label, d, onclick) => {
    const b = node("button", { type: "button", class: "ic", "aria-label": label, title: label, onclick: onclick });
    b.append(icon(d, "2.2"));
    return b;
  };

  // A card beside its passage shows no quote, since the highlight is the quote; one that is not (an orphan, a resolved thread, the phone's sheet) does.
  const threadCard = (thread, orphan) => {
    const id = text(thread.threadId);
    const resolved = thread.state === "resolved";
    const res = resolved && thread.resolution ? thread.resolution : null;
    const by = res ? authorOf(res.by).name : "";
    // Typed, not concatenated: a relayed atVersion is the page's, and a string there could write its own "by" into the summary.
    const at = res && Number.isInteger(res.atVersion) && res.atVersion > 0 ? res.atVersion : 0;
    const summary = res ? (at ? "Resolved in v" + at : "Resolved") + (relayedOnly() ? "" : " by " + by) : "Resolved";
    const card = node("div", { class: "card" + (resolved ? " resolved" : "") + (orphan ? " muted" : "") + (focusId === id ? " focus" : "") + (hoverId === id ? " hover" : ""), "data-thread": id, tabindex: "0" });
    // A click, not a press: the card moves to its passage when it becomes active, and a press that moved it would lose the click it began (on Resolve, say).
    card.addEventListener("click", () => focusThread(id));
    // Tab reaches every card, and a card reached from the keyboard becomes active, which shows its reply box. Only keyboard focus (focus-visible): a press focuses the card too, and must leave that to the click.
    card.addEventListener("focusin", (event) => { if (event.target.matches(":focus-visible")) focusThread(id); });
    // The pointer over a card marks its passage, as the passage under the pointer lifts its card.
    card.addEventListener("pointerenter", (event) => { if (event.pointerType !== "touch") post({ event: "hover", threadId: id }); });
    card.addEventListener("pointerleave", (event) => { if (event.pointerType !== "touch") post({ event: "hover", threadId: "" }); });
    if (orphan || resolved || mode === "overlay") card.append(node("div", { class: "quote" }, [text(thread.anchor && thread.anchor.exact)]));
    if (resolved) card.append(node("p", { class: "where" }, [summary]));
    const comments = Array.isArray(thread.comments) ? thread.comments : [];
    const mayResolve = own !== null && !resolved && thread.canResolve === true;
    comments.forEach((comment, index) => card.append(...commentRow(thread, comment, index, mayResolve && index === 0)));
    if (resolved && own !== null && thread.canResolve === true) card.append(node("div", { class: "acts" }, [button("Reopen", () => reopenThread(id), "link")]));
    if (errors["t:" + id]) card.append(errorLine("t:" + id));
    const first = comments[0];
    const firstId = first ? text(first.commentId) : "";
    if (firstId && errors["c:" + firstId]) card.append(errorLine("c:" + firstId));
    if (!resolved) {
      // A reply box on every card made them tall: only the focused card shows its box (the stylesheet).
      const reply = () => {
        const body = (texts["r:" + id] || "").trim();
        if (body) act("r:" + id, () => call("POST", docPath("/threads/" + encodeURIComponent(id) + "/comments"), { body: body, version: versionOf() || undefined }), () => { texts["r:" + id] = ""; focusKey = "r:" + id; announce("Comment posted"); });
      };
      const box = writer("r:" + id, "Reply…", reply);
      // Only a box to type in hides with the card's focus; the line that says there is none stays.
      if (viewer() !== null && viewer().canComment) card.append(node("div", { class: "replybox" }, box)); else card.append(...box);
    }
    return card;
  };

  const cancelDraft = () => {
    draft = null;
    texts.draft = "";
    errors.draft = "";
    render();
    post({ event: "cancel" });
  };
  const draftCard = () => {
    const card = node("div", { class: "card draft", "data-thread": "" });
    const submit = () => {
      const body = (texts.draft || "").trim();
      const snapshot = draft;
      if (!body || !snapshot) return;
      const request = { anchor: snapshot, body: body };
      if (pinned) request.version = pinned;
      // The composer stays, read-only with a spinner in Send, until the write has landed; then the new thread is drawn where the draft was until the page reports where its passage is.
      act("draft", () => call("POST", docPath("/threads"), request), (result) => {
        draft = null;
        texts.draft = "";
        if (result && typeof result.threadId === "string") { focusId = result.threadId; posted = { thread: result.threadId, top: draftTop }; focusKey = "r:" + result.threadId; }
        announce("Comment posted");
      });
    };
    card.append(...writer("draft", "Add a comment…", submit));
    return card;
  };

  const threadsOf = () => {
    const m = model();
    return m && Array.isArray(m.threads) ? m.threads.filter((t) => t && typeof t === "object" && typeof t.threadId === "string") : [];
  };

  // The sidebar: what belongs at the top (the header, the one line, resolved and orphaned threads) stacked from the top, then a card beside each passage the page placed, and the draft.
  const renderSide = () => {
    const threads = threadsOf().filter((t) => t.state !== "resolved");
    const lost = new Set(lostIds);
    const orphaned = (t) => t.anchorStatus !== "anchored" || lost.has(t.threadId);
    const flow = [];
    for (const t of threads) {
      if (orphaned(t)) continue;
      const at = tops !== null && typeof tops[t.threadId] === "number" ? tops[t.threadId] : posted !== null && posted.thread === t.threadId ? posted.top : null;
      if (at !== null) flow.push({ el: threadCard(t, false), want: at, thread: t.threadId });
    }
    if (draft) flow.push({ el: draftCard(), want: draftTop, thread: "" });
    const head = [header()];
    const line = lineCard(flow.length > 0);
    if (line) head.push(line);
    if (showResolved) for (const t of resolvedOf()) head.push(threadCard(t, false));
    const orphans = threads.filter(orphaned);
    if (orphans.length) {
      head.push(node("div", { class: "heading" }, ["On text that changed"]));
      for (const t of orphans) head.push(threadCard(t, true));
    }
    // In passage order: the page sends the positions in it, so passages that share a line keep the order they are read in.
    const order = tops !== null ? Object.keys(tops) : [];
    flow.sort((a, b) => a.want - b.want || order.indexOf(a.thread) - order.indexOf(b.thread));
    const all = head.concat(flow.map((item) => item.el));
    cards.replaceChildren(...all);
    fitAll();
    stacked = { head: head, flow: flow };
    restack();
    for (const el of all) sizes.observe(el);
  };

  // Lays the column out as a document editor's margin does. The top items stack from under the bar. Then the cards, in passage order, GAP apart: the active card (the draft, else the focused thread) exactly level with its passage, even over the top items, the cards above it pushed up and the ones below pushed down only as far as they must; with none active, each card is level with its passage unless the one above reaches past it. Then it tells the page how tall that needs the column to be (it can then extend the document, so the last card is reached by scrolling the page, never the frame). Run again whenever a card's height changes: the reply box appearing on the active card, or growing as it is typed in.
  const GAP = 8;
  const restack = () => {
    if (mode !== "margin") return;
    let floor = BAR;
    for (const el of stacked.head) {
      el.style.top = floor + "px";
      floor += el.offsetHeight + GAP;
    }
    const flow = stacked.flow, h = flow.map((item) => item.el.offsetHeight), at = [];
    const k = draft ? flow.findIndex((item) => item.thread === "") : focusId ? flow.findIndex((item) => item.thread === focusId) : -1;
    if (k >= 0) {
      at[k] = flow[k].want;
      for (let i = k - 1; i >= 0; i--) at[i] = Math.min(flow[i].want, at[i + 1] - GAP - h[i]);
    }
    for (let i = k + 1; i < flow.length; i++) at[i] = Math.max(flow[i].want, i > 0 ? at[i - 1] + h[i - 1] + GAP : floor);
    let bottom = floor;
    flow.forEach((item, i) => {
      item.el.style.top = at[i] + "px";
      bottom = Math.max(bottom, at[i] + h[i] + GAP);
    });
    cards.style.height = Math.max(height, bottom) + "px";
    const need = Math.ceil(bottom);
    if (need !== sentNeed) { sentNeed = need; post({ event: "size", height: need }); }
    // Owed until the active card is laid out: a thread focused while the sidebar was closed is revealed once its card is drawn.
    if (revealOwed && k >= 0) {
      revealOwed = false;
      post({ event: "reveal", top: at[k], height: h[k] });
    }
  };
  const sizes = new ResizeObserver(() => {
    if (mode === "margin") restack();
    else reportSheet();
  });
  // The sheet is as tall as its content, up to the page's cap, so it reports the content's height.
  const reportSheet = () => post({ event: "height", px: Math.ceil(main.scrollHeight) });

  // The sheet's list: one row per open thread, its passage and who is in it. A tap opens the card and scrolls to the passage.
  const rows = () => threadsOf().filter((t) => t.state !== "resolved").map((t) => {
    const comments = Array.isArray(t.comments) ? t.comments : [];
    const replies = Math.max(0, comments.length - 1);
    const line = authorOf(comments[0] && comments[0].author).name + (replies ? " · " + replies + (replies === 1 ? " reply" : " replies") : "");
    return node("button", { type: "button", class: "row", onclick: () => { focusId = text(t.threadId); render(); post({ event: "focus", threadId: focusId }); } }, [node("span", { class: "rq" }, [text(t.anchor && t.anchor.exact)]), node("span", { class: "rw" }, [line])]);
  });
  // The sheet: the header, then the draft, or the focused thread, or the list of open threads.
  const renderSheet = () => {
    const kids = [header()];
    if (draft) kids.push(draftCard());
    else {
      const thread = threadsOf().find((t) => t.threadId === focusId && t.state !== "resolved");
      const line = lineCard(!!thread);
      if (line) kids.push(line);
      if (showResolved) kids.push(...resolvedOf().map((t) => threadCard(t, false)));
      const list = rows();
      if (thread) kids.push(threadCard(thread, thread.anchorStatus !== "anchored"));
      else if (list.length) kids.push(node("div", { class: "list" }, list));
    }
    cards.replaceChildren(...kids);
    fitAll();
    cards.style.height = "";
  };

  const render = () => {
    const active = document.activeElement;
    const key = active && active.dataset ? active.dataset.key : undefined;
    const from = key !== undefined && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    if (composing) { owed = true; return; }
    main.className = mode + (dark ? " dark" : "");
    sizes.disconnect();
    stacked = { head: [], flow: [] };
    try {
      if (!shown) cards.replaceChildren();
      else if (mode === "overlay") renderSheet();
      else renderSide();
    } catch (error) {
      cards.replaceChildren();
    }
    // After a post, the reader's next words go in the reply field of what they posted, as in a chat; that follows their own click on Send in this frame. Otherwise the field that had focus keeps it.
    const want = focusKey || key;
    if (want !== undefined) {
      const again = Array.from(cards.querySelectorAll("[data-key]")).find((element) => element.dataset.key === want);
      if (again) { again.focus({ preventScroll: true }); if (from && want === key) again.setSelectionRange(from[0], from[1]); }
    }
    focusKey = "";
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
    } else if (msg.event === "theme") {
      // Only colours change, so the cards are not rebuilt under a reader typing in one.
      dark = msg.dark === true;
      main.classList.toggle("dark", dark);
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
        // Only the host's height moved (often in answer to our own size message): re-lay the cards, never rebuild them, or a reply box being typed in is replaced under the pointer.
        if (nextHeight !== height) {
          height = nextHeight;
          restack();
        }
        return;
      }
      positionsKey = key;
      tops = next;
      if (posted !== null && typeof next[posted.thread] === "number") posted = null;
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
        revealOwed = true;
        render();
        // The page's Comment click asks for focus. Any page on the serving origin could ask too, which gains it nothing: it could already put a reader's click on this box through a transparent frame, and posting still takes a click on Send.
        if (msg.focus === true) {
          const field = Array.from(cards.querySelectorAll("textarea")).find((element) => element.dataset.key === "draft");
          if (field) field.focus({ preventScroll: true });
        }
      } else if (draft) {
        draft = null;
        render();
      }
    } else if (msg.event === "hover") {
      hoverId = typeof msg.threadId === "string" ? msg.threadId : "";
      for (const element of cards.querySelectorAll("[data-thread]")) element.classList.toggle("hover", hoverId !== "" && element.dataset.thread === hoverId);
    } else if (msg.event === "dismiss") {
      if (draft && (texts.draft || "").trim() === "") cancelDraft();
    } else if (msg.event === "focus") {
      focusId = typeof msg.threadId === "string" ? msg.threadId : "";
      if (mode === "overlay") render();
      else markFocus();
    }
  });
  // A click anywhere else in the frame closes a draft that has nothing typed in it; one with words stays until it is sent or Escape.
  document.addEventListener("pointerdown", (event) => {
    if (!draft || (texts.draft || "").trim() !== "") return;
    if (event.target instanceof Element && event.target.closest('[data-thread=""]')) return;
    cancelDraft();
  });
  // Escape closes an empty draft; one with words in it is kept, and Escape only leaves the field.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (menuId) { menuId = ""; render(); return; }
    if (draft) {
      if ((texts.draft || "").trim() === "") cancelDraft();
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    } else if (mode === "overlay") post({ event: "close" });
  });
  // A press outside an open menu closes it without redrawing, so the press that closed it still lands on what it was aimed at.
  document.addEventListener("pointerdown", (event) => {
    if (!menuId || (event.target instanceof Element && event.target.closest(".menu, .more"))) return;
    menuId = "";
    for (const element of cards.querySelectorAll(".menu")) element.remove();
    for (const element of cards.querySelectorAll(".more")) element.setAttribute("aria-expanded", "false");
  });

  try { prepare().catch(() => {}); } catch (error) {}
  load();
})();
`;
