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
    assert.match(job, /actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ github\.event\.pull_request\.merge_commit_sha \}\}/);
  }
  assert.match(jobs.publish, /persist-credentials: false/);
  assert.match(jobs.publish, /npm publish --workspace packages\/openartifacts --ignore-scripts --access public --provenance/);
  assert.match(jobs.publish, /if: steps\.recheck\.outputs\.exists != 'true'/);
});
