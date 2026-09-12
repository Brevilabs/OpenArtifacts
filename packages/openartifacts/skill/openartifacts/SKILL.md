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
opening it in a browser shows the page as it will be uploaded; OpenArtifacts adds its
own header and footer bylines when it serves the page. Then end your turn.

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

OpenArtifacts accounts can publish within their free limits. Sign-in does not
require buying a plan. On `unauthorized`, relay the sign-in guidance rather than
claiming payment is required. Never read credential files, print tokens, or ask
the user to paste a credential into the chat.

Use `openartifacts account` to report the current plan, limits, usage, and linked
status. When the user asks to upgrade, manage billing, or link their existing
Copilot account, run `openartifacts account --open`. The command opens the browser
and prints a short-lived account URL. Show that exact URL as a clickable Markdown
link; never use a placeholder or substitute the plain `/account` address. If the
link cannot be clicked or the browser does not open, provide the full URL in a code
block so the user can copy it into their browser. If it expires, run the command
again and share the fresh link. Treat these URLs as private account access links;
do not put them in published documents, issues, or logs. The user
enters a license key and confirms linking only on that page, never in chat or
command arguments. These commands require an OAuth-issued account token; follow
the CLI guidance if an environment license key overrides the stored token.

## Errors

Relay the CLI's message verbatim and do not retry blindly. For `quota_exceeded`, say
whether to wait or unshare an unused page. For `limit_reached`, show the limit.
When a `limit_reached` response includes guidance to run
`openartifacts account --open`, run it automatically and share the returned account
link using the instructions above. Tell the user they have reached their publishing
limit and can choose a plan on that page. Do not require a separate request to
generate the link. If generating it fails, relay the error and the command so the
user can try it themselves; never invent a URL. Self-hosted servers may not offer
browser account management, so do not assume support when the response lacks this
guidance. Opening the account page is not authorization to choose a plan, start
checkout, pay, or retry publishing automatically.
