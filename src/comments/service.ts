/**
 * The comment operations: one function per route, each taking the caller as a
 * `Caller` and answering a `Response`.
 *
 * ```
 * GET    …/docs/{docId}/threads?state=&since=&v=      → 200 ThreadsResponse
 * POST   …/docs/{docId}/threads {anchor, body, version?}  → 201 {threadId, commentId, anchorStatus}
 * POST   …/docs/{docId}/threads/{threadId}/comments {body, version?}  → 201 {commentId}
 * POST   …/docs/{docId}/threads/{threadId}/resolve {version?}  → 200 Thread
 * POST   …/docs/{docId}/threads/{threadId}/reopen  {version?}  → 200 Thread
 * DELETE …/docs/{docId}/comments/{commentId}          → 204
 * PUT    …/docs/{docId}/settings {comments}           → 200 {docId, comments}
 * PUT    …/account {displayName}                      → 200 {displayName}
 * ```
 *
 * **One layer, two doors.** `/api/v1` (an account token or a license key, an
 * agent) and `/embed/api` (the frame's per-document token, a person) call
 * these same functions; only the `Caller` differs. The plan gate, the caps, the
 * rate limit, the emails and every status therefore cannot drift between them.
 *
 * **Who decides what** (`access.ts` has the rule). This layer authorises from
 * D1 and derives identity from the credential — the author is never a request
 * field — then hands the object `{principal, kind, onBehalfOf}`. The object
 * enforces what it can see for itself: caps, anchors, author checks, the state
 * machines.
 *
 * **Statuses.** Everything the caller may not see or do is `404`. The two
 * exceptions are only ever given to someone who manages the document:
 * `409 comments_off` and the plan's `402`. Deleting a comment asks for nothing
 * but `canRead` and authorship, so a switch turned off or a plan lapsed never
 * costs anyone the ability to take back what they wrote.
 */
import { mayComment as planAllowsComments } from "../auth.js";
import { setCommentsEnabled, setDisplayName, findManagedDoc } from "../db.js";
import type { Env } from "../config.js";
import type { Publisher } from "../auth.js";
import { docNotFound, errorResponse } from "../errors.js";
import { isDocId } from "../ids.js";
import { sha256Hex } from "../hash.js";
import { withinLimit } from "../limits.js";
import { readBodyWithin } from "../quota.js";
import { readerSignInConfigured } from "../reader-config.js";
import {
  commentsOff,
  commentsPlanRefusal,
  commentsStub,
  NO_STORE,
  ownerHasComments,
  standingOn,
  viewerCanComment,
  type Caller,
  type Standing,
} from "./access.js";
import { notifyComment } from "./notify.js";
import type { ThreadRecord } from "./object.js";
import { labeller, presentThread, presentThreads, type Viewer } from "./present.js";

/** A request body is a few fields; the quote and the text bound it. */
const MAX_REQUEST_BYTES = 32 * 1024;

/** The longest display name, after trimming. */
export const MAX_NAME = 64;

/** Control characters and the two Unicode line separators, which no name has. */
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");

const STATES = new Set(["open", "resolved", "all"]);

/** A version number as a query parameter: positive, no leading zero, nine digits at most. */
export const VERSION_PARAM = /^[1-9][0-9]{0,8}$/;

const bad = (message: string) => errorResponse("bad_request", message, NO_STORE);

/**
 * The body as an object: `{}` for an empty one, null when it is not JSON, not
 * an object, or too big. Callers name the fields they accept.
 */
