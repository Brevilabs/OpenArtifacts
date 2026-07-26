import { describe, expect, it } from "vitest";
import {
  bakeServedHtml,
  NOINDEX_META,
  SYMPOSIUM_FOOTER,
  SYMPOSIUM_HEADER,
} from "../src/render.js";

const bake = async (html: string): Promise<string> =>
  new TextDecoder().decode(await bakeServedHtml(html));

/** A document shaped like the ones Obsidian renders. */
const page = (body: string) =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>A note</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

/** Everything between the head tags, so "in the head" can be asserted literally. */
const headOf = (html: string) => html.slice(html.indexOf("<head>"), html.indexOf("</head>"));

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("bakeServedHtml — what gets injected", () => {
  // Every other test here compares against the exported constants, which says
  // only that the constant landed. These pin what the constants must say: D9
  // promises readers a page that asks not to be indexed and admits where it
  // came from, and both claims are about literal bytes, not about a symbol.
  it("asks robots not to index or follow", () => {
    expect(NOINDEX_META).toBe('<meta name="robots" content="noindex,nofollow">');
  });

  it("says where the document came from, in text a reader can see", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(baked).toContain(">Shared from <");
    expect(baked).toContain(">obsidiancopilot.com</a>");
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
      for (const restored of [
        "font:inherit",
        "display:inline",
        "cursor:pointer",
        "color:#888",
        "text-decoration:underline",
      ]) {
        expect(byline).toContain(restored);
      }
    }
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

describe("bakeServedHtml — where the injections land", () => {
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

  // `<template>` content is inert — the browser parses it into a fragment — but
  // lol-html emits its tokens like any others, so an inert `body` would consume
  // both injections and leave the real one bare.
  it("ignores head and body tokens inside template content", async () => {
    const baked = await bake(
      "<!doctype html><html><head></head>" +
        "<template><head></head><body><p>inert</p></body></template>" +
        "<body><p>real</p></body></html>",
    );

    expect(occurrences(baked, NOINDEX_META)).toBe(1);
    expect(occurrences(baked, SYMPOSIUM_HEADER)).toBe(1);
    expect(occurrences(baked, SYMPOSIUM_FOOTER)).toBe(1);
    // The bylines belong to the real body, so they sit after the template.
    expect(baked.indexOf(SYMPOSIUM_HEADER)).toBeGreaterThan(baked.indexOf("</template>"));
    expect(baked).toContain("<p>inert</p>");
  });

  it("keeps the document's own head content, including its own meta tags", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(baked).toContain('<meta charset="utf-8">');
    expect(baked).toContain("<title>A note</title>");
  });
});

describe("bakeServedHtml — documents missing the tags to hang them on", () => {
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

describe("bakeServedHtml — the document's own content", () => {
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

  it("returns the bytes that will be stored, not characters", async () => {
    const bytes = await bakeServedHtml(page("<p>日本語</p>"));
    const text = new TextDecoder().decode(bytes);

    // Three characters, nine bytes. A length in characters would under-report
    // the object, and the version row's `size` would disagree with what R2 holds.
    expect(bytes.byteLength).toBe(text.length + 6);
  });
});
