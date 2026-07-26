/**
 * Doc ids: 80 bits of CSPRNG entropy in lowercase Crockford base32.
 *
 * The id is the only thing standing between a public url and the doc behind it,
 * so it has to be unguessable — never a counter, never a hash of anything the
 * publisher controls. Crockford's alphabet drops i/l/o/u, which keeps the id
 * url-safe, case-insensitively unambiguous, and safe to read aloud.
 *
 * 80 bits, not 128. The threat is someone enumerating urls to find a doc they
 * were not given, and at a million docs and a sustained 10,000 guesses a second
 * — far above what the edge would pass — that is a few million years for one
 * hit. 128 bits bought another 10^15 of margin nobody needs and cost ten
 * characters of every shared link.
 *
 * Not base64: it packs 6 bits per character rather than 5, so the same id would
 * be 14 characters instead of 16, but it is case-sensitive. An id that changes
 * meaning when someone types it with a stray capital is a permanent support
 * cost, and being safe to read aloud is why this alphabet was chosen.
 *
 * 10 bytes is 80 bits is exactly 16 groups of 5, so every character carries
 * data and none is a zero-padded remainder.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Bytes of entropy per id. */
export const DOC_ID_BYTES = 10;

/** 80 / 5 — exact, so there is no partial trailing character. */
export const DOC_ID_LENGTH = 16;

const DOC_ID_PATTERN = new RegExp(`^[${ALPHABET}]{${DOC_ID_LENGTH}}$`);

/** Big-endian base32 with no padding. */
export function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return out;
}

export function newDocId(): string {
  const bytes = new Uint8Array(DOC_ID_BYTES);
  crypto.getRandomValues(bytes);
  return encodeBase32(bytes);
}

/**
 * Cheap shape check so the serving path can reject junk before it costs a D1
 * read. Passing this says nothing about whether the doc exists.
 */
export function isDocId(value: string): boolean {
  return DOC_ID_PATTERN.test(value);
}
