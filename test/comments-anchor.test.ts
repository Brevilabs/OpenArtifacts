import { describe, expect, it } from "vitest";
import {
  canonicalText,
  locateAnchor,
  sectionAt,
  validateAnchor,
  type CanonicalText,
} from "../src/comments/anchor.js";
import { decodeEntities, NAMED_ENTITY_COUNT } from "../src/comments/entities.js";

const doc = (body: string, head = "<title>T</title>") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const canon = async (html: string): Promise<CanonicalText> => await canonicalText(html);

describe("canonical text", () => {
  it("is the body's text, without head, script, style, template and noscript", async () => {
    const c = await canon(
      doc(
        `<h1>Title</h1><script>var x = "hidden";</script><style>p{color:red}</style>` +
          `<template><p>in template</p></template><noscript>no js</noscript><p>Body text.</p>`,
        `<title>Head title</title><style>h1{}</style><script>var y</script>`,
      ),
    );
    expect(c.text).toBe("TitleBody text.");
  });

  it("falls back to the whole document when there is no body", async () => {
    const c = await canon("<p>Just a fragment</p><script>x</script>");
    expect(c.text).toBe("Just a fragment");
  });

  it("ignores text between </head> and <body> when a body exists", async () => {
    const c = await canon("<html><head></head>\n<body>kept</body></html>");
    expect(c.text).toBe("kept");
  });

  it("survives an omitted </head>", async () => {
    const c = await canon("<html><head><title>x</title><body><p>visible</p></body></html>");
    expect(c.text).toBe("visible");
  });

  it("decodes numeric and named character references", async () => {
    const c = await canon(
      doc(`<p>Tom &amp; Jerry &lt;3 &#233;t&#xE9; &copy; &mdash; &hellip; &apos;q&apos; &nbsp;|</p>`),
    );
    expect(c.text).toBe("Tom & Jerry <3 été © — … 'q'  |");
  });

  it("decodes entities that a chunk boundary could split", async () => {
    const long = "word ".repeat(20000);
    const c = await canon(doc(`<p>${long}&amp;&eacute;end</p>`));
    expect(c.text.endsWith("&éend")).toBe(true);
  });

  it("normalises line endings and Unicode to NFC", async () => {
    const c = await canon(doc("<p>a\r\nb café</p>"));
    expect(c.text).toBe("a\nb café");
  });

  it("records the nearest enclosing id of each text run", async () => {
    const c = await canon(
      doc(`<div id="outer">one <section id="inner">two</section> three</div><p>four</p>`),
    );
    expect(c.text).toBe("one two threefour");
    expect(sectionAt(c, c.text.indexOf("one"))).toBe("outer");
    expect(sectionAt(c, c.text.indexOf("two"))).toBe("inner");
    expect(sectionAt(c, c.text.indexOf("three"))).toBe("outer");
    expect(sectionAt(c, c.text.indexOf("four"))).toBeUndefined();
  });

  it("is not thrown off by void and self-closing elements", async () => {
    const c = await canon(
      doc(`<div id="a">x<br>y<img src="i.png"><svg><path id="p" d="m"/></svg>z</div>after`),
    );
    expect(c.text).toBe("xyzafter");
    expect(sectionAt(c, c.text.indexOf("z"))).toBe("a");
    expect(sectionAt(c, c.text.indexOf("after"))).toBeUndefined();
  });

  it("does not let a skipped element's id leak into the section", async () => {
    const c = await canon(doc(`<div id="d">a<script id="s">hidden</script>b</div>`));
    expect(c.text).toBe("ab");
  });
});

describe("entity table", () => {
  it("covers the HTML 4 set", () => {
    // 96 Latin-1 + 5 markup + the rest of the 252 names.
    expect(NAMED_ENTITY_COUNT).toBeGreaterThanOrEqual(252);
    expect(decodeEntities("&Alpha;&rarr;&spades;&euro;")).toBe("Α→♠€");
  });

  it("decodes legacy names without a semicolon and leaves unknown ones alone", () => {
    expect(decodeEntities("&copy 2026 &amp&lt &bogus; &#0; &#x110000;")).toBe("© 2026 &< &bogus; � �");
  });

  it("maps windows-1252 numeric references", () => {
    expect(decodeEntities("&#150;&#x93;")).toBe("–“");
  });
});

const at = async (html: string) => await canon(doc(html));

