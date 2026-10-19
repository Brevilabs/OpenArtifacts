/**
 * Serve-time rendering: the one pass that turns a stored document into the
 * bytes readers get.
 *
 * It runs on the response stream, not on the stored object, and R2 holds the
 * publisher's own bytes untouched. That costs a streaming parse per read
 * instead of one per push, and buys the property the alternative cannot have:
 * changing a byline, or a plan that removes one, takes effect on documents
 * already published. Nothing tells this service that a licence changed plan —
 * reads never authenticate — so a re-bake job would have no trigger and an
 * upgraded publisher would keep their watermark forever.
 *
 * It also moves where a parse failure surfaces. Baking at push time made this
 * pass a validation gate: a document lol-html could not get through failed in
 * front of the publisher, who could fix it. Here the headers are already sent
 * when the transform runs, so the same document would break a reader's page
 * instead. lol-html accepts anything the HTML spec calls a document and has no
 * error state to reach for well-formed-ish markup, which is why this is
 * recorded rather than defended against.
 *
 * It is emphatically *not* a sanitizer. Uploaded scripts run (D6): the document
 * arrives already rendered by Obsidian, complete with callouts, dataview output
 * and embedded interactive figures, and stripping or escaping any of it would
 * destroy the fidelity that is the whole reason the client renders HTML. Safety
 * comes from the serving headers and a sacrificial origin that holds no credential, not from
 * rewriting the publisher's markup. The only edits made here are the additions
 * below.
 *
 * HTMLRewriter rather than string surgery, because it is a real HTML tokenizer:
 * a `<head>` written inside a comment or emitted by `document.write("<head>")`
 * is text to it, so injection lands in the document's actual head or nowhere.
 */

/**
 * Belt to the `X-Robots-Tag` header's braces (D9). The header is the
 * authoritative signal — it applies to every response including errors — but
 * the meta tag travels with the bytes, so a doc that is copied, mirrored, or
 * served from anywhere else keeps asking not to be indexed.
 */
export const NOINDEX_META = '<meta name="robots" content="noindex,nofollow">';

/**
 * What the reader's tab shows. Without it a shared doc carries the browser's
 * blank-page glyph, which is the least identifiable thing in a row of tabs.
 *
 * The mark is `favicon.svg` from the product site, inlined as a data URI for
 * the reasons the Copilot mark below is: no second request, and nothing to
 * break when these bytes are read from a mirror long after this deploy.
 * `img-src` — the directive favicons load under — already admits `data:`.
 * `encodeURIComponent` escapes the `"` and `#` in the markup, so nothing in
 * the value can close the `href` around it.
 *
 * A document that declares its own icon keeps that markup; ours is prepended
 * ahead of it, and which one the tab shows is then the browser's choice.
 * Detecting the case to stay out of it would cost a second pass over the head,
 * and neither outcome is wrong: the page is the publisher's, and it is served
 * by us.
 */
/** The cube mark `openartifacts.ai` uses as its own favicon, as raw SVG sized by its container. */
export const OPENARTIFACTS_MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" rx="44" fill="#15161a"/>' +
  '<g transform="translate(0 8)"><path d="M100 16 L100 60 M27.3 142 L65.4 120 M172.7 142 L134.6 120" stroke="#ffffff" stroke-opacity="0.3" stroke-width="2.6" fill="none"/>' +
  '<path d="M100 16 L27.3 58 L27.3 142 L100 184 L172.7 142 L172.7 58 Z" stroke="#ffffff" stroke-opacity="0.8" stroke-width="2.6" fill="none" stroke-linejoin="miter"/>' +
  '<path d="M100 60 L65.4 80 L100 100 L134.6 80 Z" fill="#f2f2f0"/>' +
  '<path d="M65.4 80 L65.4 120 L100 140 L100 100 Z" fill="#6f7175"/>' +
  '<path d="M100 140 L134.6 120 L134.6 80 L100 100 Z" fill="#3b3d40"/>' +
  '<path d="M27.3 58 L100 100 M100 184 L100 100 M172.7 58 L100 100" stroke="#ffffff" stroke-opacity="0.72" stroke-width="2.6" fill="none"/>' +
  '</g></svg>';

export const FAVICON_LINK =
  '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,' +
  encodeURIComponent(OPENARTIFACTS_MARK_SVG) +
  '">';

