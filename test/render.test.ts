import { describe, expect, it } from "vitest";
import {
  FAVICON_LINK,
  NOINDEX_META,
  OG_IMAGE_URL,
  renderServedHtml,
  SOCIAL_CARD_META,
  socialTitleMeta,
  OPENARTIFACTS_FOOTER,
  OPENARTIFACTS_HEADER,
} from "../src/render.js";

const bake = async (html: string, branding = true): Promise<string> =>
  await renderServedHtml(new Response(html), branding).text();

/** A document shaped like the ones Obsidian renders. */
const page = (body: string) =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>A note</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

/** Everything between the head tags, so "in the head" can be asserted literally. */
const headOf = (html: string) => html.slice(html.indexOf("<head>"), html.indexOf("</head>"));

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("renderServedHtml — what gets injected", () => {
  // Every other test here compares against the exported constants, which says
  // only that the constant landed. These pin what the constants must say: D9
  // promises readers a page that asks not to be indexed and admits where it
  // came from, and both claims are about literal bytes, not about a symbol.
  it("asks robots not to index or follow", () => {
    expect(NOINDEX_META).toBe('<meta name="robots" content="noindex,nofollow">');
  });

  // Inline for the reason the Copilot mark is: an icon fetched from another
  // host is a blank tab whenever that host is unreachable, and these bytes
  // outlive the deploy that produced them.
  it("carries the tab icon inline, in the brand's own colours", () => {
    expect(FAVICON_LINK).toContain('rel="icon"');
    expect(FAVICON_LINK).toContain('href="data:image/svg+xml,');
    for (const colour of ["#15161a", "#f2f2f0"]) {
      expect(FAVICON_LINK).toContain(encodeURIComponent(colour));
    }
    // Escaped, so the `"` on every attribute inside the SVG cannot close the
    // `href` around it.
    const href = FAVICON_LINK.slice(FAVICON_LINK.indexOf('href="') + 6, -2);
    expect(href).not.toContain('"');
    expect(decodeURIComponent(href.slice("data:image/svg+xml,".length))).toContain("<svg ");
  });

  // The card image is the one addition that cannot be inlined: an `og:image` is
  // fetched by the unfurler over http(s), so a data URI is not a value any of
  // them accept. Pinned on the brand domain rather than a deployment url,
  // because `/v{n}` pages hand this string to crawlers for a year.
  it("points the card image at a stable brand-domain url", () => {
    expect(OG_IMAGE_URL).toBe("https://openartifacts.ai/og-image.png");
    expect(SOCIAL_CARD_META).toContain(`<meta property="og:image" content="${OG_IMAGE_URL}">`);
  });

  // Without the dimensions a crawler that has not fetched the image yet has to
  // guess whether it is big enough for a full-bleed card, and several of them
  // render a thumbnail — or nothing — on the first paste. They are the actual
  // size of the file at the url above.
  it("states the image size and asks for a full-bleed card", () => {
    expect(SOCIAL_CARD_META).toContain(
      '<meta property="og:site_name" content="OpenArtifacts">',
    );
    expect(SOCIAL_CARD_META).toContain('<meta property="og:image:width" content="1200">');
    expect(SOCIAL_CARD_META).toContain('<meta property="og:image:height" content="630">');
    expect(SOCIAL_CARD_META).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  // A static title would unfurl every document under the same words, which is
  // worse than none: the fallback an unfurler reaches for is the document's own
  // `<title>`, and that at least names the document.
  it("takes the card title from the document, not from a constant", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(baked).toContain('<meta property="og:title" content="A note">');
    expect(SOCIAL_CARD_META).not.toContain("og:title");
  });

  // Publisher-controlled text going back into markup, injected as HTML. A `<`
  // that survived would open an element inside the head rather than sit in a
  // `content=""`.
  //
  // The count is what carries the claim. Inside `<title>` the sequence is text
  // — RCDATA, which the parser never treats as a tag — and those are the
  // publisher's own bytes, so it stays exactly as uploaded. What must not
  // happen is a *second* copy arriving from our injection, where it would be
  // markup.
  it("escapes a title that would otherwise close the tag it sits in", async () => {
    const hostile = '"><script>alert(1)</script><meta x="';
    const baked = await bake(
      `<!doctype html><html><head><title>${hostile}</title></head><body><p>hi</p></body></html>`,
    );

    expect(baked).toContain(`<title>${hostile}</title>`);
    expect(occurrences(baked, "<script>alert(1)</script>")).toBe(1);
    expect(headOf(baked)).toContain(
      '<meta property="og:title" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;' +
        '&lt;meta x=&quot;">',
    );
  });

  it("collapses the whitespace a pretty-printed title spans lines with", () => {
    expect(socialTitleMeta("  Weekly\n  review  ")).toBe(
      '<meta property="og:title" content="Weekly review">',
    );
  });

  // An empty `content` stops an unfurler from falling back to `<title>`, so a
  // document with nothing to say gets no tag rather than an empty one.
  it("emits no title tag at all when the document has no title text", async () => {
    const baked = await bake(
      "<!doctype html><html><head><title>  </title></head><body><p>hi</p></body></html>",
    );

    expect(baked).not.toContain("og:title");
  });

  // An unclosed `<title>` makes the parser treat the rest of the document as
  // title text. Bounded, so that cannot put a whole document in a meta tag.
  it("caps the title rather than letting an unclosed one swallow the document", async () => {
    const baked = await bake(
      `<!doctype html><html><head><title>${"x".repeat(2000)}</title></head>` +
        "<body><p>hi</p></body></html>",
    );

    const content = /<meta property="og:title" content="(x+)">/.exec(baked)?.[1] ?? "";
    expect(content.length).toBe(300);
  });

  // `<svg><title>` is a chart's accessible name, not the document's.
  it("ignores a title that belongs to an inline SVG", async () => {
    const baked = await bake(page('<svg><title>Revenue by quarter</title></svg>'));

    expect(baked).toContain('<meta property="og:title" content="A note">');
    expect(baked).toContain("<title>Revenue by quarter</title>");
  });

  it("says where the document came from, in text a reader can see", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(baked).toContain("Shared from ");
    expect(baked).toContain(">Copilot for Obsidian</span>");
  });

  // Inlined rather than linked: a byline that fetches its logo from another host
  // is a broken-image icon whenever that host is unreachable, and these bytes
  // outlive the deploy that produced them.
  it("carries the Copilot mark inline, in the byline's own grey", () => {
    // Inline, so the mark does not depend on another host being up, and no
    // request leaves the page to fetch it.
    expect(OPENARTIFACTS_HEADER).toContain("background:url(data:image/svg+xml,");
    expect(OPENARTIFACTS_HEADER).toContain(encodeURIComponent('fill="#888"'));
    // Decorative: the link text already names the product.
    expect(OPENARTIFACTS_HEADER).toContain('aria-hidden="true"');
    expect(OPENARTIFACTS_HEADER).toContain("width:17px");
    expect(OPENARTIFACTS_HEADER).toContain("height:14px");
  });

  // The header is prepended, so anything it adds is the *first* of its kind in
  // the document. A figure that opens with `d3.select("svg")` or
  // `querySelectorAll("img")[0]` would then find the logo and draw into it, and
  // interactive figures are an explicitly supported input (D6). A background
  // image on an empty span answers to neither selector.
  it("adds no element a document's own figure selectors could find", () => {
    for (const byline of [OPENARTIFACTS_HEADER, OPENARTIFACTS_FOOTER]) {
      expect(byline).not.toContain("<svg");
      expect(byline).not.toContain("<img");
      expect(byline).not.toContain("<canvas");
    }
  });

  it("names OpenArtifacts and what it is for, in text a reader can see", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(baked).toContain(">Powered by <");
    expect(baked).toContain(">openartifacts.ai</a>");
    expect(baked).toContain("a new mode of communication between agents and humans");
  });

  it("links both bylines out, which is the whole point of carrying them", async () => {
    expect(OPENARTIFACTS_HEADER).toContain('href="https://obsidiancopilot.com"');
    expect(OPENARTIFACTS_FOOTER).toContain('href="https://openartifacts.ai"');
  });

  // A container reset does not reach descendants, so a document's
  // `a { display: none }` would delete the branding. The anchors carry their
  // own reset, then put back what they need.
  it("resets its own anchors rather than inheriting the document's link styles", () => {
    for (const byline of [OPENARTIFACTS_HEADER, OPENARTIFACTS_FOOTER]) {
      expect(byline).toContain('<a href="https://');
      for (const restored of ["font:inherit", "cursor:pointer", "color:#888"]) {
        expect(byline).toContain(restored);
      }
      // Underlined either way, but the header puts it on the text rather than
      // the anchor, so the mark beside it is not underlined too.
      expect(byline).toContain("text-decoration:underline");
    }

    // Asserted apart, because a shared `display:inline` check would pass for the
    // header only by being a prefix of `inline-flex`.
    expect(OPENARTIFACTS_FOOTER).toContain("display:inline;");
    expect(OPENARTIFACTS_HEADER).toContain("display:inline-flex");

    // One reset per element the byline adds — no exceptions, since a bare span
    // is one a document's `span { font-size: 0 }` reaches. Counted against the
    // tags rather than hard-coded, so an element added later cannot skip one.
    for (const byline of [OPENARTIFACTS_HEADER, OPENARTIFACTS_FOOTER]) {
      const elements =
        occurrences(byline, "<div") + occurrences(byline, "<a ") + occurrences(byline, "<span");
      expect(occurrences(byline, "all:initial")).toBe(elements);
    }
  });

  // The reader is mid-document; a byline that navigates the page away costs
  // them their place. `noopener` is what makes `_blank` safe to hand out.
  it("opens both links in a new tab, without handing over a window handle", () => {
    for (const byline of [OPENARTIFACTS_HEADER, OPENARTIFACTS_FOOTER]) {
      expect(byline).toContain('target="_blank"');
      expect(byline).toContain('rel="noopener noreferrer"');
    }
  });
});

