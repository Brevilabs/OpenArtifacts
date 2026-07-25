/**
 * Push: `POST /api/v1/docs` mints a doc, `PUT /api/v1/docs/{docId}` mints the
 * next version of one (D4). Both are the same three steps once the request is
 * validated — reserve a version number, write the bytes, record the version.
 *
 * That order is load-bearing. The reservation is what makes the R2 key unique,
 * so it comes first; the object is written before the row that names it, so a
 * version row always has bytes behind it. A crash between the reservation and
 * the write burns a version number, which is the deliberate trade: version
 * numbers are cheap and immutability is not negotiable.
 *
 * On the create path the `docs` insert *is* the reservation, so the same crash
 * burns a doc slot rather than a version number: a doc row with no versions and
 * no bytes, unreachable because its id was never returned, still counting
 * against the 500-doc ceiling. Only an R2 or D1 failure produces one, and the
 * alternative — inserting the row after the write — would hand out a url before
 * anything pointed at it. Rolling the row back is deliberately not attempted:
 * the failure may equally be the version insert *after* a successful write, and
 * a rollback there would strand the object it names.
 */
import type { Publisher } from "../auth.js";
import { MAX_DOCS_PER_PUBLISHER, MAX_DOC_BYTES, MAX_PUSHES_PER_DAY } from "../config.js";
import type { Env } from "../config.js";
import {
  deleteDocRow,
  deleteVersionRow,
  commitVersionMetadata,
  docIsDeleted,
  FIRST_VERSION,
  insertDocWithinQuota,
  insertVersion,
  ownsLiveDoc,
  reserveNextVersion,
} from "../db.js";
import { docNotFound, errorResponse } from "../errors.js";
import { isDocId, newDocId } from "../ids.js";
import {
  MAX_REQUEST_BYTES,
  readBodyWithin,
  refundDailyPush,
  reserveDailyPush,
  utcDay,
  utf8Length,
} from "../quota.js";
import { bakeServedHtml } from "../render.js";
import { STORED_CONTENT_TYPE, versionObjectKey } from "../storage.js";
import { publicDocUrl } from "../urls.js";

/** Titles are display strings in a list, not documents; long ones are noise. */
const MAX_TITLE_LENGTH = 512;

/** A push with no usable title still publishes. Naming is not a gate. */
const DEFAULT_TITLE = "Untitled";

interface PushBody {
  /** Null when the push carried no usable title. */
  title: string | null;
  html: string;
}

type ParsedPush = { ok: true; body: PushBody } | { ok: false; response: Response };

/** Trimmed and capped, or null when there is nothing worth storing. */
function normalizeTitle(raw: string): string | null {
  const title = raw.trim().slice(0, MAX_TITLE_LENGTH);
  return title.length > 0 ? title : null;
}

/**
 * Parse and vet `{title?, html}` (D13).
 *
 * Size is checked twice against two different ceilings: the request as a whole
 * while it streams in, so an oversized push costs no memory, and then the
 * `html` field itself, which is what D10's 10MB actually governs.
 */
async function parsePushBody(request: Request): Promise<ParsedPush> {
  const raw = await readBodyWithin(request, MAX_REQUEST_BYTES);
  if (raw === null) {
    return {
      ok: false,
      response: errorResponse("too_large", "That push is too large to accept."),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { ok: false, response: errorResponse("bad_request", "Body must be JSON.") };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: errorResponse("bad_request", "Body must be a JSON object.") };
  }

  const { html, title } = parsed as Record<string, unknown>;

  // HTML only, and only from the client (D5). There is no markdown branch to
  // fall back to, so an empty or absent field is a client bug worth surfacing.
  if (typeof html !== "string" || html.length === 0) {
    return {
      ok: false,
      response: errorResponse("bad_request", "`html` must be a non-empty string."),
    };
  }
  if (utf8Length(html) > MAX_DOC_BYTES) {
    return {
      ok: false,
      response: errorResponse("too_large", `A doc may be at most ${MAX_DOC_BYTES} bytes of HTML.`),
    };
  }

  if (title !== undefined && title !== null && typeof title !== "string") {
    return { ok: false, response: errorResponse("bad_request", "`title` must be a string.") };
  }

  return {
    ok: true,
    body: { title: typeof title === "string" ? normalizeTitle(title) : null, html },
  };
}

function dailyQuotaExceeded(): Response {
  return errorResponse(
    "quota_exceeded",
    `You have used all ${MAX_PUSHES_PER_DAY} of today's pushes. Try again tomorrow (UTC).`,
  );
}

/**
 * Render, store, record — in that order, for the reasons at the top of the file.
 *
 * The version number is already reserved by the time this runs, so the key it
 * writes cannot collide with another push and the object it writes is never
 * read back or rewritten.
 *
 * Returns false when a concurrent delete won the race and this version was
 * rolled back; see below.
 */
