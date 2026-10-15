import { expect, it } from "vitest";
import { isPublishingRequest } from "../src/auth.js";
it("requires the API path boundary before publishing-plan resolution", () => {
  for (const path of ["/api/v1docs", "/api/v1docs/doc", "/other/docs"]) {
    expect(isPublishingRequest(new Request(`https://api.example${path}`, { method: "POST" }))).toBe(false);
    expect(isPublishingRequest(new Request(`https://api.example${path}`, { method: "PUT" }))).toBe(false);
  }
  expect(isPublishingRequest(new Request("https://api.example/api/v1/docs", { method: "POST" }))).toBe(true);
  // The private create publishes too, so it takes the same plan gate and the same fresh plan read.
  expect(isPublishingRequest(new Request("https://api.example/api/v1/private-docs", { method: "POST" }))).toBe(true);
  for (const [method, path] of [["GET", "/api/v1/private-docs"], ["PUT", "/api/v1/private-docs/abc"], ["POST", "/api/v1/private-docs/abc"], ["POST", "/api/v1/private-docs/x/y"]]) {
    expect(isPublishingRequest(new Request(`https://api.example${path}`, { method }))).toBe(false);
  }
});