/**
 * The card image every shared doc unfurls with, on the brand domain.
 *
 * It is the one OpenArtifacts addition that cannot be inlined. A data URI is not a
 * valid `og:image` — every unfurler fetches the value over http(s) from its own
 * infrastructure, never from the reader's browser — so this is a hard
 * dependency on a url staying alive, which is exactly the dependency the
 * favicon and the Copilot mark were inlined to avoid.
 *
 * Given that, `openartifacts.ai` rather than the marketing site's Vercel
 * deployment url: pinned `/v{n}` pages are served `immutable` for a year, so a
 * document published today is still handing this url to crawlers long after
 * this deploy, and a preview deployment's hostname is not a thing to bet that
 * on. It is the same 1200×630 image the product site's own card uses.
 *
 * It loads on the *unfurler's* side, so nothing about it touches the serving
 * origin's CSP or costs a reader a request.
 */
export const OG_IMAGE_URL = "https://openartifacts.ai/og-image.png";

/**
 * The part of the card that is the same for every document: which image, how
 * big it is, and that it should be shown full-bleed rather than as a thumbnail.
 *
 * `og:image:width`/`height` matter more than they look. Without them a crawler
 * that has not yet fetched the image has to guess whether it is large enough
 * for a big card, and several of them render a small square — or nothing — on
 * the first unfurl and only correct it on a later scrape. Stating the real
 * dimensions makes the first paste render right.
 *
 * `twitter:card` is the only `twitter:` tag carried: X falls back to the `og:`
 * tags for everything else, and duplicating them would be two strings to keep
 * in step for no gain. `og:type` is absent for the same reason in reverse —
 * nothing that unfurls these links renders anything differently for it.
 *
 * `og:site_name` does earn its place: it is the small label Discord and Slack
 * put above the title, and naming OpenArtifacts there is the branding this exists
 * for.
 */
export const SOCIAL_CARD_META =
  '<meta property="og:site_name" content="OpenArtifacts">' +
  `<meta property="og:image" content="${OG_IMAGE_URL}">` +
  '<meta property="og:image:width" content="1200">' +
  '<meta property="og:image:height" content="630">' +
  '<meta property="og:image:alt" content="OpenArtifacts: A new mode of communication between agents and humans.">' +
  '<meta name="twitter:card" content="summary_large_image">';

/** How much of a document's title the card carries. Every unfurler truncates
 * well before this; the cap is here so an unclosed `<title>` — which makes the
 * parser treat the rest of the document as title text — cannot put a whole
 * document into a meta tag. */
const MAX_CARD_TITLE = 300;

/**
 * A title read out of the document is publisher-controlled text going back into
 * markup, so it is escaped rather than trusted. `&` first, or it would re-escape
 * the ampersands the later replacements introduce.
 *
 * All four of `&<>"` and not just the quote that closes the attribute: the
 * injection is handed to HTMLRewriter as markup (`AS_HTML`), so a `<` in a title
 * would open an element rather than sit in a `content=""`.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The per-document half of the card: `og:title`, taken from the document's own
 * `<title>`.
 *
 * A static title would be worse than none — every doc would unfurl under the
 * same words, and a link to a specific document would say nothing about which
 * one. Taking it from the document keeps this a pure function of the stored
 * bytes, which is what lets the served etag stay a per-object validator: no D1
 * read, and nothing that can drift out from under a pinned `/v{n}` url.
 *
 * Whitespace is collapsed because a pretty-printed `<title>` spans lines, and
 * the newlines would reach the card as-is.
 *
 * Empty means no tag rather than an empty one: unfurlers fall back to the
 * `<title>` element on their own, and an empty `content` would stop them.
 */
export function socialTitleMeta(rawTitle: string): string {
  const title = rawTitle.replace(/\s+/g, " ").trim();
  if (title.length === 0) return "";
  return `<meta property="og:title" content="${escapeAttribute(title)}">`;
}

/**
 * Shared between the two bylines (D9).
 *
 * `all:initial` first, then only the properties we want back: the page's own
 * stylesheet has no way to guess these classes, but it very often styles `div`,
 * and a byline inheriting a 4rem serif body font would look like a bug. Inline
 * styles keep them self-contained — no stylesheet to fetch, nothing for the CSP
 * to allow.
 */
const BYLINE_BASE =
  "all:initial;display:block;box-sizing:border-box;width:100%;clear:both;" +
  "font:400 13px/1.6 Archivo,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
  "color:#888;text-align:center";

