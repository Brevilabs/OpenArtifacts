# OpenArtifacts CLI

This package is an optional Python-side entry point for users who prefer
`pipx`. It is a thin launcher for the OpenArtifacts npm CLI rather than a
separate implementation.

```bash
pipx install openartifacts
```

[Hermes Agent](https://hermes-agent.nousresearch.com/) does not require this
package. Its one-line native installation fetches the canonical skill, which
uses `npx` when the CLI is not already installed:

```bash
hermes skills install https://raw.githubusercontent.com/Brevilabs/OpenArtifacts/main/packages/openartifacts/skill/openartifacts/SKILL.md
```

The skill is not copied into the Python package.

Node.js 20+ and npm are still required. The launcher passes every command to
the exact npm release matching the installed Python package; it does not expose
a Python API or reimplement the CLI.

The PyPI bridge is optional. Self-hosted OpenArtifacts deployments remain
Node.js and Cloudflare Worker projects and do not require Python.
