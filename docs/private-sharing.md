# Private sharing and reader identity

**Status: designed, not built.** Nothing here exists in code. It is written down
because two of the decisions are not retrofittable — the same reason
[serving-domain.md](serving-domain.md) exists — and because
[comments.md](comments.md) has a hard dependency on the identity half of it.

[← README](../README.md) · [Serving domain](serving-domain.md) · [Comments](comments.md) · [Positioning](positioning.md)

## The constraint everything else follows from

Today a doc's url *is* its access control. There are no readers, no accounts, no
permissions. That is also what makes the security argument in `src/serve.ts`
work, and it says so out loud:

> the origin is cookieless and holds nothing but already-public docs, so there is
> no session or private data on it to steal

That sentence is what buys `'unsafe-inline'`, `'unsafe-eval'` and an open
`connect-src` — the policy that lets uploaded documents run charts, simulations
and Pyodide. Private sharing falsifies both halves of it at once.

**So the obvious implementation is the one that must not be built.** Put a
session cookie on `symposium.site` and any uploaded document's JavaScript can
issue same-origin `fetch()` calls carrying that session. `HttpOnly` does not
help: it stops a script *reading* the cookie, not *using* it. One hostile
document would read every private document its reader can reach and post the
contents anywhere, because `connect-src` is deliberately open and nothing can
close it while scripts run at all.

Cookies on the serving origin mean choosing between private sharing and
interactive documents. Both are load-bearing.

## The shape: identity never touches the serving origin

`symposium.site` stays cookieless forever. Identity lives on the brand domain,
and access is granted **per document** rather than ambiently.

```
reader → symposium.site/d/{id}      private, no grant → 302
       → symposium.md  sign in       OAuth, session lives here
       → API checks the ACL          mints a short-lived signed grant
       → symposium.site/d/{id}?…     signature verified, bytes served
```

The property that saves the CSP: **a document's scripts can read their own
grant, but cannot forge one for a document they were not given.** Same-origin
stops being a skeleton key, because there is no ambient authority to borrow.

Two questions this leaves, both worth deciding before code:

**Grant transport.** A query signature is simplest and leaks into referrers,
logs and shared screenshots — though `Referrer-Policy: no-referrer` is already
set. A path-scoped `HttpOnly` cookie (`Path=/d/{docId}`) is not sent to another
document's path, which restores most of the isolation, but cookie scoping is a
weaker fence than a signature and puts state back on the origin we promised to
keep clean. Prefer the signature.

**Per-document origins.** Serving each doc from `{docId}.symposium.site` on a
wildcard certificate makes the browser's own origin boundary do the isolating,
which is how `googleusercontent.com` works. It is strictly stronger than
signatures and strictly more moving parts. **This is the retrofit hazard**: it
changes every url the product has ever issued, so it is nearly free to adopt
before there are readers and effectively impossible after. Decide it at Phase 2,
not later.

## What it costs elsewhere

**Caching, and therefore the cost model.** A private document cannot sit in a
shared edge cache. Either `no-store`, or the cache key includes the grant — and
then every reader is a miss. [cost-at-scale.md](cost-at-scale.md) argues serving
is nearly free *because* reads are cacheable; that argument holds for public docs
and fails for private ones. Private sharing is structurally more expensive per
read, which is an argument for it being the paid tier rather than an obstacle
to it.

**The frozen contract.** Two sentences in [http-api.md](http-api.md) stop being
true: *"Reading a doc requires nothing"* and *"Serving responses never set a
cookie."* This is the first change that genuinely requires a client release.

**Unshare gets better.** Today delete cannot recall a copy already fetched. With
expiring grants, access actually lapses, which is much closer to what people
assume "unshare" means.

## Phases

Each phase ships something usable on its own. The ordering is forced by
dependencies, not preference.

### Phase 1 — public links *(shipped)*

The url is the capability. 80 bits of entropy, `noindex`, no reader identity.
Publishing gated to lifetime license holders.

### Phase 2 — privacy without accounts

The cheapest thing that answers "can I share this with only some people".

- **Expiring links.** A grant with a lifetime, signed by the Worker. No reader
  identity, no database work beyond a key.
- **Password on a document.** Publisher sets one; readers exchange it for a
  grant on the brand domain. Still no accounts.

Both are days of work and cover most of what people mean by "private". Neither
tells you *who* read it, which is exactly why they do not unblock comments.

**Decide per-document origins here.** After this phase there are private urls in
circulation and changing their shape breaks them.

### Phase 3 — reader identity

The large one, and the prerequisite for everything after.

- OAuth sign-in on `symposium.md` — Google and GitHub cover nearly everyone
  without our storing a password. The session lives on the brand domain only.
- A `readers` table, and an ACL per document: named readers, or a domain rule
  ("anyone at acme.com"), or public. Public stays the default.
- Grants become per-reader and short-lived, minted after the ACL check.
- The list endpoint learns who a document is shared with.

This is where "who read it" becomes answerable, and where the product stops
being a link and starts being a place.

### Phase 4 — comments

[comments.md](comments.md) is the design; it is blocked on Phase 3 and says so.
Every utterance needs attribution, and an anonymous reader cannot be attributed.

Threads anchor to quotes rather than offsets, so they survive the next push.
Where threads render is the open question that decides whether the cheap-serving
story survives — see that document.

### Phase 5 — agents as first-class participants

The end state, and the reason the product exists: humans and agents converge on
one artifact instead of pasting it between tools.

Agents authenticate too, and **delegated identity is already in the comments
schema**: every comment carries `author` and a nullable `on_behalf_of`. That one
column is the whole feature — a human wrote this, or an agent proposed it and a
human let it through.

- An agent gets a token scoped to one publisher and one document, issued by the
  human it acts for. Not a license key, not a shared secret: something
  revocable, attributable, and narrow.
- Agent-authored comments start `pending` and become visible on approval.
  Approval must batch, or the friction removed from writing comes back as
  moderation — the batching shape is an open question in `comments.md`.
- Agents read one predictable threads resource rather than parsing the page,
  which also settles the question [positioning.md](positioning.md) ends on.

The scoping matters more here than for humans. A human's session is bounded by
their attention; an agent's is bounded only by its token, so the token has to be
the fence.

## What is not decided

- Grant transport: signature versus path-scoped cookie. Leaning signature.
- Per-document origins. Nearly free before Phase 2 ships, effectively impossible
  after.
- Whether Phase 2 ships at all, or whether privacy waits for real identity.
  Shipping it first buys time; it also puts urls in circulation whose shape
  Phase 3 may want to change.
- How an agent token is issued and revoked, and whether it is per-document or
  per-publisher.