/**
 * The container's `all:initial` does not reach its descendants, so the anchor
 * carries its own — otherwise a document's `a { display: none }` deletes the
 * branding, and a stylesheet that hides bare links is ordinary rather than
 * hostile. `all:initial` also drops `cursor` to `auto` and the font to the UA
 * default, so both are put back; `font:inherit` takes the byline's.
 *
 * Where this stops: a document declaration marked `!important` outranks an
 * inline one, so `a { display: none !important }` still wins. Closing that
 * needs shadow DOM or an iframe — the byline would stop being part of the
 * document — which is a much larger change than a byline warrants.
 *
 * `_blank` because the reader is mid-document: a byline that navigates the page
 * away costs them their place, and the footer sits at the end of something they
 * were reading. `noopener` denies the opened page a handle back to this one;
 * `no-referrer` on the serving surface already covers the referrer, but the
 * `rel` travels with the bytes if the document is mirrored elsewhere.
 */
const BYLINE_LINK =
  'target="_blank" rel="noopener noreferrer" style="' +
  "all:initial;font:inherit;display:inline;cursor:pointer;" +
  'color:#888;text-decoration:underline"';

/** The Copilot mark's outline, from `mark-mono-cream.svg` in the product site. */
const MARK_PATH =
  "M75.9 6.9c-6.8 1.4-12.5 6-35.5 29.3-33.5 33.8-33.5 33.9-34.2 62.2-0.3 12.4 0 20.2 0.7 22.7 " +
  "2.4 7.8 10.8 11.2 17.6 7.1 1.7-1.1 14.9-14.1 29.5-29.1 14.5-14.9 26.7-27 27-26.9 0.3 0.2 12.4 12.4 " +
  "27 27.3 14.6 14.8 27.6 27.8 29 28.7 5.1 3.6 13.6 1.4 16.5-4.2 1.2-2.3 1.5-6.9 1.5-22.3 0-22.9-1.2-28.6-8.3-37.9-7.6-10.2-50-52.3-54.9-54.6-5.1-2.4-10.9-3.2-15.9-2.3z";

/**
 * The mark as a data URI, not as an element.
 *
 * Inlined rather than linked, because a byline that depends on another host's
 * uptime is a byline that is sometimes a broken-image icon, and the document
 * may be read from a mirror or a cache long after this deploy. `img-src` on the
 * serving surface admits `data:`, so nothing in the CSP has to move.
 *
 * A data URI rather than an inline `<svg>` because the mark shares the DOM with
 * an interactive document (D6). Prepending the header puts our element *first*,
 * so a figure that opens with `d3.select("svg")` or `document.querySelector(
 * "svg")` — the ordinary way to grab a chart's root — would find the logo and
 * draw into it. That is a real document breaking on a real selector, not a
 * hostile one. The byline's own grey is baked in place of `currentColor`, which
 * costs nothing: `BYLINE_BASE` pins the colour anyway.
 */
const copilotMarkSrc = (fill: string): string =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 4 152 127" fill="${fill}">` +
      `<path d="${MARK_PATH}"/></svg>`,
  );

/**
 * And a `<span>` rather than an `<img>`, for the same reason one step further:
 * `querySelectorAll("img")` is how a lightbox or a caption pass finds a
 * document's figures, and the mark must not be one of them. A background image
 * on an empty span answers to neither selector.
 */
const copilotMark = (fill: string): string =>
  '<span aria-hidden="true" style="all:initial;display:inline-block;' +
  "width:17px;height:14px;vertical-align:-0.15em;flex:none;" +
  // `url()` unquoted: `encodeURIComponent` leaves nothing in the value that
  // would close the CSS function or the HTML attribute around it.
  `background:url(${copilotMarkSrc(fill)}) center/contain no-repeat"></span>`;

/** The header's mark, in the header's own grey. */
const COPILOT_MARK = copilotMark("#888");

/**
 * The header's link carries the mark as well as the name, so both are clickable.
 * `inline-flex` to keep them on one line at a shared baseline, and the underline
 * moves to the text — an underlined logo reads as a rendering fault.
 */
const BYLINE_LINK_WITH_MARK =
  'target="_blank" rel="noopener noreferrer" style="' +
  "all:initial;font:inherit;display:inline-flex;align-items:center;gap:0.4em;" +
  'cursor:pointer;color:#888;text-decoration:none"';