describe("renderServedHtml — where the injections land", () => {
  it("puts the robots meta, the icon and the card inside the head, and the bylines around the body", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(baked).toContain(`<head>${NOINDEX_META}${FAVICON_LINK}${SOCIAL_CARD_META}`);
    expect(baked).toContain(`<body>${OPENARTIFACTS_HEADER}`);
    expect(baked).toContain(`${OPENARTIFACTS_FOOTER}</body>`);
  });

  // `og:title` is read out of the document's own `<title>`, which has not been
  // seen when `<head>` opens — so it is the one head injection that lands at the
  // end tag instead of the start. It still has to be *in* the head.
  it("puts the card title inside the head even though it is injected last", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(headOf(baked)).toContain('<meta property="og:title" content="A note">');
    expect(baked).toContain('<meta property="og:title" content="A note"></head>');
  });

  it("puts the header above the document's own content, not below it", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(baked.indexOf(OPENARTIFACTS_HEADER)).toBeLessThan(baked.indexOf("<p>hello</p>"));
    expect(baked.indexOf(OPENARTIFACTS_FOOTER)).toBeGreaterThan(baked.indexOf("<p>hello</p>"));
  });

  it("injects each exactly once, however many candidate tags the page has", async () => {
    const baked = await bake(page("<div><p>one</p></div><div><p>two</p></div>"));

    expect(occurrences(baked, NOINDEX_META)).toBe(1);
    expect(occurrences(baked, FAVICON_LINK)).toBe(1);
    expect(occurrences(baked, SOCIAL_CARD_META)).toBe(1);
    expect(occurrences(baked, "og:title")).toBe(1);
    expect(occurrences(baked, OPENARTIFACTS_HEADER)).toBe(1);
    expect(occurrences(baked, OPENARTIFACTS_FOOTER)).toBe(1);
  });

  // A repeated head is the shape that catches a card title accumulated across
  // both of them, or injected once per head. First one wins, like everything
  // else here.
  it("takes the card title from the first head, once, when the document has two", async () => {
    const baked = await bake(
      "<!doctype html><html><head><title>first</title></head><body><p>one</p></body>" +
        "<head><title>second</title></head><body><p>two</p></body></html>",
    );

    expect(occurrences(baked, "og:title")).toBe(1);
    expect(baked).toContain('<meta property="og:title" content="first">');
  });

  // The case the test above is named for but does not reach: the handlers hang
  // on `head` and `body`, so repeating a `<div>` proves nothing. Repeating the
  // tags they actually match is what catches a guard that only disables the
  // document-end fallback instead of the injection itself.
  it("injects each exactly once even when the document repeats head and body", async () => {
    const baked = await bake(
      "<!doctype html><html><head></head><body><p>one</p></body>" +
        "<head></head><body><p>two</p></body></html>",
    );

    expect(occurrences(baked, NOINDEX_META)).toBe(1);
    expect(occurrences(baked, OPENARTIFACTS_HEADER)).toBe(1);
    expect(occurrences(baked, OPENARTIFACTS_FOOTER)).toBe(1);
    expect(baked).toContain("<p>one</p>");
    expect(baked).toContain("<p>two</p>");
  });

  // Nesting, which the sequential fixture above cannot reach: the inner end tag
  // arrives first, so a guard that lets the first `</body>` win puts the footer
  // above the outer body's remaining content. Registering the callback on the
  // single body that got the header is what pairs the right end tag.
  it("footers the outer body when a second body is nested inside it", async () => {
    const baked = await bake(
      "<!doctype html><html><head></head><body><p>before</p>" +
        "<body><p>inner</p></body><p>after</p></body></html>",
    );

    expect(occurrences(baked, OPENARTIFACTS_HEADER)).toBe(1);
    expect(occurrences(baked, OPENARTIFACTS_FOOTER)).toBe(1);
    expect(baked.indexOf(OPENARTIFACTS_FOOTER)).toBeGreaterThan(baked.indexOf("<p>after</p>"));
  });

  // A `<template>` holding ordinary content is a shape real documents have, and
  // it must not disturb placement. One holding a `<body>` would — lol-html emits
  // inert tokens like any others — and that is the documented limit of
  // best-effort placement rather than a case to guard against.
  it("leaves template content alone", async () => {
    const baked = await bake(page("<template><p>inert</p></template><p>real</p>"));

    expect(occurrences(baked, OPENARTIFACTS_HEADER)).toBe(1);
    expect(occurrences(baked, OPENARTIFACTS_FOOTER)).toBe(1);
    expect(baked).toContain("<template><p>inert</p></template>");
    expect(baked.indexOf(OPENARTIFACTS_HEADER)).toBeLessThan(baked.indexOf("<template>"));
  });

  it("keeps the document's own head content, including its own meta tags", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(baked).toContain('<meta charset="utf-8">');
    expect(baked).toContain("<title>A note</title>");
  });
});

