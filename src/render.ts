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
 * rewriting the publisher's markup. The only edits made here are the two
 * additions below.
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
export const RENDER_REVISION = 1;

/**
 * Belt to the `X-Robots-Tag` header's braces (D9). The header is the
 * authoritative signal — it applies to every response including errors — but
 * the meta tag travels with the bytes, so a doc that is copied, mirrored, or
 * served from anywhere else keeps asking not to be indexed.
 */
export const NOINDEX_META = '<meta name="robots" content="noindex,nofollow">';

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
  "font:400 13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
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

/** Where the document came from. Injected at the top of the body. */
export const SYMPOSIUM_HEADER =
  '<div class="symposium-header" style="' +
  BYLINE_BASE +
  ";margin:0 0 2rem;padding:0.75rem 0;border-bottom:1px solid rgba(128,128,128,0.25)\">" +
  '<span style="display:inline-flex;align-items:center;gap:0.4em">Shared from ' +
  `<a href="https://obsidiancopilot.com" ${BYLINE_LINK_WITH_MARK}>` +
  COPILOT_MARK +
  '<span style="text-decoration:underline">Copilot for Obsidian</span></a></span></div>';

/** What served it. Injected immediately before `</body>`. */
export const SYMPOSIUM_FOOTER =
  '<div class="symposium-footer" style="' +
  BYLINE_BASE +
  ";margin:4rem 0 0;padding:1rem 0;border-top:1px solid rgba(128,128,128,0.25)\">" +
  `Powered by <a href="https://symposium.md" ${BYLINE_LINK}>symposium.md</a>, ` +
  "where agents and humans get on the same page</div>";

/** HTMLRewriter treats injected content as markup, not text, only when asked. */
const AS_HTML = { html: true } as const;

/**
 * Inject the robots meta and the two bylines, and change nothing else.
 *
 * Every injection has a fallback, because a document is not guaranteed to have
 * the tag we want to hang it on:
 *
 * - The meta goes first inside `<head>`. A document with no `<head>` gets it at
 *   the end instead, where the parser hoists it into the body — weaker, since a
 *   robots meta outside the head is not honoured, which is exactly why the
 *   `X-Robots-Tag` header carries the real signal.
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
 * `branding` will be false for plans that pay to remove the bylines. It does not
 * reach the robots meta, and must not: `noindex` is policy, and a flag that
 * switched it off would make paid customers' documents indexable — the worst
 * possible bug to ship attached to an upgrade.
 */
export function renderServedHtml(response: Response, branding = true): Response {
  let metaPlaced = false;
  let headerPlaced = false;
  let footerPlaced = false;

  return new HTMLRewriter()
    .on("head", {
      element(head) {
        if (metaPlaced) return;
        metaPlaced = true;
        head.prepend(NOINDEX_META, AS_HTML);
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
        if (branding) body.prepend(SYMPOSIUM_HEADER, AS_HTML);
        body.onEndTag((endTag) => {
          footerPlaced = true;
          if (branding) endTag.before(SYMPOSIUM_FOOTER, AS_HTML);
        });
      },
    })
    .onDocument({
      end(end) {
        if (!metaPlaced) end.append(NOINDEX_META, AS_HTML);
        if (branding && !headerPlaced) end.append(SYMPOSIUM_HEADER, AS_HTML);
        if (branding && !footerPlaced) end.append(SYMPOSIUM_FOOTER, AS_HTML);
      },
    })
    .transform(response);
}
