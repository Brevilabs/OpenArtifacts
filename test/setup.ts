import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

/**
 * Bring the test D1 up to the committed schema once, before the per-test
 * storage isolation starts stacking. Everything a test writes afterwards is
 * rolled back at the end of that test; the schema is not.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