describe("renderServedHtml — documents missing the tags to hang them on", () => {
  it("still footers a document whose body is never closed", async () => {
    // `append()` on an element with no end tag silently does nothing, which is
    // why the footer is injected via the end tag rather than by appending.
    const baked = await bake(
      "<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n<p>hi</p>",
    );

    expect(headOf(baked)).toContain(NOINDEX_META);
    expect(baked).toContain(`<body>${OPENARTIFACTS_HEADER}`);
    expect(baked).toContain(OPENARTIFACTS_FOOTER);
    expect(baked).toContain("<p>hi</p>");
  });

  // The documented cost of the split: a head with no end tag keeps the image
  // tags, because those are prepended, and the title meta falls out of the head.
  // Pinned so that cost stays a decision on record — and because losing it is
  // survivable, the unfurler falling back to `<title>` for the same string.
  it("keeps the card image when the head is never closed", async () => {
    const baked = await bake("<!doctype html><html><head><title>t</title><body><p>hi</p>");

    expect(headOf(baked)).toContain(SOCIAL_CARD_META);
    expect(baked).toContain("og:title");
    expect(baked).toContain("<title>t</title>");
  });

  it("still injects into a document with no head", async () => {
    const baked = await bake("<!doctype html>\n<html>\n<body>\n<p>hi</p>\n</body>\n</html>");

    expect(baked).toContain(NOINDEX_META);
    expect(baked).toContain(FAVICON_LINK);
    expect(baked).toContain(`<body>${OPENARTIFACTS_HEADER}`);
    expect(baked).toContain(`${OPENARTIFACTS_FOOTER}</body>`);
    // The doctype has to stay first: a meta ahead of it would put the page into
    // quirks mode, which is a real change to how the document renders.
    expect(baked.startsWith("<!doctype html>")).toBe(true);
  });

  it("still injects into a bare fragment", async () => {
    const baked = await bake("<p>just a fragment</p>");

    expect(baked).toContain("<p>just a fragment</p>");
    expect(baked).toContain(NOINDEX_META);
    expect(baked).toContain(OPENARTIFACTS_HEADER);
    expect(baked).toContain(OPENARTIFACTS_FOOTER);
  });

  // The documented cost of hanging the header on `<body>`: with no start tag to
  // prepend to, it lands at the document end. Pinned so the tradeoff is a
  // decision on record rather than a surprise, and so moving the header to a
  // different hook has to come here and say so.
  it("puts the header below the content when there is no body start tag", async () => {
    const baked = await bake("<p>just a fragment</p>");

    expect(baked.indexOf(OPENARTIFACTS_HEADER)).toBeGreaterThan(
      baked.indexOf("<p>just a fragment</p>"),
    );
  });
});

