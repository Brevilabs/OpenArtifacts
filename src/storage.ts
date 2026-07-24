/**
 * The R2 key layout. R2 is the system of record, so this file is the schema of
 * the thing D1 is rebuildable *from*: a key names its doc and its version and
 * nothing else is needed to reconstruct a pointer row.
 *
 * Every object is grouped under one prefix per doc, so deleting a doc is a
 * prefix scan rather than a version-by-version walk of D1.
 *
 * Objects are written exactly once and never rewritten. The version number in
 * the key is minted by an atomic D1 reservation, which is what makes "write
 * before the row exists" safe: two pushes can never target the same key.
 */

/** Root prefix for doc content. Nothing else lives in the bucket. */
const DOCS_PREFIX = "docs/";

/**
 * Every object belonging to one doc. Not exported yet: delete (phase 5) is the
 * first caller that needs it from outside, and it can export it then.
 */
function docObjectPrefix(docId: string): string {
  return `${DOCS_PREFIX}${docId}/`;
}

/**
 * The immutable object holding version `n` of `docId` — `docs/{docId}/v{n}.html`.
 * `n` starts at 1; there is no v0.
 */
export function versionObjectKey(docId: string, n: number): string {
  return `${docObjectPrefix(docId)}v${n}.html`;
}

/**
 * Content type of every stored object. Injection happens at push time (D11), so
 * these bytes are the served bytes and this is the type they are served with.
 */
export const STORED_CONTENT_TYPE = "text/html; charset=utf-8";
