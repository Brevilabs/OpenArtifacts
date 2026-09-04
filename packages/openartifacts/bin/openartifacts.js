#!/usr/bin/env node

import { main, presentError } from "../src/cli.js";

try {
  await main(process.argv.slice(2));
} catch (error) {
  presentError(error);
  process.exitCode = 1;
}
