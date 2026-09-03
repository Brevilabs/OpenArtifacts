import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  approveDeviceCode,
  deviceCodeIsPending,
  findOrCreateAccount,
  type AccountRow,
} from "../src/db.js";
import {
  githubVerifiedEmail,
  googleVerifiedEmail,
  normalizeEmail,
} from "../src/approval/providers.js";
import { ACCOUNT_ID_PREFIX, newAccountId } from "../src/ids.js";

const NOW = 1_800_000_000_000;

/** Distinct from the account ids under test, so a mix-up cannot pass. */
let minted = 0;
const nextId = () => `oa_test${(minted += 1)}`;

async function seedCode(userCode: string, expiresAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO device_codes (user_code, expires_at, created_at) VALUES (?, ?, ?)`,
  )
    .bind(userCode, expiresAt, NOW)
    .run();
}

async function readCode(userCode: string) {
  return await env.DB.prepare(
    "SELECT account_id, approved_at FROM device_codes WHERE user_code = ?",
  )
    .bind(userCode)
    .first<{ account_id: string | null; approved_at: number | null }>();
}

describe("newAccountId", () => {
  it("prefixes every id so it can never equal a license-key owner's uuid", () => {
    const id = newAccountId();
    expect(id.startsWith(ACCOUNT_ID_PREFIX)).toBe(true);
    // An app-sites `User.id` is a uuid, which has dashes and no `oa_`.
    expect(id).not.toContain("-");
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newAccountId()));
    expect(ids.size).toBe(100);
  });
});

describe("normalizeEmail", () => {
  it("folds case and surrounding space so two providers reach one account", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  it("refuses values that are not an address", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("ada")).toBeNull();
    expect(normalizeEmail("@example.com")).toBeNull();
    expect(normalizeEmail("ada@")).toBeNull();
    expect(normalizeEmail("ada@a@example.com")).toBeNull();
    expect(normalizeEmail("ada @example.com")).toBeNull();
  });
});

describe("googleVerifiedEmail", () => {
  it("returns the address as Google wrote it once Google says it verified it", () => {
    expect(googleVerifiedEmail({ email: "Ada@Example.com", email_verified: true })).toBe(
      "Ada@Example.com",
    );
  });

  it("refuses an address Google has not verified", () => {
    expect(googleVerifiedEmail({ email: "ada@example.com", email_verified: false })).toBeNull();
    expect(googleVerifiedEmail({ email: "ada@example.com" })).toBeNull();
    // A truthy non-boolean must not pass for verification.
    expect(googleVerifiedEmail({ email: "ada@example.com", email_verified: "true" })).toBeNull();
  });

  it("refuses a token carrying no address at all", () => {
    expect(googleVerifiedEmail({ email_verified: true })).toBeNull();
    expect(googleVerifiedEmail(null)).toBeNull();
  });
});

describe("githubVerifiedEmail", () => {
  it("takes the primary verified address and ignores the rest", () => {
    expect(
      githubVerifiedEmail([
        { email: "old@example.com", primary: false, verified: true },
        { email: "Ada@Example.com", primary: true, verified: true },
      ]),
    ).toBe("Ada@Example.com");
  });

  it("refuses an unverified primary rather than falling back to another address", () => {
    expect(
      githubVerifiedEmail([
        { email: "other@example.com", primary: false, verified: true },
        { email: "ada@example.com", primary: true, verified: false },
      ]),
    ).toBeNull();
  });

  it("refuses a payload with no primary verified address", () => {
    expect(githubVerifiedEmail([])).toBeNull();
    expect(githubVerifiedEmail({ message: "Bad credentials" })).toBeNull();
  });
});

describe("findOrCreateAccount", () => {
  it("creates the account on first sight and finds the same one afterwards", async () => {
    const first = await findOrCreateAccount(env.DB, nextId(), "first@example.com", NOW);
    const again = await findOrCreateAccount(env.DB, nextId(), "first@example.com", NOW + 1000);

    expect(again).toEqual<AccountRow>(first);
    expect(first.created_at).toBe(NOW);
  });

  it("gives two different addresses two accounts", async () => {
    const one = await findOrCreateAccount(env.DB, nextId(), "one@example.com", NOW);
    const two = await findOrCreateAccount(env.DB, nextId(), "two@example.com", NOW);

    expect(one.id).not.toBe(two.id);
  });

  it("lands concurrent first approvals of one address on a single account", async () => {
    const [a, b] = await Promise.all([
      findOrCreateAccount(env.DB, nextId(), "race@example.com", NOW),
      findOrCreateAccount(env.DB, nextId(), "race@example.com", NOW),
    ]);

    expect(a?.id).toBe(b?.id);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE email = ?")
      .bind("race@example.com")
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

describe("deviceCodeIsPending", () => {
  it("is true only while an unapproved code is unexpired", async () => {
    await seedCode("PENDING-1", NOW + 1000);
    await seedCode("STALE-1", NOW - 1);

    expect(await deviceCodeIsPending(env.DB, "PENDING-1", NOW)).toBe(true);
    expect(await deviceCodeIsPending(env.DB, "STALE-1", NOW)).toBe(false);
    expect(await deviceCodeIsPending(env.DB, "NEVER-EXISTED", NOW)).toBe(false);

    await approveDeviceCode(env.DB, "PENDING-1", "oa_account", NOW);
    expect(await deviceCodeIsPending(env.DB, "PENDING-1", NOW)).toBe(false);
  });
});

describe("approveDeviceCode", () => {
  it("records the account against the code it approved", async () => {
    await seedCode("BIND-1", NOW + 1000);

    expect(await approveDeviceCode(env.DB, "BIND-1", "oa_owner", NOW)).toBe(true);
    expect(await readCode("BIND-1")).toEqual({ account_id: "oa_owner", approved_at: NOW });
  });

  it("refuses an unknown, expired or already-approved code alike", async () => {
    await seedCode("SPENT-1", NOW + 1000);
    await seedCode("OLD-1", NOW - 1);
    await approveDeviceCode(env.DB, "SPENT-1", "oa_first", NOW);

    expect(await approveDeviceCode(env.DB, "SPENT-1", "oa_second", NOW)).toBe(false);
    expect(await approveDeviceCode(env.DB, "OLD-1", "oa_owner", NOW)).toBe(false);
    expect(await approveDeviceCode(env.DB, "GHOST-1", "oa_owner", NOW)).toBe(false);
  });

  it("leaves a spent code bound to the account that won it", async () => {
    await seedCode("ONCE-1", NOW + 1000);

    await approveDeviceCode(env.DB, "ONCE-1", "oa_first", NOW);
    await approveDeviceCode(env.DB, "ONCE-1", "oa_second", NOW);

    expect(await readCode("ONCE-1")).toEqual({ account_id: "oa_first", approved_at: NOW });
  });
});