/**
 * The two spans the header needs for layout, each reset like everything else it
 * adds.
 *
 * The rule is one per element, without exception: `all:initial` on the container
 * does not reach descendants, so a span left bare is a span a document's
 * `span { font-size: 0 }` or `span { position: absolute }` reaches — and a
 * stylesheet with a broad `span` rule is ordinary rather than hostile. `font`
 * and `color` come straight back, since the point is to inherit the byline's,
 * not the document's.
 */
const SPAN_RESET = "all:initial;font:inherit;color:inherit;";

/**
 * Where the document came from. Injected at the top of the body, except on a
 * server with reader sign-in, where the top bar carries this text instead.
 */
export const OPENARTIFACTS_HEADER =
  '<div class="openartifacts-header" style="' +
  BYLINE_BASE +
  ";margin:0 0 2rem;padding:0.75rem 0;border-bottom:1px solid rgba(128,128,128,0.25)\">" +
  `<span style="${SPAN_RESET}display:inline-flex;align-items:center;gap:0.4em">Shared from ` +
  `<a href="https://obsidiancopilot.com" ${BYLINE_LINK_WITH_MARK}>` +
  COPILOT_MARK +
  `<span style="${SPAN_RESET}text-decoration:underline">Copilot for Obsidian</span>` +
  "</a></span></div>";

/** What served it. Injected immediately before `</body>`. */
export const OPENARTIFACTS_FOOTER =
  '<div class="openartifacts-footer" style="' +
  BYLINE_BASE +
  ";margin:4rem 0 0;padding:1rem 0;border-top:1px solid rgba(128,128,128,0.25)\">" +
  `Powered by <a href="https://openartifacts.ai" ${BYLINE_LINK}>openartifacts.ai</a>, ` +
  "a new mode of communication between agents and humans</div>";

/** System fonts only: the bar fetches nothing. */
const BAR_FONT_FAMILY = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const BAR_FONT = `font:500 13px/1.25 ${BAR_FONT_FAMILY}`;

/**
 * The strip's own height, as the spacer takes it: change both or content starts
 * under the strip. `flex:none` keeps the spacer from shrinking when the author's
 * body is a column flexbox, and like every element the bar adds it carries
 * `all:initial` (an author `!important` rule still wins, as `BYLINE_LINK`
 * already concedes).
 */
export const OPENARTIFACTS_BAR_SPACER =
  '<div class="openartifacts-bar-spacer" aria-hidden="true" style="all:initial;display:block;flex:none;height:48px"></div>';

/**
 * The one stylesheet the bar adds: a scroll offset the size of the strip, so an
 * anchor jump or a focused control does not land under it, a print rule,
 * because a fixed strip repeats over the top of every printed page, and the
 * states an inline style cannot express (hover and focus). The scroll offset
 * and the print rule do not belong in an inline style: a print rule needs a
 * media query, and an inline `scroll-padding` would have to go on the author's
 * own `<html>` element, where it would beat the author's own rule. `:where()`
 * has zero specificity, so an author rule on `html` or `:root` wins.
 *
 * The state rules are `:where()`-scoped too, but must say `!important`: every
 * element carries `all:initial` inline, and an inline declaration beats any
 * stylesheet rule that is not important. That is the same concession
 * `BYLINE_LINK` already makes: an author `!important` rule with higher
 * specificity still wins.
 *
 * No `media` attribute: on a page with no head stylesheet this is
 * `document.styleSheets[0]`, and author code calling `insertRule` on it must get
 * rules that apply on screen. It lives in `<body>` with the bar because the bar
 * has one injection site.
 */
export const OPENARTIFACTS_BAR_STYLE =
  "<style>:where(html){scroll-padding-top:48px}" +
  "@media print{.openartifacts-bar,.openartifacts-bar-spacer,.openartifacts-share-popover{display:none!important}}" +
  // Home is its icon alone on a phone, so the byline keeps the room.
  "@media(max-width:600px){:where(.openartifacts-home){padding:0 9px!important}:where(.openartifacts-home-label){display:none!important}}" +
  ":where(.openartifacts-share,.openartifacts-home):hover{background:#272b33!important;border-color:rgba(255,255,255,0.14)!important}" +
  // The Comments button (`src/comments-scripts.ts`): its border and ink only, never
  // its background, which says whether the sidebar is open.
  ":where(.openartifacts-comments-button):hover{border-color:rgba(255,255,255,0.14)!important;color:#f4f5f7!important}" +
  ":where(.openartifacts-share,.openartifacts-home):focus-visible,:where(.openartifacts-comments-button):focus-visible,:where(.openartifacts-byline):focus-visible{" +
  "outline:2px solid #f6ae52!important;outline-offset:2px!important}" +
  ":where(.openartifacts-byline):is(:hover,:focus-visible) .openartifacts-byline-text{text-decoration:underline!important}" +
  "</style>";

