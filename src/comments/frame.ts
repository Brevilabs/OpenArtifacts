/**
 * `GET /embed/comments?doc={docId}&origin={embedder's origin}[&v={n}]`: the
 * comments frame (the sidebar, or the bottom sheet), the page that draws the comment cards and holds the only
 * credential a reader writes with.
 *
 * Built exactly as the Share popover's is (`embed.ts` `shareFrame`): one shell
 * for every document id and every viewer, a strict policy that names its one
 * inline script by hash, `frame-ancestors` set to the document's own serving
 * origin and `'none'` for anything else (`frameContext`). The body carries the
 * id and the embedder's origin and nothing else, so a non-reader, a reader and a
 * visitor to a deleted or unknown id are told the same thing until a token is
 * used; the cards, the title and the viewer's name all arrive afterwards from
 * `/embed/api/…`. `v` and the rest of the query are read by the script from its
 * own address, not rendered.
 *
 * The route is absent (the reader pages' not-found) on a server whose Worker has
 * no `COMMENTS` binding, as every comment route is, so a self-hoster on an old
 * configuration never serves a frame that cannot work. Without reader sign-in
 * the router has no `/embed/*` at all.
 */
import type { Env } from "../config.js";
import { COMMENTS_FRAME_CSS, COMMENTS_FRAME_SCRIPT } from "../comments-scripts.js";
import { frameContext, frameHeaders } from "../frame-shell.js";
import { scriptHashSource } from "../hash.js";
import { escapeHtml } from "../page.js";
import { READER_NOT_FOUND } from "../reader-pages.js";

let scriptSource: Promise<string> | undefined;

/** The frame's `script-src` source, memoised: the script is a constant. */
function commentsScriptHash(): Promise<string> {
  scriptSource ??= scriptHashSource(COMMENTS_FRAME_SCRIPT);
  return scriptSource;
}

export async function commentsFrame(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== "GET" || env.COMMENTS === undefined) return READER_NOT_FOUND();
  const context = await frameContext(url, env);
  if (context === null) return READER_NOT_FOUND();
  const { doc, origin } = context;

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Comments · OpenArtifacts</title>
<style>${COMMENTS_FRAME_CSS}</style>
</head>
<body>
<main class="margin" data-doc="${escapeHtml(doc)}" data-origin="${origin === null ? "" : escapeHtml(origin)}"><div class="cards"></div></main>
<script>${COMMENTS_FRAME_SCRIPT}</script>
</body>
</html>`;

  return new Response(body, { status: 200, headers: frameHeaders(await commentsScriptHash(), origin) });
}
