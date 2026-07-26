import { describe, expect, it } from "vitest";
import {
  NOINDEX_META,
  renderServedHtml,
  SYMPOSIUM_FOOTER,
  SYMPOSIUM_HEADER,
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

  it("says where the document came from, in text a reader can see", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(baked).toContain("Shared from ");
    expect(baked).toContain(">Copilot for Obsidian</span>");
  });

  // Inlined rather than linked: a byline that fetches its logo from another host
  // is a broken-image icon whenever that host is unreachable, and these bytes
  // outlive the deploy that produced them.
  it("carries the Copilot mark inline, tinted by the byline's own colour", () => {
    expect(SYMPOSIUM_HEADER).toContain("<svg ");
    expect(SYMPOSIUM_HEADER).toContain("fill:currentColor");
    expect(SYMPOSIUM_HEADER).not.toContain("<img");
    // Decorative: the link text already names the product.
    expect(SYMPOSIUM_HEADER).toContain('aria-hidden="true"');
    // In the style, not only the attributes: `width`/`height` on an <svg> are
    // presentation attributes, so a document's `svg { width: 100% }` — which is
    // in plenty of ordinary resets — would otherwise stretch the mark.
    expect(SYMPOSIUM_HEADER).toContain("width:17px");
    expect(SYMPOSIUM_HEADER).toContain("height:14px");
  });

  it("names Symposium and what it is for, in text a reader can see", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(baked).toContain(">Powered by <");
    expect(baked).toContain(">symposium.md</a>");
    expect(baked).toContain("where agents and humans get on the same page");
  });

  it("links both bylines out, which is the whole point of carrying them", async () => {
    expect(SYMPOSIUM_HEADER).toContain('href="https://obsidiancopilot.com"');
    expect(SYMPOSIUM_FOOTER).toContain('href="https://symposium.md"');
  });

  // A container reset does not reach descendants, so a document's
  // `a { display: none }` would delete the branding. The anchors carry their
  // own reset, then put back what they need.
  it("resets its own anchors rather than inheriting the document's link styles", () => {
    for (const byline of [SYMPOSIUM_HEADER, SYMPOSIUM_FOOTER]) {
      expect(byline).toContain('<a href="https://');
      // Twice: once on the container, once on the anchor inside it.
      expect(occurrences(byline, "all:initial")).toBe(2);
      for (const restored of ["font:inherit", "cursor:pointer", "color:#888"]) {
        expect(byline).toContain(restored);
      }
      // Underlined either way, but the header puts it on the text rather than
      // the anchor, so the mark beside it is not underlined too.
      expect(byline).toContain("text-decoration:underline");
    }

    // Asserted apart, because a shared `display:inline` check would pass for the
    // header only by being a prefix of `inline-flex`.
    expect(SYMPOSIUM_FOOTER).toContain("display:inline;");
    expect(SYMPOSIUM_HEADER).toContain("display:inline-flex");
  });

  // The reader is mid-document; a byline that navigates the page away costs
  // them their place. `noopener` is what makes `_blank` safe to hand out.
  it("opens both links in a new tab, without handing over a window handle", () => {
    for (const byline of [SYMPOSIUM_HEADER, SYMPOSIUM_FOOTER]) {
      expect(byline).toContain('target="_blank"');
      expect(byline).toContain('rel="noopener noreferrer"');
    }
  });
});

