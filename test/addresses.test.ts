import { describe, expect, it } from "vitest";
import { parseAddresses } from "../src/addresses.js";
import { FRAME_SCRIPT } from "../src/embed-scripts.js";

// The frame cannot import, so FRAME_SCRIPT carries a copy of the parser. Both are
// run against the same cases, so the copy cannot drift.
const frameCopy = (() => {
  const source = /const parseAddresses = \(text\) => \{[\s\S]*?\n {2}\};/.exec(FRAME_SCRIPT)?.[0];
  if (source === undefined) throw new Error("FRAME_SCRIPT has no parseAddresses");
  return new Function(`${source}\nreturn parseAddresses;`)() as typeof parseAddresses;
})();

describe.each([
  ["src/addresses.ts", parseAddresses],
  ["the frame's copy", frameCopy],
])("parseAddresses, %s", (_name, parse) => {
  it("splits on commas, semicolons, spaces and newlines", () => {
    expect(parse("a@x.com, b@x.com;c@x.com d@x.com\ne@x.com\r\nf@x.com\t,\n g@x.com")).toEqual({
      emails: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com", "g@x.com"],
      bad: [],
    });
  });

  it("takes the address out of Name <address>, quoted names with commas included", () => {
    expect(parse('Ann Lee <ann@x.com>, "Doe, Jane" <jane@x.com>; <bob@x.com>\nCarol <carol@x.com> dan@x.com')).toEqual({
      emails: ["ann@x.com", "jane@x.com", "bob@x.com", "carol@x.com", "dan@x.com"],
      bad: [],
    });
  });

  it("does not cut the end off an address that comes just before a named contact", () => {
    expect(parse("dan@x.com Carol <carol@x.com>")).toEqual({ emails: ["dan@x.com", "carol@x.com"], bad: [] });
    expect(parse("bob@x.com <bob@x.com>, ann@x.com")).toEqual({ emails: ["bob@x.com", "ann@x.com"], bad: [] });
  });

  it("collapses duplicates whatever their case, keeping the first position", () => {
    expect(parse("A@x.com b@x.com a@X.com B@x.com")).toEqual({ emails: ["a@x.com", "b@x.com"], bad: [] });
  });

  it("keeps what is not an address so it can be reported, once", () => {
    expect(parse("a@x.com, bob@, @x.com, plain, plain, a@b@c, ,;")).toEqual({
      emails: ["a@x.com"],
      bad: ["bob@", "@x.com", "plain", "a@b@c"],
    });
  });

  it("finds nothing in nothing", () => {
    expect(parse("")).toEqual({ emails: [], bad: [] });
    expect(parse(" \n ,; ")).toEqual({ emails: [], bad: [] });
  });
});