/**
 * Fixed rather than sticky, because it survives author `overflow` rules that
 * break `sticky`; the highest z-index there is. Dark, like the reader pages
 * (`#0b0c10`, nearly the page background `#07080b`), whatever the document
 * under it looks like, so it reads as the host's chrome and not as a part of the
 * author's page. The surface is solid and never translucent: a
 * translucent surface greys out over a white document (an 86% one composites to
 * about `#2b2c2f`) and then sits visibly apart from the near-black popover
 * hanging under it, and a solid one is also what a browser without
 * `backdrop-filter` would show, so the two never differ.
 * Contrast: the byline's `#8d94a0` on `#0b0c10` is 6.4:1 and its link `#c9ced6`
 * 12:1, both above 4.5:1.
 * `direction:ltr` because `all` resets every property except `direction` and
 * `unicode-bidi`: a publisher's `dir=rtl` would otherwise draw Share at the left
 * edge, away from where the popover opens.
 */
const BAR_STYLE =
  "all:initial;direction:ltr;position:fixed;top:0;left:0;right:0;z-index:2147483647;box-sizing:border-box;" +
  "height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;" +
  "padding:0 12px 0 16px;background:#0b0c10;border-bottom:1px solid rgba(255,255,255,0.08);color:#8d94a0;" +
  "-webkit-font-smoothing:antialiased;" +
  BAR_FONT;

/**
 * The bar's byline link, reset like `BYLINE_LINK_WITH_MARK` and for the same
 * reasons. `#c9ced6` is a step brighter than the muted text around it, so the
 * link reads as one; it is underlined on hover and focus only
 * (`OPENARTIFACTS_BAR_STYLE`). The underline and the focus ring sit outside the
 * link's text box, so nothing around the link may clip them: its text span has
 * vertical padding for the underline and the wrapper beside it does not hide
 * overflow (the text span already ends in an ellipsis).
 */
const BAR_BYLINE_LINK =
  'class="openartifacts-byline" target="_blank" rel="noopener noreferrer" style="all:initial;font:inherit;' +
  "display:flex;align-items:center;gap:0.4em;min-width:0;cursor:pointer;color:#c9ced6;" +
  'text-decoration:none;border-radius:4px"';

/** The Copilot mark in the link's colour, so it reads on the dark strip. */
const BAR_COPILOT_MARK = copilotMark("#c9ced6");

/**
 * Share's glyph, an arrow leaving a box, painted by a mask in the pill's own
 * ink (`#f4f5f7`). Not `currentColor`: the span's `all:initial` resets `color`
 * to `CanvasText`, which is black on a light document, and a black glyph on the
 * dark pill would vanish.
 * A data-URI background on an empty span, not an inline `<svg>`, for the reason
 * `copilotMarkSrc` gives: the bar is near the top of the body, and an `<svg>`
 * there is the first one a document's `querySelector("svg")` finds.
 */
const SHARE_ICON_SRC =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13"/></svg>',
  );
const SHARE_ICON =
  `<span aria-hidden="true" style="all:initial;display:block;flex:none;width:16px;height:16px;` +
  `background-color:#f4f5f7;-webkit-mask:url(${SHARE_ICON_SRC}) center/contain no-repeat;` +
  `mask:url(${SHARE_ICON_SRC}) center/contain no-repeat"></span>`;

/**
 * Share, and Home at the other end, are the strip's actions: a raised dark pill, a step lighter
 * than the strip, with a hairline edge (`#f4f5f7` on `#1d2027`, 15:1). Its
 * hover and focus ring are in `OPENARTIFACTS_BAR_STYLE`. It never wraps.
 */