async function readFields(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await readBodyWithin(request, MAX_REQUEST_BYTES);
  if (raw === null) return null;
  if (raw.byteLength === 0) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Every key of `fields` is one of `allowed`. */
const onlyKeys = (fields: Record<string, unknown>, allowed: string[]) =>
  Object.keys(fields).every((key) => allowed.includes(key));

/** `undefined` when absent, the number when a valid version, null when malformed. */
function versionField(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 999_999_999 ? value : null;
}

/** `GET …/threads?state=&since=&v=`. `caller` is null for an anonymous reader of a public document. */
export async function listThreads(env: Env, url: URL, caller: Caller | null, docId: string): Promise<Response> {
  const state = url.searchParams.get("state") ?? "all";
  if (!STATES.has(state)) return bad('state must be "open", "resolved" or "all".');

  let since: number | undefined;
  const sinceParam = url.searchParams.get("since");
  if (sinceParam !== null) {
    const parsed = /^\d{4}-\d{2}-\d{2}/.test(sinceParam) ? Date.parse(sinceParam) : Number.NaN;
    if (Number.isNaN(parsed)) return bad("since must be an ISO 8601 date or timestamp.");
    since = parsed;
  }

  const versionParam = url.searchParams.get("v");
  if (versionParam !== null && !VERSION_PARAM.test(versionParam)) return bad("v must be a version number.");
  const pinned = versionParam === null ? null : Number(versionParam);

  const standing = await standingOn(env, docId, caller, pinned);
  if (standing === null) return docNotFound(docId);
  if (standing.doc.comments_enabled !== 1) return commentsOff(standing, docId);
  // The newest version that has bytes, or the one asked for; none means there is no such page to anchor to.
  if (standing.doc.version === null) return docNotFound(docId);

  const listed = await commentsStub(env, docId).list({
    docId,
    version: standing.doc.version,
    state: state as "open" | "resolved" | "all",
    since,
  });
  if (!listed.ok) return docNotFound(docId);

  const viewer = caller === null ? null : await viewerOf(env, standing, Date.now());
  const body = await presentThreads(
    env,
    { docId, title: standing.doc.title, ownerAccount: standing.doc.owner_account },
    { version: listed.version, latestVersion: standing.doc.latest_version, threads: listed.threads as ThreadRecord[] },
    viewer,
  );
  return Response.json(body, { headers: NO_STORE });
}

async function viewerOf(env: Env, standing: Standing, now: number): Promise<Viewer> {
  return {
    scope: standing.scope,
    canManage: standing.canManage,
    canComment: await viewerCanComment(env, standing, now),
    name: standing.doc.viewer_name,
  };
}

/**
 * Everything a write has to clear before the object is asked: readable, comments
 * on, the role allows writing, the owner's plan has comments, a person has a
 * name, and the principal is under the rate limit. The limit comes last so a
 * write refused by these gates never spends it; one refused after it, for its
 * content (see `docs/http-api.md`), has.
 */
async function authoriseWrite(env: Env, docId: string, caller: Caller, now: number): Promise<Standing | Response> {
  const standing = await standingOn(env, docId, caller);
  if (standing === null) return docNotFound(docId);
  if (standing.doc.comments_enabled !== 1) return commentsOff(standing, docId);
  if (!standing.mayWrite) return docNotFound(docId);
  if (!(await ownerHasComments(env, standing.doc.owner, now))) {
    return standing.canManage ? commentsPlanRefusal(env, caller.publisher) : docNotFound(docId);
  }
  // A person is named on their cards; an agent is named after the person it acts for.
  if (caller.kind === "human" && standing.doc.viewer_name === null) {
    return errorResponse("name_required", "Choose a display name before commenting.", NO_STORE);
  }
  if (!(await withinLimit(env.COMMENT_WRITE_LIMITER, await sha256Hex(`comment:${standing.doc.principal_id}`)))) {
    return errorResponse("quota_exceeded", "Too many comments. Try again in a minute.", {
      ...NO_STORE,
      "retry-after": "60",
    });
  }
  return standing;
}

/** The version a write is for: the one the writer was reading, else the newest. Null when it does not exist. */
function writeVersion(requested: number | undefined, standing: Standing): number | null {
  const latest = standing.doc.latest_version;
  if (latest === null) return null;
  const version = requested ?? latest;
  return version <= latest ? version : null;
}

/** The writer, as the object stores it. */
function writer(standing: Standing, caller: Caller) {
  return {
    principal: standing.doc.principal_id,
    kind: caller.kind,
    onBehalfOf: caller.kind === "agent" ? standing.doc.principal_id : null,
  };
}

type Failed = { ok: false; reason: string };

/** An object refusal as the status the contract gives it. */
function refusal(result: Failed, caller: Caller, version?: number): Response {
  switch (result.reason) {
    case "invalid_anchor":
      return bad("anchor must be {exact, prefix?, suffix?, section?} with exact 1 to 1,000 characters.");
    case "invalid_body":
      return bad("body must be 1 to 4,000 characters.");
    case "anchor_not_found":
      return errorResponse(
        "anchor_not_found",
        `That text is not in version ${version}. Quote it exactly as that version reads.`,
        NO_STORE,
      );
    case "limit_threads":
      return errorResponse("limit_reached", "This document has the most threads it can hold (500).", NO_STORE, {
        plan: caller.publisher.plan,
        limit: "threads",
      });
    case "limit_comments":
      return errorResponse("limit_reached", "This document has the most comments it can hold (2,000).", NO_STORE, {
        plan: caller.publisher.plan,
        limit: "comments",
      });
    default:
      // thread_not_found, comment_not_found, version_not_found and forbidden: all `404`, never `403`.
      return errorResponse("not_found", "No such thread, comment or version.", NO_STORE);
  }
}

/** `POST …/threads`. */
export async function createThread(
  request: Request,
  url: URL,
  env: Env,
  caller: Caller,
  docId: string,
): Promise<Response> {
  const fields = await readFields(request);
  if (fields === null || !onlyKeys(fields, ["anchor", "body", "version"])) {
    return bad('Expected {"anchor": {...}, "body": "…", "version"?: n}.');
  }
  const requested = versionField(fields.version);
  if (requested === null || typeof fields.body !== "string" || typeof fields.anchor !== "object" || fields.anchor === null) {
    return bad('Expected {"anchor": {...}, "body": "…", "version"?: n}.');
  }

  const now = Date.now();
  const standing = await authoriseWrite(env, docId, caller, now);
  if (standing instanceof Response) return standing;
  const version = writeVersion(requested, standing);
  if (version === null) return docNotFound(docId);

  const result = await commentsStub(env, docId).createThread({
    docId,
    ...writer(standing, caller),
    anchor: fields.anchor as never,
    body: fields.body,
    version,
  });
  if (!result.ok) return refusal(result, caller, version);

  caller.ctx.waitUntil(
    notifyComment(env, url, {
      event: "thread",
      docId,
      doc: standing.doc,
      actor: { principal: standing.doc.principal_id, kind: caller.kind },
      thread: result.thread as ThreadRecord,
      text: fields.body.trim(),
      version,
    }),
  );
  return Response.json(
    { threadId: result.threadId, commentId: result.commentId, anchorStatus: result.anchorStatus },
    { status: 201, headers: NO_STORE },
  );
}

/** `POST …/threads/{threadId}/comments`. */
export async function replyToThread(
  request: Request,
  url: URL,
  env: Env,
  caller: Caller,
  docId: string,
  threadId: string,
): Promise<Response> {
  const fields = await readFields(request);
  if (fields === null || !onlyKeys(fields, ["body", "version"])) return bad('Expected {"body": "…"}.');
  const requested = versionField(fields.version);
  if (requested === null || typeof fields.body !== "string") return bad('Expected {"body": "…"}.');

  const now = Date.now();
  const standing = await authoriseWrite(env, docId, caller, now);
  if (standing instanceof Response) return standing;
  const version = writeVersion(requested, standing);
  if (version === null) return docNotFound(docId);

  const result = await commentsStub(env, docId).reply({
    docId,
    ...writer(standing, caller),
    threadId,
    body: fields.body,
    version,
  });
  if (!result.ok) return refusal(result, caller, version);

  caller.ctx.waitUntil(
    notifyComment(env, url, {
      event: "reply",
      docId,
      doc: standing.doc,
      actor: { principal: standing.doc.principal_id, kind: caller.kind },
      thread: result.thread as ThreadRecord,
      text: fields.body.trim(),
      version,
    }),
  );
  return Response.json({ commentId: result.commentId }, { status: 201, headers: NO_STORE });
}

/**
 * `POST …/threads/{threadId}/resolve` and `…/reopen`. The owner, or the
 * thread's author while they can still comment; anyone else, and every id that
 * is not a thread, is `404`. Both are idempotent and answer the thread either way.
 */
export async function changeThreadState(
  request: Request,
  url: URL,
  env: Env,
  caller: Caller,
  docId: string,
  threadId: string,
  to: "resolve" | "reopen",
): Promise<Response> {
  const fields = await readFields(request);
  if (fields === null || !onlyKeys(fields, ["version"])) return bad('Expected {"version"?: n} or no body.');
  const requested = versionField(fields.version);
  if (requested === null) return bad("version must be a version number.");

  const now = Date.now();
  const standing = await authoriseWrite(env, docId, caller, now);
  if (standing instanceof Response) return standing;
  const version = writeVersion(requested, standing);
  if (version === null) return docNotFound(docId);

  const result = await commentsStub(env, docId)[to]({
    docId,
    ...writer(standing, caller),
    threadId,
    isOwner: standing.canManage,
    scope: standing.scope,
    version,
  });
  if (!result.ok) return refusal(result, caller, version);

  const thread = result.thread as ThreadRecord;
  if (result.changed && to === "resolve") {
    caller.ctx.waitUntil(
      notifyComment(env, url, {
        event: "resolved",
        docId,
        doc: standing.doc,
        actor: { principal: standing.doc.principal_id, kind: caller.kind },
        thread,
        text: null,
        version,
      }),
    );
  }
  const viewer: Viewer = {
    scope: standing.scope,
    canManage: standing.canManage,
    canComment: true,
    name: standing.doc.viewer_name,
  };
  const label = await labeller(env, standing.doc.owner_account, [thread]);
  return Response.json(presentThread(thread, label, viewer), { headers: NO_STORE });
}

/** `DELETE …/comments/{commentId}`: the author's own, on any document they can read. */
export async function deleteComment(env: Env, caller: Caller, docId: string, commentId: string): Promise<Response> {
  const standing = await standingOn(env, docId, caller);
  if (standing === null) return docNotFound(docId);
  const result = await commentsStub(env, docId).deleteComment({
    docId,
    commentId,
    scope: standing.scope,
  });
  // Someone else's comment answers exactly like a missing one.
  if (!result.ok) return errorResponse("not_found", "No such comment.", NO_STORE);
  return new Response(null, { status: 204, headers: NO_STORE });
}

/**
 * `PUT …/settings {comments}`: the owner's switch. Turning it on needs a plan
 * with comments (`402 limit_reached`, `limit: "comments"`); turning it off never
 * does, and deletes nothing. Naming the state it already has is a repeat.
 */
export async function setComments(request: Request, env: Env, caller: Caller, docId: string): Promise<Response> {
  const fields = await readFields(request);
  if (fields === null || !onlyKeys(fields, ["comments"]) || typeof fields.comments !== "boolean") {
    return bad('Expected {"comments": true | false}.');
  }
  return await switchComments(env, caller.publisher, docId, fields.comments);
}

/**
 * The switch itself, for a caller that has already read its request: the API
 * routes above and the share page's form, which must refuse and answer exactly
 * as they do.
 */
export async function switchComments(env: Env, publisher: Publisher, docId: string, on: boolean): Promise<Response> {
  if (!isDocId(docId) || env.COMMENTS === undefined) return docNotFound(docId);
  if ((await findManagedDoc(env.DB, docId, publisher.owner)) === null) return docNotFound(docId);
  if (on && !planAllowsComments(env, publisher)) return commentsPlanRefusal(env, publisher);
  await setCommentsEnabled(env.DB, docId, publisher.owner, on);
  return Response.json({ docId, comments: on }, { headers: NO_STORE });
}

/**
 * `PUT …/account {displayName}`: the name cards show for this account, trimmed,
 * 1 to 64 characters with no control characters. `owner` is a license key's
 * owner id too, which names the account it is linked to; one with no account
 * has nothing to name and answers `404`.
 */
export async function setName(request: Request, env: Env, owner: string): Promise<Response> {
  // A display name is only ever shown on a comment, so a deployment without comments (or without
  // the reader sign-in they need) has no such route.
  if (env.COMMENTS === undefined || !readerSignInConfigured(env)) return errorResponse("not_found", "No route.", NO_STORE);
  const fields = await readFields(request);
  if (fields === null || !onlyKeys(fields, ["displayName"]) || typeof fields.displayName !== "string") {
    return bad('Expected {"displayName": "…"}.');
  }
  const name = fields.displayName.normalize("NFC").trim();
  if (name.length < 1 || name.length > MAX_NAME || CONTROL.test(name)) {
    return bad(`displayName must be 1 to ${MAX_NAME} characters with no control characters.`);
  }
  if (!(await setDisplayName(env.DB, owner, name))) {
    return errorResponse("not_found", "This credential has no account to name. Sign in to link one.", NO_STORE);
  }
  return Response.json({ displayName: name }, { headers: NO_STORE });
}
