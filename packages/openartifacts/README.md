# OpenArtifacts CLI

Install the CLI and the shared OpenArtifacts skill into detected Claude Code, Codex, OpenCode, and pi installations:

```bash
npx @brevilabs/openartifacts install
```

The `openartifacts` binary can then publish Markdown or HTML, update the same document on repeat publishes, list and fetch documents, unshare them, and list or revoke machine tokens. The first authenticated command opens the browser device flow and stores the resulting token with owner-only permissions.

Set `OPENARTIFACTS_TOKEN` to supply a credential without browser sign-in. Set `OPENARTIFACTS_API_HOST` to target a self-hosted deployment.
