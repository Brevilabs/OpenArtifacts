/**
 * The comment routes under a document, as path segments after its id. The
 * same table serves `/api/v1/docs/{docId}/…` and `/embed/api/docs/{docId}/…`:
 *
 * ```
 * threads                          GET, POST
 * threads/{threadId}/comments      POST
 * threads/{threadId}/resolve       POST
 * threads/{threadId}/reopen        POST
 * comments/{commentId}             DELETE
 * settings                         PUT
 * ```
 *
 * Null means the segments are none of these, and the caller answers its own
 * not-found. A shape check on the ids comes first, so a junk id costs a regex
 * and not an object. On a deployment with no `COMMENTS` binding every one of
 * these routes is `404` before its body, query or ids are looked at, as on a
 * Worker that predates comments. (The anonymous list in the embed family does not
 * come through here: it calls `listThreads` itself.)
 */
import type { Env } from "../config.js";
import { docNotFound } from "../errors.js";
import type { Caller } from "./access.js";
import {
  changeThreadState,
  createThread,
  deleteComment,
  listThreads,
  replyToThread,
  setComments,
} from "./service.js";

const THREAD_ID = /^th_[0-9a-z]{1,64}$/;
const COMMENT_ID = /^cm_[0-9a-z]{1,64}$/;

export async function commentRoute(
  request: Request,
  url: URL,
  env: Env,
  caller: Caller,
  docId: string,
  extra: string[],
): Promise<Response | null> {
  const [section, id, action, ...rest] = extra;
  const method = request.method;
  if (rest.length > 0) return null;

  const listing = section === "threads" && id === undefined && method === "GET";
  const threads = section === "threads" && id === undefined && method === "POST";
  const onThread =
    section === "threads" && id !== undefined && method === "POST" &&
    (action === "comments" || action === "resolve" || action === "reopen");
  const comment = section === "comments" && id !== undefined && action === undefined && method === "DELETE";
  const settings = section === "settings" && id === undefined && method === "PUT";
  if (!listing && !threads && !onThread && !comment && !settings) return null;

  if (env.COMMENTS === undefined) return docNotFound(docId);

  if (listing) return await listThreads(env, url, caller, docId);
  if (threads) return await createThread(request, url, env, caller, docId);
  if (settings) return await setComments(request, env, caller, docId);
  if (comment) {
    return COMMENT_ID.test(id!) ? await deleteComment(env, caller, docId, id!) : docNotFound(docId);
  }
  if (!THREAD_ID.test(id!)) return docNotFound(docId);
  return action === "comments"
    ? await replyToThread(request, url, env, caller, docId, id!)
    : await changeThreadState(request, url, env, caller, docId, id!, action as "resolve" | "reopen");
}
