# OpenArtifacts CLI

This package is a thin Python launcher for the OpenArtifacts npm CLI. It is
useful when `pipx` is the preferred way to install commands:

```bash
pipx install openartifacts
openartifacts install
```

Node.js 20+ and npm are still required. The launcher passes every command to
the exact npm release matching the installed Python package; it does not expose
a Python API or reimplement the CLI.

The PyPI bridge is optional. Self-hosted OpenArtifacts deployments remain
Node.js and Cloudflare Worker projects and do not require Python.
