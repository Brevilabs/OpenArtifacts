import { describe, expect, it } from "vitest";
import { DOC_ID_BYTES, DOC_ID_LENGTH, encodeBase32, isDocId, newDocId } from "../src/ids.js";

const CROCKFORD = /^[0-9abcdefghjkmnpqrstvwxyz]+$/;

describe("encodeBase32", () => {
  it("encodes big-endian, five bits at a time", () => {
    expect(encodeBase32(new Uint8Array([0x00]))).toBe("00");
    expect(encodeBase32(new Uint8Array([0xff]))).toBe("zw");
    expect(encodeBase32(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]))).toBe("00000000");
    expect(encodeBase32(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))).toBe("zzzzzzzz");
  });

  it("is injective across single-byte inputs", () => {
    const seen = new Set<string>();
    for (let b = 0; b < 256; b++) {
      seen.add(encodeBase32(new Uint8Array([b])));
    }
    expect(seen.size).toBe(256);
  });

  it("emits no padding character", () => {
    // 10 bytes = 80 bits = exactly 16 groups of 5, so an id has no trailing
    // partial group at all. The zero-padding branch still exists for other
    // lengths and is covered below.
    expect(encodeBase32(new Uint8Array(DOC_ID_BYTES))).toHaveLength(DOC_ID_LENGTH);
    expect(encodeBase32(new Uint8Array(DOC_ID_BYTES))).not.toContain("=");
  });

  it("pads a trailing partial group with zero bits, not characters", () => {
    // One byte is 8 bits: one full group of 5, then 3 bits zero-padded into a
    // second character. Kept because DOC_ID_BYTES no longer exercises it.
    expect(encodeBase32(new Uint8Array([0xff]))).toBe("zw");
  });

  it("carries all 80 bits — flipping any single bit changes the id", () => {
    // The encoder shifts a 32-bit accumulator, so a bit dropped off the top
    // would silently collapse distinct inputs onto one id and shrink the
    // guessing space well below 2^128.
    const seen = new Set<string>();
    for (let bit = 0; bit < DOC_ID_BYTES * 8; bit++) {
      const bytes = new Uint8Array(DOC_ID_BYTES);
      bytes[bit >> 3] = 1 << bit % 8;
      seen.add(encodeBase32(bytes));
    }
    expect(seen.size).toBe(DOC_ID_BYTES * 8);
  });
});

describe("newDocId", () => {
  const ids = Array.from({ length: 1000 }, newDocId);

  it("is 16 lowercase Crockford base32 characters", () => {
    for (const id of ids) {
      expect(id).toHaveLength(DOC_ID_LENGTH);
      expect(id).toMatch(CROCKFORD);
    }
  });

  it("omits the ambiguous letters i, l, o and u", () => {
    expect(ids.join("")).not.toMatch(/[ilou]/);
  });

  it("is url-safe as a single path segment", () => {
    for (const id of ids.slice(0, 50)) {
      expect(encodeURIComponent(id)).toBe(id);
      expect(new URL(`https://openartifacts.page/d/${id}`).pathname).toBe(`/d/${id}`);
    }
  });

  it("does not repeat", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("spends its full entropy budget rather than a fixed prefix", () => {
    // Every one of the 16 characters carries a full 5 bits, so a sequential or
    // constant-seeded id would leave some position never varying.
    for (let i = 0; i < DOC_ID_LENGTH; i++) {
      const distinct = new Set(ids.map((id) => id[i]));
      expect(distinct.size).toBeGreaterThan(1);
    }
  });
});

describe("isDocId", () => {
  it("accepts what newDocId produces", () => {
    expect(isDocId(newDocId())).toBe(true);
  });

  it("rejects wrong length, wrong case, and excluded letters", () => {
    const id = newDocId();
    expect(isDocId(id.slice(0, DOC_ID_LENGTH - 1))).toBe(false);
    expect(isDocId(`${id}0`)).toBe(false);
    expect(isDocId(id.toUpperCase())).toBe(false);
    expect(isDocId(`i${id.slice(1)}`)).toBe(false);
    expect(isDocId("")).toBe(false);
  });

  it("rejects path traversal and query junk", () => {
    expect(isDocId("../../etc/passwd")).toBe(false);
    expect(isDocId(`${newDocId()}/v1`)).toBe(false);
    expect(isDocId(`${newDocId()}?x=1`)).toBe(false);
  });
});
