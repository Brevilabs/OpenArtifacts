# Who owns a document

**The rule: a document belongs to an account, never to the credential used to
publish it.**

A license key is a way of proving who you are. It is not who you are. Keeping
those two apart is what lets someone replace a key, hold two of them, or arrive
having never made one — and see the same documents throughout.

[← README](../README.md) · [HTTP API](http-api.md) · [Private sharing](private-sharing.md)

## Two kinds of owner

`docs.owner` is an opaque string. Nothing parses it, and every query only ever
compares it for equality. Two things put a value there, and they are deliberately
never mixed:

| Credential | Owner id | Where it comes from |
| --- | --- | --- |
| A Brevilabs license key | an app-sites `User.id` (a uuid) | `license.validateLicenseKey` returns it as `accountId` |
| An OpenArtifacts account | `oa_` and 26 base32 characters | `newAccountId`, minted by the first approval |

An account here holds an id, one verified email address, and the time it was
created. That is the whole `accounts` table, and nothing else about a person is
read, requested or stored — no name, no avatar, no provider account id.

**The prefix is load-bearing.** An app-sites uuid cannot start with `oa_`, so the
two id spaces cannot collide, and no equality test between them can accidentally
succeed and hand one account another's documents. That property is what makes it
safe for one column to carry both.

### Why they are not merged

A Copilot user who approves with the address on their license gets a *new*
account, not the one their license key resolves to. Merging them would mean
treating a verified email as proof of holding a particular license, which is a
claim OAuth cannot make and the license server was never asked. So a Copilot user
who wants their plugin documents from the CLI presents the same license key the
plugin does — the API accepts it — and the two shelves stay separate until there
is a deliberate exchange between them. That exchange is the follow-up named in
[#55](https://github.com/Brevilabs/OpenArtifacts/issues/55), and it is also what
eventually moves the license code out of this repo.

## How an account comes into existence

There is no sign-up form, no sign-in page and no session. The only human surface
is one approval page.

1. An agent's CLI has no token, so it asks for a device code and prints a url.
2. The person opens it. `GET /approve?user_code=…` shows the code and one button
   per configured provider.
3. They pick Google or GitHub. The handshake's OAuth `state` and PKCE verifier
   go into a signed, HttpOnly cookie that expires in five minutes.
4. The provider redirects back to `/approve/callback/{provider}`. The state is
   checked against the cookie, the authorization code is exchanged, and the
   provider's **verified** address is read.
5. That address resolves to an account, creating one if it is new, and the
   account is bound to the device code the CLI is polling.

The first approval an address makes is the registration. Every one after it finds
the same account, whichever provider proved it — the address is folded to
lowercase in one place, so Google and GitHub on one mailbox never become two
shelves. When the page is done the cookie is cleared and nothing about the
browser is remembered, because the token the CLI holds is the credential from
then on.

The device flow either side of that page — minting the code, polling it, and
issuing the token an approval earns — is
[#57](https://github.com/Brevilabs/OpenArtifacts/issues/57). This repo owns the
`accounts` row and the one write that binds a code to it.

## Three properties that are load-bearing

**An owner id is an identifier, never a credential.** It is safe to store, log
and pass between services only because holding one grants nothing: the owner is
always *derived*, from a validated license key or a completed approval, and never
accepted as input. Nothing in [`http-api.md`](http-api.md) takes or returns one.
An endpoint that accepted an owner id as a parameter would silently turn every id
into a password — this is the easiest way to undo the model, and it would not
look like a security change when it was written.

**An account is only as sound as the provider's email verification.**
`accounts.email` is unique, so an address is a claim on an account and on every
document that account has published. Approval therefore accepts an address only
when the provider says it verified it: Google's `email_verified` in the id token,
and GitHub's primary address from `/user/emails` with `verified` set. Taking an
address a provider merely reported would let anyone who can assert one take over
the documents of whoever owns it. This check is about document ownership, not
about login, and must not be relaxed without knowing that.

**A license key never changes hands, and the validation cache depends on that.**
`LicenseKeyConfig.authUserId` is written when a key is created and is never
updated. That is what makes it safe to serve a cached owner for an hour without
re-asking: the value cannot have moved. Introducing key transfer upstream would
turn this cache into a hole, because a transferred key would keep resolving to
its previous account — and so keep listing, updating and unsharing that account's
documents — until the row expired. Transfer needs a cache purge shipped with it,
or it must stay impossible.

### Why `publishers` is still keyed by the key hash

Ownership no longer is, which makes it a fair question. Three reasons:

1. **It is the only thing derivable from a request without a network call.** The
   request carries a license key; the account is on the far side of the license
   server. A cache keyed by account could not be read without first making the
   call the cache exists to avoid.
2. **Revocation and plan are per key.** `LicenseKeyConfig` carries `plan` and
   `delete` per license key, not per user. If two keys shared one row they would
   share one `validated_at`, so validating a good key would refresh the row a
   revoked key reads — and the revoked one would keep publishing until the TTL
   expired.
3. **They answer different questions.** `publishers.key_hash` is "what do I know
   about this credential"; `docs.owner` is "whose document is this";
   `publishers.owner` is the mapping between them.

The hash never leaves `src/auth.ts`. It is an index, not an identity.

## Why there is no session

A session is a credential that outlives the request that created it, and here it
would exist to serve a dashboard that does not exist: listing documents,
unsharing one, and revoking a token are all CLI commands. Without a dashboard, a
session buys nothing and costs a store, an expiry policy, and a cookie on a
browser that has no further business with us.

The one cookie this Worker sets carries a handshake in progress, lives for five
minutes, and is confined to `/approve` on the API host. **The serving origin sets
no cookie at all**, which [`http-api.md`](http-api.md) promises and a test now
asserts on every reader-facing response — publishers' own scripts run there, and
that is only acceptable while there is nothing on the origin for them to steal.

## What this does not do

- **It does not follow an email change.** The owner is the account id, which is
  stable across email changes. Changing the address on an existing account has no
  path yet; a new address approves into a new account.
- **It does not give a credential its own documents.** Two keys on one account,
  or two machines' tokens on one account, share one list, one daily push
  allowance and one document ceiling. Isolation is per account, and
  [`http-api.md`](http-api.md) says so.
- **It does not survive the account being deleted.** Nothing reacts to a `User`
  row disappearing upstream, and nothing deletes an `accounts` row here. The
  documents would simply stop being reachable by anyone. Worth solving before
  there are accounts worth deleting.
- **It does not decide what an account may do.** Entitlement is a separate
  question, answered per operation — today by the license key's plan, next by
  [#60](https://github.com/Brevilabs/OpenArtifacts/issues/60)'s plan config. An
  account exists before it is allowed to do anything.
