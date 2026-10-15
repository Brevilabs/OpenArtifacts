/**
 * Quote anchoring: how a comment finds its passage again.
 *
 * A comment is attached to a quote, not to a position, because the document
 * underneath it is replaced wholesale on every push (its versions are
 * immutable and a new one shares nothing with the last but its text). This file
 * is the pure half of that: it turns a stored version into canonical text, and
 * decides where a quote sits in it. The Durable Object (object.ts) supplies the
 * stored HTML and remembers the answers.
 *
 * **Canonical text** is the text a reader's DOM holds, minus anything that is
 * not the author's: the text of `<body>` (the whole document when it has none),
 * without `head`, `script`, `style`, `template` and `noscript` subtrees,
 * character references decoded, each text node normalised to NFC. The page
 * script builds the same string from the live DOM, skipping the OpenArtifacts
 * chrome it injected; stored R2 HTML never contains that chrome, so the server
 * has nothing to skip.
 *
 * **The ladder** runs per version, for a thread that has no answer for it yet:
 *
 *  1. The exact quote. One occurrence anchors. Several are scored by how much
 *     of the stored prefix and suffix agree with the text around each, and a
 *     unique best wins; a tie falls to the occurrences inside the quote's
 *     `section` (an element id), and a tie that survives that orphans. A wrong
 *     guess puts a reply under someone else's sentence, which is worse than
 *     asking the owner's agent to look at an orphan.
 *  2. Only when the quote is nowhere: the same search over whitespace-collapsed
 *     text, which is what a reflowed paragraph looks like. A unique winner
 *     anchors and reports the text as it now reads, so the caller can rewrite
 *     the stored quote.
 *
 * **What the page's `exact` must be.** The page builds `exact` (and `prefix` and
 * `suffix`) by slicing ITS canonical text, built with the same skip rules, at the
 * selection's mapped offsets. It must not use `range.toString()`: that joins every
 * Text node the range crosses, including a `<script>`, `<style>` or `<noscript>`
 * body between two paragraphs, text the canonical text leaves out, so a quote
 * that spans one would match neither rung and be refused as `anchor_not_found`.
 *
 * Nothing here edits a quote that merely changed: no edit-distance, no
 * guessing. Text that comes back in a later version anchors again by itself,
 * because every version is judged on its own.
 */
import { decodeEntities } from "./entities.js";

/** Limits on an anchor, enforced at post time. */
export const MAX_QUOTE = 1000;
export const MAX_CONTEXT = 32;
export const MAX_SECTION = 128;

export interface Anchor {
  section?: string;
  exact: string;
  prefix?: string;
  suffix?: string;
}

/** One text node's slice of the canonical text, with the ids that enclose it. */
export interface Run {
  start: number;
  end: number;
  /** Ids of every enclosing element, outermost first. */
  ids: readonly string[];
}

export interface CanonicalText {
  text: string;
  runs: readonly Run[];
}

/** Subtrees whose text is not the author's prose. */
const SKIPPED = new Set(["head", "script", "style", "template", "noscript"]);

/** Elements with no content and no end tag, so no frame to pop. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/** Start tags that close an open `<p>` (the HTML "has a p in button scope" list). */
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol",
  "p", "pre", "section", "table", "ul",
  // These close it too, as part of closing a list item.
  "li", "dd", "dt",
]);

/** An open element whose scope an implied close does not reach across. */
const SCOPE_BOUNDARY = new Set(["table", "td", "th", "caption", "template", "object", "button", "marquee", "applet"]);

/** What can sit in a `<head>`: any other start tag ends it. */
const HEAD_CONTENT = new Set(["meta", "link", "title", "style", "script", "base", "noscript", "template"]);

const P = new Set(["p"]);
const LI = new Set(["li"]);
const LISTS = new Set(["ul", "ol", "menu"]);
const DT_DD = new Set(["dt", "dd"]);
const DL = new Set(["dl"]);
const NONE: ReadonlySet<string> = new Set();

