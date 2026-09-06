# OpenArtifacts CLI

Install the CLI and the shared OpenArtifacts skill into detected Claude Code, Codex, OpenCode, and pi installations:

```bash
npx openartifacts install
```

Hermes Agent needs only its native skill install:

```bash
hermes skills install https://cdn.jsdelivr.net/npm/openartifacts@latest/skill/v1/SKILL.md
```

The skill uses an installed `openartifacts` command when available and falls
back to `npx --yes openartifacts@latest`, so no separate CLI installation is
required. Run `hermes skills update` to refresh the skill from that source.

The `openartifacts` binary can then preview and publish Markdown or HTML, update the same document on repeat publishes, list and fetch documents, unshare them, and list or revoke machine tokens. The first authenticated command opens the browser device flow and stores the resulting token with owner-only permissions.

Render a local review file before publishing (choose a separate output path that
does not overwrite your source):

```bash
openartifacts preview notes.md > notes.review.html
```

Open the review HTML in a browser to inspect the rendered page. The agent skill
requires the user's explicit approval of that displayed page before every publish
or update. If the source changes, preview and approve it again. After approval,
publish the original source path to preserve its existing update mapping:

```bash
openartifacts publish notes.md --reviewed-sha256 <hash-printed-by-preview>
```

`preview` prints HTML to stdout without authentication, API requests, or changes to
publishing state. It wraps the rendered upload HTML in a protected static preview:
page scripts, network resources, and navigation are disabled only during review.
It prints the upload HTML's SHA-256 to stderr; `--reviewed-sha256` rejects changed
content before authentication or upload. Published HTML remains unchanged.
OpenArtifacts' serving decorations are not included. Source `<html>` and `<body>`
attributes are not preserved in this static preview; put essential styling in CSS
rules or content elements when preparing a page for review. The CLI's `publish` command itself remains non-interactive; the agent
skill handles the rendered review and approval.

Set `OPENARTIFACTS_TOKEN` to supply a credential without browser sign-in. Set `OPENARTIFACTS_API_HOST` to target a self-hosted deployment.

## Host adapters and contract v1

The published shared skill is available without Node or npm at:
https://cdn.jsdelivr.net/npm/openartifacts@latest/skill/v1/SKILL.md

Hosts such as Copilot fetch it once per publishing task and follow **Shared
publishing rules**, replacing **Standalone CLI** with their bundled transport,
authentication, identity, and approval UI. A failed fetch stops agent publishing;
it does not justify skipping review. No scripts are downloaded for execution.

Keep `skill/v1/SKILL.md` compatible with existing v1 hosts in every future npm
release. A rule requiring new host capabilities belongs in a new contract path;
retain v1 for installed clients. CDN caching means compatible updates may not be
immediately visible. Do not point hosts at unreleased branch content.

Skill edits and CLI changes require a new npm version. This feature PR does not
publish one: merge it, then use the existing `vX.Y.Z` release PR workflow. Verify
the URL serves the new skill before releasing the Copilot adapter.

For publishing changes, verify both the CLI and Copilot flows: protected rendered
review, explicit approval, unchanged uploaded HTML, changed-content review,
stable updates, cancellation/reopen, and exact failure reporting. Preserve the
Copilot banner. Sharing instructions does not replace host implementation checks.
