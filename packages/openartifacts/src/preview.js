/** @param {string} value */
function escapeHtmlAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** @param {string} html */
export function createBrowserPreview(html) {
  // Mirror obsidian-copilot src/openArtifacts/openArtifactsAgentHandoff.ts when changing this shell.
  // Preview-only isolation must not reject or rewrite the published document.
  // https://github.com/logancyang/obsidian-copilot/issues/3121
  const policy =
    "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src data:; form-action 'none'; img-src data:; media-src data:; object-src 'none'; style-src 'unsafe-inline'";
  const contentPolicy = `${policy}; frame-src 'none'; script-src 'none'`;
  const frameHtml = `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(contentPolicy)}"></head><body></body></html>`;
  const source = JSON.stringify(html).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(`${policy}; frame-src 'self'; script-src 'unsafe-inline'`)}">
<meta name="referrer" content="no-referrer">
<title>OpenArtifacts local preview</title>
<style>html,body,iframe{border:0;height:100%;margin:0;padding:0;width:100%}body{overflow:hidden}iframe{display:block}</style>
</head>
<body>
<iframe title="OpenArtifacts HTML preview" sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe>
<script>
// Inert full-document parsing preserves root styling without executing note scripts.
// https://github.com/logancyang/obsidian-copilot/issues/3121
const parsed = new DOMParser().parseFromString(${source}, "text/html");
for (const element of parsed.querySelectorAll("*")) {
  if (["noscript", "script", "iframe", "frame", "object", "embed", "template", "meta", "base", "animate", "animatetransform", "animatemotion", "set"].includes(element.localName.toLowerCase())) { element.remove(); continue; }
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.localName.toLowerCase();
    // Keep static SVG references; anchors must remain non-navigable.
    // https://github.com/logancyang/obsidian-copilot/issues/3121
    const svgResource = element.namespaceURI === "http://www.w3.org/2000/svg" && element.localName !== "a" &&
      (attribute.value.startsWith("#") || (element.localName === "image" && attribute.value.startsWith("data:image/")));
    if ((name === "href" && !svgResource) || name === "action" || name === "formaction") {
      element.removeAttributeNode(attribute);
    }
  }
}
const frame = document.querySelector("iframe");
const mount = () => {
  const child = frame.contentDocument;
  if (child?.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content !== ${JSON.stringify(contentPolicy)}) return;
  frame.removeEventListener("load", mount);
  for (const [sourceRoot, targetRoot] of [[parsed.documentElement, child.documentElement], [parsed.body, child.body]]) {
    for (const attribute of Array.from(sourceRoot.attributes)) {
      if (["class", "style", "id", "lang", "dir"].includes(attribute.name) || attribute.name.startsWith("data-")) {
        targetRoot.setAttribute(attribute.name, attribute.value);
      }
    }
  }
  while (parsed.head.firstChild) child.head.appendChild(parsed.head.firstChild);
  child.body.replaceChildren();
  while (parsed.body.firstChild) child.body.appendChild(parsed.body.firstChild);
};
frame.addEventListener("load", mount);
frame.srcdoc = ${JSON.stringify(frameHtml).replaceAll("<", "\\u003c")};
</script>
</body>
</html>
`;
}
