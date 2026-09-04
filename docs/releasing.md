# Releasing the official npm CLI

This runbook is only for Brevilabs maintainers publishing the official
`openartifacts` npm package. Self-hosters do not need this workflow; their
Worker and CLI setup is unchanged.

## One-time setup

Create a protected GitHub environment named `package-release` with:

- required reviewer approval;
- deployment branches restricted to `main`; and
- no npm token.

Configure npm Trusted Publishing with this identity:

| Field | Value |
| --- | --- |
| GitHub owner | `Brevilabs` |
| Repository | `OpenArtifacts` |
| Workflow | `release-openartifacts.yml` |
| Environment | `package-release` |

Set its **Allowed action** to **npm publish**, because the staged-only default
refuses a direct `npm publish`. npm authenticates the workflow through a
short-lived OIDC credential, so GitHub stores no registry secret.

## Release

From the repository root, update the manifest and lockfile together:

```bash
npm version X.Y.Z --workspace packages/openartifacts --no-git-tag-version
```

Open and merge the version-bump PR. A change to
`packages/openartifacts/package.json` on `main` automatically starts **Publish
OpenArtifacts npm package**. Approve the `package-release` environment prompt;
there is no separate workflow dispatch or version input.

The workflow requires a stable `X.Y.Z` version, checks that the lockfile agrees,
and looks up that version on npm. A new version runs the JavaScript checks,
inspects the tarball, publishes with provenance, and verifies the registry. An
already-published version exits successfully, so a rerun after publication is
safe and a package-manifest edit without a version bump is a no-op.

PyPI is not part of this release process. The OpenArtifacts skill ships in the
npm package and is also available directly to Hermes from its canonical
repository path.

## One-time PyPI namespace package

`pypi/openartifacts` is a small functional compatibility launcher for the
official npm CLI. Its `0.0.1` version is intentionally independent from npm and
is published manually once to establish the official PyPI namespace. Do not add
it to the npm release workflow or keep its version in sync with npm.