/** Elements whose first LF is not content. */
const LEADING_LF = new Set(["pre", "listing", "textarea"]);

interface Frame {
  name: string;
  foreign: boolean;
  skip: boolean;
  body: boolean;
  head: boolean;
  id: string | null;
}

interface RawRun {
  text: string;
  ids: readonly string[];
  inBody: boolean;
}

/**
 * Build the canonical text of a stored version.
 *
 * HTMLRewriter is a tokenizer, not a tree builder, which shapes this. Text
 * arrives as raw source in chunks that can split a character reference, so
 * chunks are joined per text node before decoding. An element that ends without
 * an end tag (`<p>`, `<li>`, an omitted `</head>`) never reports its close, so
 * frames are popped by identity, taking anything opened inside them along, and
 * `<body>` closes a `<head>` that was left open, which HTML permits and
 * Obsidian-adjacent generators do.
 *
 * It is also not a tree builder, so the few parser fix-ups that change the text
 * or the section a run belongs to are applied here, and only these (a browser
 * does more, none of it changes what is selectable): an unclosed `<head>` ends at
 * the first start tag that is not head content; the one LF directly after
 * `<pre>`, `<listing>` or `<textarea>` is dropped; a block-level start tag closes
 * an open `<p>`, a second `<li>` closes the first, and `<dt>`/`<dd>` close each
 * other, so an id on an implicitly closed element stops enclosing what follows.
 */
export async function canonicalText(source: string | ReadableStream<Uint8Array>): Promise<CanonicalText> {
  const stack: Frame[] = [];
  let skipDepth = 0;
  let bodyDepth = 0;
  let sawBody = false;
  let idsCache: string[] | null = [];
  let dropLeadingLf = false;
  const raw: RawRun[] = [];
  let pending = "";

  const pop = (frame: Frame): void => {
    const at = stack.lastIndexOf(frame);
    if (at === -1) return;
    while (stack.length > at) {
      const top = stack.pop() as Frame;
      if (top.skip) skipDepth--;
      if (top.body) bodyDepth--;
      if (top.id !== null) idsCache = null;
    }
  };

  /**
   * Close the nearest open element named in `names` (and what is inside it),
   * looking outwards from the current one and giving up at a `stop` name or a
   * scope boundary: the implied end tag a tree builder would have inserted.
   */
  const closeNearest = (names: ReadonlySet<string>, stops: ReadonlySet<string>): void => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i] as Frame;
      if (f.foreign) continue;
      if (names.has(f.name)) return pop(f);
      if (stops.has(f.name) || SCOPE_BOUNDARY.has(f.name)) return;
    }
  };

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const name = el.tagName.toLowerCase();
        const foreign = el.namespaceURI !== "http://www.w3.org/1999/xhtml";
        dropLeadingLf = !foreign && LEADING_LF.has(name);
        if (!foreign) {
          // An unclosed <head> ends at <body>, or at any start tag that is not head
          // content (not one nested in a head child: a <noscript> or <template> keeps its own).
          const top = stack[stack.length - 1];
          if (top?.head && !HEAD_CONTENT.has(name)) pop(top);
          if (name === "body") {
            const open = stack.find((f) => f.head);
            if (open) pop(open);
          }
          if (CLOSES_P.has(name)) closeNearest(P, NONE);
          if (name === "li") closeNearest(LI, LISTS);
          if (name === "dt" || name === "dd") closeNearest(DT_DD, DL);
        }
        const selfClosing = (el as unknown as { selfClosing?: boolean }).selfClosing === true;
        if ((!foreign && VOID.has(name)) || (foreign && selfClosing)) return;
        const id = el.getAttribute("id");
        const frame: Frame = {
          name,
          foreign,
          // `title` outside the body is the document's, and a DOM would have
          // put it in the head it implies.
          skip: SKIPPED.has(name) || (name === "title" && !foreign && bodyDepth === 0),
          body: name === "body" && !foreign,
          head: name === "head" && !foreign,
          id: id !== null && id !== "" ? id : null,
        };
        stack.push(frame);
        if (frame.skip) skipDepth++;
        if (frame.body) {
          bodyDepth++;
          sawBody = true;
        }
        if (frame.id !== null) idsCache = null;
        try {
          el.onEndTag(() => pop(frame));
        } catch {
          // Not every element can take an end-tag handler; it is popped by its
          // parent's close instead.
        }
      },
    })
    .onDocument({
      text(chunk) {
        pending += chunk.text;
        if (!chunk.lastInTextNode) return;
        let piece = pending;
        pending = "";
        if (dropLeadingLf) {
          dropLeadingLf = false;
          piece = piece.startsWith("\r\n") ? piece.slice(2) : piece.startsWith("\n") ? piece.slice(1) : piece;
        }
        if (skipDepth > 0 || piece === "") return;
        if (idsCache === null) idsCache = stack.flatMap((f) => (f.id === null ? [] : [f.id]));
        raw.push({ text: decodeEntities(piece).normalize("NFC"), ids: idsCache, inBody: bodyDepth > 0 });
      },
    });

  await rewriter.transform(new Response(source)).arrayBuffer();

  let text = "";
  const runs: Run[] = [];
  for (const r of raw) {
    if (sawBody && !r.inBody) continue;
    if (r.text === "") continue;
    runs.push({ start: text.length, end: text.length + r.text.length, ids: r.ids });
    text += r.text;
  }
  return { text, runs };
}

