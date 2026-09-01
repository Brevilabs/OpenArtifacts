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
 * comes from the serving headers and a cookieless sacrificial origin, not from
 * rewriting the publisher's markup. The only edits made here are the additions
 * below.
 *
 * HTMLRewriter rather than string surgery, because it is a real HTML tokenizer:
 * a `<head>` written inside a comment or emitted by `document.write("<head>")`
 * is text to it, so injection lands in the document's actual head or nowhere.
 */

/**
 * Which rendering the injections below produce. **Bump it whenever any of them
 * changes.**
 *
 * The stored object's etag cannot notice: it identifies the publisher's bytes,
 * which a byline edit does not touch. Without this in the validator, a reader
 * or a cache holding an older rendering revalidates, gets `304`, and keeps it —
 * indefinitely, since each revalidation renews its freshness. That would defeat
 * the reason for rendering at read time at all.
 *
 * It is a number and not a content hash on purpose: the injections are string
 * constants in this file, so the thing that changes them is an edit to this
 * file, and a reviewer can see whether the number moved with it.
 */
export const RENDER_REVISION = 5;

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
const COPILOT_MARK_SRC =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 4 152 127" fill="#888">' +
      `<path d="${MARK_PATH}"/></svg>`,
  );

/**
 * And a `<span>` rather than an `<img>`, for the same reason one step further:
 * `querySelectorAll("img")` is how a lightbox or a caption pass finds a
 * document's figures, and the mark must not be one of them. A background image
 * on an empty span answers to neither selector.
 */
const COPILOT_MARK =
  '<span aria-hidden="true" style="all:initial;display:inline-block;' +
  "width:17px;height:14px;vertical-align:-0.15em;flex:none;" +
  // `url()` unquoted: `encodeURIComponent` leaves nothing in the value that
  // would close the CSS function or the HTML attribute around it.
  `background:url(${COPILOT_MARK_SRC}) center/contain no-repeat"></span>`;

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

/** Where the document came from. Injected at the top of the body. */
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

/** HTMLRewriter treats injected content as markup, not text, only when asked. */
const AS_HTML = { html: true } as const;

/**
 * Inject the robots meta, the favicon, the social card and the two bylines, and
 * change nothing else.
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
 * - The header byline is prepended inside `<body>`. A document with no `<body>`
 *   start tag gets it at the document end instead, which puts the header below
 *   the content: wrong, but present. Hanging it on `<html>` would be no better,
 *   because that element's start tag is seen *before* `<body>`, so a fallback
 *   there would fire on every normal page and inject the header twice. The
 *   client renders whole documents, so the fallback is the rare path.
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
export function renderServedHtml(response: Response, branding = true): Response {
  const head = branding ? NOINDEX_META + FAVICON_LINK + SOCIAL_CARD_META : NOINDEX_META;
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
        if (branding) body.prepend(OPENARTIFACTS_HEADER, AS_HTML);
        body.onEndTag((endTag) => {
          footerPlaced = true;
          if (branding) endTag.before(OPENARTIFACTS_FOOTER, AS_HTML);
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
        if (branding && !headerPlaced) end.append(OPENARTIFACTS_HEADER, AS_HTML);
        if (branding && !footerPlaced) end.append(OPENARTIFACTS_FOOTER, AS_HTML);
      },
    })
    .transform(response);
}
