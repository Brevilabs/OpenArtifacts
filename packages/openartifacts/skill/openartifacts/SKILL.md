---
name: openartifacts
description: Render a document to HTML, let the user review the file, then publish it as a public OpenArtifacts page. Update or unshare published pages.
metadata:
  hermes:
    category: productivity
    tags: [publishing, html, artifacts]
---

# OpenArtifacts

Turn a document into a public web page. You render the HTML; OpenArtifacts hosts it.
The CLI is `openartifacts` when installed, otherwise `npx --yes openartifacts@latest`.
It only sends the HTML file you give it. Never run Node scripts of your own against
the API.

## 1. Render the page

Read the source the user points at and write one complete, self-contained HTML
document. Preserve the content faithfully. Inline your CSS. Scripts and external
resources are allowed and are published unchanged.

Themes are design specs written for you. If the user names one, read
`themes/<name>.md` next to this file and follow it. `research-memo` is bundled.
If the named theme does not exist, say so and continue with clean, readable
defaults of your own. A missing theme never blocks publishing.

## 2. Let the user review

Write the HTML to a new file next to the source, for example `notes.html` for
`notes.md`. Never overwrite the source. Tell the user the absolute path and that
opening it in a browser shows exactly what will be published. Then end your turn.

Never publish in the same turn that produced the HTML. Publish only when a later
message from the user clearly asks to publish this page. Treat anything else as
feedback (revise the same file and repeat this step) or as a cancellation. When
unsure whether a message is an approval, ask once. Never simulate the user's
approval.

## 3. Publish

```
openartifacts publish <file.html> --title "Page title"
```

The command prints `{"docId":"…","url":"…","version":1}`. Give the user the url.

To update a page the user already published, pass its id so the same url gets the
next version:

```
openartifacts publish <file.html> --title "Page title" --doc-id <docId>
```

Take the docId from the url you reported earlier (`…/d/<docId>`) or from
`openartifacts list`. Never guess a docId. If an update answers `not_found`, stop
and tell the user; do not publish a replacement unless they explicitly ask.

## 4. Withdraw

```
openartifacts unshare <docId>
```

The url then answers 410 Gone. Copies readers already downloaded cannot be recalled.

## Credentials

The CLI reads `OPENARTIFACTS_TOKEN` from the environment. It accepts an OpenArtifacts
token or a Brevilabs license key. Without it, the first authenticated command starts a
browser sign-in: relay both urls and the code the CLI prints, then keep waiting.

Publishing needs a paid OpenArtifacts plan. On `unauthorized`, tell the user they need a
credential with publishing access before anything can be published. Never read
credential files, print tokens, or ask the user to paste a credential into the chat.

## Errors

Relay the CLI's message verbatim and do not retry blindly. For `quota_exceeded`, say
whether to wait or unshare an unused page. For `limit_reached`, show the limit and the
upgrade link the CLI prints.
