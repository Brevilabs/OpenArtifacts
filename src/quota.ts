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
 * the ceiling on the `html` field inside it and the only one the contract
 * documents. This one exists so an oversized body is rejected while it is still
 * arriving rather than after it has been buffered.
 *
 * It has to clear the worst case *a real document* produces, which is 2x: every
 * `"` and `\` costs two bytes instead of one, and attribute-dense HTML passes
 * 10% quote density without being remarkable. A ceiling budgeted for typical
 * escaping instead would be an undocumented second limit that refuses documents
 * under the published one.
 *
 * Not 6x. A control character escapes to `\uXXXX`, but control characters are
 * not valid in HTML text, so reaching that bound takes ~1.7M of them — an
 * adversarial payload, not a note. It gets a clean 413, and budgeting for it
 * would mean holding ~60MB of raw bytes plus the decoded string plus the parsed
 * field against a 128MB isolate: a real OOM risk on ordinary large docs, traded
 * for a document that does not exist.
 *
 * Doubling is affordable: the worst case holds the raw bytes, the decoded
 * string and the parsed field at once, and content escape-dense enough to reach
 * this bound is ASCII by definition, which V8 stores one byte per character.
 * That is roughly 60MB against the isolate's 128MB.
 */
export const MAX_REQUEST_BYTES = 2 * MAX_DOC_BYTES + 1024 * 1024;

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
  owner: string,
  day: string,
  limit = MAX_PUSHES_PER_DAY,
): Promise<boolean> {
  const claimed = await db
    .prepare(
      `INSERT INTO push_quota (owner, day, pushes) VALUES (?, ?, 1)
       ON CONFLICT(owner, day) DO UPDATE SET pushes = push_quota.pushes + 1
         WHERE push_quota.pushes < ?
       RETURNING pushes`,
    )
    .bind(owner, day, limit)
    .first<{ pushes: number }>();

  return claimed !== null;
}

// The doc ceiling is enforced by `insertDocWithinQuota` in db.ts, where the
// count is a predicate on the insert. A standalone count belongs nowhere near
// it: reading the number and acting on it separately is the race that fix
// removed, and a spare helper is an invitation to reintroduce it.

/**
 * Give back a push claimed for work that then did not happen.
 *
 * The claim has to come before the work — that is what stops two concurrent
 * pushes both seeing 99 — so a push that loses a race to a concurrent delete
 * has already been counted by the time it finds out. The contract is that a
 * rejected push costs nothing, so the counter is repaid rather than the
 * reservation moved later.
 *
 * `pushes > 0` keeps a double refund, or one crossing a UTC day boundary into
 * a row it never incremented, from writing a negative count.
 */
export async function refundDailyPush(
  db: D1Database,
  owner: string,
  day: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE push_quota SET pushes = pushes - 1
        WHERE owner = ? AND day = ? AND pushes > 0`,
    )
    .bind(owner, day)
    .run();
}
