/**
 * A publisher's origin code: the 6-character subdomain their invited-only pages
 * are served from, stored in `publisher_origins` and never changed or reused.
 *
 * Imports nothing at runtime, so `src/rebuild.ts` can run under plain Node.
 */

/** No vowels, so no words; no 0/1/o/l/i, so nothing to misread. 27 symbols. */
export const ORIGIN_CODE_ALPHABET = "23456789bcdfghjkmnpqrstvwxz";

export const ORIGIN_CODE_LENGTH = 6;

/** A code host's subdomain. */
export const ORIGIN_CODE = new RegExp(`^[${ORIGIN_CODE_ALPHABET}]{${ORIGIN_CODE_LENGTH}}$`);

/**
 * A fresh random code. Bytes at or above the largest multiple of the alphabet
 * size are discarded rather than folded in with `%`, so every symbol is equally
 * likely.
 */
export function newOriginCode(): string {
  const size = ORIGIN_CODE_ALPHABET.length;
  const limit = 256 - (256 % size);
  let code = "";
  while (code.length < ORIGIN_CODE_LENGTH) {
    const bytes = new Uint8Array(ORIGIN_CODE_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limit && code.length < ORIGIN_CODE_LENGTH) code += ORIGIN_CODE_ALPHABET[byte % size];
    }
  }
  return code;
}

/** Draws are bounded: a collision is a 1-in-387-million event, so five in a row is a bug. */
const MAX_ATTEMPTS = 5;

/**
 * `owner`'s code, created on first need. `owner` is always a document's own
 * `docs.owner`, never the caller's id (see `src/private.ts`).
 *
 * The insert does nothing on any conflict: the owner already has a row (a
 * concurrent request won) or the drawn code is another owner's. Reading back
 * tells the two apart, and only the second draws again.
 */
export async function originCode(
  db: D1Database,
  owner: string,
  draw: () => string = newOriginCode,
): Promise<string> {
  const select = () => db.prepare("SELECT code FROM publisher_origins WHERE owner = ?").bind(owner);
  const existing = await select().first<{ code: string }>();
  if (existing !== null) return existing.code;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [, read] = await db.batch([
      db
        .prepare("INSERT INTO publisher_origins (owner, code, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(owner, draw(), Date.now()),
      select(),
    ]);
    const row = read!.results[0] as { code: string } | undefined;
    if (row !== undefined) return row.code;
  }
  throw new Error("could not allocate an origin code");
}
