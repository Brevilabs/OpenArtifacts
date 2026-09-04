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
  assert.doesNotMatch(jobs.publish, /actions\/checkout|npm (?:ci|test|run|exec|pack)\b|\bnpx\b/);
  for (const command of jobs.publish.match(/^.*npm (?:install|publish)\b.*$/gm) || []) {
    assert.match(command, /--ignore-scripts\b/);
  }
});

test("publish consumes the prepared tarball, not a workspace", () => {
  assert.match(jobs.prepare, /npm pack --workspace packages\/openartifacts --ignore-scripts/);
  assert.match(jobs.prepare, /actions\/upload-artifact@v4/);
  assert.match(jobs.prepare, /name: npm-package/);
  assert.match(jobs.prepare, /if-no-files-found: error/);
  assert.match(jobs.publish, /actions\/download-artifact@v4/);
  assert.match(jobs.publish, /name: npm-package\n\s+path: package/);
  assert.match(jobs.publish, /npm publish "\.\/package\/openartifacts-\$VERSION\.tgz" --ignore-scripts --access public --provenance/);
  assert.match(jobs.publish, /if: steps\.recheck\.outputs\.exists != 'true'/);
});
