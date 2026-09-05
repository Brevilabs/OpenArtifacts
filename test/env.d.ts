import type { Env } from "../src/config.js";

declare module "cloudflare:test" {
  /** `env` inside a test is the worker's own Env, plus the migrations to apply. */
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