describe("renderServedHtml — where the injections land", () => {
  it("puts the robots meta inside the head, and the bylines around the body", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(headOf(baked)).toContain(NOINDEX_META);
    expect(baked).toContain(`<body>${SYMPOSIUM_HEADER}`);
    expect(baked).toContain(`${SYMPOSIUM_FOOTER}</body>`);
  });

  it("puts the header above the document's own content, not below it", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(baked.indexOf(SYMPOSIUM_HEADER)).toBeLessThan(baked.indexOf("<p>hello</p>"));
    expect(baked.indexOf(SYMPOSIUM_FOOTER)).toBeGreaterThan(baked.indexOf("<p>hello</p>"));
  });

  it("injects each exactly once, however many candidate tags the page has", async () => {
    const baked = await bake(page("<div><p>one</p></div><div><p>two</p></div>"));

    expect(occurrences(baked, NOINDEX_META)).toBe(1);
    expect(occurrences(baked, SYMPOSIUM_HEADER)).toBe(1);
    expect(occurrences(baked, SYMPOSIUM_FOOTER)).toBe(1);
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
    expect(occurrences(baked, SYMPOSIUM_HEADER)).toBe(1);
    expect(occurrences(baked, SYMPOSIUM_FOOTER)).toBe(1);
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

    expect(occurrences(baked, SYMPOSIUM_HEADER)).toBe(1);
    expect(occurrences(baked, SYMPOSIUM_FOOTER)).toBe(1);
    expect(baked.indexOf(SYMPOSIUM_FOOTER)).toBeGreaterThan(baked.indexOf("<p>after</p>"));
  });

  // A `<template>` holding ordinary content is a shape real documents have, and
  // it must not disturb placement. One holding a `<body>` would — lol-html emits
  // inert tokens like any others — and that is the documented limit of
  // best-effort placement rather than a case to guard against.
  it("leaves template content alone", async () => {
    const baked = await bake(page("<template><p>inert</p></template><p>real</p>"));

    expect(occurrences(baked, SYMPOSIUM_HEADER)).toBe(1);
    expect(occurrences(baked, SYMPOSIUM_FOOTER)).toBe(1);
    expect(baked).toContain("<template><p>inert</p></template>");
    expect(baked.indexOf(SYMPOSIUM_HEADER)).toBeLessThan(baked.indexOf("<template>"));
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
    expect(baked).toContain(`<body>${SYMPOSIUM_HEADER}`);
    expect(baked).toContain(SYMPOSIUM_FOOTER);
    expect(baked).toContain("<p>hi</p>");
  });

  it("still injects into a document with no head", async () => {
    const baked = await bake("<!doctype html>\n<html>\n<body>\n<p>hi</p>\n</body>\n</html>");

    expect(baked).toContain(NOINDEX_META);
    expect(baked).toContain(`<body>${SYMPOSIUM_HEADER}`);
    expect(baked).toContain(`${SYMPOSIUM_FOOTER}</body>`);
    // The doctype has to stay first: a meta ahead of it would put the page into
    // quirks mode, which is a real change to how the document renders.
    expect(baked.startsWith("<!doctype html>")).toBe(true);
  });

  it("still injects into a bare fragment", async () => {
    const baked = await bake("<p>just a fragment</p>");

    expect(baked).toContain("<p>just a fragment</p>");
    expect(baked).toContain(NOINDEX_META);
    expect(baked).toContain(SYMPOSIUM_HEADER);
    expect(baked).toContain(SYMPOSIUM_FOOTER);
  });

  // The documented cost of hanging the header on `<body>`: with no start tag to
  // prepend to, it lands at the document end. Pinned so the tradeoff is a
  // decision on record rather than a surprise, and so moving the header to a
  // different hook has to come here and say so.
  it("puts the header below the content when there is no body start tag", async () => {
    const baked = await bake("<p>just a fragment</p>");

    expect(baked.indexOf(SYMPOSIUM_HEADER)).toBeGreaterThan(
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
    expect(occurrences(baked, SYMPOSIUM_FOOTER)).toBe(1);
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
  it("drops both bylines but keeps the robots meta", async () => {
    const bare = await bake(page("<p>hello</p>"), false);

    expect(bare).not.toContain(SYMPOSIUM_HEADER);
    expect(bare).not.toContain(SYMPOSIUM_FOOTER);
    expect(headOf(bare)).toContain(NOINDEX_META);
    expect(bare).toContain("<p>hello</p>");
  });

  it("still adds the meta to a document with no head", async () => {
    const bare = await bake("<!doctype html><html><body><p>hi</p></body></html>", false);

    expect(bare).toContain(NOINDEX_META);
    expect(bare).not.toContain(SYMPOSIUM_HEADER);
  });
});