describe("renderServedHtml — the document's own content", () => {
  it("leaves scripts, handlers and iframes exactly as uploaded (D6)", async () => {
    const interactive =
      '<script>const a = 1 < 2 && 3 > 2; document.title = "x";</script>' +
      '<button onclick="alert(1)">go</button>' +
      '<iframe src="https://example.com/figure"></iframe>' +
      "<script src=\"https://cdn.example.com/plot.js\"></script>";

    const baked = await bake(page(interactive));

    expect(baked).toContain(interactive);
  });

  it("does not inject into markup that only looks like a tag", async () => {
    // The whole reason this is a parser and not a regex: neither of these is a
    // head or a body, and a string replace would have injected into both.
    const decoys =
      '<script>document.write("<head></head><body></body>");</script>' +
      "<!-- <head> a commented-out head </head> -->" +
      "<pre>&lt;body&gt;</pre>";

    const baked = await bake(page(decoys));

    expect(baked).toContain(decoys);
    expect(occurrences(baked, NOINDEX_META)).toBe(1);
    expect(occurrences(baked, OPENARTIFACTS_FOOTER)).toBe(1);
  });

  it("preserves non-ASCII content byte for byte", async () => {
    const body = "<p>callout — “quoted”, 日本語, 🌍</p>";

    const baked = await bake(page(body));

    expect(baked).toContain(body);
  });

  it("streams rather than buffering, so a large doc is never a string", async () => {
    const rendered = renderServedHtml(new Response(page("<p>x</p>")));

    // The point of taking and returning a Response: the body is still a stream
    // the runtime pulls through, not bytes this worker has materialised.
    expect(rendered.body).toBeInstanceOf(ReadableStream);
  });
});

