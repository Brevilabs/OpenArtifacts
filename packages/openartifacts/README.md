# OpenArtifacts CLI

Install the CLI and the shared OpenArtifacts skill into detected Claude Code, Codex, OpenCode, and pi installations:

```bash
npx openartifacts install
```

Hermes Agent needs only its native skill install:

```bash
hermes skills install https://raw.githubusercontent.com/Brevilabs/OpenArtifacts/main/packages/openartifacts/skill/openartifacts/SKILL.md
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
openartifacts publish notes.md
```

`preview` prints HTML to stdout without authentication, API requests, or changes to
publishing state. It uses the same renderer as `publish`; HTML inputs are unchanged
and Markdown is rendered locally. OpenArtifacts' serving decorations are not
included. The CLI's `publish` command itself remains non-interactive; the agent
skill handles the rendered review and approval.

Set `OPENARTIFACTS_TOKEN` to supply a credential without browser sign-in. Set `OPENARTIFACTS_API_HOST` to target a self-hosted deployment.
