/**
 * What the two frames on the API host (the Share popover's, `/embed/share`, and
 * the comments margin's, `/embed/comments`) share: which origin may embed them,
 * and the policy that says so.
 *
 * **The frame reveals nothing to a non-reader.** Anyone can load either with any
 * id, and until a token proves the viewer can read the document the body is the
 * same bytes for a public, an invited-only, an unknown and a deleted document.
 * The one thing that varies is `frame-ancestors`, and with it `data-origin` (the
 * target of the frame's `postMessage`). The lookup here decides only that: the
 * document's serving origin is `https://{SERVING_HOST}` when it is live and
 * public, its publisher's `https://{label}.{SERVING_HOST}` when it is live and
 * invited-only, and none otherwise. The frame may be embedded only by that
 * origin, and the policy echoes the caller's own `origin` parameter only when it
 * equals it, so the header tells a caller nothing it did not already name. (The
 * parameter is why: the request is anonymous and serving pages send
 * `no-referrer`, so the server cannot see the embedder, and a header derived
 * from the row alone would publish an invited-only document's label origin to
 * anyone holding the link.) The browser checks the policy against the real
 * ancestor, so a forged parameter frames nothing. A private document's frames
 * can therefore be embedded only by its own publisher's pages, never by another
 * publisher's. Residual, accepted: someone who already knows a label and holds a
 * link can confirm the pairing.
 */
import type { Env } from "./config.js";
import { findReadableDoc } from "./db.js";
import { isDocId } from "./ids.js";
import { publisherOrigin } from "./private.js";

export interface FrameContext {
  doc: string;
  /** The embedder's origin when it is the document's own serving origin, else null. */
  origin: string | null;
}

/** The document and the embedder the request names, or null for a malformed id. */
export async function frameContext(url: URL, env: Env): Promise<FrameContext | null> {
  const doc = url.searchParams.get("doc");
  if (doc === null || !isDocId(doc)) return null;

  const row = await findReadableDoc(env.DB, doc, null, "");
  const live = row !== null && row.deleted_at === null;
  const serving = !live
    ? null
    : row.link_access === "anyone"
      ? env.SERVING_HOST?.trim()
        ? `https://${env.SERVING_HOST.trim()}`
        : null
      : ((await publisherOrigin(env, row.owner))?.origin ?? null);
  const servingOrigin = serving?.toLowerCase() ?? null;
  const matched = servingOrigin !== null && (url.searchParams.get("origin") ?? "").toLowerCase() === servingOrigin;
  return { doc, origin: matched ? servingOrigin : null };
}

/** The headers every frame shell carries; `scriptSource` is its one inline script's hash source. */
export function frameHeaders(scriptSource: string, origin: string | null): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // Not `no-referrer`: a Safari from before WebKit bug 256472 was fixed
    // derived `Sec-Fetch-Site` from the referrer, and would send `none` on the
    // popup navigation, which the popup refuses. It also keeps a real `Origin`
    // on the frame's writes.
    "referrer-policy": "same-origin",
    "content-security-policy":
      `default-src 'none'; script-src ${scriptSource}; style-src 'unsafe-inline'; img-src data:; ` +
      `connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin ?? "'none'"}`,
  };
}
