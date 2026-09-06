const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const workflow = readFileSync(join(__dirname, "../.github/workflows/release-openartifacts.yml"), "utf8");
// Job-level blocks in this workflow use two-space indentation; actionlint
// checks YAML validity separately. Keep these checks dependency-free.
const jobs = Object.fromEntries(
  [...workflow.matchAll(/^  (\w+):\n([\s\S]*?)(?=^  \w+:\n|(?![\s\S]))/gm)]
    .map(([, name, body]) => [name, body]),
);

test("release runs queue instead of replacing a pending release", () => {
  assert.match(workflow, /^concurrency:\n  group: publish-openartifacts-npm\n  queue: max\n  cancel-in-progress: false$/m);
});

test("dependency scripts run only before the publishing boundary", () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(jobs.prepare, /needs: gate/);
  assert.match(jobs.prepare, /npm ci/);
  assert.match(jobs.prepare, /npm test/);
  assert.doesNotMatch(jobs.prepare, /id-token:|environment:/);
  assert.doesNotMatch(jobs.gate, /id-token:|environment:/);
  assert.match(jobs.publish, /needs: \[gate, prepare\]/);
  assert.match(jobs.publish, /environment: package-release/);
  assert.match(jobs.publish, /id-token: write/);
  assert.equal((workflow.match(/id-token: write/g) || []).length, 1);
  assert.doesNotMatch(jobs.publish, /npm (?:ci|test|run|exec)\b|\bnpx\b/);
  for (const command of jobs.publish.match(/^.*npm (?:install|publish)\b.*$/gm) || []) {
    assert.match(command, /--ignore-scripts\b/);
  }
});

test("publication uses pristine source, not files from the test job", () => {
  assert.doesNotMatch(jobs.prepare, /npm (?:pack|publish)\b/);
  assert.doesNotMatch(workflow, /actions\/(?:upload|download)-artifact/);
  for (const job of [jobs.prepare, jobs.publish]) {
    assert.match(job, /actions\/checkout@v7\n\s+with:\n\s+ref: \$\{\{ github\.event\.pull_request\.merge_commit_sha \}\}/);
  }
  assert.match(jobs.publish, /persist-credentials: false/);
  assert.match(jobs.publish, /package-manager-cache: false/);
  assert.doesNotMatch(jobs.publish, /^\s+cache:/m);
  assert.match(jobs.publish, /npm publish --workspace packages\/openartifacts --ignore-scripts --access public --provenance/);
  assert.match(jobs.publish, /if: steps\.recheck\.outputs\.exists != 'true'/);
});

const { checkReleasePR } = require("../scripts/check-release-pr.cjs");
const candidate = { baseVersion: "0.2.0", version: "0.2.1", lockVersion: "0.2.1" };

test("version bumps require the exact matching release title", () => {
  for (const title of ["Fix publishing", "v0.3.0", "v0.2.1 extra", "v0.2.1\n", "v00.2.1", "v0.2.1-beta.1"]) {
    assert.throws(() => checkReleasePR({ ...candidate, title }), /exact PR title/);
  }
  assert.doesNotThrow(() => checkReleasePR({ ...candidate, title: "v0.2.1" }));
});

test("ordinary PRs need no release title, but release titles must match even without a bump", () => {
  const unchanged = { ...candidate, baseVersion: "0.2.1" };
  assert.doesNotThrow(() => checkReleasePR({ ...unchanged, title: "Fix publishing" }));
  assert.doesNotThrow(() => checkReleasePR({ ...unchanged, title: "v0.2.1" }));
  assert.throws(() => checkReleasePR({ ...unchanged, title: "v0.3.0" }), /exact PR title/);
});

test("a release cannot pass with stale lockfile metadata", () => {
  assert.throws(() => checkReleasePR({ ...candidate, title: "v0.2.1", lockVersion: "0.2.0" }), /versions must match/);
});

test("CI reruns title validation on PR edits and retains the base revision", () => {
  const ci = readFileSync(join(__dirname, "../.github/workflows/ci.yml"), "utf8");
  assert.match(ci, /types: \[opened, synchronize, reopened, edited\]/);
  assert.match(ci, /fetch-depth: 0/);
  assert.match(ci, /if: github.event_name == 'pull_request'\n\s+run: node scripts\/check-release-pr.cjs/);
});
