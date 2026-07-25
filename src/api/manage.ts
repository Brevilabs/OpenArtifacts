/**
 * Manage: `DELETE /api/v1/docs/{docId}` withdraws a doc, `GET /api/v1/docs`
 * lists the ones a publisher still holds (D8).
 *
 * Delete is the reason this file exists. Accidentally sharing the wrong note is
 * the single most likely support request, so the fix has to be a call the client
 * can make rather than a script someone runs for you — and it has to be
 * immediate, which means dropping the bytes, not just hiding the row.
 *
 * The two halves of a delete are deliberately asymmetric: the D1 row is marked
 * deleted and kept forever, while the R2 objects are destroyed. The row is what
 * lets `/d/{docId}` answer 410 instead of 404 (phase 4), which is the difference
 * between a reader learning the doc was withdrawn and a reader concluding they
 * mistyped the link. It costs a few dozen bytes; the content, which is the part
 * that actually had to disappear, is gone.
 */
import type { Publisher } from "../auth.js";
import type { Env } from "../config.js";
import { listPublisherDocs, softDeleteDoc, type DocListCursor, type DocListRow } from "../db.js";
import { docNotFound, errorResponse } from "../errors.js";
import { isDocId } from "../ids.js";
import { docObjectPrefix } from "../storage.js";
import { publicDocUrl } from "../urls.js";

/** Docs per page when the caller names no `limit`. */
const DEFAULT_LIMIT = 50;

/**
 * Ceiling on `limit`. Not a politeness limit: every row costs a `versions`
 * lookup and a url, and an unbounded page would let one request walk a
 * publisher's entire 500-doc shelf in one D1 query.
 */
const MAX_LIMIT = 100;

/** R2 caps both a list page and a bulk delete at 1000 keys. */
const OBJECT_BATCH = 1000;

export interface DeleteDeps {
  /**
   * Keys per R2 listing page. Injected by tests so the loop below can be walked
   * across pages with three objects rather than a thousand — what it has to
   * prove is that delete keeps asking until the prefix is empty, and a thousand
   * writes proved that no better while timing out on a slow machine. Production
   * never sets it: R2's cap is the real number.
   */
  objectBatch?: number;
}

/**
 * Destroy every object under the doc's prefix.
 *
 * The prefix is the source of truth here, not the `versions` rows: R2 is the
 * system of record, and a push that wrote an object and died before its row
 * would leave bytes behind that a row-driven delete would silently miss. A doc
 * can hold more than a page of versions — 100 pushes a day compounds — so this
 * pages rather than assuming one listing covers it.
 */
async function deleteDocObjects(env: Env, docId: string, objectBatch: number): Promise<void> {
  const prefix = docObjectPrefix(docId);
  let cursor: string | undefined;

  do {
    const listing = await env.DOCS.list({ prefix, limit: objectBatch, cursor });
    if (listing.objects.length > 0) {
      await env.DOCS.delete(listing.objects.map((object) => object.key));
    }
    // Cursors are positions in the key order, and everything before this one is
    // already gone, so resuming from it never revisits a deleted key.
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);
}

/**
 * Row first, bytes second.
 *
 * Marking the row is what stops the doc being served, so it happens before
 * anything can fail. The other order would leave a doc D1 still calls live with
 * no bytes behind it — a link that 404s while its publisher is told it is fine
 * — which is a worse thing to be wrong about.
 *
 * A second delete is `docNotFound`, not another 204: an already-deleted doc has
 * to be indistinguishable from one that never existed. What repeats safely is
 * the outcome, which is the part a client retrying after a timeout cares about
 * — the doc is deleted, its bytes are gone, and a second call changes nothing.
 */
export async function deleteDoc(
  env: Env,
  publisher: Publisher,
  docId: string,
  deps: DeleteDeps = {},
): Promise<Response> {
  // An id that cannot exist is answered without touching D1.
  if (!isDocId(docId)) return docNotFound(docId);

  if (!(await softDeleteDoc(env.DB, docId, publisher.id, Date.now()))) {
    return docNotFound(docId);
  }

  try {
    await deleteDocObjects(env, docId, deps.objectBatch ?? OBJECT_BATCH);
  } catch (error) {
    // Past this point the doc is withdrawn from every reader whatever R2 does,
    // so answering anything but 204 would be a lie in the direction that costs
    // the most: the publisher is told their unshare failed, and the retry they
    // make answers 404 because the row is already marked. The failure costs
    // orphaned objects instead — storage, not exposure, since nothing can reach
    // them once the row says deleted — and this log is what makes them findable.
    console.error("delete left objects behind", { docId, error });
  }
  return new Response(null, { status: 204 });
}

