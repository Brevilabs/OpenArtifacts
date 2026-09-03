/**
 * The one page a human ever sees from this Worker.
 *
 * Two surfaces reach for it and neither can borrow the other's response
 * handling: the serving surface's 404, 410 and 500 status pages, and the
 * approval page on the API host. What they share is the look — a document that
 * says it is unavailable and a page that asks someone to approve a terminal
 * should not look like they came from different products — so the shell lives
 * here and each caller supplies its own copy, its own status and its own
 * headers.
 *
 * Self-contained by necessity: the serving surface's own Content-Security-Policy
 * governs these bytes, and a stylesheet request from a status page would be an
 * extra hop for a page whose whole job is to render immediately.
 */
import { FAVICON_LINK, NOINDEX_META, OPENARTIFACTS_MARK_SVG } from "./render.js";

export interface BrandPage {
  /** Prefixed onto ` · OpenArtifacts` in the tab. */
  title: string;
  heading: string;
  message: string;
  /**
   * Raw HTML for what the reader can do next — a link, or the forms whose
   * buttons start and confirm an approval. Already-escaped markup, never raw
   * user input.
   */
  actions?: string;
  /**
   * Raw HTML placed between the message and the actions, for a page that has
   * something to show as well as something to say. Already escaped.
   */
  detail?: string;
}

/** The link every status page offers, since there is nowhere else to go. */
export const ABOUT_LINK = '<a href="https://openartifacts.ai">About OpenArtifacts</a>';

export function brandPageHtml(page: BrandPage): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${NOINDEX_META}
${FAVICON_LINK}
<title>${page.title} · OpenArtifacts</title>
<style>
  :root { color-scheme: dark; font-family: Archivo, "Helvetica Neue", Helvetica, Arial, ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 2rem; color: #e9ebee; background: #07080b; }
  main { width: min(100%, 34rem); padding: clamp(2rem, 6vw, 4rem); border: 1px solid #20242c; border-radius: 1.5rem; background: #0d0f14; box-shadow: 0 1.5rem 5rem rgba(0, 0, 0, 0.45); }
  .brand { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 3.5rem; color: #8d94a0; font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace; font-size: 0.7rem; font-weight: 500; letter-spacing: 0.16em; text-transform: uppercase; }
  .mark { display: block; width: 2rem; height: 2rem; }
  .mark svg { display: block; width: 100%; height: 100%; }
  h1 { max-width: 12ch; margin: 0; color: #f4f5f7; font-size: clamp(2.25rem, 7vw, 4.25rem); font-weight: 700; line-height: 0.98; letter-spacing: -0.035em; }
  p { max-width: 30rem; margin: 1.5rem 0 0; color: #8d94a0; font-size: 1.05rem; line-height: 1.7; }
  a { display: inline-flex; margin-top: 2rem; color: #f6ae52; font-weight: 600; text-underline-offset: 0.25em; }
  a:hover { color: #f9c47f; }
  .code { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 1.25rem; border: 1px solid #20242c; border-radius: 0.75rem; background: #07080b; color: #f4f5f7; font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace; font-size: 1.5rem; letter-spacing: 0.22em; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .actions form { display: contents; }
  .actions a, .actions button { margin-top: 2rem; padding: 0.85rem 1.5rem; border: 1px solid #2c313b; border-radius: 0.75rem; background: none; color: #f4f5f7; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  .actions a:hover, .actions button:hover { border-color: #f6ae52; color: #f9c47f; }
</style>
</head>
<body>
<main aria-labelledby="page-title">
  <div class="brand"><span class="mark" aria-hidden="true">${OPENARTIFACTS_MARK_SVG}</span>OpenArtifacts</div>
  <h1 id="page-title">${page.heading}</h1>
  <p>${page.message}</p>
${page.detail ?? ""}
  ${page.actions ?? ""}
</main>
</body>
</html>`;
}

/**
 * Escape text before it goes anywhere near the template above.
 *
 * The approval page prints a device code that arrived in the query string, so
 * this is the boundary between what a link can carry and what the page renders.
 * Both quote characters are escaped as well as the tag delimiters, so the same
 * function is safe inside an attribute.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
