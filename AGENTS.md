# Repository instructions

Read [CLAUDE.md](CLAUDE.md) for development commands and product constraints.

## npm releases

OpenArtifacts npm releases occur only when a PR titled exactly `vX.Y.Z` is merged
into `main`. The title version must match `packages/openartifacts/package.json`
and its `packages/openartifacts` entry in `package-lock.json`.

CLI releases are patch-only: keep the major and minor versions unchanged and
increment the patch by exactly one (for example, `0.2.2` → `0.2.3`). Do not
skip patches, downgrade, or prepare minor or major releases. PR checks compare
against the base branch; publication checks against npm’s current `latest`.

A version bump in a descriptively titled PR does not publish. When preparing a
release, verify all three match before handing off the PR. Do not merge or publish
without user authorization.

The authoritative release implementation is
[release-openartifacts.yml](.github/workflows/release-openartifacts.yml).
CI checks version-bump PRs before merge and reruns when a PR title is edited.
