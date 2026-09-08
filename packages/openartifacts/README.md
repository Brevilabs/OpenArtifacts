# OpenArtifacts CLI

Install the CLI and the shared OpenArtifacts skill into detected Claude Code, Codex, OpenCode, and pi installations:

```bash
npx openartifacts install
```

Hermes Agent needs only its native skill install:

```bash
hermes skills install https://cdn.jsdelivr.net/npm/openartifacts@latest/skill/openartifacts/SKILL.md
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
OpenArtifacts' serving decorations are not included. Root presentation attributes
and embedded SVG resources are preserved. The CLI's `publish` command remains
non-interactive; the agent skill handles rendered review and approval.

Set `OPENARTIFACTS_TOKEN` to supply a credential without browser sign-in. Set `OPENARTIFACTS_API_HOST` to target a self-hosted deployment.

## Host adapters

The canonical skill is `skill/openartifacts/SKILL.md`. Hosts such as Copilot bundle
its **Shared publishing rules** at build time and provide their own execution,
authentication, identity, and approval UI. No instruction fetch occurs while publishing.

Pin the npm package version in the host's development dependencies. Regenerate the
bundled rules when upgrading that version, and test that they match the installed
package's shared section. Review and ship the host update normally. Plugin users do
not need Node or npm. Never download executable scripts at runtime.

Skill edits require a new npm version. Merge this feature, publish through the
existing release PR workflow, then pin that published version in Copilot.
The agent skill requires human approval; the non-interactive CLI does not enforce
human review. The optional `--reviewed-sha256` flag only verifies content consistency.

Verify both implementations for protected rendered review, explicit approval,
unchanged upload HTML, changed-content review, stable updates, cancellation/reopen,
and exact errors. The server-added Copilot banner remains unchanged.
