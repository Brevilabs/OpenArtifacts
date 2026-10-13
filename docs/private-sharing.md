# Private sharing and reader identity

**Status: built.** A document's owner can make it "Only those invited" and add
people by email. This file is how it works and why it has this shape; the
endpoints are in [http-api.md](http-api.md), and the one-time setup is in
[deploying.md](deploying.md#private-sharing).

[← README](../README.md) · [Serving domain](serving-domain.md) · [Identity](identity.md) · [Comments](comments.md) · [HTTP API](http-api.md)

## What a person sees

An owner (from Copilot's share dialog or `openartifacts share`) sets a document
to **Only those invited** and adds `alice@acme.com`. Alice gets an email with the
title and the same `openartifacts.site/d/…` link every document has. She opens
it, signs in once with Google, GitHub or an emailed code, and reads. Everyone
else sees "not available". Removing Alice takes effect on her next request.
Switching back to **Anyone with the link** makes the same url public again for
everyone, with no sign-in, exactly as before.

**Public documents did not change.** `link_access` defaults to `anyone` for every
document, old and new, and the public path serves the same url, headers, caching
and bytes it always did, with no sign-in and no cookie.

## The constraint everything else follows from

`openartifacts.site` runs every author's scripts on purpose, with an open
`connect-src`. `src/serve.ts` justifies that policy by what the origin holds:
nothing to steal. A reader session on that origin would falsify it, because any
document a reader opens could use it with a same-origin `fetch` to read every
private document that reader can reach. `HttpOnly` stops a script reading a
cookie, not using it.

A grant alone does not fix a shared origin either. A hostile public document can
`window.open` a private one, wait for the popup to return from sign-in, and read
the grant out of `popup.location`, because both pages are on one origin.

So the rule that replaces "the origin is cookieless" is: **no origin that runs
more than one author's scripts ever holds a credential.** Each private document
therefore lives on an origin of its own, where only its author's scripts run.

## Three hosts, one rule

| Host | Serves | Credential it holds |
| --- | --- | --- |
| `openartifacts.site` | Public documents, unchanged. A redirect for private ones. | None, ever |
| `api.openartifacts.ai` | The bearer API, reader sign-in, `/open/{docId}` | The reader session cookie |
| `{label}.openartifacts.site` | Exactly one private document, all its versions | That document's grant cookie |

`label` is the first 16 bytes of `SHA-256("openartifacts-origin-v1:" + docId)` in
Crockford base32, 26 characters, derived and never stored. It is one-way, so the
hostname in DNS and TLS SNI does not reveal the doc id, which stays in the
encrypted path where it was always secret. A label host answers `404` for any
path whose doc id does not hash to its label, so a host never serves another
document.

```
reader  → openartifacts.site/d/{docId}        302, no-store → api.openartifacts.ai/open/{docId}
reader  → api.openartifacts.ai/open/{docId}   session? on the list or the owner?
                                              302 → {label}.openartifacts.site/d/{docId}?grant=…   (valid 60 s)
reader  → {label}.openartifacts.site/d/…?grant=…   303 + Set-Cookie (1 h), to the clean url
reader  → {label}.openartifacts.site/d/{docId}     200, private, no-store
```

- **The grant never stays in the address bar.** The document's own origin swaps
  it for a one-hour `__Host-oa_grant` cookie with a bodiless `303`, so it is not
  a live credential a reader can paste to someone who was not invited.
- **The cookie names a principal, not a permission.** Every request reads the
  invite list in D1 again, so removing a person takes effect on their next
  request. A tab they already have open keeps what it loaded.
- **Lifetimes:** URL grant 60 seconds, document cookie one hour, reader session
  thirty days. Sign-out ends the session at once.
- **The three signed values use different prefixes in the signed input**, so none
  can be replayed as another (`src/session.ts`).

### Why an author's script cannot steal access

- A hostile document can start a grant by navigating to `/open/{target}`, since a
  top-level navigation is the only request that carries the `Lax` session cookie.
  The grant lands on the target's own origin, which the attacker cannot script,
  and `Cross-Origin-Opener-Policy: same-origin-allow-popups` cuts the attacker's
  window reference.
- A document's own scripts reach only that document: they never see the URL grant
  (the label host answers it with a bodiless `303`), and the cookie they can make
  same-origin requests with opens only the document their author already has.
- Other origins carry no session cookie on `fetch`, frames or subresources, and
  CORS and `Cross-Origin-Resource-Policy: same-origin` stop them reading a label
  host's response.

## Who may read a document

The unit is the document. Two additions, in migration `0014`: `docs.link_access`
(`anyone` or `invited`) and `doc_invites (doc_id, email)`, at most 100 people so
the list never needs paging. The invite list is independent of the mode:
switching to `anyone` keeps it, and switching back restores it. Unshare deletes
the invites with the bytes and keeps the row for the `410`.

A principal may read an invited-only document when it is in the document's owner
scope (`OWNER_SCOPE_SQL`, so a license key and its linked account are one owner)
or is an account whose email is on the list. The principal is a reader's account
id, or a publisher's owner id for the owner route below. One query answers it
(`findPrivateRead`), for both the API host and the document's origin.

When spaces arrive, they add `spaces`, `space_invites` and a nullable
`docs.space_id`, and access becomes "invited to the document or to its space". No
existing row moves.

## Reader identity

A reader is an `accounts` row, the same principal a publisher is.

- **Google and GitHub** reuse the device-code handshake: a `device_codes` row with
  a `reader_` prefix, the shared `/approve/callback/{provider}`, and the Terms step
  for a first-time account. The OAuth `state` is also bound to the starting
  browser by a short-lived signed `__Host-oa_login` cookie, so a callback link
  forwarded to somebody else does not sign them in.
- **Emailed codes:** six digits, ten minutes, five wrong guesses, stored hashed,
  rate-limited per address and per client. A code signs in to any address except
  one whose account already signs in with Google or GitHub, which keeps
  [identity.md](identity.md)'s recycled-mailbox refusal true for every
  provider-backed account. A request for a new code keeps the count of wrong
  guesses, and a code that has used them all cannot be replaced until it expires.
- **The session** is `__Host-oa_session` on the API host (`HttpOnly`, `Secure`,
  `SameSite=Lax`, `Path=/`, thirty days): an HMAC over `{accountId, expiresAt}`
  keyed by `READER_SESSION_SECRET`. Only `/open` and `/signin` read it, and
  `/api/v1` stays bearer-only, so the cookie adds no cross-site request surface to
  the API. Rotating the secret signs every reader out.
- **Owners with a license key never sign in.** `POST /api/v1/docs/{docId}/open`
  returns their own page's url with a 60-second grant whose principal is their
  owner id. Clients open it and discard it; publish receipts never carry a grant.

The sign-in pages return only to an `/open/…` path, rebuilt from the parsed
document id, so they cannot become an open redirect.

## Plans

The plan is checked on write, in the Worker, and only on the two operations that
spend it: making a document invited-only, and adding a person. Removing people and
switching to `anyone` never need it, and reading never checks a plan, so invitees
never pay. A lapsed plan keeps what exists: private documents stay private and
current invitees keep reading; new invites and new private documents get
`402 limit_reached` with `limit: "privateSharing"`.

A license-key publisher gets the same code and limit with the message "Your Copilot
plan does not include private sharing." and no `upgrade_url`, because they manage
their plan in Copilot, not with the OpenArtifacts CLI.

Account plans carry `"privateSharing": true` in `PLAN_LIMITS` (the hosted `pro`
plan). License keys use `PRIVATE_SHARING_LICENSE_PLANS` in `src/auth.ts` (`plus`).
Which other plans qualify is a pricing decision, not a code one.

## Email

Invites and sign-in codes go through the Cloudflare Email Service `send_email`
binding from a dedicated sending subdomain, so abuse cannot hurt the brand
domain's mail reputation. It is optional like the OAuth secrets: without the
binding no invite is sent and the code form is not offered, and Google and GitHub
still work.

The first add of an address sends one invite: who shared it (the owner's account
email, when the Worker knows it), the title, the canonical link, and "sign in with
this address". The address is on the list whether or not the email goes out.
Invite abuse is bounded by paid-only adds, a per-owner limiter, the sending
subdomain, and links that always point at the sacrificial domain.

## Revocation and caching

- **Removing a person** takes effect on their next request: 0 seconds, because the
  list is read live.
- **Making a public document private** takes effect on the next request. Copies
  fetched while it was public cannot be recalled, including pinned `/v{n}` pages
  a browser may keep for a year. This is the limit [http-api.md](http-api.md)
  already states for unshare.
- **No private bytes reach a shared cache.** Private responses are
  `private, no-store`, pinned versions included, and the redirect on
  `openartifacts.site` is `no-store`. Label hosts are never cache-rule targets.
  When an edge cache exists (see [CLAUDE.md](../CLAUDE.md)), "make private" must
  purge it exactly as delete does.
- **Cost:** private reads cannot be cached. A first open costs four Worker
  invocations, three D1 reads and one R2 read; a reload costs one of each.

## Rollback floor

Once any document is invited-only, a Worker older than the private-sharing deploy
would serve it publicly at its canonical url. That deploy is a hard rollback
floor; [deploying.md](deploying.md#private-sharing) says where to record it.

## What is not built

- A web share dialog for CLI publishers. The CLI's `share` command covers them.
- Domain rules ("anyone at acme.com"), which would be one more `link_access` value.
- Spaces, and folding of address variants (`+tag`, Gmail dots).
- Edge caching, which [#33](https://github.com/Brevilabs/OpenArtifacts/issues/33) owns.
- Single-use URL grants: someone who reads one out of a reader's history within its
  60 seconds could open the document as that reader. Making it single-use costs a
  D1 write on every open.

## What comes next

[comments.md](comments.md) is blocked on reader identity, which now exists. When
both ship, a private document's threads resource is served from its label host
behind the same check, and the comments sidebar keeps its own token because it
runs in a third-party iframe where cookies are unreliable. Agents as first-class
participants (a token scoped to one document, issued by the human it acts for) is
the step after that.
