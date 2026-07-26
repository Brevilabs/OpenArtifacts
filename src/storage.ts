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
 * Every object belonging to one doc, and nothing else. Delete lists and drops
 * this prefix rather than walking `versions` row by row, which is what makes
 * "all the bytes are gone" a property of R2's own listing rather than of D1's
 * pointer index being complete.
 */
export function docObjectPrefix(docId: string): string {
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
 * Content type of every stored object, and of every served page. Injection
 * happens on the way out, so the two are not the same bytes — but the transform
 * only adds HTML to HTML, so it is the same type either way.
 */
export const STORED_CONTENT_TYPE = "text/html; charset=utf-8";
