/**
 * Push-time rendering: the one pass that turns an uploaded document into the
 * bytes readers get.
 *
 * It runs once per version, at push time, and what it produces is what R2
 * stores (D11) — serving is a pure passthrough, so this cost is paid once per
 * push rather than once per read, and a served page can never disagree with the
 * stored object.
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

/** Where the document came from. Injected at the top of the body. */
export const SYMPOSIUM_HEADER =
  '<div class="symposium-header" style="' +
  BYLINE_BASE +
  ";margin:0 0 2rem;padding:0.75rem 0;border-bottom:1px solid rgba(128,128,128,0.25)\">" +
  `Shared from <a href="https://obsidiancopilot.com" ${BYLINE_LINK}>obsidiancopilot.com</a></div>`;

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
 * HTMLRewriter is a token rewriter; the browser's tree builder is not. A second
 * `<body>` start tag is ignored by the HTML parsing spec, a nested one is
 * ignored, and one inside `<template>` lands in a fragment — so wherever those
 * two disagree, markup exists that puts a byline somewhere useless. The guards
 * above cover the shapes that turned up in review; `<noscript>`, foreign
 * content in `<svg>`, and `srcdoc` are further examples nobody has chased.
 *
 * That is acceptable because a byline is not a security boundary. `BYLINE_LINK`
 * already concedes that a document rule marked `!important` removes it outright,
 * and every one of these shapes has to be written deliberately by the publisher
 * the header names. Hardening placement against a hostile author is unwinnable
 * and not worth attempting; correctness for documents a client actually renders
 * is what these guards are for.
 *
 * Returns the bytes to store: the caller needs their length for the version row
 * and hands the same buffer to R2, so a string round-trip would copy 10MB for
 * nothing.
 */
export async function bakeServedHtml(html: string): Promise<Uint8Array> {
  let metaPlaced = false;
  let headerPlaced = false;
  let footerPlaced = false;
  let templateDepth = 0;

  const baked = new HTMLRewriter()
    // `<template>` content is inert: the browser parses it into a fragment, so
    // a `head` or `body` token inside one is not the document's. lol-html sees
    // the tokens anyway, and without this the first such token consumes the
    // injections and the real body gets nothing.
    .on("template", {
      element(template) {
        templateDepth += 1;
        template.onEndTag(() => {
          templateDepth -= 1;
        });
      },
    })
    .on("head", {
      element(head) {
        if (metaPlaced || templateDepth > 0) return;
        metaPlaced = true;
        head.prepend(NOINDEX_META, AS_HTML);
      },
    })
    .on("body", {
      element(body) {
        // Uploaded HTML can carry more than one `<body>` start tag, and this
        // handler fires for each — as `head`'s does above. Both injections go
        // to the first one and the handler returns, so the end-tag callback is
        // registered on a single element rather than on every match.
        //
        // Guarding *inside* the callback instead is not equivalent, and the
        // difference only shows with nesting: for
        // `<body>a<body>b</body>c</body>` the inner end tag arrives first, so a
        // first-one-wins guard puts the footer before `c`. Registering on one
        // element makes lol-html pair that element's own end tag.
        if (headerPlaced || templateDepth > 0) return;
        headerPlaced = true;
        body.prepend(SYMPOSIUM_HEADER, AS_HTML);
        body.onEndTag((endTag) => {
          footerPlaced = true;
          endTag.before(SYMPOSIUM_FOOTER, AS_HTML);
        });
      },
    })
    .onDocument({
      end(end) {
        if (!metaPlaced) end.append(NOINDEX_META, AS_HTML);
        if (!headerPlaced) end.append(SYMPOSIUM_HEADER, AS_HTML);
        if (!footerPlaced) end.append(SYMPOSIUM_FOOTER, AS_HTML);
      },
    })
    .transform(new Response(html));

  return new Uint8Array(await baked.arrayBuffer());
}
