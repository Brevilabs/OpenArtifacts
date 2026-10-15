/**
 * The threads JSON, one shape for every surface that serves it: the serving
 * origin's `/d/{docId}/threads`, `/api/v1/docs/{docId}/threads` and the frame's
 * `/embed/api/docs/{docId}/threads`.
 *
 * The object stores principals; this turns them into the only thing a reader
 * may see, a display name and a kind. **No account id and no email appears in
 * the output**, and `createdBy` / `updatedAt`, which the object returns for the
 * Worker's own use, are dropped here. Names come from one batched D1 read.
 *
 * The authenticated variants add `viewer` and, per thread and comment,
 * `canResolve` and `mine`. The unauthenticated one carries none of them, so the
 * same bytes serve every anonymous reader.
 */
import type { Env } from "../config.js";
import { displayNames } from "../db.js";
import type { Actor, ThreadRecord } from "./object.js";

/** Who is asking, when the surface knows. */
export interface Viewer {
  /** The viewer as comments store a principal; compared with authors, never sent. */
  principalId: string;
  canComment: boolean;
  canManage: boolean;
  name: string | null;
}

export interface Labelled {
  name: string;
  kind: "human" | "agent";
}

/** The account an actor's name is looked up under: a person's own, or the one an agent acts for. */
function nameKey(actor: Actor): string {
  return actor.kind === "agent" ? (actor.onBehalfOf ?? actor.principal) : actor.principal;
}

/**
 * Names for everyone who appears in `threads`. An agent is named after the
 * account it acts for ("Alice's agent"); with no name on file the document's
 * owner's agent is "Owner's agent" and any other is "An agent".
 */
export async function labeller(
  env: Env,
  ownerAccount: string,
  threads: ThreadRecord[],
  extra: string[] = [],
): Promise<(actor: Actor) => Labelled> {
  const ids = new Set(extra);
  for (const thread of threads) {
    for (const comment of thread.comments) ids.add(nameKey(comment.author));
    if (thread.resolution) ids.add(nameKey(thread.resolution.by));
  }
  return labelWith(await displayNames(env.DB, [...ids]), ownerAccount);
}

export function labelWith(names: Map<string, string>, ownerAccount: string): (actor: Actor) => Labelled {
  return (actor) => {
    const name = names.get(nameKey(actor));
    if (actor.kind === "human") return { name: name ?? "Someone", kind: "human" };
    if (name !== undefined) return { name: `${name}'s agent`, kind: "agent" };
    return { name: nameKey(actor) === ownerAccount ? "Owner's agent" : "An agent", kind: "agent" };
  };
}

/** One thread as the wire carries it. */
export function presentThread(thread: ThreadRecord, label: (actor: Actor) => Labelled, viewer: Viewer | null) {
  return {
    threadId: thread.threadId,
    anchor: thread.anchor,
    anchorStatus: thread.anchorStatus,
    matchedText: thread.matchedText,
    createdAtVersion: thread.createdAtVersion,
    createdAt: thread.createdAt,
    state: thread.state,
    resolution:
      thread.resolution === null
        ? null
        : { by: label(thread.resolution.by), atVersion: thread.resolution.atVersion, at: thread.resolution.at },
    comments: thread.comments.map((comment) => ({
      commentId: comment.commentId,
      author: label(comment.author),
      body: comment.body,
      createdAt: comment.createdAt,
      atVersion: comment.atVersion,
      ...(viewer === null ? {} : { mine: comment.author.principal === viewer.principalId }),
    })),
    ...(viewer === null
      ? {}
      : { canResolve: viewer.canManage || (viewer.canComment && thread.createdBy === viewer.principalId) }),
  };
}

/** The `ThreadsResponse`. `version` is the one the anchors were computed for. */
export async function presentThreads(
  env: Env,
  doc: { docId: string; title: string; ownerAccount: string },
  listed: { version: number; latestVersion: number | null; threads: ThreadRecord[] },
  viewer: Viewer | null,
) {
  const label = await labeller(env, doc.ownerAccount, listed.threads);
  return {
    docId: doc.docId,
    title: doc.title,
    version: listed.version,
    latestVersion: listed.latestVersion,
    threads: listed.threads.map((thread) => presentThread(thread, label, viewer)),
    ...(viewer === null ? {} : { viewer: { canComment: viewer.canComment, canManage: viewer.canManage, name: viewer.name } }),
  };
}
