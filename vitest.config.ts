import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

/**
 * Tests run inside workerd, not Node.
 *
 * They have to: HTMLRewriter, R2 and D1 are runtime, not library, and a test
 * double for any of them would be asserting our idea of Cloudflare rather than
 * Cloudflare. Every test therefore gets the real bindings from `wrangler.jsonc`,
 * backed by Miniflare, with storage isolated per test.
 */
export default defineWorkersConfig(async () => {
  // The same files `wrangler d1 migrations apply` runs, so the schema under
  // test is the schema that ships rather than a hand-maintained copy.
  const migrations = await readD1Migrations(new URL("migrations", import.meta.url).pathname);

  return {
    test: {
      setupFiles: ["./test/setup.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            // Only the tests need it: `test/auth.test.ts` computes the expected
            // key hash with node:crypto so it never reuses the implementation's
            // own hashing to check the implementation.
            compatibilityFlags: ["nodejs_compat"],

            // The runtime bundled with the test pool is older than the
            // deployed-worker compatibility date in wrangler.jsonc, and workerd
            // refuses a date it does not know. Pinned to the newest date this
            // binary supports rather than left to drift silently.
            compatibilityDate: "2026-03-01",

            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
