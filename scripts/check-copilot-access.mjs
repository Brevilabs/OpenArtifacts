import { readFileSync } from "node:fs";
import { documentAccess } from "../packages/openartifacts/src/access.cjs";

const coverage = JSON.parse(readFileSync(process.argv[2], "utf8"));
const missing = Object.keys(documentAccess).filter((operation) => {
  const entry = coverage[operation] ?? {};
  const routes = Object.keys(entry);
  return routes.length !== 1 ||
    !["tool", "uiOnly", "excluded", "pending"].includes(routes[0]) ||
    typeof entry[routes[0]] !== "string" ||
    !entry[routes[0]].trim();
});
if (missing.length) {
  throw new Error(`Record a Copilot coverage decision for: ${missing.join(", ")}`);
}
