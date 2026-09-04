# Releasing the official CLI packages

This runbook is only for Brevilabs maintainers publishing the official
`openartifacts` packages. Self-hosters do not need this workflow, a PyPI
account, or Python; their Worker and npm CLI setup is unchanged.

## One-time setup

Create a protected GitHub environment named `package-release` with:

- required reviewer approval;
- deployment branches restricted to `main`; and
- no npm or PyPI tokens.

Configure Trusted Publishing on both registries with the same identity:

| Field | Value |
| --- | --- |
| GitHub owner | `Brevilabs` |
| Repository | `OpenArtifacts` |
| Workflow | `release-openartifacts.yml` |
| Environment | `package-release` |

For the first PyPI release, configure a pending publisher for the unclaimed
`openartifacts` project. npm Trusted Publishing is configured on the existing
package; set its **Allowed action** to **npm publish**, because the staged-only
default refuses a direct `npm publish`. Both registries authenticate the
workflow through short-lived OIDC credentials, so GitHub stores no registry
secret.

## Release

1. From the repository root, update the npm manifest and lockfile together:

   ```bash
   npm version X.Y.Z --workspace packages/openartifacts --no-git-tag-version
   ```

   Set `packages/openartifacts/pyproject.toml` to the same version.
2. Merge that version to `main`.
3. Run **Release OpenArtifacts packages** on `main` and enter that exact
   version.
4. Approve the single `package-release` environment prompt.

The workflow validates the ref and both manifests before contacting either
registry. It runs the JavaScript and Python checks, builds both distributions,
publishes npm first, waits until the exact version is visible, and then
publishes PyPI. Registry versions are immutable. If a run stops between the two
publishes, rerun the same version: an existing version is verified and skipped,
so the missing registry can finish without a version bump.

Prereleases are intentionally unsupported because npm SemVer and PyPI PEP 440
do not preserve every prerelease string identically.

The OpenArtifacts skill has no separate PyPI release. npm packages the
canonical `packages/openartifacts/skill/openartifacts/SKILL.md`, while Hermes
installs that same file directly from this repository through its native skill
manager. Maintainers do not copy or publish a second skill.
