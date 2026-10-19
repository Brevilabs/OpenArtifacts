/**
 * Where things live in a url: the path prefixes of the serving host and of the
 * API host's reader surface, and the reading and writing of a document's path.
 *
 * A leaf, importing only `ids.ts`. The signed values in `session.ts` need to
 * read a return path and the pages and routes need the same prefixes, so they
 * all import downward from here rather than `session.ts` reaching up into the
 * pages (`reader-pages.ts`, with the scripts it embeds) or the serving module.
 */
import { isDocId } from "./ids.js";

/** Path prefix of the serving surface, used by the router's path fallback. */
export const SERVING_PREFIX = "/d";

/** The door a private document opens through, on the API host. */
export const OPEN_PREFIX = "/open";

export const SIGNIN_PREFIX = "/signin";

/** The share page, where an owner manages one document: `/share/{docId}`. */
export const SHARE_PREFIX = "/share";

/** Home, the signed-in owner's list of their pages: `GET /home` on the API host. */
export const HOME_PATH = "/home";

/**
 * Everything the top bar's Share button needs from the API host: the page
 * script, the popover frame, its sign-in popup and the routes the frame calls.
 * Not a client surface.
 */
export const EMBED_PREFIX = "/embed";

/** The script every served page loads. Permanent: pinned pages carry the tag for a year. */
export const PAGE_SCRIPT_PATH = "/embed/page.js";

/** The Share popover's frame, `GET /embed/share?doc={docId}&origin=…`. */
export const EMBED_SHARE_PATH = "/embed/share";

/** The comments frame, `GET /embed/comments?doc={docId}&origin=…[&v={n}]`. */
export const EMBED_COMMENTS_PATH = "/embed/comments";

/** The popover's sign-in popup, `GET /embed/sign-in?doc={docId}&h=…`. */
export const EMBED_SIGNIN_PATH = "/embed/sign-in";

/** The frame's claim of its token, `POST /embed/token`. */
export const EMBED_TOKEN_PATH = "/embed/token";

/** The frame's JSON routes: `/embed/api/docs/{docId}/access…`. */
export const EMBED_API_PREFIX = "/embed/api";

/**
 * `v` then a decimal with no leading zeros, so one version has exactly one url.
 * Bounded at nine digits: the number only ever reaches R2 as part of a key, and
 * a bound here means no unbounded digit string ever becomes a `Number`.
 */
const VERSION_SEGMENT = /^v([1-9][0-9]{0,8})$/;

export interface DocRoute {
  docId: string;
  /** The version from `/v{n}`, or null for the latest-version url. */
  pinned: number | null;
}

/** `{prefix}/{docId}` or `{prefix}/{docId}/v{n}`, the inverse of `parseDocPath`. */
export function docPath(prefix: string, route: DocRoute): string {
  return `${prefix}/${route.docId}${route.pinned === null ? "" : `/v${route.pinned}`}`;
}

/**
 * Parse `/d/{docId}` and `/d/{docId}/v{n}` (or the same under another prefix,
 * which is how `/open/…` on the API host is read), or null for anything else.
 *
 * The prefix is matched rather than sliced off blind: on the serving host every
 * path lands here, so `/dx{docId}` reaches this function too and must not be
 * mistaken for a doc url.
 *
 * `isDocId` runs before anything else touches the database (phase 1), so junk
 * and crawler noise cost a regex rather than a D1 read.
 */
export function parseDocPath(pathname: string, prefix: string = SERVING_PREFIX): DocRoute | null {
  if (!pathname.startsWith(`${prefix}/`)) return null;

  const segments = pathname.slice(prefix.length + 1).split("/");
  // `/d/{docId}/` is the same page as `/d/{docId}`; a trailing slash is a
  // browser and copy-paste artifact, not a different resource.
  if (segments.length > 1 && segments.at(-1) === "") segments.pop();

  const [docId, versionSegment, ...extra] = segments;
  if (docId === undefined || extra.length > 0) return null;
  if (!isDocId(docId)) return null;
  if (versionSegment === undefined) return { docId, pinned: null };

  const digits = VERSION_SEGMENT.exec(versionSegment)?.[1];
  return digits === undefined ? null : { docId, pinned: Number(digits) };
}

/**
 * `{prefix}/{docId}/threads`, the comments resource, or null for any other
 * path. A separate matcher because `parseDocPath` reads the second segment as a
 * version and returns null for this one.
 */
export function parseThreadsPath(pathname: string, prefix: string = SERVING_PREFIX): string | null {
  if (!pathname.startsWith(`${prefix}/`)) return null;
  const segments = pathname.slice(prefix.length + 1).split("/");
  if (segments.length === 3 && segments[2] === "") segments.pop();
  const [docId, resource, ...extra] = segments;
  return docId !== undefined && resource === "threads" && extra.length === 0 && isDocId(docId) ? docId : null;
}
