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
const template = document.createElement("template");
template.innerHTML = ${source};
for (const element of template.content.querySelectorAll("*")) {
  if (["noscript", "script", "iframe", "frame", "object", "embed", "template", "meta", "base", "animate", "animatetransform", "animatemotion", "set"].includes(element.localName.toLowerCase())) { element.remove(); continue; }
  for (const attribute of Array.from(element.attributes)) {
    if (["href", "action", "formaction"].includes(attribute.localName.toLowerCase())) {
      element.removeAttributeNode(attribute);
    }
  }
}
const frame = document.querySelector("iframe");
const mount = () => {
  const child = frame.contentDocument;
  if (child?.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content !== ${JSON.stringify(contentPolicy)}) return;
  frame.removeEventListener("load", mount);
  child.body.replaceChildren(template.content);
};
frame.addEventListener("load", mount);
frame.srcdoc = ${JSON.stringify(frameHtml).replaceAll("<", "\\u003c")};
</script>
</body>
</html>
`;
}
