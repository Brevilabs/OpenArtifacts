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
 * The "shared with updoc" byline (D9).
 *
 * `all:initial` first, then only the properties we want back: the page's own
 * stylesheet has no way to guess this class, but it very often styles `div`,
 * and a footer inheriting a 4rem serif body font would look like a bug. Inline
 * styles keep it self-contained — no stylesheet to fetch, nothing for the CSP
 * to allow.
 */
export const UPDOC_FOOTER =
  '<div class="updoc-footer" style="' +
  "all:initial;display:block;box-sizing:border-box;width:100%;clear:both;" +
  "margin:4rem 0 0;padding:1rem 0;border-top:1px solid rgba(128,128,128,0.25);" +
  "font:400 13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
  'color:#888;text-align:center">Shared with updoc</div>';

/** HTMLRewriter treats injected content as markup, not text, only when asked. */
const AS_HTML = { html: true } as const;

/**
 * Inject the robots meta and the footer, and change nothing else.
 *
 * Both injections have a fallback, because a document is not guaranteed to have
 * the tag we want to hang them on:
 *
 * - The meta goes first inside `<head>`. A document with no `<head>` gets it at
 *   the end instead, where the parser hoists it into the body — weaker, since a
 *   robots meta outside the head is not honoured, which is exactly why the
 *   header carries the real signal.
 * - The footer goes immediately before `</body>`. `append()` is not used for
 *   this: it silently does nothing when an element has no end tag, and an
 *   unclosed `<body>` is common enough in hand-written HTML that a silently
 *   missing footer would be a real outcome. Hooking the end tag instead tells
 *   us whether the injection actually landed, and the document-end fallback
 *   covers every case where it did not.
 *
 * Returns the bytes to store: the caller needs their length for the version row
 * and hands the same buffer to R2, so a string round-trip would copy 10MB for
 * nothing.
 */
export async function bakeServedHtml(html: string): Promise<Uint8Array> {
  let metaPlaced = false;
  let footerPlaced = false;

  const baked = new HTMLRewriter()
    .on("head", {
      element(head) {
        metaPlaced = true;
        head.prepend(NOINDEX_META, AS_HTML);
      },
    })
    .on("body", {
      element(body) {
        body.onEndTag((endTag) => {
          footerPlaced = true;
          endTag.before(UPDOC_FOOTER, AS_HTML);
        });
      },
    })
    .onDocument({
      end(end) {
        if (!metaPlaced) end.append(NOINDEX_META, AS_HTML);
        if (!footerPlaced) end.append(UPDOC_FOOTER, AS_HTML);
      },
    })
    .transform(new Response(html));

  return new Uint8Array(await baked.arrayBuffer());
}
