-- Accounts OpenArtifacts owns, created by the first approval.
--
-- Until now the only identity in this repo was a Brevilabs license key, and
-- `docs.owner` was always an app-sites `User.id` resolved through the license
-- server. That made an open source project depend on a private service, and it
-- left anyone without a Copilot license with nothing to publish as. An account
-- here is the other way in: a verified email, an id of our own, and nothing
-- else.
--
-- The two id spaces are deliberately disjoint rather than merged. A license
-- key keeps resolving to its app-sites uuid, an account minted here carries the
-- `oa_` prefix `newAccountId` gives it, and no equality test can ever confuse
-- one for the other. Merging them would mean trusting an email to name an
-- app-sites account, which is exactly the claim OAuth cannot make.

CREATE TABLE accounts (
  id         TEXT    PRIMARY KEY,
  -- The address a provider asserted *and* said it had verified. Unique, because
  -- it is the only thing that makes approving with Google and then with GitHub
  -- land on one account rather than two. Stored lowercased and trimmed
  -- (`normalizeEmail`), since the uniqueness is only as good as the folding.
  email      TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- The provider identities that resolve to an account on a later sign-in.
--
-- `accounts.email` is what *creates* an account and links a second provider to
-- it, and it must not be what *returns* someone to one. A mailbox is
-- recyclable: a corporate or custom-domain address can be reassigned, and its
-- new holder can verify it with the same provider perfectly honestly. Resolving
-- a returning sign-in by email alone would hand them the previous holder's
-- documents. A provider's subject is not recyclable — Google's `sub` and
-- GitHub's numeric user id are permanent and never reissued — so it is what a
-- returning sign-in is looked up by.
--
-- No foreign key onto `accounts`, for the reason `device_codes` has none: D1
-- leaves `PRAGMA foreign_keys` off, so the constraint would be documentation
-- that does not run, and the only writer is `resolveAccountForIdentity`, which
-- has the account row in hand.
CREATE TABLE identities (
  -- `google` or `github`, matching `PROVIDER_IDS`.
  provider   TEXT    NOT NULL,
  -- The provider's own permanent id for the person: Google's `sub` claim, or
  -- GitHub's numeric user id as a string. Never an email, never a username —
  -- both of those can move to somebody else.
  subject    TEXT    NOT NULL,
  account_id TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);

-- The pending device codes an approval binds an account to, and the OAuth
-- handshake that proves who is approving one.
--
-- **Minimal on purpose: #57 owns the device flow and extends this table.** The
-- approval page needs somewhere to keep a handshake in flight and somewhere to
-- record the outcome, so only those columns exist here. The device code the CLI
-- holds, its token, the machine label and the polling bookkeeping all belong to
-- #57, which should add columns to this table rather than create a second one.
--
-- The handshake lives in this row rather than in a signed cookie because the
-- browser is not the thing being authorized — the terminal is. Keeping it here
-- means the Worker sets no cookie on any surface, which is what lets the
-- serving origin's cookieless promise stay an absolute rather than a
-- host-by-host argument.
--
-- `user_code` is the primary key because it is what the human sees and what the
-- approval url carries. It is stored uppercase; `normalizeUserCode` folds the
-- request's copy so a code typed by hand still matches.
CREATE TABLE device_codes (
  user_code   TEXT    PRIMARY KEY,
  -- Which provider the handshake in flight was started with, so a callback
  -- cannot be replayed at the other provider's endpoint. Null between
  -- handshakes.
  provider    TEXT,
  -- The OAuth `state`, and the only thing that ties three separate requests
  -- together: the provider's redirect back names it, and the confirm form
  -- carries it in a hidden field. Unguessable, and the confirm write clears it,
  -- so it is single-use. Null between handshakes.
  state       TEXT,
  -- The PKCE code verifier for the handshake in flight, cleared once spent.
  verifier    TEXT,
  -- The account whose email a completed handshake proved. It is written before
  -- `approved_at` and means nothing on its own: the code is not approved until
  -- a person presses the button on the confirm page.
  account_id  TEXT,
  -- Epoch ms of that press, and null until then. This column alone is what #57
  -- polls on: an account_id without it is an identity proven and an approval
  -- not yet given.
  approved_at INTEGER,
  -- Epoch ms. Every step of the handshake is refused past it, so a code left on
  -- a screen overnight cannot be approved by whoever walks past next.
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- The callback and the confirm both arrive knowing only the state, so it is the
-- lookup key and has to be one row exactly. Partial, so the many rows between
-- handshakes do not collide on null and cost nothing to hold.
CREATE UNIQUE INDEX device_codes_by_state
  ON device_codes (state)
  WHERE state IS NOT NULL;