async function storeVersion(
  env: Env,
  docId: string,
  version: number,
  html: string,
  atMs: number,
): Promise<boolean> {
  const bytes = await bakeServedHtml(html);
  const key = versionObjectKey(docId, version);

  await env.DOCS.put(key, bytes, {
    httpMetadata: { contentType: STORED_CONTENT_TYPE },
  });

  await insertVersion(env.DB, {
    doc_id: docId,
    n: version,
    size: bytes.byteLength,
    created_at: atMs,
  });

  // A delete that lands between the version reservation and this write has
  // already finished its prefix scan, so it never saw these bytes: unshare
  // would report success while leaving content in the bucket. There is no lock
  // to take — v0 has no per-doc coordinator on purpose (D7) — so the write
  // compensates for itself. Losing the race means undoing it, not preventing it.
  //
  // The version row goes with the object it named. The doc row is untouched,
  // which is what keeps the deleted url answering 410 rather than 404.
  if (await docIsDeleted(env.DB, docId)) {
    await env.DOCS.delete(key);
    await deleteVersionRow(env.DB, docId, version);
    return false;
  }

  return true;
}

function pushed(env: Env, requestUrl: URL, docId: string, version: number, status: number) {
  return Response.json(
    { docId, url: publicDocUrl(env, requestUrl, docId), version },
    { status },
  );
}

export async function createDoc(
  request: Request,
  requestUrl: URL,
  env: Env,
  publisher: Publisher,
): Promise<Response> {
  const parsed = await parsePushBody(request);
  if (!parsed.ok) return parsed.response;

  const now = Date.now();

  // Capacity before the daily counter, so a publisher who is out of room does
  // not also lose a push from today's allowance for a doc that was never made.
  // The check lives inside the insert: counting first and inserting after would
  // let concurrent creates all read the same count and all proceed, so the
  // documented ceiling would hold only for callers who push one at a time.
  const docId = newDocId();
  const inserted = await insertDocWithinQuota(
    env.DB,
    {
      id: docId,
      publisher: publisher.id,
      title: parsed.body.title ?? DEFAULT_TITLE,
      created_at: now,
      updated_at: now,
    },
    MAX_DOCS_PER_PUBLISHER,
  );
  if (!inserted) {
    return errorResponse(
      "quota_exceeded",
      `You are holding ${MAX_DOCS_PER_PUBLISHER} docs. Delete one to publish another.`,
    );
  }

  if (!(await reserveDailyPush(env.DB, publisher.id, utcDay(now)))) {
    await deleteDocRow(env.DB, docId);
    return dailyQuotaExceeded();
  }

  await storeVersion(env, docId, FIRST_VERSION, parsed.body.html, now);
  return pushed(env, requestUrl, docId, FIRST_VERSION, 201);
}

export async function updateDoc(
  request: Request,
  requestUrl: URL,
  env: Env,
  publisher: Publisher,
  docId: string,
): Promise<Response> {
  // An id that cannot exist is answered without touching D1.
  if (!isDocId(docId)) return docNotFound(docId);

  const parsed = await parsePushBody(request);
  if (!parsed.ok) return parsed.response;

  // Ownership before quota: pushing at a doc that is not yours is not a push,
  // so it must not spend one of today's. `reserveNextVersion` re-checks both
  // atomically, which is what actually guarantees it — this read only fixes
  // which error a rejected push gets.
  if (!(await ownsLiveDoc(env.DB, docId, publisher.id))) {
    return docNotFound(docId);
  }

  const now = Date.now();
  const day = utcDay(now);
  if (!(await reserveDailyPush(env.DB, publisher.id, day))) {
    return dailyQuotaExceeded();
  }

  // Past this point the push is paid for, and a delete can still land at either
  // of the two steps below. Both give the push back: a rejected push costs the
  // caller nothing, which is the same promise the ownership check above makes.
  const version = await reserveNextVersion(env.DB, docId, publisher.id);
  if (version === null) {
    await refundDailyPush(env.DB, publisher.id, day);
    return docNotFound(docId);
  }

  // The doc can still be deleted while this version is being written. Answering
  // 200 would hand back a url that serves 410, so a lost race reads as what it
  // is from the caller's side: the doc is gone.
  if (!(await storeVersion(env, docId, version, parsed.body.html, now))) {
    await refundDailyPush(env.DB, publisher.id, day);
    return docNotFound(docId);
  }

  // Only now: the title and timestamp in "my docs" describe what the public url
  // is serving, so they move after the bytes do, never before.
  await commitVersionMetadata(env.DB, docId, parsed.body.title, now);
  return pushed(env, requestUrl, docId, version, 200);
}
