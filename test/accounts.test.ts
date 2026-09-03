import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  confirmDeviceApproval,
  deviceCodeIsPending,
  findOrCreateAccount,
  findPendingHandshake,
  holdProvenIdentity,
  startDeviceHandshake,
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
    "SELECT state, verifier, account_id, approved_at FROM device_codes WHERE user_code = ?",
  )
    .bind(userCode)
    .first<{
      state: string | null;
      verifier: string | null;
      account_id: string | null;
      approved_at: number | null;
    }>();
}

/** Take a code from pending to identity-proven, which is where confirm starts. */
async function proven(userCode: string, state: string, accountId: string): Promise<void> {
  await startDeviceHandshake(env.DB, userCode, "google", state, "verifier", NOW);
  await holdProvenIdentity(env.DB, state, accountId, NOW);
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

    await proven("PENDING-1", "state-1", "oa_account");
    await confirmDeviceApproval(env.DB, "state-1", NOW);
    expect(await deviceCodeIsPending(env.DB, "PENDING-1", NOW)).toBe(false);
  });
});

describe("startDeviceHandshake", () => {
  it("records the handshake against a code that is still waiting", async () => {
    await seedCode("START-1", NOW + 1000);

    expect(
      await startDeviceHandshake(env.DB, "START-1", "google", "state-a", "verifier-a", NOW),
    ).toBe(true);
    const row = await readCode("START-1");
    expect(row?.state).toBe("state-a");
    expect(row?.verifier).toBe("verifier-a");
    // Starting a handshake is not approving anything.
    expect(row?.approved_at).toBeNull();
  });

  it("replaces an earlier handshake, so only the newest one can be finished", async () => {
    await seedCode("START-2", NOW + 1000);

    await startDeviceHandshake(env.DB, "START-2", "google", "state-first", "v1", NOW);
    await startDeviceHandshake(env.DB, "START-2", "github", "state-second", "v2", NOW);

    expect(await findPendingHandshake(env.DB, "state-first", NOW)).toBeNull();
    expect(await findPendingHandshake(env.DB, "state-second", NOW)).toEqual({
      user_code: "START-2",
      provider: "github",
      verifier: "v2",
    });
  });

  it("drops the identity an earlier handshake proved, so a restart cannot be approved for it (https://github.com/Brevilabs/OpenArtifacts/pull/61#discussion_r3919988470)", async () => {
    await seedCode("START-5", NOW + 1000);
    await proven("START-5", "state-proved", "oa_victim");

    await startDeviceHandshake(env.DB, "START-5", "google", "state-restarted", "v2", NOW);

    expect((await readCode("START-5"))?.account_id).toBeNull();
    expect(await confirmDeviceApproval(env.DB, "state-restarted", NOW)).toBeNull();
  });

  it("refuses an unknown, expired or already-approved code alike", async () => {
    await seedCode("START-3", NOW - 1);
    await seedCode("START-4", NOW + 1000);
    await proven("START-4", "state-done", "oa_account");
    await confirmDeviceApproval(env.DB, "state-done", NOW);

    expect(await startDeviceHandshake(env.DB, "START-3", "google", "s", "v", NOW)).toBe(false);
    expect(await startDeviceHandshake(env.DB, "START-4", "google", "s", "v", NOW)).toBe(false);
    expect(await startDeviceHandshake(env.DB, "GHOST", "google", "s", "v", NOW)).toBe(false);
  });
});

describe("findPendingHandshake", () => {
  it("resolves the state a provider hands back to the code it belongs to", async () => {
    await seedCode("FIND-1", NOW + 1000);
    await startDeviceHandshake(env.DB, "FIND-1", "github", "state-find", "verifier-find", NOW);

    expect(await findPendingHandshake(env.DB, "state-find", NOW)).toEqual({
      user_code: "FIND-1",
      provider: "github",
      verifier: "verifier-find",
    });
  });

  it("finds nothing for an unknown state or an expired code", async () => {
    await seedCode("FIND-2", NOW + 1000);
    await startDeviceHandshake(env.DB, "FIND-2", "google", "state-late", "v", NOW);

    expect(await findPendingHandshake(env.DB, "never-issued", NOW)).toBeNull();
    expect(await findPendingHandshake(env.DB, "state-late", NOW + 2000)).toBeNull();
  });
});

describe("holdProvenIdentity", () => {
  it("records the account without approving the code", async () => {
    await seedCode("HOLD-1", NOW + 1000);
    await startDeviceHandshake(env.DB, "HOLD-1", "google", "state-hold", "verifier-hold", NOW);

    expect(await holdProvenIdentity(env.DB, "state-hold", "oa_owner", NOW)).toBe(true);
    const row = await readCode("HOLD-1");
    expect(row?.account_id).toBe("oa_owner");
    // The signal #57 polls for stays null until a person presses the button.
    expect(row?.approved_at).toBeNull();
    // The verifier is spent, so a replayed callback cannot exchange again.
    expect(row?.verifier).toBeNull();
    // The state survives, because the confirm form is about to carry it back.
    expect(row?.state).toBe("state-hold");
  });

  it("refuses a state that names no pending handshake", async () => {
    expect(await holdProvenIdentity(env.DB, "never-issued", "oa_owner", NOW)).toBe(false);
  });
});

describe("confirmDeviceApproval", () => {
  it("approves the code the proven handshake belongs to", async () => {
    await seedCode("OK-1", NOW + 1000);
    await proven("OK-1", "state-ok", "oa_owner");

    expect(await confirmDeviceApproval(env.DB, "state-ok", NOW)).toBe("OK-1");
    const row = await readCode("OK-1");
    expect(row).toMatchObject({ account_id: "oa_owner", approved_at: NOW });
    // Cleared, so the same press cannot be replayed.
    expect(row?.state).toBeNull();
  });

  it("refuses a handshake whose identity was never proven", async () => {
    await seedCode("NOID-1", NOW + 1000);
    await startDeviceHandshake(env.DB, "NOID-1", "google", "state-noid", "v", NOW);

    expect(await confirmDeviceApproval(env.DB, "state-noid", NOW)).toBeNull();
    expect((await readCode("NOID-1"))?.approved_at).toBeNull();
  });

  it("refuses an unknown state, an expired code and a second press alike", async () => {
    await seedCode("ONCE-1", NOW + 1000);
    await seedCode("OLD-1", NOW - 1);
    await proven("ONCE-1", "state-once", "oa_first");
    await confirmDeviceApproval(env.DB, "state-once", NOW);
    await env.DB.prepare(
      "UPDATE device_codes SET state = ?, account_id = ? WHERE user_code = 'OLD-1'",
    )
      .bind("state-old", "oa_owner")
      .run();

    expect(await confirmDeviceApproval(env.DB, "state-once", NOW)).toBeNull();
    expect(await confirmDeviceApproval(env.DB, "state-old", NOW)).toBeNull();
    expect(await confirmDeviceApproval(env.DB, "never-issued", NOW)).toBeNull();
  });

  it("leaves an approved code bound to the account that won it", async () => {
    await seedCode("WIN-1", NOW + 1000);
    await proven("WIN-1", "state-win", "oa_first");

    const [first, second] = await Promise.all([
      confirmDeviceApproval(env.DB, "state-win", NOW),
      confirmDeviceApproval(env.DB, "state-win", NOW),
    ]);

    expect([first, second].filter((code) => code !== null)).toEqual(["WIN-1"]);
    expect((await readCode("WIN-1"))?.account_id).toBe("oa_first");
  });
});
