import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach } from "vitest";

/**
 * Reset every binding before each test, then rebuild D1 from the committed
 * migrations. The current pool's `reset()` clears D1 tables as well as rows,
 * so applying the schema is part of the isolation boundary.
 */
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
