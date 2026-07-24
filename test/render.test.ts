import { describe, expect, it } from "vitest";
import { bakeServedHtml, NOINDEX_META, UPDOC_FOOTER } from "../src/render.js";

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

  it("names updoc in text a reader can see", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(baked).toContain(">Shared with updoc<");
  });
});

describe("bakeServedHtml — where the injections land", () => {
  it("puts the robots meta inside the head and the footer just before </body>", async () => {
    const baked = await bake(page("<p>hello</p>"));

    expect(headOf(baked)).toContain(NOINDEX_META);
    expect(baked).toContain(`${UPDOC_FOOTER}</body>`);
  });

  it("injects each exactly once, however many candidate tags the page has", async () => {
    const baked = await bake(page("<div><p>one</p></div><div><p>two</p></div>"));

    expect(occurrences(baked, NOINDEX_META)).toBe(1);
    expect(occurrences(baked, UPDOC_FOOTER)).toBe(1);
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
    expect(baked).toContain(UPDOC_FOOTER);
    expect(baked).toContain("<p>hi</p>");
  });

  it("still injects into a document with no head", async () => {
    const baked = await bake("<!doctype html>\n<html>\n<body>\n<p>hi</p>\n</body>\n</html>");

    expect(baked).toContain(NOINDEX_META);
    expect(baked).toContain(`${UPDOC_FOOTER}</body>`);
    // The doctype has to stay first: a meta ahead of it would put the page into
    // quirks mode, which is a real change to how the document renders.
    expect(baked.startsWith("<!doctype html>")).toBe(true);
  });

  it("still injects into a bare fragment", async () => {
    const baked = await bake("<p>just a fragment</p>");

    expect(baked).toContain("<p>just a fragment</p>");
    expect(baked).toContain(NOINDEX_META);
    expect(baked).toContain(UPDOC_FOOTER);
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
    expect(occurrences(baked, UPDOC_FOOTER)).toBe(1);
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