describe("renderServedHtml — branding off", () => {
  // The separation the tier work depends on: a plan that pays to lose the
  // bylines must not also lose `noindex`, which is policy rather than branding.
  // The tab icon goes with them: an OpenArtifacts mark in the reader's tab is
  // branding too. The robots meta is policy and stays.
  it("drops both bylines, the icon and the card but keeps the robots meta", async () => {
    const bare = await bake(page("<p>hello</p>"), false);

    expect(bare).not.toContain(OPENARTIFACTS_HEADER);
    expect(bare).not.toContain(OPENARTIFACTS_FOOTER);
    expect(bare).not.toContain(FAVICON_LINK);
    // The card carries OpenArtifacts' own image into somebody else's Discord,
    // which is the most visible branding of the lot. `og:title` goes with it:
    // a title with no image unfurls worse than the fallback would.
    expect(bare).not.toContain(SOCIAL_CARD_META);
    expect(bare).not.toContain("og:");
    expect(headOf(bare)).toContain(NOINDEX_META);
    expect(bare).toContain("<p>hello</p>");
  });

  it("still adds the meta to a document with no head", async () => {
    const bare = await bake("<!doctype html><html><body><p>hi</p></body></html>", false);

    expect(bare).toContain(NOINDEX_META);
    expect(bare).not.toContain(OPENARTIFACTS_HEADER);
  });
});
