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

/**
 * The prefix every account id minted here carries.
 *
 * `docs.owner` holds two kinds of value: an app-sites `User.id` that the
 * license server resolved, and an id this repo minted for an account created by
 * approval. They are never merged, and this prefix is what makes that
 * structural rather than a convention — an app-sites uuid cannot start with
 * `oa_`, so no equality test between the two spaces can ever accidentally
 * succeed and hand one account another's documents.
 */
export const ACCOUNT_ID_PREFIX = "oa_";

/**
 * Bytes of entropy per account id.
 *
 * More than a doc id's ten, because the two ids answer to different threats. A
 * doc id is a capability sized against someone guessing urls; an account id is
 * never accepted as input and grants nothing, so all it has to be is unique
 * forever, against the birthday bound rather than against an attacker.
 */
export const ACCOUNT_ID_BYTES = 16;

/** An account created by approval, distinguishable from a license-key owner. */
export function newAccountId(): string {
  const bytes = new Uint8Array(ACCOUNT_ID_BYTES);
  crypto.getRandomValues(bytes);
  return `${ACCOUNT_ID_PREFIX}${encodeBase32(bytes)}`;
}

/**
 * Bytes of entropy in an approval handshake's `state` and PKCE verifier.
 *
 * 256 bits, because `state` is doing more work here than the usual CSRF nonce:
 * it is the lookup key for the pending handshake *and* the token the confirm
 * form carries, so guessing one would be enough to confirm somebody else's
 * approval. It is never a capability that outlives the handshake — the confirm
 * write clears it — but while it lives it has to be unguessable.
 */
export const HANDSHAKE_TOKEN_BYTES = 32;

/**
 * A token for one approval handshake.
 *
 * Base32 rather than base64url so PKCE gets a verifier it can use unchanged:
 * RFC 7636 admits only unreserved characters, and this alphabet is a subset of
 * them, where base64url's `-` and `_` would need the encoder this file already
 * has plus a second one nobody needs.
 */
export function newHandshakeToken(): string {
  const bytes = new Uint8Array(HANDSHAKE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return encodeBase32(bytes);
}
