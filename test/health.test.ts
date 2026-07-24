import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

const call = (path: string) => worker.fetch(new Request(`https://updoc.test${path}`));

describe("worker", () => {
  it("serves a health check", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("404s unknown paths", async () => {
    const res = await call("/nope");
    expect(res.status).toBe(404);
  });
});
