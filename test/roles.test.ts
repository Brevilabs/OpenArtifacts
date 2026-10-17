import { describe, expect, it } from "vitest";
import { parseInviteRole, ROLE_PLAN_FLAG, ROLES, roleAtLeast, rolesAtLeastSql } from "../src/roles.js";

describe("the role ladder", () => {
  it("orders the roles lowest first, and each includes the ones below it", () => {
    expect(ROLES).toEqual(["view", "comment"]);
    expect(roleAtLeast("view", "view")).toBe(true);
    expect(roleAtLeast("view", "comment")).toBe(false);
    expect(roleAtLeast("comment", "view")).toBe(true);
    expect(roleAtLeast("comment", "comment")).toBe(true);
  });

  it("gives an unknown, future or missing role nothing", () => {
    for (const role of ["edit", "owner", "", null, undefined]) {
      expect(roleAtLeast(role, "view"), String(role)).toBe(false);
      expect(roleAtLeast(role, "comment"), String(role)).toBe(false);
    }
  });

  it("parses only the rungs it has", () => {
    expect(parseInviteRole("view")).toBe("view");
    expect(parseInviteRole("comment")).toBe("comment");
    for (const value of ["edit", "Comment", "", null, 1, {}]) expect(parseInviteRole(value), String(value)).toBeNull();
  });

  it("builds SQL from the same constant", () => {
    expect(rolesAtLeastSql("comment")).toBe("('comment')");
    expect(rolesAtLeastSql("view")).toBe("('view', 'comment')");
  });

  it("names a plan flag for every rung", () => {
    expect(Object.keys(ROLE_PLAN_FLAG)).toEqual([...ROLES]);
  });
});
