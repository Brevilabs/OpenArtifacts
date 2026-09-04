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
`packages/openartifacts/package.json` and `package-lock.json` must be the only
release-specific work, and the PR title must be exactly `vX.Y.Z` for the same
version. When that PR merges to `main`, **Publish OpenArtifacts npm package**
starts automatically. Approve the `package-release` environment prompt; there
is no separate workflow dispatch or version input.

The workflow strips the title's `v`, checks that both package files have that
stable `X.Y.Z` version, and looks it up on npm. An unpublished version must be
newer than npm's current `latest` version, preventing an out-of-order release
from downgrading installs. A job without publishing permission installs
dependencies and runs the JavaScript checks. After approval, a separate job
checks out the same merge commit afresh, rechecks both the exact version and
`latest`, and packs and publishes the checked-in CLI with provenance. It never
installs project dependencies or runs project code; npm lifecycle scripts are
disabled. No files from the test job are reused. The CLI needs no build step.
The registry is verified after publication. An already-published version exits
successfully, so a rerun after publication is safe. Every merged PR whose title
is not exactly `vX.Y.Z` stops at the release gate and never requests
protected-environment approval.
