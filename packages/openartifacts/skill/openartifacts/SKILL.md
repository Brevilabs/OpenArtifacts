---
name: openartifacts
description: Publish, update, list, fetch, or unshare public OpenArtifacts documents and manage this machine's OpenArtifacts access.
---

# OpenArtifacts

Use the `openartifacts` CLI for every operation. Do not read OpenArtifacts config files, look for credentials, or print `OPENARTIFACTS_TOKEN`.

- Publish Markdown or HTML: `openartifacts publish <file>`
- List documents: `openartifacts list`
- Fetch current HTML: `openartifacts get <docId>`
- Withdraw a document: `openartifacts unshare <docId>`
- List machine tokens: `openartifacts tokens`
- Revoke one: `openartifacts revoke <tokenId>`
- Sign in again after an `unauthorized` response: `openartifacts login`

The first authenticated command may wait for approval. Relay both sign-in URLs and the user code printed by the CLI, then keep waiting; never ask the user to copy a token. Return the public URL printed by `publish`.

Publishing the same local file again updates its existing document. If an update returns `not_found`, stop and report it; do not create a replacement. If publishing returns `limit_reached`, show its limit and upgrade link when present, and retry only after the user confirms the limit was changed.