/** One doc as the list reports it. `updatedAt` is epoch ms, like every time here. */
interface ListedDoc {
  docId: string;
  title: string;
  url: string;
  /**
   * Latest version with bytes, or null for a doc whose first push died between
   * creating the row and writing the object. Such a doc is listed rather than
   * hidden: it still counts against the 500-doc ceiling, so the publisher needs
   * its id to be able to delete it.
   */
  version: number | null;
  updatedAt: number;
}

interface ListResponse {
  docs: ListedDoc[];
  /** Present only when another page exists. Opaque: pass it back unchanged. */
  cursor?: string;
}

function base64UrlEncode(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string | null {
  try {
    return atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
}

/** `{created_at}.{docId}` — the two columns the index scan orders by. */
const CURSOR_PATTERN = /^([0-9]{1,15})\.([0-9a-z]+)$/;

/**
 * The cursor is base64url over the resume point rather than the raw columns,
 * because it is a position in a scan, not a fact about a doc: encoding it says
 * so, and leaves us free to change what a page resumes on without clients
 * having built a parser for it.
 */
function encodeCursor(row: DocListRow): string {
  return base64UrlEncode(`${row.created_at}.${row.id}`);
}

/**
 * Null for anything this API did not issue. Every field is re-validated rather
 * than trusted: the cursor arrives from the client, and it is bound straight
 * into a comparison, so a timestamp has to be a real integer and an id has to be
 * a real id before either goes near D1.
 */
function decodeCursor(raw: string): DocListCursor | null {
  const decoded = base64UrlDecode(raw);
  if (decoded === null) return null;

  const match = CURSOR_PATTERN.exec(decoded);
  if (match === null) return null;

  const [, createdAt = "", id = ""] = match;
  if (!isDocId(id)) return null;

  const created_at = Number(createdAt);
  return Number.isSafeInteger(created_at) ? { created_at, id } : null;
}

/** The requested page size, or null when the caller sent something that is not one. */
function parseLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_LIMIT;
  // Digits only, so `10.5`, `1e2`, ` 10` and `-1` are rejected rather than
  // quietly coerced into a page size the caller did not ask for.
  if (!/^[0-9]{1,3}$/.test(raw)) return null;

  const limit = Number(raw);
  return limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

/**
 * `GET /api/v1/docs?limit&cursor` — this publisher's live docs, newest first.
 *
 * Newest by creation, which is the order the partial index is built in and the
 * only order a keyset cursor can walk safely: a doc re-pushed mid-walk would
 * move under an `updated_at` ordering and be seen twice or not at all.
 *
 * One row beyond the page is fetched to decide whether there is another page.
 * The alternative — always returning a cursor and letting the caller discover
 * the end with an empty page — costs every client one extra round trip.
 */
export async function listDocs(
  requestUrl: URL,
  env: Env,
  publisher: Publisher,
): Promise<Response> {
  const limit = parseLimit(requestUrl.searchParams.get("limit"));
  if (limit === null) {
    return errorResponse(
      "bad_request",
      `\`limit\` must be a whole number between 1 and ${MAX_LIMIT}.`,
    );
  }

  const rawCursor = requestUrl.searchParams.get("cursor");
  const after = rawCursor === null ? null : decodeCursor(rawCursor);
  if (rawCursor !== null && after === null) {
    return errorResponse(
      "bad_request",
      "`cursor` must be a cursor from a previous list response.",
    );
  }

  const rows = await listPublisherDocs(env.DB, publisher.id, after, limit + 1);
  const page = rows.slice(0, limit);

  const body: ListResponse = {
    docs: page.map((row) => ({
      docId: row.id,
      title: row.title,
      url: publicDocUrl(env, requestUrl, row.id),
      version: row.version,
      updatedAt: row.updated_at,
    })),
  };

  const last = rows.length > limit ? page.at(-1) : undefined;
  if (last !== undefined) body.cursor = encodeCursor(last);

  return Response.json(body);
}
