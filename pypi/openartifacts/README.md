# OpenArtifacts on PyPI

This is the official PyPI namespace for OpenArtifacts. It contains a small,
functional compatibility launcher for the canonical npm CLI; it is not a
Python SDK and its version does not track the npm package.

```bash
pipx install openartifacts
openartifacts --help
```

The launcher requires Node.js 20+ with npm and forwards commands to
`npx --yes openartifacts@latest`.

Hermes Agent does not need this package. Install the canonical OpenArtifacts
skill through Hermes's native skill manager instead.
