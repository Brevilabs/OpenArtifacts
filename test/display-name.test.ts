import { describe, expect, it } from "vitest";
import { nameFromEmail, normalizeDisplayName } from "../src/display-name.js";

describe("the display name rule", () => {
  it("trims, and refuses empty, overlong and control-character names", () => {
    expect(normalizeDisplayName("  Ada L.  ")).toBe("Ada L.");
    expect(normalizeDisplayName("   ")).toBeNull();
    expect(normalizeDisplayName("a".repeat(65))).toBeNull();
    expect(normalizeDisplayName("Ada\u0007")).toBeNull();
    expect(normalizeDisplayName(42)).toBeNull();
  });

  it("names a person with none from their email before the @, without a +tag", () => {
    expect(nameFromEmail("john.smith@acme.com")).toBe("john.smith");
    expect(nameFromEmail("john.smith+openartifacts@acme.com")).toBe("john.smith");
    expect(nameFromEmail("+tag@acme.com")).toBe("Reader");
    expect(nameFromEmail("")).toBe("Reader");
  });
});