const SHARE_STYLE =
  "all:initial;flex:none;box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;height:34px;" +
  "padding:0 16px 0 14px;border:1px solid rgba(255,255,255,0.08);border-radius:999px;background:#1d2027;" +
  "color:#f4f5f7;cursor:pointer;white-space:nowrap;text-decoration:none;-webkit-font-smoothing:antialiased;" +
  `font:500 14px/1 ${BAR_FONT_FAMILY}`;

/**
 * Where a served page's Share link leads and which script upgrades it. Both are
 * built from the deployment's API host (`serve.ts`), and the bar exists only
 * when reader sign-in is configured.
 */
export interface TopBar {
  /** `https://{API_HOST}/share/{docId}`: the plain link, which works with no script. */
  shareUrl: string;
  /** `https://{API_HOST}/embed/page.js`: the script that turns the link into a popover. */
  scriptUrl: string;
  /**
   * Whether the page has comments to show: a thread exists, or a person holds a
   * role of at least `comment`. Derived, never set by the owner. Set only on the shared link (`/d/{docId}`)
   * and left out of a pinned `/v{n}`, which is immutable and must not freeze it.
   * Rendered as `data-comments="on|off"` on the Share link; absent means "ask".
   */
  comments?: boolean;
  /**
   * The version these bytes are, set alongside `comments` on the shared link,
   * whose bytes change on a push while a reader's copy (an open tab, a 60-second
   * cache) does not. Rendered as `data-version`; the page script reads and writes
   * comments at it, so they stay tied to the text on screen. A pinned `/v{n}`
   * names its version in its path.
   */
  version?: number;
  /** `https://{API_HOST}/home`: where **Home** leads, the same for every viewer. */
  homeUrl: string;
}

/** Home's glyph, a house, painted the way `SHARE_ICON` is and for its reasons. */
const HOME_ICON_SRC =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 11l9-8 9 8M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/></svg>',
  );
const HOME_ICON =
  `<span aria-hidden="true" style="all:initial;display:block;flex:none;width:16px;height:16px;` +
  `background-color:#f4f5f7;-webkit-mask:url(${HOME_ICON_SRC}) center/contain no-repeat;` +
  `mask:url(${HOME_ICON_SRC}) center/contain no-repeat"></span>`;

/**
 * The top bar, in the order it must land: the spacer first, so it is the first
 * child of `<body>` and the author's content starts below the strip, then the
 * stylesheet, the strip, and the script tag.
 *
 * **The same bytes for every viewer of a document.** It names no identity, so a
 * public page keeps `max-age=60` and a pinned one `immutable`.
 *
 * Far left: **Home**, a plain link to `/home` in Share's style, for every viewer.
 * It is the same for everyone so the page learns nothing from it: `/home` itself
 * decides, listing the signed-in viewer's own pages or asking them to sign in.
 * Then the byline's text, for Copilot-rendered HTML that has branding. That
 * text exists only where the header byline would have: printing it on other
 * pages would be false attribution, or would undo `branding = false`, so those
 * pages get an empty left side. Right: **Share**, a plain link to the share page
 * that works with no script, and never branding, so a plan that removes the
 * bylines does not remove the owner's route to it.
 *
 * No shadow DOM: declarative shadow DOM would hide the bar entirely in browsers
 * without it, and the link must work with no script. The `data-` attribute is
 * how the script finds the link rather than a class an author might reuse.
 */
function topBar(bar: TopBar, byline: boolean): string {
  return (
    OPENARTIFACTS_BAR_SPACER +
    OPENARTIFACTS_BAR_STYLE +
    `<div class="openartifacts-bar" style="${BAR_STYLE}">` +
    `<a class="openartifacts-home" href="${escapeAttribute(bar.homeUrl)}" style="${SHARE_STYLE}">${HOME_ICON}` +
    `<span class="openartifacts-home-label" style="${SPAN_RESET}-webkit-font-smoothing:antialiased">Home</span></a>` +
    // A flex row, so the text and the link share one centre line. On a narrow
    // strip the link's own text ends in an ellipsis; Share keeps its width.
    `<span style="${SPAN_RESET}display:flex;align-items:center;gap:0.4em;flex:1 1 auto;min-width:0;white-space:nowrap">` +
    (byline
      ? `Shared from <a href="https://obsidiancopilot.com" ${BAR_BYLINE_LINK}>${BAR_COPILOT_MARK}` +
        `<span class="openartifacts-byline-text" style="${SPAN_RESET}display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 0;text-decoration:none;text-underline-offset:3px">Copilot for Obsidian</span></a>`
      : "") +
    "</span>" +
    `<a class="openartifacts-share" data-openartifacts-share href="${escapeAttribute(bar.shareUrl)}" ` +
    (bar.comments === undefined ? "" : `data-comments="${bar.comments ? "on" : "off"}" `) +
    (bar.version === undefined ? "" : `data-version="${bar.version}" `) +
    `target="_blank" rel="noopener noreferrer" style="${SHARE_STYLE}">${SHARE_ICON}Share</a>` +
    "</div>" +
    `<script defer src="${escapeAttribute(bar.scriptUrl)}"></script>`
  );
}

