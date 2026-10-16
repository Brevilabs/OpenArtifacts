/**
 * The role ladder, in one place (docs/comments.md, "Access").
 *
 * Every person on a document's list has one role, and each role includes the
 * ones below it: `view` < `comment`. A later `edit` is one more entry here, one
 * in `ROLE_PLAN_FLAG`, and nothing else moves. No check anywhere compares a role
 * to one value: TypeScript asks `roleAtLeast`, SQL asks `rolesAtLeastSql`.
 *
 * The owner is not on the list and stands above every role.
 */
export const ROLES = ["view", "comment"] as const;

export type InviteRole = (typeof ROLES)[number];

/** What a new person is given when the caller names no role. */
export const DEFAULT_ROLE: InviteRole = "comment";

/** Which plan flag a role needs on the owner's plan, to be granted or changed to. */
export const ROLE_PLAN_FLAG = { view: "privateSharing", comment: "comments" } as const satisfies Record<
  InviteRole,
  "privateSharing" | "comments"
>;

/** `value` as a role, or null for anything that is not one. */
export function parseInviteRole(value: unknown): InviteRole | null {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value) ? (value as InviteRole) : null;
}

/**
 * Whether `role` is `floor` or above it. An unknown or future role (something
 * stored by a newer Worker) is at least nothing, so it is never granted more than
 * it is known to mean.
 */
export function roleAtLeast(role: string | null | undefined, floor: InviteRole): boolean {
  const held = ROLES.indexOf(role as InviteRole);
  return held >= 0 && held >= ROLES.indexOf(floor);
}

/**
 * `('comment', …)` for SQL: the rungs at or above `floor`. Built from the
 * constant, never from input, so it is safe to splice into a statement.
 */
export function rolesAtLeastSql(floor: InviteRole): string {
  return `(${ROLES.filter((role) => roleAtLeast(role, floor)).map((role) => `'${role}'`).join(", ")})`;
}
