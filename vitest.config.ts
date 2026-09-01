import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside workerd, not Node.
 *
 * They have to: HTMLRewriter, R2 and D1 are runtime, not library, and a test
 * double for any of them would be asserting our idea of Cloudflare rather than
 * Cloudflare. Every test therefore gets the real bindings from `wrangler.jsonc`,
 * backed by Miniflare, with storage isolated per test.
 */
export default defineConfig(async () => {
  // The same files `wrangler d1 migrations apply` runs, so the schema under
  // test is the schema that ships rather than a hand-maintained copy.
  const migrations = await readD1Migrations(new URL("migrations", import.meta.url).pathname);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Only the tests need it: `test/auth.test.ts` computes the expected
          // key hash with node:crypto so it never reuses the implementation's
          // own hashing to check the implementation.
          compatibilityFlags: ["nodejs_compat"],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
