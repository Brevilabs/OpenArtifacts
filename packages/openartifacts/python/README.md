# OpenArtifacts CLI

This package is the Python-side entry point for OpenArtifacts, primarily for
[Hermes Agent](https://hermes-agent.nousresearch.com/). It is a thin launcher
for the OpenArtifacts npm CLI rather than a separate implementation.

```bash
pipx install openartifacts
hermes skills install https://raw.githubusercontent.com/Brevilabs/OpenArtifacts/main/packages/openartifacts/skill/openartifacts/SKILL.md
```

Hermes installs that `SKILL.md` through its native skill manager, including its
security scan and update tracking. `hermes skills update` refreshes it from the
same canonical file. The skill is not copied into the Python package.

Node.js 20+ and npm are still required. The launcher passes every command to
the exact npm release matching the installed Python package; it does not expose
a Python API or reimplement the CLI.

The PyPI bridge is optional. Self-hosted OpenArtifacts deployments remain
Node.js and Cloudflare Worker projects and do not require Python.
