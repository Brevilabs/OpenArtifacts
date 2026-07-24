import { describe, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import worker, { resolveSurface } from "../src/index.js";

/** Phase 1 routing never touches a binding, so the storage bindings stay unset. */
const env = (vars: Partial<Env> = {}): Env =>
  ({ SERVING_HOST: "", API_HOST: "", ...vars }) as Env;

const ctx = {} as ExecutionContext;

const get = (url: string, vars: Partial<Env> = {}) =>
  worker.fetch(new Request(url), env(vars), ctx);

const WORKERS_DEV = "updoc.workers.dev";
const TWO_DOMAIN = { servingHost: "updoc.page", apiHost: "api.updoc.md" };

describe("resolveSurface — workers.dev, no hosts configured", () => {
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
    expect(resolveSurface(WORKERS_DEV, "/api/v1/docs", { servingHost: "", apiHost: "" })).toBe(
      "api",
    );
  });
});

describe("resolveSurface — two configured domains", () => {
  it("routes by host, not path", () => {
    expect(resolveSurface("updoc.page", "/d/abc", TWO_DOMAIN)).toBe("serving");
    expect(resolveSurface("api.updoc.md", "/api/v1/docs", TWO_DOMAIN)).toBe("api");
  });

  it("keeps /api/v1 off the serving host", () => {
    expect(resolveSurface("updoc.page", "/api/v1/docs", TWO_DOMAIN)).toBe("serving");
    expect(resolveSurface("updoc.page", "/api/v1/docs/abc", TWO_DOMAIN)).toBe("serving");
  });

  it("keeps doc serving off the API host", () => {
    expect(resolveSurface("api.updoc.md", "/d/abc", TWO_DOMAIN)).toBe("api");
  });

  it("matches the host case-insensitively and ignores the root dot", () => {
    // Both forms reach `/api/v1` if the match fails, so each asserts the
    // security property rather than just a normalisation detail.
    expect(resolveSurface("UPDOC.PAGE", "/api/v1/docs", TWO_DOMAIN)).toBe("serving");
    expect(resolveSurface("updoc.page.", "/api/v1/docs", TWO_DOMAIN)).toBe("serving");
    expect(resolveSurface("updoc.page", "/api/v1/docs", { servingHost: "UPDOC.Page." })).toBe(
      "serving",
    );
  });

  it("does not match a subdomain or suffix of a configured host", () => {
    // A path with no prefix to fall back on, so "unknown" can only mean the
    // host itself did not match.
    expect(resolveSurface("evil.updoc.page", "/nope", TWO_DOMAIN)).toBe("unknown");
    expect(resolveSurface("updoc.page.evil.com", "/nope", TWO_DOMAIN)).toBe("unknown");
    expect(resolveSurface("notupdoc.page", "/nope", TWO_DOMAIN)).toBe("unknown");
    // And a lookalike host still gets no serving treatment for an API path.
    expect(resolveSurface("evil.updoc.page", "/api/v1/docs", TWO_DOMAIN)).toBe("api");
  });

  it("falls back to path prefixes on an unrecognised host", () => {
    expect(resolveSurface(WORKERS_DEV, "/api/v1/docs", TWO_DOMAIN)).toBe("api");
    expect(resolveSurface(WORKERS_DEV, "/d/abc", TWO_DOMAIN)).toBe("serving");
  });

  it("routes by host when only the serving host is configured", () => {
    expect(resolveSurface("updoc.page", "/api/v1/docs", { servingHost: "updoc.page" })).toBe(
      "serving",
    );
  });
});

describe("worker dispatch", () => {
  it("serves the health check on any host", async () => {
    for (const host of [WORKERS_DEV, "updoc.page", "api.updoc.md"]) {
      const res = await get(`https://${host}/health`, {
        SERVING_HOST: "updoc.page",
        API_HOST: "api.updoc.md",
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
    }
  });

  it("answers unknown paths with the error contract", async () => {
    const res = await get(`https://${WORKERS_DEV}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({
      error: { code: "not_found", message: expect.stringContaining("/nope") },
    });
  });

  it("hands /api/v1 to the API surface on workers.dev", async () => {
    const res = await get(`https://${WORKERS_DEV}/api/v1/docs`);
    expect(res.status).toBe(404);
    // The serving surface stamps every response it produces; the API does not.
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it("hands /d to the serving surface on workers.dev", async () => {
    const res = await get(`https://${WORKERS_DEV}/d/abc`);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("never reaches the API surface on the serving host", async () => {
    // Including the trailing-root-dot form, which `new URL()` preserves in
    // `hostname` and which would otherwise miss the host match and fall
    // through to the /api/v1 path prefix.
    for (const host of ["updoc.page", "updoc.page.", "UPDOC.PAGE"]) {
      const res = await get(`https://${host}/api/v1/docs`, {
        SERVING_HOST: "updoc.page",
        API_HOST: "api.updoc.md",
      });
      expect(res.status).toBe(404);
      // Two independent signals that the serving surface answered: only it
      // stamps the robots header, and only it phrases the miss as a doc.
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      await expect(res.json()).resolves.toEqual({
        error: { code: "not_found", message: expect.stringContaining("No doc at") },
      });
    }
  });

  it("never sets a cookie on the serving surface", async () => {
    const res = await get("https://updoc.page/d/abc", { SERVING_HOST: "updoc.page" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