/** The run holding `offset`, by binary search; undefined for an empty text. */
function runAt(runs: readonly Run[], offset: number): Run | undefined {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = runs[mid] as Run;
    if (offset < run.start) hi = mid - 1;
    else if (offset >= run.end) lo = mid + 1;
    else return run;
  }
  return undefined;
}

/** The id of the innermost element with one around `offset`, as a section hint. */
export function sectionAt(canon: CanonicalText, offset: number): string | undefined {
  const run = runAt(canon.runs, offset);
  return run && run.ids.length > 0 ? run.ids[run.ids.length - 1] : undefined;
}

export type Located =
  | { status: "anchored"; start: number; end: number; matchedText: string; rung: 1 | 2 }
  | { status: "orphaned" };

interface Hit {
  start: number;
  end: number;
}

/** Every occurrence of `needle`, overlapping ones included. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (needle === "") return found;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    found.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return found;
}

/** How many trailing characters of `before` equal the trailing characters of `prefix`. */
function agreeBefore(before: string, prefix: string): number {
  let n = 0;
  while (n < before.length && n < prefix.length && before[before.length - 1 - n] === prefix[prefix.length - 1 - n]) n++;
  return n;
}

/** How many leading characters of `after` equal the leading characters of `suffix`. */
function agreeAfter(after: string, suffix: string): number {
  let n = 0;
  while (n < after.length && n < suffix.length && after[n] === suffix[n]) n++;
  return n;
}

/**
 * Pick one occurrence of the quote, or none. `starts` index `text`; `origin`
 * maps a start in `text` to the offset in the canonical text, which is how the
 * section tiebreak reaches the runs when `text` is the collapsed copy.
 */
function pick(
  text: string,
  needleLength: number,
  starts: number[],
  anchor: Anchor,
  prefix: string,
  suffix: string,
  originOf: (index: number) => number,
  runs: readonly Run[],
): number | null {
  if (starts.length === 0) return null;
  if (starts.length === 1) return starts[0] as number;

  let best: number[] = [];
  let bestScore = -1;
  for (const start of starts) {
    const before = text.slice(Math.max(0, start - MAX_CONTEXT), start);
    const after = text.slice(start + needleLength, start + needleLength + MAX_CONTEXT);
    const score = agreeBefore(before, prefix) + agreeAfter(after, suffix);
    if (score > bestScore) {
      bestScore = score;
      best = [start];
    } else if (score === bestScore) {
      best.push(start);
    }
  }
  if (best.length === 1) return best[0] as number;

  const section = anchor.section;
  if (section) {
    const inside = best.filter((start) => runAt(runs, originOf(start))?.ids.includes(section));
    if (inside.length === 1) return inside[0] as number;
  }
  return null;
}

