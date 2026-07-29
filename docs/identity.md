# Who owns a document

**The rule: a document belongs to a Brevilabs account, never to the credential
used to publish it.**

A license key is a way of proving who you are. It is not who you are. Keeping
those two apart is what lets someone replace a key, hold two of them, or sign in
to symposium.md having never made one — and see the same documents throughout.

[← README](../README.md) · [HTTP API](http-api.md) · [Private sharing](private-sharing.md)

## The owner id

`docs.owner` holds an **app-sites `User.id`** — the uuid in the Brevilabs
Postgres that identifies a person across every Brevilabs product. Symposium
stores no email and keeps no account table of its own. The id is opaque here:
nothing parses it, and every query only ever compares it for equality.

Two facts make that enough:

- **The license server already resolves a key to it.**
  `license.validateLicenseKey` returns `accountId: LicenseKeyConfig.authUserId`
  on every valid response, alongside the plan.
- **A symposium.md session already carries it.** NextAuth's session callback
  sets `session.user.id` to the same uuid.

So both sides arrive at the identical value without deriving anything. There is
no hashing rule, no email normalisation, and therefore no way for two codebases
to compute it differently and quietly split one person into two.

## How a request resolves to an owner

Today there is one credential, and one day there will be two. They meet at
`Publisher.owner`, and nothing downstream can tell which was used:

```
Authorization: Bearer <license key>   →  license server  →  accountId  ┐
                                                                       ├→  Publisher.owner  →  docs.owner
symposium.md session (JWT)            →  session.user.id              ┘
```

`src/auth.ts` is the only module that sees a license key at all. It hashes the
key immediately, uses that hash as its own validation-cache key, and hands the
rest of the system nothing but an owner and a plan.

### Why `publishers` is still keyed by the key hash

A fair question, since ownership no longer is. Three reasons:

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

The hash never leaves that module. It is an index, not an identity.

## What happens when symposium.md gains sign-in

Almost nothing, which is the point. `User` is one NextAuth table shared by every
app-sites product, so a symposium.md sign-up resolves through the same
`authOptions` Copilot already uses:

| On sign-in | Result |
| --- | --- |
| An `Account` row already links this provider identity | that existing `User.id` |
| Different provider, same verified email | the **same** `User.id` — GitHub and Google both set `allowDangerousEmailAccountLinking: true` |
| Neither matches | the adapter mints a new `User` row |

In all three cases `session.user.id` is the owner. A Copilot user signing in sees
the documents they published from the plugin, with no linking step and no key to
paste. Someone who has never held a license key gets a working, empty list rather
than a dead end. **No join, and no branch on "is this person a Copilot user."**

### The join is for entitlement, not identity

*Who* needs no lookup. *May they publish* does. That gate is currently the
license key's plan, and a symposium.md-only user has no `LicenseKeyConfig` row at
all — so it needs a per-product table, following the shape already in the schema:
`Customer` for Copilot, `MiyoCustomer` for miyo, and a Symposium equivalent keyed
by `authUserId`. Joined on the account, answering *what plan*, never *who*.

Keeping that split is what stops the identity model growing a special case per
product.

## Two properties that are load-bearing

**An owner id is an identifier, never a credential.** It is safe to store, log
and pass between services only because holding one grants nothing: the owner is
always *derived*, from a validated license key or a signed session, and never
accepted as input. Nothing in `docs/http-api.md` takes or returns one. An
endpoint that accepted an owner id as a parameter would silently turn every id
into a password — this is the easiest way to undo the model, and it would not
look like a security change when it was written.

**A license key never changes hands, and the validation cache depends on that.**
`LicenseKeyConfig.authUserId` is written when a key is created and is never
updated — every write to that table in app-sites sets only `delete`. That is what
makes it safe to serve a cached owner for an hour without re-asking: the value
cannot have moved. Introducing key transfer upstream would turn this cache into a
hole, because a transferred key would keep resolving to its previous account —
and so keep listing, updating and unsharing that account's documents — until the
row expired. Transfer needs a cache purge shipped with it, or it must stay
impossible.

**Cross-provider linking rests on the provider's email verification.** With
`allowDangerousEmailAccountLinking` on, a provider asserting an address it does
not own would be handed the matching account. The `signIn` callback blocks any
OAuth sign-in whose email the provider has not verified, which is what makes it
sound. That check is load-bearing for document ownership, not only for login, and
should not be relaxed without knowing that.

## What this does not do

- **It does not follow an email change.** The owner is the account uuid, which is
  stable across email changes — that is a feature, not an omission.
- **It does not give a key its own documents.** Two keys on one account share one
  list, one daily push allowance, and one 500-document ceiling. Isolation is per
  account, and `docs/http-api.md` says so.
- **It does not survive the account being deleted.** Nothing in Symposium
  currently reacts to a `User` row disappearing upstream; the documents would
  simply stop being reachable by anyone. Worth solving before there are accounts
  worth deleting.
