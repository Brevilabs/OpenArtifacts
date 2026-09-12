import { expect, it } from "vitest";
import { isPublishingRequest } from "../src/auth.js";
it("requires the API path boundary before publishing-plan resolution", () => {
  for (const path of ["/api/v1docs", "/api/v1docs/doc", "/other/docs"]) {
    expect(isPublishingRequest(new Request(`https://api.example${path}`, { method: "POST" }))).toBe(false);
    expect(isPublishingRequest(new Request(`https://api.example${path}`, { method: "PUT" }))).toBe(false);
  }
  expect(isPublishingRequest(new Request("https://api.example/api/v1/docs", { method: "POST" }))).toBe(true);
});
