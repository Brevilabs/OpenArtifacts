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
 * against the account's doc ceiling. Only an R2 or D1 failure produces one, and the
 * alternative — inserting the row after the write — would hand out a url before
 * anything pointed at it. Rolling the row back is deliberately not attempted:
 * the failure may equally be the version insert *after* a successful write, and
 * a rollback there would strand the object it names.
 *
 * Both paths record their outcome last, and with the same `now` the rows carry
 * rather than a fresh clock read, so a push and the event describing it cannot
 * fall on opposite sides of an interval boundary.
 *
 * Which outcome is a question about the `versions` table, not about which verb
 * was used: `document_published` names the push that stored a doc's first
 * version, and a `PUT` is that push whenever a create left a row behind without
 * one. `insertVersion` answers it as part of the write.
 *
 * `ownerId` is the canonical account the doc belongs to, which the same
 * statement that authorized the push already resolved. It is derived from a
 * validated credential and from nothing else — `docs/identity.md` makes that
 * the only admissible source, and no request field could supply one. It is not
 * `publisher.owner` verbatim, because that is the id of the *credential*: a
 * license key and an account token linked to one another deliberately resolve
 * to two different ids there, and one publisher must not become two.
 */
import type { AnalyticsSink } from "../analytics.js";
import type { Publisher } from "../auth.js";
import { MAX_DOCS_PER_PUBLISHER, MAX_DOC_BYTES, MAX_PUSHES_PER_DAY } from "../config.js";
import { limitReached, planLimits, type PlanLimits } from "../plans.js";
import type { Env } from "../config.js";
import {
  rollbackCreate,
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

import { STORED_CONTENT_TYPE, versionObjectKey } from "../storage.js";
import { reserveStorage, releaseStorage } from "../storage-quota.js";
import { publicDocUrl } from "../urls.js";

/** Titles are display strings in a list, not documents; long ones are noise. */
const MAX_TITLE_LENGTH = 512;

/** A push with no usable title still publishes. Naming is not a gate. */
const DEFAULT_TITLE = "Untitled";

interface PushBody {
  /**
   * The title the push asked for: a string, `null` when the field was present
   * but blank, and `undefined` when it was absent.
   *
   * Those last two are kept apart on purpose. Absence is the only signal that
   * means "keep the doc's current title"; a blank string is not a title, and
   * becomes `Untitled` on create and update alike. Collapsing them would make
   * `""` mean one thing to POST and another to PUT.
   */
  title: string | null | undefined;
  html: string;
  htmlBytes: number;
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

  const fields = parsed as Record<string, unknown>;
  const { html } = fields;
  const titleGiven = "title" in fields;
  const title = fields.title;

  // HTML only, and only from the client (D5). There is no markdown branch to
  // fall back to, so an empty or absent field is a client bug worth surfacing.
  if (typeof html !== "string" || html.length === 0) {
    return {
      ok: false,
      response: errorResponse("bad_request", "`html` must be a non-empty string."),
    };
  }
  const htmlBytes = utf8Length(html);
  if (htmlBytes > MAX_DOC_BYTES) {
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
    body: {
      // `null` for a present-but-blank title, `undefined` for an absent one.
      title: titleGiven ? (typeof title === "string" ? normalizeTitle(title) : null) : undefined,
      html,
      htmlBytes,
    },
  };
}

function dailyQuotaExceeded(env: Env, publisher: Publisher, limits: PlanLimits | null): Response {
  const message = `You have used all ${limits?.pushesPerDay ?? MAX_PUSHES_PER_DAY} of today's pushes. Try again tomorrow (UTC).`;
  return limits ? limitReached(env, publisher, "pushesPerDay", message) : errorResponse("quota_exceeded", message);
}

function planHtmlExceeded(env: Env, publisher: Publisher, limits: PlanLimits): Response {
  return limitReached(env, publisher, "htmlBytes", `Your plan allows ${limits.htmlBytes} bytes of HTML per document.`);
}

/**
 * What a push did with its bytes. `firstVersion` is the fact the publication
 * outcome turns on: this store is what made the doc a page, rather than a new
 * version of one that already was.
 */
type StoreOutcome =
  | { stored: true; firstVersion: boolean }
  | { stored: false; reason: "deleted" | "full" };

/**
 * Store, record — in that order, for the reasons at the top of the file.
 *
 * The version number is already reserved by the time this runs, so the key it
 * writes cannot collide with another push and the object it writes is never
 * read back or rewritten.
 *
 * Distinguishes a full allowance from a concurrent withdrawal.
 */
async function storeVersion(
  env: Env,
  docId: string,
  version: number,
  html: string,
  title: string | null,
  atMs: number,
  publisher: Publisher,
  limits: PlanLimits | null,
): Promise<StoreOutcome> {
  // The publisher's own bytes, unmodified. OpenArtifacts' additions go in when the
  // document is served, so a byline change — or a plan that removes one —
  // reaches documents already published. `size` is therefore the size of what
  // the publisher sent, not of what a reader receives.
  const bytes = new TextEncoder().encode(html);
  const key = versionObjectKey(docId, version);

  if (!(await reserveStorage(env.DB, publisher.owner, docId, version, bytes.byteLength, limits?.storageBytes))) {
    return { stored: false, reason: "full" };
  }
  // An uncertain put/metadata failure keeps the reservation until reconciliation.
  await env.DOCS.put(key, bytes, {
    httpMetadata: { contentType: STORED_CONTENT_TYPE },
  });

  const firstVersion = await insertVersion(env.DB, {
    doc_id: docId,
    n: version,
    size: bytes.byteLength,
    // What this push asked the doc to be called. Null means it asked for
    // nothing, which is how the doc's title survives a push that omits one.
    title,
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
    await releaseStorage(env.DB, docId, [version]);
    return { stored: false, reason: "deleted" };
  }

  return { stored: true, firstVersion };
}

function storageFull(env: Env, publisher: Publisher, limits: PlanLimits): Response {
  return limitReached(env, publisher, "storageBytes",
    `Your ${limits.storageBytes} byte storage allowance is full, including retained versions and pending uploads. Unshare documents to free space. Existing pages remain available.`);
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
  analytics: AnalyticsSink,
): Promise<Response> {
  const limits = publisher.authKind === "account" ? planLimits(env, publisher.plan) : null;
  const parsed = await parsePushBody(request);
  if (!parsed.ok) return parsed.response;
  if (limits && parsed.body.htmlBytes > limits.htmlBytes) {
    return planHtmlExceeded(env, publisher, limits);
  }

  const maxDocs = limits?.documents ?? MAX_DOCS_PER_PUBLISHER;
  const now = Date.now();
  // A create always names the doc something: absent and blank alike land on the
  // default rather than leaving it nameless in the list.
  const title = parsed.body.title ?? DEFAULT_TITLE;

  // Capacity before the daily counter, so a publisher who is out of room does
  // not also lose a push from today's allowance for a doc that was never made.
  // The check lives inside the insert: counting first and inserting after would
  // let concurrent creates all read the same count and all proceed, so the
  // documented ceiling would hold only for callers who push one at a time.
  const docId = newDocId();
  const owner = await insertDocWithinQuota(
    env.DB,
    {
      id: docId,
      owner: publisher.owner,
      title,
      created_at: now,
      updated_at: now,
    },
    maxDocs,
  );
  if (owner === null) {
    if (limits) {
      return limitReached(
        env, publisher, "documents",
        `Your account can hold ${maxDocs} published ${maxDocs === 1 ? "document" : "documents"}. Unshare enough documents to get below this limit before publishing another.`,
      );
    }
    return errorResponse(
      "quota_exceeded",
      `You are holding ${MAX_DOCS_PER_PUBLISHER} docs. Delete one to publish another.`,
    );
  }

  const day = utcDay(now);
  if (!(await reserveDailyPush(env.DB, publisher.owner, day, limits?.pushesPerDay))) {
    await rollbackCreate(env.DB, docId);
    return dailyQuotaExceeded(env, publisher, limits);
  }

  // A create is deletable before it answers: the row is visible to this
  // publisher's own list the moment it is inserted, so they can delete the doc
  // while its first version is still being written. Same answer as an update
  // that loses that race — the doc is gone, and the push is given back rather
  // than spent on a url that would serve 410.
  const result = await storeVersion(env, docId, FIRST_VERSION, parsed.body.html, title, now, publisher, limits);
  if (!result.stored) {
    await refundDailyPush(env.DB, publisher.owner, day);
    if (result.reason === "full") {
      await rollbackCreate(env.DB, docId);
      return storageFull(env, publisher, limits!);
    }
    return docNotFound(docId);
  }

  // The doc becomes a published page here and not a line earlier: `storeVersion`
  // is the first step whose success cannot be undone by the ones around it, and
  // the url is handed over on the next line.
  //
  // Unconditionally `document_published`, and it cannot be a second one for this
  // doc: `docId` was minted from 80 fresh CSPRNG bits in this request and
  // inserted under the `docs` primary key, so reaching this line means no row —
  // and therefore no version of it — existed before. `result.firstVersion` says
  // the same thing; the update path is where it is load-bearing, because there a
  // doc that already exists may still have no version.
  analytics.record({ name: "document_published", docId, atMs: now, ownerId: owner });
  return pushed(env, requestUrl, docId, FIRST_VERSION, 201);
}

export async function updateDoc(
  request: Request,
  requestUrl: URL,
  env: Env,
  publisher: Publisher,
  docId: string,
  analytics: AnalyticsSink,
): Promise<Response> {
  // An id that cannot exist is answered without touching D1.
  if (!isDocId(docId)) return docNotFound(docId);

  const limits = publisher.authKind === "account" ? planLimits(env, publisher.plan) : null;
  const parsed = await parsePushBody(request);
  if (!parsed.ok) return parsed.response;

  // Ownership before quota: pushing at a doc that is not yours is not a push,
  // so it must not spend one of today's. `reserveNextVersion` re-checks both
  // atomically, which is what actually guarantees it — this read only fixes
  // which error a rejected push gets.
  if (!(await ownsLiveDoc(env.DB, docId, publisher.owner))) {
    return docNotFound(docId);
  }
  if (limits && parsed.body.htmlBytes > limits.htmlBytes) {
    return planHtmlExceeded(env, publisher, limits);
  }

  const now = Date.now();
  const day = utcDay(now);
  if (!(await reserveDailyPush(env.DB, publisher.owner, day, limits?.pushesPerDay))) {
    return dailyQuotaExceeded(env, publisher, limits);
  }

  // Past this point the push is paid for, and a delete can still land at either
  // of the two steps below. Both give the push back: a rejected push costs the
  // caller nothing, which is the same promise the ownership check above makes.
  const reserved = await reserveNextVersion(env.DB, docId, publisher.owner);
  if (reserved === null) {
    await refundDailyPush(env.DB, publisher.owner, day);
    return docNotFound(docId);
  }
  const version = reserved.version;

  // Absent title keeps the doc's current one; a blank one resets it, same as on
  // create. The version row records which of those this push asked for, so the
  // doc's title resolves by version number rather than by commit order.
  const title = parsed.body.title === undefined ? null : (parsed.body.title ?? DEFAULT_TITLE);

  // The doc can still be deleted while this version is being written. Answering
  // 200 would hand back a url that serves 410, so a lost race reads as what it
  // is from the caller's side: the doc is gone.
  const result = await storeVersion(env, docId, version, parsed.body.html, title, now, publisher, limits);
  if (!result.stored) {
    await refundDailyPush(env.DB, publisher.owner, day);
    return result.reason === "full" ? storageFull(env, publisher, limits!) : docNotFound(docId);
  }

  // Only now: the title and timestamp in "my docs" describe what the public url
  // is serving, so they move after the bytes do, never before.
  await commitVersionMetadata(env.DB, docId, version, now);

  // A name of its own, never a second `document_published`. A page pushed twenty
  // times is one page, and the epic's "new pages published" counts first
  // publications alone — emitting the same name twice would make one diligent
  // author indistinguishable from twenty documents that do not exist.
  //
  // Which is exactly why the *first* one cannot be assumed to have happened. A
  // create that died between inserting its `docs` row and writing version 1
  // leaves a row this publisher can see in their own list and push to, and this
  // push stores the doc's first bytes — its first moment of being readable by
  // anyone — under version 2. Calling that an update would hand the internet a
  // new page and leave it out of the count of new pages. `firstVersion` is the
  // `versions` table's own answer, taken inside the insert that settles it, so
  // two pushes racing at such a doc produce exactly one publication between
  // them whichever order they land in.
  analytics.record({
    name: result.firstVersion ? "document_published" : "document_updated",
    docId,
    atMs: now,
    ownerId: reserved.owner,
  });
  return pushed(env, requestUrl, docId, version, 200);
}