/** HTMLRewriter treats injected content as markup, not text, only when asked. */
const AS_HTML = { html: true } as const;

/**
 * Inject the robots meta, the favicon, the social card, the top bar and the
 * bylines, and change nothing else.
 *
 * Every injection has a fallback, because a document is not guaranteed to have
 * the tag we want to hang it on:
 *
 * - The meta, the favicon and the static half of the social card go first
 *   inside `<head>`. A document with no `<head>` gets them at the end instead,
 *   where the parser hoists them into the body — weaker for the meta, since a
 *   robots meta outside the head is not honoured, which is exactly why the
 *   `X-Robots-Tag` header carries the real signal, and best-effort for the icon
 *   and the card.
 * - `og:title` cannot go with them, because it is read out of the document's
 *   own `<title>` and that tag has not been seen yet when `<head>` opens. It is
 *   injected before `</head>` instead, by which point it has. A document that
 *   never closes its head keeps the image tags — they were prepended — and
 *   loses only this one, and losing it costs little: an unfurler with no
 *   `og:title` falls back to the `<title>` element, which is the same string.
 *   That is why the split is worth a second injection site rather than moving
 *   the whole card to the end tag.
 * - The top bar, or without one the header byline, is prepended inside
 *   `<body>`. A document with no `<body>` start tag gets it at the document end
 *   instead, which puts it below the content: wrong, but present, and the bar is
 *   fixed, so still visible. Hanging it on `<html>` would be no better,
 *   because that element's start tag is seen *before* `<body>`, so a fallback
 *   there would fire on every normal page and inject it twice. The client
 *   renders whole documents, so the fallback is the rare path.
 * - The footer goes immediately before `</body>`. `append()` is not used for
 *   this: it silently does nothing when an element has no end tag, and an
 *   unclosed `<body>` is common enough in hand-written HTML that a silently
 *   missing footer would be a real outcome. Hooking the end tag instead tells
 *   us whether the injection actually landed, and the document-end fallback
 *   covers every case where it did not.
 *
 * **Placement is best-effort, and deliberately not hardened further.**
 * HTMLRewriter is a token rewriter; the browser's tree builder is not, so
 * wherever the two disagree — a `<body>` inside `<template>`, in `<noscript>`,
 * in foreign content, in `srcdoc` — markup exists that puts a byline somewhere
 * useless. None of it is chased. A byline is not a security boundary:
 * `BYLINE_LINK` already concedes that a document rule marked `!important`
 * removes it outright, and every one of those shapes has to be written
 * deliberately by the publisher the header names. What the guards below are for
 * is documents a client actually renders.
 *
 * Takes and returns a `Response` so the body stays a stream: a 10MB document
 * passes through the worker without ever being a 10MB string in it, exactly as
 * it did when serving was a passthrough.
 *
 * `bar` is the top bar's two addresses, or null on a server with no reader
 * sign-in. When set it replaces the header byline (whose text moves into the
 * bar), on every document and whatever `branding` says. When null the output is
 * exactly what a server that predates the bar renders. Like the bylines it is
 * added here on the way out and never stored.
 *
 * `branding` will be false for plans that pay to remove the bylines. It takes
 * the favicon and the social card with them — an OpenArtifacts mark in the reader's
 * tab is branding too, and a card carrying OpenArtifacts' own image is the most
 * visible branding of the lot: it is what a paying customer's link shows in
 * somebody else's Discord. `og:title` goes with it rather than being kept on
 * its own, because a card with a title and no image is a worse unfurl than the
 * one an unfurler builds from `<title>` by itself.
 * It does not reach the robots meta, and must not: `noindex` is policy, and a flag that
 * switched it off would make paid customers' documents indexable — the worst
 * possible bug to ship attached to an upgrade.
 */
