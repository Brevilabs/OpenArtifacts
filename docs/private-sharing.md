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

Grants remove *ambient* authority: a document's scripts cannot forge a grant for
a document they were not given. That is necessary and it is not sufficient.

### Grants alone do not fix a shared origin

A hostile public document can steal a grant somebody else legitimately obtained:

1. It calls `window.open('/d/{targetId}')` and keeps the opener reference.
2. The popup bounces to `symposium.md`, where the reader signs in and comes back
   with a grant.
3. Back on `symposium.site`, opener and popup are same-origin **again**, because
   the same-origin check is evaluated per access rather than pinned at open
   time. The opener reads `popup.location.href`, which contains the signature,
   and `popup.document`, which contains the document.

Nothing already in place stops this. `frame-ancestors 'none'` governs framing,
not popups. `Referrer-Policy: no-referrer` is irrelevant. `noopener` is the
*opener's* choice and a hostile opener will not make it.
`Cross-Origin-Opener-Policy: same-origin` severs cross-origin openers and leaves
same-origin ones intact, which is exactly the case here.

**So origin isolation is a prerequisite for private documents, not an
enhancement.** Each document needs its own origin — a wildcard certificate over
per-document subdomains, the way `googleusercontent.com` works, or an
equivalently isolated browsing context. Then `window.open` on another document
crosses an origin boundary and the opener can read nothing.

### The origin label must not be the capability

The obvious form of that — `{docId}.symposium.site` — trades one leak for
another. A hostname is not confidential: it appears in the DNS query, and absent
Encrypted Client Hello it appears in the TLS SNI, both before any encryption. A
recursive resolver, a corporate DNS server, or anything on the network path
would learn the id — and the id is the only access control a doc has. The
observer could just fetch it.

Today's scheme does not have this problem, because the id lives in the request
path, which is encrypted, and every document shares one hostname.

So the two jobs need two identifiers:

| | secret? | job |
| --- | --- | --- |
| origin label | no | isolates browsing contexts |
| doc id, and any grant | yes | authorises the read, stays in the encrypted path |

`{originLabel}.symposium.site/d/{docId}` gives isolation without exposure. The
label being enumerable is harmless: reaching the origin without the path id and
the grant gets you nothing. ECH would close the SNI half of the leak but not the
DNS half, so it is not a substitute for separating the two.

Two things follow, and both are ordering constraints rather than preferences:

**It must ship with the first grant, not after it.** The theft above needs a
shared origin, not an anonymous reader, so a per-reader grant is stolen exactly
the way an accountless one would have been. Shipping privacy on a shared origin
first would put grant-bearing urls in circulation before the fence exists.

**It changes every url the product has ever issued.** Nearly free while every
document is public and links are disposable; effectively impossible once readers
hold private ones. This is the retrofit hazard, the same shape as the serving
domain split itself.

**Grant transport**, once origins are isolated, is the smaller question. A query
signature is simplest and leaks into logs and shared screenshots — though
`Referrer-Policy: no-referrer` is already set. A `HttpOnly` cookie scoped to the
document's own origin is cleaner but puts state back on a serving origin we
promised to keep clean. Prefer the signature.

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
dependencies, not preference. These numbers are the ones
[cost-at-scale.md](cost-at-scale.md) costs against, so they are worth keeping in
step.

> **An earlier plan had a phase between 1 and 2**: expiring links and
> per-document passwords, on the argument that they are days of work and cover
> most of what people mean by "private". It is dropped. **Private sharing
> requires an account** with symposium.md or Obsidian Copilot, so there is no
> password path and no unauthenticated grant, and nothing private exists until
> Phase 2 ships. Recorded here because the case for it was reasonable and will
> be made again; what defeats it is that it buys weeks of convenience at the
> cost of putting grant-bearing urls in circulation before identity exists.

### Phase 1 — public links *(shipped)*

The url is the capability. 80 bits of entropy, `noindex`, no reader identity.
Publishing is gated to paid Copilot plans.

### Phase 2 — reader identity

The large one, the prerequisite for everything after, and the only route to a
private document.

- OAuth sign-in on `symposium.md` — Google and GitHub cover nearly everyone
  without our storing a password. The session lives on the brand domain only.
- A `readers` table, and an ACL per document: named readers, or a domain rule
  ("anyone at acme.com"), or public. Public stays the default.
- Grants become per-reader and short-lived, minted after the ACL check.
- The list endpoint learns who a document is shared with.

**Origin isolation ships with this phase, not after it.** A per-reader grant is
stolen exactly the way an anonymous one is: the `window.open` theft above needs
only a shared origin, not an anonymous reader. It applies from the first private
document onwards, and once private urls are in circulation, changing their shape
breaks them.

This is where "who read it" becomes answerable, and where the product stops
being a link and starts being a place.

### Phase 3 — comments

[comments.md](comments.md) is the design; it is blocked on reader identity and
says so. Every utterance needs attribution, and an anonymous reader cannot be
attributed.

Threads anchor to quotes rather than offsets, so they survive the next push.
Where threads render is the open question that decides whether the cheap-serving
story survives — see that document.

### Phase 4 — agents as first-class participants

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

- Grant transport: signature versus a cookie scoped to the document's own
  origin. Leaning signature.
- The exact isolation mechanism — per-document subdomains on a wildcard
  certificate, or a sandboxed opaque origin. *Whether* to isolate is settled;
  the mechanism is not. Whichever is chosen, the origin label is not the
  capability.
- Where the origin label comes from: a second stored identifier, or something
  derived from the doc id by a one-way function so it need not be stored. The
  second is tempting and has to survive the observation that anyone can compute
  the label from an id they already hold — which is fine — but not the reverse.
- How an agent token is issued and revoked, and whether it is per-document or
  per-publisher.
