import { describe, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import worker, { resolveSurface } from "../src/index.js";

/** Routing tests never touch storage, so those bindings stay unset. */
const env = (vars: Partial<Env> = {}): Env =>
  ({
    SERVING_HOST: "",
    API_HOST: "",
    LEGACY_SERVING_HOST: "",
    RETIRED_API_HOST: "",
    ...vars,
  }) as Env;

const ctx = {} as ExecutionContext;

const get = (url: string, vars: Partial<Env> = {}) =>
  worker.fetch(new Request(url), env(vars), ctx);

const WORKERS_DEV = "openartifacts.workers.dev";
const HOSTS = {
  servingHost: "openartifacts.site",
  apiHost: "api.openartifacts.ai",
  legacyServingHost: "symposium.site",
  retiredApiHost: "api.symposium.md",
};
const PRODUCTION_ENV: Partial<Env> = {
  SERVING_HOST: HOSTS.servingHost,
  API_HOST: HOSTS.apiHost,
  LEGACY_SERVING_HOST: HOSTS.legacyServingHost,
  RETIRED_API_HOST: HOSTS.retiredApiHost,
};

describe("resolveSurface — local development, no hosts configured", () => {
  const unset = {};

  it("routes /api/v1 paths to the API surface", () => {
    expect(resolveSurface(WORKERS_DEV, "/api/v1/docs", unset)).toBe("api");
    expect(resolveSurface(WORKERS_DEV, "/api/v1/docs/abc", unset)).toBe("api");
    expect(resolveSurface(WORKERS_DEV, "/api/v1", unset)).toBe("api");
  });

  it("routes /d paths to the serving surface", () => {
    expect(resolveSurface(WORKERS_DEV, "/d/abc", unset)).toBe("serving");
    expect(resolveSurface(WORKERS_DEV, "/d/abc/v2", unset)).toBe("serving");
  });

  it("does not treat a prefix lookalike as a match", () => {
    expect(resolveSurface(WORKERS_DEV, "/api/v11/docs", unset)).toBe("unknown");
    expect(resolveSurface(WORKERS_DEV, "/docs", unset)).toBe("unknown");
    expect(resolveSurface(WORKERS_DEV, "/", unset)).toBe("unknown");
  });

  it("ignores empty host vars the same as absent ones", () => {
    expect(
      resolveSurface(WORKERS_DEV, "/api/v1/docs", {
        servingHost: "",
        apiHost: "",
        legacyServingHost: "",
        retiredApiHost: "",
      }),
    ).toBe("api");
  });
});

describe("resolveSurface — canonical and legacy domains", () => {
  it("routes the canonical hosts by surface", () => {
    expect(resolveSurface("openartifacts.site", "/d/abc", HOSTS)).toBe("serving");
    expect(resolveSurface("api.openartifacts.ai", "/api/v1/docs", HOSTS)).toBe("api");
  });

  it("supports a fresh two-host deployment without legacy or retired hosts", () => {
    const fresh = { servingHost: "docs.example", apiHost: "api.example" };
    expect(resolveSurface("docs.example", "/d/abc", fresh)).toBe("serving");
    expect(resolveSurface("api.example", "/api/v1/docs", fresh)).toBe("api");
    expect(resolveSurface("other.example", "/api/v1/docs", fresh)).toBe("unknown");
  });

  it("redirects the legacy document host and retires the old API host", () => {
    expect(resolveSurface("symposium.site", "/d/abc", HOSTS)).toBe("legacy-serving");
    expect(resolveSurface("api.symposium.md", "/api/v1/docs", HOSTS)).toBe("retired-api");
  });

  it("keeps /api/v1 off both document hosts", () => {
    expect(resolveSurface("openartifacts.site", "/api/v1/docs", HOSTS)).toBe("serving");
    expect(resolveSurface("symposium.site", "/api/v1/docs", HOSTS)).toBe("legacy-serving");
  });

  it("keeps document serving off the canonical and retired API hosts", () => {
    expect(resolveSurface("api.openartifacts.ai", "/d/abc", HOSTS)).toBe("api");
    expect(resolveSurface("api.symposium.md", "/d/abc", HOSTS)).toBe("retired-api");
  });

  it("matches every configured host case-insensitively and ignores the root dot", () => {
    expect(resolveSurface("OPENARTIFACTS.SITE.", "/api/v1/docs", HOSTS)).toBe("serving");
    expect(resolveSurface("SYMPOSIUM.SITE.", "/d/abc", HOSTS)).toBe("legacy-serving");
    expect(resolveSurface("API.OPENARTIFACTS.AI.", "/d/abc", HOSTS)).toBe("api");
    expect(resolveSurface("API.SYMPOSIUM.MD.", "/d/abc", HOSTS)).toBe("retired-api");
  });

  it("fails closed on unknown hosts even when the path names a surface", () => {
    expect(resolveSurface(WORKERS_DEV, "/api/v1/docs", HOSTS)).toBe("unknown");
    expect(resolveSurface(WORKERS_DEV, "/d/abc", HOSTS)).toBe("unknown");
    expect(resolveSurface("evil.openartifacts.site", "/api/v1/docs", HOSTS)).toBe("unknown");
    expect(resolveSurface("openartifacts.site.evil.com", "/d/abc", HOSTS)).toBe("unknown");
  });

  it("fails closed when only part of the production host config is present", () => {
    expect(
      resolveSurface(WORKERS_DEV, "/api/v1/docs", { servingHost: "openartifacts.site" }),
    ).toBe("unknown");
  });
});

describe("worker dispatch", () => {
  it("serves health on the canonical hosts", async () => {
    for (const host of ["openartifacts.site", "api.openartifacts.ai"]) {
      const res = await get(`https://${host}/health`, PRODUCTION_ENV);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
    }
  });

  it("redirects legacy document health and fails closed on an unknown host", async () => {
    const legacy = await get("https://symposium.site/health?probe=deploy", PRODUCTION_ENV);
    expect(legacy.status).toBe(307);
    expect(legacy.headers.get("location")).toBe(
      "https://openartifacts.site/health?probe=deploy",
    );

    const unknown = await get(`https://${WORKERS_DEV}/health`, PRODUCTION_ENV);
    expect(unknown.status).toBe(404);
  });

  it("preserves the exact path and query for GET and HEAD document redirects", async () => {
    const source = "https://symposium.site/d/9f2k4mvq7t0xbz3n/v2?source=old%20note&view=full";
    const target =
      "https://openartifacts.site/d/9f2k4mvq7t0xbz3n/v2?source=old%20note&view=full";

    for (const method of ["GET", "HEAD"]) {
      const res = await worker.fetch(new Request(source, { method }), env(PRODUCTION_ENV), ctx);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(target);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.text()).toBe("");
    }
  });

  it("does not redirect non-read methods from the legacy document host", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await worker.fetch(
        new Request("https://symposium.site/d/9f2k4mvq7t0xbz3n?source=old", { method }),
        env(PRODUCTION_ENV),
        ctx,
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });

  it("returns 410 before auth for every method and path on the retired API host", async () => {
    const requests = [
      ["GET", "/health"],
      ["GET", "/api/v1/docs"],
      ["POST", "/api/v1/docs"],
      ["PUT", "/api/v1/docs/9f2k4mvq7t0xbz3n"],
      ["DELETE", "/api/v1/docs/9f2k4mvq7t0xbz3n"],
      ["HEAD", "/anything"],
    ] as const;

    for (const [method, path] of requests) {
      const res = await worker.fetch(
        new Request(`https://api.symposium.md${path}`, {
          method,
          headers: { authorization: "Bearer deliberately-not-validated" },
        }),
        env(PRODUCTION_ENV),
        ctx,
      );
      expect(res.status).toBe(410);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("www-authenticate")).toBeNull();
      if (method !== "HEAD") {
        await expect(res.json()).resolves.toEqual({
          error: {
            code: "gone",
            message: "This API host has been retired. Use https://api.openartifacts.ai.",
          },
        });
      }
    }
  });

  it("answers unknown configured hosts without falling through by path", async () => {
    const res = await get(`https://${WORKERS_DEV}/api/v1/docs`, PRODUCTION_ENV);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it("keeps the API off the canonical document host", async () => {
    const res = await get("https://openartifacts.site/api/v1/docs", PRODUCTION_ENV);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("This document isn’t available.");
  });

  it("keeps documents off the canonical API host", async () => {
    const res = await get("https://api.openartifacts.ai/d/9f2k4mvq7t0xbz3n", PRODUCTION_ENV);
    expect(res.status).toBe(401);
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it("keeps local path fallback for wrangler dev", async () => {
    const api = await get(`https://${WORKERS_DEV}/api/v1/docs`);
    expect(api.status).toBe(401);

    const serving = await get(`https://${WORKERS_DEV}/d/abc`);
    expect(serving.status).toBe(404);
    expect(serving.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("never sets a cookie on the canonical document surface", async () => {
    const res = await get("https://openartifacts.site/d/abc", PRODUCTION_ENV);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
