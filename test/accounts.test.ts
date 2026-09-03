import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  confirmDeviceApproval,
  deviceCodeIsPending,
  findOrCreateAccount,
  findPendingHandshake,
  holdProvenIdentity,
  resolveAccountForIdentity,
  startDeviceHandshake,
  type AccountRow,
} from "../src/db.js";
import {
  githubVerifiedIdentity,
  googleVerifiedIdentity,
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
    `SELECT state, verifier, confirm_token, account_id, approved_at
       FROM device_codes WHERE user_code = ?`,
  )
    .bind(userCode)
    .first<{
      state: string | null;
      verifier: string | null;
      confirm_token: string | null;
      account_id: string | null;
      approved_at: number | null;
    }>();
}

async function accountCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Take a code from pending to identity-proven, which is where confirm starts,
 * and hand back the token that press has to carry.
 */
async function proven(userCode: string, state: string, accountId: string): Promise<string> {
  const token = `confirm-${state}`;
  await startDeviceHandshake(env.DB, userCode, "google", state, "verifier", NOW);
  await holdProvenIdentity(env.DB, state, accountId, token, NOW);
  return token;
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

describe("googleVerifiedIdentity", () => {
  it("returns the subject and the address as Google wrote it", () => {
    expect(
      googleVerifiedIdentity({ sub: "108422", email: "Ada@Example.com", email_verified: true }),
    ).toEqual({ subject: "108422", email: "Ada@Example.com" });
  });

  it("refuses an address Google has not verified", () => {
    const claims = { sub: "108422", email: "ada@example.com" };
    expect(googleVerifiedIdentity({ ...claims, email_verified: false })).toBeNull();
    expect(googleVerifiedIdentity(claims)).toBeNull();
    // A truthy non-boolean must not pass for verification.
    expect(googleVerifiedIdentity({ ...claims, email_verified: "true" })).toBeNull();
  });

  it("refuses a token with no address or no subject to remember it by", () => {
    expect(googleVerifiedIdentity({ sub: "108422", email_verified: true })).toBeNull();
    expect(
      googleVerifiedIdentity({ email: "ada@example.com", email_verified: true }),
    ).toBeNull();
    expect(
      googleVerifiedIdentity({ sub: "", email: "ada@example.com", email_verified: true }),
    ).toBeNull();
    expect(googleVerifiedIdentity(null)).toBeNull();
  });
});

describe("githubVerifiedIdentity", () => {
  const USER = { id: 4207, login: "ada" };

  it("takes the numeric id and the primary verified address", () => {
    expect(
      githubVerifiedIdentity(USER, [
        { email: "old@example.com", primary: false, verified: true },
        { email: "Ada@Example.com", primary: true, verified: true },
      ]),
    ).toEqual({ subject: "4207", email: "Ada@Example.com" });
  });

  it("refuses an unverified primary rather than falling back to another address", () => {
    expect(
      githubVerifiedIdentity(USER, [
        { email: "other@example.com", primary: false, verified: true },
        { email: "ada@example.com", primary: true, verified: false },
      ]),
    ).toBeNull();
  });

  it("refuses a payload with no primary verified address", () => {
    expect(githubVerifiedIdentity(USER, [])).toBeNull();
    expect(githubVerifiedIdentity(USER, { message: "Bad credentials" })).toBeNull();
  });

  it("refuses an account resource with no id to remember the person by", () => {
    const emails = [{ email: "ada@example.com", primary: true, verified: true }];
    expect(githubVerifiedIdentity({ login: "ada" }, emails)).toBeNull();
    expect(githubVerifiedIdentity(null, emails)).toBeNull();
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

    await confirmDeviceApproval(env.DB, await proven("PENDING-1", "state-1", "oa_account"), NOW);
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

  it("drops an earlier handshake's identity and confirm token when it restarts", async () => {
    await seedCode("START-5", NOW + 1000);
    await proven("START-5", "state-abandoned", "oa_owner");

    await startDeviceHandshake(env.DB, "START-5", "github", "state-new", "verifier-new", NOW);

    const row = await readCode("START-5");
    // A page from the abandoned attempt must not be able to approve the new one.
    expect(row?.account_id).toBeNull();
    expect(row?.confirm_token).toBeNull();
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
    await confirmDeviceApproval(env.DB, await proven("START-4", "state-done", "oa_account"), NOW);

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
  it("records the account and the confirm token without approving the code", async () => {
    await seedCode("HOLD-1", NOW + 1000);
    await startDeviceHandshake(env.DB, "HOLD-1", "google", "state-hold", "verifier-hold", NOW);

    expect(await holdProvenIdentity(env.DB, "state-hold", "oa_owner", "confirm-hold", NOW)).toBe(
      true,
    );
    const row = await readCode("HOLD-1");
    expect(row?.account_id).toBe("oa_owner");
    expect(row?.confirm_token).toBe("confirm-hold");
    // The signal #57 polls for stays null until a person presses the button.
    expect(row?.approved_at).toBeNull();
    // The verifier is spent, so a replayed callback cannot exchange again.
    expect(row?.verifier).toBeNull();
    // The state survives, because the row stays findable while the page is open.
    expect(row?.state).toBe("state-hold");
  });

  it("refuses a state that names no pending handshake", async () => {
    expect(await holdProvenIdentity(env.DB, "never-issued", "oa_owner", "t", NOW)).toBe(false);
  });

  /**
   * One authorization url can be completed by two different people, and both
   * callbacks read the verifier before either exchange finishes. Unless this
   * write consumes the verifier, the second would overwrite an account whose
   * confirmation page had already been rendered, and that page would then
   * approve the wrong account.
   */
  it("lets exactly one of two overlapping callbacks record an identity", async () => {
    await seedCode("RACE-1", NOW + 1000);
    await startDeviceHandshake(env.DB, "RACE-1", "google", "state-race", "verifier-race", NOW);

    const held = await Promise.all([
      holdProvenIdentity(env.DB, "state-race", "oa_first", "confirm-first", NOW),
      holdProvenIdentity(env.DB, "state-race", "oa_second", "confirm-second", NOW),
    ]);

    expect(held.filter(Boolean)).toHaveLength(1);
    // Whichever won, the account and the token that can approve it agree.
    const winner = held[0] === true ? "first" : "second";
    const row = await readCode("RACE-1");
    expect(row?.account_id).toBe(`oa_${winner}`);
    expect(row?.confirm_token).toBe(`confirm-${winner}`);
  });
});

describe("confirmDeviceApproval", () => {
  it("approves the code the proven handshake belongs to", async () => {
    await seedCode("OK-1", NOW + 1000);
    const token = await proven("OK-1", "state-ok", "oa_owner");

    expect(await confirmDeviceApproval(env.DB, token, NOW)).toBe("OK-1");
    const row = await readCode("OK-1");
    expect(row).toMatchObject({ account_id: "oa_owner", approved_at: NOW });
    // Both cleared, so the same press cannot be replayed.
    expect(row?.state).toBeNull();
    expect(row?.confirm_token).toBeNull();
  });

  /**
   * `state` reaches whoever *started* the handshake, in the redirect they were
   * given. If it could approve, an attacker could start one on their own code,
   * send the provider's url to a signed-in victim, and approve as them.
   */
  it("refuses the handshake's state, which is no secret from its initiator", async () => {
    await seedCode("STATE-1", NOW + 1000);
    await proven("STATE-1", "state-known", "oa_owner");

    expect(await confirmDeviceApproval(env.DB, "state-known", NOW)).toBeNull();
    expect((await readCode("STATE-1"))?.approved_at).toBeNull();
  });

  it("refuses a handshake whose identity was never proven", async () => {
    await seedCode("NOID-1", NOW + 1000);
    await startDeviceHandshake(env.DB, "NOID-1", "google", "state-noid", "v", NOW);

    expect(await confirmDeviceApproval(env.DB, "confirm-state-noid", NOW)).toBeNull();
    expect((await readCode("NOID-1"))?.approved_at).toBeNull();
  });

  it("refuses a token left over from a handshake that was restarted", async () => {
    await seedCode("RESTART-1", NOW + 1000);
    const stale = await proven("RESTART-1", "state-stale", "oa_owner");
    await startDeviceHandshake(env.DB, "RESTART-1", "github", "state-fresh", "verifier", NOW);

    expect(await confirmDeviceApproval(env.DB, stale, NOW)).toBeNull();
    expect((await readCode("RESTART-1"))?.approved_at).toBeNull();
  });

  it("refuses an unknown token, an expired code and a second press alike", async () => {
    await seedCode("ONCE-1", NOW + 1000);
    await seedCode("OLD-1", NOW - 1);
    const spent = await proven("ONCE-1", "state-once", "oa_first");
    await confirmDeviceApproval(env.DB, spent, NOW);
    await env.DB.prepare(
      "UPDATE device_codes SET confirm_token = ?, account_id = ? WHERE user_code = 'OLD-1'",
    )
      .bind("confirm-old", "oa_owner")
      .run();

    expect(await confirmDeviceApproval(env.DB, spent, NOW)).toBeNull();
    expect(await confirmDeviceApproval(env.DB, "confirm-old", NOW)).toBeNull();
    expect(await confirmDeviceApproval(env.DB, "never-issued", NOW)).toBeNull();
  });

  it("leaves an approved code bound to the account that won it", async () => {
    await seedCode("WIN-1", NOW + 1000);
    const token = await proven("WIN-1", "state-win", "oa_first");

    const [first, second] = await Promise.all([
      confirmDeviceApproval(env.DB, token, NOW),
      confirmDeviceApproval(env.DB, token, NOW),
    ]);

    expect([first, second].filter((code) => code !== null)).toEqual(["WIN-1"]);
    expect((await readCode("WIN-1"))?.account_id).toBe("oa_first");
  });
});

describe("resolveAccountForIdentity", () => {
  const GOOGLE = "google";
  const GITHUB = "github";

  it("creates the account and links the identity on a first sign-in", async () => {
    const account = await resolveAccountForIdentity(
      env.DB,
      GOOGLE,
      "sub-first",
      "first@example.com",
      nextId(),
      NOW,
    );

    expect(account?.email).toBe("first@example.com");
    const linked = await env.DB.prepare(
      "SELECT account_id, created_at FROM identities WHERE provider = ? AND subject = ?",
    )
      .bind(GOOGLE, "sub-first")
      .first<{ account_id: string; created_at: number }>();
    expect(linked).toEqual({ account_id: account?.id, created_at: NOW });
  });

  /**
   * The whole point of storing a subject: the address on an account can change
   * under it, and the person keeps their documents.
   */
  it("returns a known subject to its account even when the email has changed", async () => {
    const first = await resolveAccountForIdentity(
      env.DB,
      GOOGLE,
      "sub-stable",
      "old@example.com",
      nextId(),
      NOW,
    );

    const again = await resolveAccountForIdentity(
      env.DB,
      GOOGLE,
      "sub-stable",
      "new@example.com",
      nextId(),
      NOW + 1000,
    );

    expect(again?.id).toBe(first?.id);
    // The account row is left alone; the address it was created with stands.
    expect(again?.email).toBe("old@example.com");
    expect(await accountCount()).toBe(1);
  });

  /**
   * The reassigned mailbox. The previous holder's Google account still exists,
   * somebody else now verifies the same address with Google, and merging them
   * would hand over the previous holder's documents.
   */
  it("refuses a new subject presenting an address the same provider already claims", async () => {
    const original = await resolveAccountForIdentity(
      env.DB,
      GOOGLE,
      "sub-leaver",
      "shared@example.com",
      nextId(),
      NOW,
    );

    const successor = await resolveAccountForIdentity(
      env.DB,
      GOOGLE,
      "sub-successor",
      "shared@example.com",
      nextId(),
      NOW + 1000,
    );

    expect(successor).toBeNull();
    // Nothing was created and nothing was moved.
    expect(await accountCount()).toBe(1);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM identities WHERE account_id = ?",
    )
      .bind(original?.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  /**
   * Two previously unseen subjects on one provider can verify one address at
   * the same moment. A check before the write would let both through, which is
   * worse than not refusing at all: the account would be permanently shared and
   * no later sign-in would notice.
   */
  it("lets only one of two racing subjects claim an address on one provider", async () => {
    const resolved = await Promise.all([
      resolveAccountForIdentity(env.DB, GOOGLE, "sub-one", "one@example.com", nextId(), NOW),
      resolveAccountForIdentity(env.DB, GOOGLE, "sub-two", "one@example.com", nextId(), NOW),
    ]);

    expect(resolved.filter((account) => account !== null)).toHaveLength(1);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM identities WHERE provider = ?",
    )
      .bind(GOOGLE)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("keeps one account to one subject per provider even when asked twice", async () => {
    const first = await resolveAccountForIdentity(
      env.DB,
      GOOGLE,
      "sub-holder",
      "held@example.com",
      nextId(),
      NOW,
    );

    // The same account, reached again through its address by another subject.
    expect(
      await resolveAccountForIdentity(
        env.DB,
        GOOGLE,
        "sub-other",
        "held@example.com",
        nextId(),
        NOW + 1000,
      ),
    ).toBeNull();
    expect(first).not.toBeNull();
  });

  it("still links a second provider on the same address, with no linking step", async () => {
    const viaGoogle = await resolveAccountForIdentity(
      env.DB,
      GOOGLE,
      "sub-google",
      "both@example.com",
      nextId(),
      NOW,
    );

    const viaGitHub = await resolveAccountForIdentity(
      env.DB,
      GITHUB,
      "4207",
      "both@example.com",
      nextId(),
      NOW + 1000,
    );

    expect(viaGitHub?.id).toBe(viaGoogle?.id);
    expect(await accountCount()).toBe(1);
  });

  /**
   * Two first sign-ins for one subject can overlap while the provider reports
   * two different addresses, and each picks a different account. Only one
   * identity row survives, so both callers have to be given the account that
   * every later sign-in will resolve to — otherwise one device code is approved
   * onto an account its owner can never reach again.
   */
  it("gives both racing sign-ins the account the identity actually names", async () => {
    const [a, b] = await Promise.all([
      resolveAccountForIdentity(env.DB, GOOGLE, "sub-moved", "before@example.com", nextId(), NOW),
      resolveAccountForIdentity(env.DB, GOOGLE, "sub-moved", "after@example.com", nextId(), NOW),
    ]);

    expect(a?.id).toBe(b?.id);
    const linked = await env.DB.prepare(
      "SELECT account_id FROM identities WHERE provider = ? AND subject = ?",
    )
      .bind(GOOGLE, "sub-moved")
      .first<{ account_id: string }>();
    expect(a?.id).toBe(linked?.account_id);
  });

  it("links one identity row when a subject signs in twice at once", async () => {
    const [a, b] = await Promise.all([
      resolveAccountForIdentity(env.DB, GOOGLE, "sub-race", "race@example.com", nextId(), NOW),
      resolveAccountForIdentity(env.DB, GOOGLE, "sub-race", "race@example.com", nextId(), NOW),
    ]);

    expect(a?.id).toBe(b?.id);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM identities WHERE provider = ? AND subject = ?",
    )
      .bind(GOOGLE, "sub-race")
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect(await accountCount()).toBe(1);
  });
});
