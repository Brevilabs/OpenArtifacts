---
name: openartifacts
description: Publish, update, list, fetch, or unshare public OpenArtifacts documents and manage this machine's OpenArtifacts access.
metadata:
  hermes:
    category: productivity
    tags: [publishing, markdown, artifacts]
---

# OpenArtifacts

Use `openartifacts` as the command prefix when it is installed. Otherwise use
`npx --yes openartifacts@latest`; do not require another package install first.
Do not read OpenArtifacts config files, look for credentials, or print
`OPENARTIFACTS_TOKEN`.

- Preview Markdown or HTML locally: `openartifacts preview <file>`
- Publish Markdown or HTML after review: `openartifacts publish <file>`
- List documents: `openartifacts list`
- Fetch current HTML: `openartifacts get <docId>`
- Withdraw a document: `openartifacts unshare <docId>`
- List machine tokens: `openartifacts tokens`
- Revoke one: `openartifacts revoke <tokenId>`
- Sign in again after an `unauthorized` response: `openartifacts login`

Before every publish or update:

1. Run `openartifacts preview <file>` and save its HTML output to a separate local
   review `.html` file. Never overwrite the source file. Preview runs locally
   without signing in or publishing. If the CLI does not support `preview`, use a
   release that supports it or stop; never fall back to publishing without review.
2. Open that review file in a user-visible browser or HTML preview so the user can
   inspect the rendered page. Showing HTML source, a file path, or a prose summary
   does not count. If a rendered preview cannot be presented, stop; never publish
   to obtain a preview.
3. Ask for and wait for the user's explicit approval of the displayed page before
   running `openartifacts publish <file>`. The original request to publish and
   browser sign-in approval do not replace this review. If the source changes,
   regenerate and present the preview and obtain approval again.
4. Publish the original, unchanged source path, not the temporary review HTML, so
   repeat publishing keeps updating the same document.

Preview and publish use the same renderer and produce the same upload HTML for
an unchanged source file. OpenArtifacts adds its own decorations when serving the
public page, so those are not included in the local preview.

The first authenticated command may wait for approval. Relay both sign-in URLs and the user code printed by the CLI, then keep waiting; never ask the user to copy a token. Return the public URL printed by `publish`.

Publishing the same local file again updates its existing document. If an update returns `not_found`, stop and report it; do not create a replacement.

Markdown files use ordinary Markdown rendering. Obsidian wikilinks, embeds, and callouts are not expanded and will appear as literal text.

If the user explicitly wants a new link after an update returns `not_found`, ask for confirmation, run `openartifacts unshare <oldDocId>` to forget the stale local mapping, then publish the file again. Never take that recovery path automatically.

If publishing returns `quota_exceeded`, show the error and advise the user to wait for the current quota window or remove an unused document, as appropriate. Do not blindly retry. If publishing returns `limit_reached`, show its limit and upgrade link when present, and retry only after the user confirms the limit was changed.
