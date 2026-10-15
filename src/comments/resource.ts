/**
 * The threads resource, on the document's own origin:
 *
 * ```
 * GET|HEAD https://openartifacts.site/d/{docId}/threads[?v={n}]            a public document
 * GET|HEAD https://{label}.openartifacts.site/d/{docId}/threads[?v={n}]    an invited-only one, behind the grant cookie
 * ```
 *
 * What the page script will fetch (the in-page experience, a later change),
 * same-origin, to paint highlights and size the margin. It carries no credential and answers no more than the page does: the
 * unauthenticated `ThreadsResponse` (`present.ts`), with display names and no
 * account id, email, viewer or `canResolve`. The same bytes serve every reader,
 * so the author's script, which can read this response, learns nothing about
 * who is looking.
 *
 * Whether the caller may read is the origin's own rule, handed in as `judge`:
 * the apex serves only an `anyone` document and answers `404` for an invited-only
 * one (a JSON fetch cannot follow a sign-in redirect), and a publisher's origin
 * runs the grant, label and `canRead` chain it runs for the page. Here are only
 * the rest: no such version, comments off or unavailable → `404`; deleted →
 * `410`, decided before the version so `?v=` cannot tell a deleted document
 * from one that never had that version.
 *
 * Does not count a view, is `no-store` (threads change), and sets no cookie.
 * Full serving header policy via `servingJson`.
 */
import type { Env } from "../config.js";
import { findCommentableDoc, type CommentableDoc } from "../db.js";
import { readerSignInConfigured } from "../reader-config.js";
import { servingJson } from "../serve.js";
import { commentsStub } from "./access.js";
import type { ThreadRecord } from "./object.js";
import { presentThreads } from "./present.js";
import { VERSION_PARAM } from "./service.js";

/** What the origin's read rule says about the document it found. */
export type Verdict = "ok" | "missing" | "deleted";

/** The `404` every miss shares, so it never says which part missed. */
export const threadsNotFound = (method: string) =>
  servingJson(method, 404, { error: { code: "not_found", message: "No comments for this page." } });

export async function threadsResource(
  env: Env,
  method: string,
  docId: string,
  versionParam: string | null,
  principal: string,
  judge: (doc: CommentableDoc) => Verdict | Promise<Verdict>,
): Promise<Response> {
  // Comments need the reader secret too (`/api/v1` and `/embed/api` answer 404 without it), so a
  // deployment that lost it does not keep serving threads that no other surface will.
  if (env.COMMENTS === undefined || !readerSignInConfigured(env)) return threadsNotFound(method);
  if (versionParam !== null && !VERSION_PARAM.test(versionParam)) return threadsNotFound(method);
  const doc = await findCommentableDoc(env.DB, docId, principal, versionParam === null ? null : Number(versionParam));
  if (doc === null) return threadsNotFound(method);

  const verdict = await judge(doc);
  if (verdict === "deleted") {
    return servingJson(method, 410, { error: { code: "gone", message: "This document was deleted." } });
  }
  if (verdict !== "ok" || doc.comments_enabled !== 1 || doc.version === null) return threadsNotFound(method);

  const listed = await commentsStub(env, docId).list({
    docId,
    version: doc.version,
  });
  if (!listed.ok) return threadsNotFound(method);
  const body = await presentThreads(
    env,
    { docId, title: doc.title, ownerAccount: doc.owner_account },
    { version: listed.version, latestVersion: doc.latest_version, threads: listed.threads as ThreadRecord[] },
    null,
  );
  return servingJson(method, 200, body);
}
