const { readFileSync } = require("node:fs");
const { parseConfigFileTextToJson } = require("typescript");

/** Only the hosted deployment has mandatory account routing; self-hosted plans remain local. */
function checkHostedAccountActions(config) {
  const parsed = parseConfigFileTextToJson("wrangler.jsonc", config);
  if (parsed.error) throw new Error("Invalid Wrangler JSONC configuration.");
  const value = (key) => parsed.config?.vars?.[key];
  if (value("API_HOST") !== "api.openartifacts.ai") return;
  for (const name of ["ACCOUNT_ACTION_URL", "UPGRADE_URL"]) {
    if (value(name) !== "https://openartifacts.ai/account") {
      throw new Error(`${name} must point to the hosted /account page before deployment.`);
    }
  }
}
if (require.main === module) checkHostedAccountActions(readFileSync("wrangler.jsonc", "utf8"));
module.exports = { checkHostedAccountActions };
