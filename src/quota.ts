/**
 * The three ceilings from D10, enforced on the push path.
 *
 * They exist to cap the abuse and hoarding tail, not to monetize: a real
 * Copilot user never reaches any of them. The numbers themselves live in
 * `config.ts`; this file is how they are counted.
 */
import { MAX_DOC_BYTES, MAX_PUSHES_PER_DAY } from "./config.js";

/**
 * Byte ceiling on the whole request, as opposed to `MAX_DOC_BYTES`, which is
 * the ceiling on the `html` field inside it.
 *
 * The two differ by the JSON envelope: the field name, the title, and whatever
 * escaping the document's own bytes need. A megabyte of slack covers escaping
 * for any real document — reaching it would take a tenth of the file to be
 * quotes, backslashes or control characters — and it is what lets an oversized
 * body be rejected while it is still arriving rather than after it has been
 * buffered.
 */
export const MAX_REQUEST_BYTES = MAX_DOC_BYTES + 1024 * 1024;

/**
 * Read the body, giving up the moment it passes `limit`.
 *
 * `request.arrayBuffer()` would buffer whatever the client chose to send — up
 * to Cloudflare's 100MB request limit — before there was anything to compare
 * against the quota, so a 10MB ceiling enforced after the read is not a ceiling
 * on memory at all. Returns null when the body is too large; the bytes
 * otherwise.
 */
export async function readBodyWithin(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Bytes a string occupies once encoded, which is what the ceiling is in. */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * The `push_quota.day` key: a UTC `YYYY-MM-DD` string, so the window rolls over
 * on its own and no scheduled job has to reset a counter.
 */
export function utcDay(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/**
 * Claim one of today's pushes, returning false when there are none left.
 *
 * Claim rather than check: the count is read and incremented by a single
 * statement, so two concurrent pushes cannot both see 99 and both proceed. The
 * `WHERE` on the upsert's update branch is what enforces the limit — when it
 * fails SQLite leaves the row alone and `RETURNING` yields nothing, which is
 * the rejection.
 */
export async function reserveDailyPush(
  db: D1Database,
  publisher: string,
  day: string,
): Promise<boolean> {
  const claimed = await db
    .prepare(
      `INSERT INTO push_quota (publisher, day, pushes) VALUES (?, ?, 1)
       ON CONFLICT(publisher, day) DO UPDATE SET pushes = push_quota.pushes + 1
         WHERE push_quota.pushes < ?
       RETURNING pushes`,
    )
    .bind(publisher, day, MAX_PUSHES_PER_DAY)
    .first<{ pushes: number }>();

  return claimed !== null;
}

// The doc ceiling is enforced by `insertDocWithinQuota` in db.ts, where the
// count is a predicate on the insert. A standalone count belongs nowhere near
// it: reading the number and acting on it separately is the race that fix
// removed, and a spare helper is an invitation to reintroduce it.