const WHITESPACE = /\s/;

interface Collapsed {
  text: string;
  /** For each collapsed character, the original offset it starts at. */
  starts: number[];
  /** ...and the original offset just past it (a collapsed space spans the run). */
  ends: number[];
}

/** Runs of Unicode whitespace become one space, remembering where each came from. */
function collapse(text: string): Collapsed {
  let out = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (WHITESPACE.test(ch)) {
      let j = i + 1;
      while (j < text.length && WHITESPACE.test(text[j] as string)) j++;
      out += " ";
      starts.push(i);
      ends.push(j);
      i = j;
    } else {
      out += ch;
      starts.push(i);
      ends.push(i + 1);
      i++;
    }
  }
  return { text: out, starts, ends };
}

/** Collapse a loose string (needle or context) without the offset maps. */
function collapseText(text: string): string {
  return collapse(text).text;
}

/**
 * Find the anchor's quote in a version's canonical text: the ladder in the file
 * docblock. Pure; the caller decides what to store.
 */
export function locateAnchor(canon: CanonicalText, anchor: Anchor): Located {
  const prefix = anchor.prefix ?? "";
  const suffix = anchor.suffix ?? "";

  const exact = occurrences(canon.text, anchor.exact);
  if (exact.length > 0) {
    const start = pick(canon.text, anchor.exact.length, exact, anchor, prefix, suffix, (i) => i, canon.runs);
    if (start === null) return { status: "orphaned" };
    return { status: "anchored", start, end: start + anchor.exact.length, matchedText: anchor.exact, rung: 1 };
  }

  const flat = collapse(canon.text);
  const needle = collapseText(anchor.exact);
  const loose = occurrences(flat.text, needle);
  const start = pick(
    flat.text,
    needle.length,
    loose,
    anchor,
    collapseText(prefix),
    collapseText(suffix),
    (i) => flat.starts[i] as number,
    canon.runs,
  );
  if (start === null) return { status: "orphaned" };
  const hit: Hit = { start: flat.starts[start] as number, end: flat.ends[start + needle.length - 1] as number };
  return {
    status: "anchored",
    start: hit.start,
    end: hit.end,
    matchedText: canon.text.slice(hit.start, hit.end),
    rung: 2,
  };
}

/**
 * Check and normalise an anchor from a request body. Strings are NFC, because
 * canonical text is, and a quote typed on a decomposed keyboard must still find
 * itself. `null` means malformed; the caller answers 400.
 */
export function validateAnchor(input: unknown): Anchor | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const optional = (value: unknown, max: number): string | undefined | null => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") return null;
    const text = value.normalize("NFC");
    return text.length > max ? null : text === "" ? undefined : text;
  };
  if (typeof raw.exact !== "string") return null;
  const exact = raw.exact.normalize("NFC");
  if (exact.length < 1 || exact.length > MAX_QUOTE) return null;
  const prefix = optional(raw.prefix, MAX_CONTEXT);
  const suffix = optional(raw.suffix, MAX_CONTEXT);
  const section = optional(raw.section, MAX_SECTION);
  if (prefix === null || suffix === null || section === null) return null;
  const anchor: Anchor = { exact };
  if (prefix !== undefined) anchor.prefix = prefix;
  if (suffix !== undefined) anchor.suffix = suffix;
  if (section !== undefined) anchor.section = section;
  return anchor;
}
