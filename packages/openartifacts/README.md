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
back to `npx --yes openartifacts@latest`, so installing the PyPI bridge first is
not required. Run `hermes skills update` to refresh the skill from that source.

The `openartifacts` binary can then publish Markdown or HTML, update the same document on repeat publishes, list and fetch documents, unshare them, and list or revoke machine tokens. The first authenticated command opens the browser device flow and stores the resulting token with owner-only permissions.

Set `OPENARTIFACTS_TOKEN` to supply a credential without browser sign-in. Set `OPENARTIFACTS_API_HOST` to target a self-hosted deployment.