export function renderServedHtml(
  response: Response,
  branding = true,
  bar: TopBar | null = null,
): Response {
  const footer = branding ? OPENARTIFACTS_FOOTER : "";
  const head = branding ? NOINDEX_META + FAVICON_LINK + SOCIAL_CARD_META : NOINDEX_META;
  let fromCopilot = false;
  let headPlaced = false;
  let cardTitlePlaced = false;
  let headerPlaced = false;
  let footerPlaced = false;

  // The document's own `<title>`, accumulated as it streams past. Text arrives
  // in chunks, and an entity in the middle of one splits it into more, so this
  // cannot stop at the first chunk — it stops at the element's end tag.
  let documentTitle = "";
  let titleClosed = false;

  return new HTMLRewriter()
    // Copilot's existing HTML renderer emits this marker. It describes the
    // document format, not authenticated identity or publishing entitlement.
    // Two ids, because the renderer was renamed at the OpenArtifacts cutover
    // (Copilot 4.0.5): pages published by 4.0.0-4.0.4 through the Symposium
    // path carry the `symposium-` id and this Worker still serves them, so
    // dropping it would strip the byline off every pre-cutover document.
    .on(
      'style[id="openartifacts-obsidian-publish-baseline"], style[id="symposium-obsidian-publish-baseline"]',
      {
        element() { fromCopilot = true; },
      },
    )
    // `head > title` and not `title`: an inline `<svg>` may carry a `<title>`
    // of its own as its accessible name, and a chart's "Revenue by quarter" is
    // not what the document is called.
    .on("head > title", {
      element(element) {
        // First title wins, matching every other injection here. A second one
        // is marked closed on sight so its text is never accumulated.
        if (titleClosed || documentTitle.length > 0) {
          titleClosed = true;
          return;
        }
        element.onEndTag(() => {
          titleClosed = true;
        });
      },
      text(chunk) {
        if (titleClosed) return;
        documentTitle = (documentTitle + chunk.text).slice(0, MAX_CARD_TITLE);
      },
    })
    .on("head", {
      element(element) {
        if (headPlaced) return;
        headPlaced = true;
        // One `prepend()` for all three, because each prepend goes *ahead* of
        // the last: separate calls would have to be written in the reverse of
        // the order they produce, which is a trap for the next edit.
        element.prepend(head, AS_HTML);
        // Registered on the head that got the prepend, for the reason the
        // footer's callback is registered on the body that got the header.
        element.onEndTag((endTag) => {
          cardTitlePlaced = true;
          if (!branding) return;
          const titleMeta = socialTitleMeta(documentTitle);
          if (titleMeta.length > 0) endTag.before(titleMeta, AS_HTML);
        });
      },
    })
    .on("body", {
      element(body) {
        // Uploaded HTML can carry more than one `<body>` start tag, and this
        // handler fires for each — as `head`'s does above. Both injections go
        // to the first one, so the end-tag callback is registered on a single
        // element rather than on every match. Guarding *inside* that callback
        // is not equivalent: for `<body>a<body>b</body>c</body>` the inner end
        // tag arrives first, so a first-one-wins guard would put the footer
        // before `c`.
        if (headerPlaced) return;
        headerPlaced = true;
        if (bar !== null) body.prepend(topBar(bar, branding && fromCopilot), AS_HTML);
        else if (branding && fromCopilot) body.prepend(OPENARTIFACTS_HEADER, AS_HTML);
        body.onEndTag((endTag) => {
          footerPlaced = true;
          if (footer !== "") endTag.before(footer, AS_HTML);
        });
      },
    })
    .onDocument({
      end(end) {
        if (!headPlaced) end.append(head, AS_HTML);
        if (branding && !cardTitlePlaced) {
          const titleMeta = socialTitleMeta(documentTitle);
          if (titleMeta.length > 0) end.append(titleMeta, AS_HTML);
        }
        if (!headerPlaced) {
          if (bar !== null) end.append(topBar(bar, branding && fromCopilot), AS_HTML);
          else if (branding && fromCopilot) end.append(OPENARTIFACTS_HEADER, AS_HTML);
        }
        if (footer !== "" && !footerPlaced) end.append(footer, AS_HTML);
      },
    })
    .transform(response);
}
