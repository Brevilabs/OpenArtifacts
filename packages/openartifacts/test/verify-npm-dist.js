import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { stdout } = await execute("npm", ["pack", "--dry-run", "--json"], {
  cwd: packageRoot,
});
const reports = JSON.parse(stdout);
assert.equal(reports.length, 1, "npm pack should describe one package");

const files = reports[0].files.map(({ path }) => path);
const forbidden = files.filter((path) =>
  path === "pyproject.toml"
    || path === "MANIFEST.in"
    || path.startsWith("python/")
    || path.endsWith(".py")
);
assert.deepEqual(forbidden, [], `npm tarball contains Python files: ${forbidden.join(", ")}`);
console.log(`npm tarball contains ${files.length} non-Python files`);
