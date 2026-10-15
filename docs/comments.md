# Comments — design sketch

**Status: not designed, not planned, not built.** This is a sketch of the
smallest thing that could work, written down so the shape is not re-derived from
scratch later. It has not been through a design review, and the open questions
at the bottom are genuinely open. Do not treat it as decided.

Comments are step 2 of the wedge in [positioning.md](positioning.md): share,
then comment, then converge. Humans and agents both post; agent-drafted comments
wait for the human they act for to approve them.

[← README](../README.md) · [Hosting](hosting.md) · [Positioning](positioning.md)

## Three state machines

| | States | Belongs to |
| --- | --- | --- |
| **Comment** | `pending` → `posted`, or `discarded` | one author |
| **Thread** | `open` → `resolved` (cites the version that addressed it) | one anchor |
| **Anchor** | `anchored` ⇄ `orphaned` | one quote |

Three machines, and none of them interacts with the others. That is deliberate:
anchor status has to be orthogonal to thread state, because a resolved thread
whose quoted text disappears in a later push is still resolved and still cites
the version that addressed it — collapsing the two would destroy exactly the
resolve-provenance the design exists for. An open orphan is equally ordinary.
The reverse transition is real too: a fuzzy match can find the quote again if the
text comes back.

Human-authored comments start `posted`. Agent-authored ones start `pending` and
become visible to others when the human they act for approves — that gate is the
whole agent-identity feature, and approval needs to be batchable or the friction
removed from writing comes back as moderation.

Note this splits states differently from [cost-at-scale.md](cost-at-scale.md)
§6, which puts `pending|posted|resolved` together on the comment. Resolution is a
property of a conversation reaching a conclusion, not of a single reply — a
"resolved reply" means nothing. Approval is per-comment because every utterance
needs attribution; resolution is per-thread. Keeping them apart is what lets the
machines stay independent, which is most of what keeps this small.

Every comment carries `author` and a nullable `on_behalf_of`. That one column is
delegated identity: a human wrote this, or an agent proposed it and a human let
it through.

## Anchors are quotes

A thread anchors to `{exact, prefix, suffix}` — the quoted text and enough
context to disambiguate it — in the style of W3C TextQuoteSelector. **Never
offsets.** Offsets do not survive the next push, and that is precisely the
failure every surveyed competitor has (see [positioning.md](positioning.md)).

On each push, every anchor re-resolves: search the new version for the exact
quote, fall back to fuzzy matching, and mark the anchor `orphaned` if nothing
matches. The thread's own state is untouched. Orphaning is shown, not hidden — a
comment about text that no longer exists is information.

This is pure string work with no I/O: a few milliseconds for a 200 KB document
with 50 threads, against a Worker's 30-second CPU budget.

## Where it would live

One **Durable Object per document**, its embedded SQLite holding that document's
threads and comments. Every write to a document — post, approve, resolve,
re-anchor — serializes through it. This is the coordinator that v0 deliberately
does without (`CLAUDE.md`), and comments are the feature that earns it.

The DO is the system of record. [cost-at-scale.md](cost-at-scale.md) §6 instead
makes R2 thread fragments canonical; the deviation is deliberate, because the
fragment would be regenerated from DO state on every write anyway, and two
authoritative copies of the same thing is a category of bug rather than a
feature. Treat any R2 fragment as a render cache.

D1 keeps its current job as the cross-document index. It only needs a new table
for "everything awaiting my approval" *across* documents — which per-document
DOs cannot answer — and even that can wait if approval happens on the document
page itself.

## What this breaks

**Serving starts to depend on state.** Today a read is a lookup, a stream, and a
fixed set of additions that are a pure function of the stored version — cheap,
and cacheable because the answer never varies between readers. (Only `/d/{docId}/v{n}` is
immutable; the shared `/d/{docId}` link is a mutable pointer with a 60-second
lifetime. See [http-api.md](http-api.md).) Threads make the page vary with state
between pushes. Three ways out, and this is a real decision, not a detail:

1. Serve the stored document as now and fetch threads separately — keeps the
   additions a pure function of the version and both cache lifetimes intact,
   costs an agent a second request.
2. Compose the page per read — kills caching.
3. Re-render and store on every comment — write amplification, reads stay static.

(1) looks right, and it also settles the open question
[positioning.md](positioning.md) ends on: agents fetch one predictable threads
resource instead of parsing them out of the page.

**Comments need reader identity, and it now exists for private documents.** On a
public document an anonymous reader still cannot be attributed, so commenting
there needs a signed-in reader. Access control was the hard prerequisite, not a
parallel track, and it is built: [private-sharing.md](private-sharing.md) has
readers sign in on the API host (one account, one session), and a private
document is served from its publisher's origin, `{label}.openartifacts.site`,
not from `openartifacts.site`. Comments are the next step on top of it, and
take four adjustments from it, none of which changes the shape of this sketch:

1. Call `canRead` from the threads resource and every comment route, so a private
   document's discussion is as private as its page.
2. Serve a private document's threads resource on the publisher's origin, behind
   the grant cookie, which is how the grant check slots in front of it.
3. Derive the comments sidebar's `frame-ancestors` per document from the document's serving
   origin (`openartifacts.site` for public, the publisher's origin for private)
   instead of the fixed `https://openartifacts.site`. The Share popover's frame
   already follows this rule (the embedder's origin is echoed only when it is the
   document's serving origin, `src/embed.ts`), and the sidebar follows the same one.
4. Accept the Share popover's per-document token in the comment routes. The
   sidebar runs in a third-party iframe where cookies are unreliable, so it carries
   a bearer token, and the popup on the API host that mints it sees the reader
   session, so a reader signs in once per document for both.

`doc_invites.role` (`view` or `comment`) and the `canComment` predicate are
reserved for it; nothing calls them yet.

## Open questions

- Where threads render (the three options above), which decides whether the
  cheap-serving story survives comments.
- Whether approval batches per agent, per document, or per session. Batching is
  the stated mitigation for approval fatigue, and the shape of it is not obvious.
- Whether resolve may be reopened, and what that does to `resolved_by_version`.
