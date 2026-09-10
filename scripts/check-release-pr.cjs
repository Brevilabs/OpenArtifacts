const { readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");

const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function checkNextPatch(baseVersion, version) {
  const base = stableVersion.exec(baseVersion ?? "");
  const next = stableVersion.exec(version ?? "");
  if (!base || !next || base[1] !== next[1] || base[2] !== next[2] ||
      BigInt(next[3]) !== BigInt(base[3]) + 1n) {
    throw new Error(`OpenArtifacts releases must use the next patch version after ${baseVersion}; received ${version}.`);
  }
}

function checkReleasePR({ title, baseVersion, version, lockVersion }) {
  if (version !== lockVersion) {
    throw new Error("OpenArtifacts package.json and package-lock.json versions must match.");
  }
  const releaseTitle = title.startsWith("v") && stableVersion.test(title.slice(1));
  if (version !== baseVersion || releaseTitle) {
    if (!stableVersion.test(version) || title !== `v${version}`) {
      throw new Error(`An OpenArtifacts version change requires the exact PR title v${version}.`);
    }
    checkNextPatch(baseVersion, version);
  }
}

if (require.main === module) {
  const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (!pr || !/^[a-f0-9]{40}$/.test(pr.base.sha)) throw new Error("Expected a pull request event with a valid base SHA.");
  const base = JSON.parse(execFileSync("git", ["show", `${pr.base.sha}:packages/openartifacts/package.json`], { encoding: "utf8" }));
  const pkg = JSON.parse(readFileSync("packages/openartifacts/package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  checkReleasePR({ title: pr.title, baseVersion: base.version, version: pkg.version, lockVersion: lock.packages["packages/openartifacts"].version });
  console.log("OpenArtifacts release title and versions are consistent.");
}

module.exports = { checkReleasePR, checkNextPatch };
