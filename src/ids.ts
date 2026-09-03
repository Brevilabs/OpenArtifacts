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
  return randomBase32(HANDSHAKE_TOKEN_BYTES);
}

/** CSPRNG bytes as base32, which is the shape of every secret minted here. */
function randomBase32(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase32(bytes);
}

/**
 * Bytes in the device code a terminal polls with.
 *
 * 256 bits, the same as a handshake token and for the same reason: it is the
 * only thing that can collect the token an approval earns, so guessing one
 * would be taking somebody's credential. It is never displayed and never typed,
 * so its length costs nothing.
 */
export const DEVICE_CODE_BYTES = 32;

/** The secret half of a device authorization, held only by the terminal. */
export function newDeviceCode(): string {
  return randomBase32(DEVICE_CODE_BYTES);
}

/**
 * The alphabet a user code is drawn from. Shown grouped: `WDJB-MJHT`.
 *
 * Twenty consonants, exactly RFC 8628 §6.1's recommended set. Two properties
 * matter and neither is obvious:
 *
 * - **No digits.** A code is read off one screen and typed into another, often
 *   a phone, so `0`/`O` and `1`/`I`/`l` would each be a support request. The
 *   doc-id alphabet solves the same problem by dropping those letters instead;
 *   here the digits go, because a code is spoken as letters.
 * - **No vowels.** Without them no draw can spell a word, which is what keeps a
 *   code from being an obscenity or somebody's brand name on screen. That is
 *   worth more than the entropy it costs.
 *
 * Twenty to the eighth is about 2^34.6, which is what the RFC asks for when the
 * endpoint is rate limited — and the code is not a credential in any case,
 * since polling needs the device code and approving needs a sign-in.
 */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** Characters of randomness in a user code, excluding the grouping dash. */
export const USER_CODE_LENGTH = 8;

/** Where the dash goes. Two groups of four is what people read back correctly. */
const USER_CODE_GROUP = 4;

/**
 * The short code a person reads off their terminal and types into the approval
 * page.
 *
 * Rejection sampling rather than `byte % 20`: 256 is not a multiple of 20, so a
 * plain modulo would make the first sixteen letters likelier than the last
 * four. The bias is small and the fix is one comparison, and an alphabet with
 * quietly uneven letters is how the entropy claim above stops being true.
 */
export function newUserCode(): string {
  const size = USER_CODE_ALPHABET.length;
  // Largest multiple of the alphabet size that fits in a byte. A draw at or
  // above it is discarded rather than folded.
  const ceiling = Math.floor(256 / size) * size;
  const draw = new Uint8Array(1);

  let code = "";
  let drawn = 0;
  while (drawn < USER_CODE_LENGTH) {
    crypto.getRandomValues(draw);
    const byte = draw[0] ?? 0;
    // Discarded before the dash is placed, so a rejected draw cannot leave two.
    if (byte >= ceiling) continue;
    if (drawn === USER_CODE_GROUP) code += "-";
    code += USER_CODE_ALPHABET[byte % size];
    drawn += 1;
  }
  return code;
}

/**
 * The prefix every token this deployment issues carries.
 *
 * It is what tells `resolvePublisher` which credential it is holding, and that
 * matters for more than tidiness: without it a token would be sent to the
 * Brevilabs license server to be identified, handing our own secret to a third
 * party on every request. It also makes a leaked token recognisable to a secret
 * scanner, which a bare random string is not.
 */
export const TOKEN_PREFIX = "oat_";

/** Bytes of entropy in a token. It is a bearer credential; treat it as one. */
export const TOKEN_BYTES = 32;

/** A token an approval earns. Returned once, stored only as a hash. */
export function newApiToken(): string {
  return `${TOKEN_PREFIX}${randomBase32(TOKEN_BYTES)}`;
}

/**
 * The prefix on a token's public id, so a person reading CLI output can tell it
 * from the token itself and from a doc id.
 */
export const TOKEN_ID_PREFIX = "tok_";

/**
 * Bytes in a token id. Like an account id it grants nothing and is never
 * accepted as proof of anything, so it only has to stay unique.
 */
export const TOKEN_ID_BYTES = 10;

/** The name a token is listed and revoked by. Never derived from its value. */
export function newTokenId(): string {
  return `${TOKEN_ID_PREFIX}${randomBase32(TOKEN_ID_BYTES)}`;
}

/** 80 / 5 — the characters `TOKEN_ID_BYTES` encodes to, with nothing left over. */
const TOKEN_ID_LENGTH = 16;

const TOKEN_ID_PATTERN = new RegExp(`^${TOKEN_ID_PREFIX}[${ALPHABET}]{${TOKEN_ID_LENGTH}}$`);

/**
 * Cheap shape check, so revoking a junk id costs no D1 read. Passing it says
 * nothing about whether the token exists or whose it is.
 */
export function isTokenId(value: string): boolean {
  return TOKEN_ID_PATTERN.test(value);
}
