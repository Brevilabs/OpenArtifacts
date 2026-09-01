import type { Env as OpenArtifactsEnv } from "../src/config.js";
import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    /** Test bindings are the worker's own Env, plus the migrations to apply. */
    interface Env extends OpenArtifactsEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
