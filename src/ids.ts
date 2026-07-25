/**
 * Doc ids: 128 bits of CSPRNG entropy in lowercase Crockford base32.
 *
 * The id is the only thing standing between a public url and the doc behind it,
 * so it has to be unguessable — 128 bits, never a counter or a hash of anything
 * the publisher controls. Crockford's alphabet drops i/l/o/u, which keeps the id
 * url-safe, case-insensitively unambiguous, and safe to read aloud.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Bytes of entropy per id. */
export const DOC_ID_BYTES = 16;

/** ceil(128 / 5) — 25 full characters, then one carrying the last 3 bits. */
export const DOC_ID_LENGTH = 26;

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