describe("the ladder", () => {
  it("rung 1: a unique exact quote anchors", async () => {
    const c = await at("<p>The quick brown fox jumps.</p>");
    const r = locateAnchor(c, { exact: "brown fox" });
    expect(r).toMatchObject({ status: "anchored", rung: 1, matchedText: "brown fox" });
    if (r.status === "anchored") expect(c.text.slice(r.start, r.end)).toBe("brown fox");
  });

  it("rung 1: several matches are told apart by prefix and suffix", async () => {
    const c = await at("<p>Alpha: the end. Beta: the end. Gamma: the end.</p>");
    const r = locateAnchor(c, { exact: "the end", prefix: "Beta: ", suffix: ". Gamma" });
    expect(r.status).toBe("anchored");
    if (r.status === "anchored") expect(c.text.slice(r.start - 6, r.start)).toBe("Beta: ");
  });

  it("rung 1: longer agreeing context beats shorter", async () => {
    const c = await at("<p>xx the end. yy the end.</p>");
    const r = locateAnchor(c, { exact: "the end", prefix: "yy ", suffix: "." });
    expect(r.status).toBe("anchored");
    if (r.status === "anchored") expect(r.start).toBe(c.text.lastIndexOf("the end"));
  });

  it("rung 1: a tie with no section orphans rather than guesses", async () => {
    const c = await at("<p>the end</p><p>the end</p>");
    expect(locateAnchor(c, { exact: "the end" })).toEqual({ status: "orphaned" });
  });

  it("rung 1: a tie is broken by the section", async () => {
    const c = await at(`<div id="a">the end</div><div id="b">the end</div>`);
    const r = locateAnchor(c, { exact: "the end", section: "b" });
    expect(r.status).toBe("anchored");
    if (r.status === "anchored") expect(r.start).toBe(c.text.lastIndexOf("the end"));
  });

  it("rung 1: a section that does not separate the tie still orphans", async () => {
    const c = await at(`<div id="a">the end<p>the end</p></div>`);
    expect(locateAnchor(c, { exact: "the end", section: "a" })).toEqual({ status: "orphaned" });
    expect(locateAnchor(c, { exact: "the end", section: "zzz" })).toEqual({ status: "orphaned" });
  });

  it("rung 2: reflowed whitespace anchors and reports the text as it now reads", async () => {
    const c = await at("<p>The quick\n   brown   fox jumps.</p>");
    const r = locateAnchor(c, { exact: "quick brown fox" });
    expect(r).toMatchObject({ status: "anchored", rung: 2, matchedText: "quick\n   brown   fox" });
  });

  it("rung 2: context is compared collapsed too", async () => {
    const c = await at("<p>one   two. alpha\nbeta</p><p>three four. alpha  beta</p>");
    const r = locateAnchor(c, { exact: "alpha beta", prefix: "three four. " });
    expect(r.status).toBe("anchored");
    if (r.status === "anchored") expect(r.start).toBe(c.text.lastIndexOf("alpha"));
  });

  it("rung 2: an ambiguous collapsed match orphans", async () => {
    const c = await at("<p>a  b</p><p>a   b</p>");
    expect(locateAnchor(c, { exact: "a b" })).toEqual({ status: "orphaned" });
  });

  it("orphans when the text is gone, and anchors again when it returns", async () => {
    const quote = { exact: "the sentence" };
    expect(locateAnchor(await at("<p>Something else entirely.</p>"), quote)).toEqual({ status: "orphaned" });
    expect(locateAnchor(await at("<p>Now the sentence is back.</p>"), quote).status).toBe("anchored");
  });

  it("does not match across edits it would have to guess at", async () => {
    expect(locateAnchor(await at("<p>the sentances</p>"), { exact: "the sentence" })).toEqual({
      status: "orphaned",
    });
  });
});

describe("validateAnchor", () => {
  it("accepts the shape and normalises to NFC", () => {
    expect(validateAnchor({ exact: "café", prefix: "a", suffix: "b", section: "s" })).toEqual({
      exact: "café",
      prefix: "a",
      suffix: "b",
      section: "s",
    });
  });

  it("drops empty optionals", () => {
    expect(validateAnchor({ exact: "x", prefix: "", suffix: null })).toEqual({ exact: "x" });
  });

  it("refuses malformed and oversized anchors", () => {
    for (const bad of [
      null,
      "x",
      [],
      {},
      { exact: "" },
      { exact: 3 },
      { exact: "x".repeat(1001) },
      { exact: "x", prefix: "p".repeat(33) },
      { exact: "x", suffix: "s".repeat(33) },
      { exact: "x", section: "i".repeat(129) },
      { exact: "x", prefix: 1 },
    ]) {
      expect(validateAnchor(bad)).toBeNull();
    }
    expect(validateAnchor({ exact: "x".repeat(1000), prefix: "p".repeat(32), section: "i".repeat(128) })).not.toBeNull();
  });
});
