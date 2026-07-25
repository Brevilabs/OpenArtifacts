# Comments — design sketch

**Status: not designed, not planned, not built.** This is a sketch of the
smallest thing that could work, written down so the shape is not re-derived from
scratch later. It has not been through a design review, and the two open
questions at the bottom are genuinely open. Do not treat it as decided.

Comments are step 2 of the wedge in [positioning.md](positioning.md): share,
then comment, then converge. Humans and agents both post; agent-drafted comments
wait for the human they act for to approve them.

[← README](../README.md) · [Hosting](hosting.md) · [Positioning](positioning.md)

## Two objects, two state machines

| | States | Belongs to |
| --- | --- | --- |
| **Comment** | `pending` → `posted`, or `discarded` | one author |
| **Thread** | `open` → `resolved` (cites the version that addressed it) | one anchor |

Human-authored comments start `posted`. Agent-authored ones start `pending` and
become visible to others when the human they act for approves — that gate is the
whole agent-identity feature, and approval needs to be batchable or the friction
removed from writing comes back as moderation.

Note this splits states differently from [cost-at-scale.md](cost-at-scale.md)
§6, which puts `pending|posted|resolved` together on the comment. Resolution is a
property of a conversation reaching a conclusion, not of a single reply — a
"resolved reply" means nothing. Approval is per-comment because every utterance
needs attribution; resolution is per-thread. Keeping them apart means the two
state machines never interact, which is most of what keeps this small.

Every comment carries `author` and a nullable `on_behalf_of`. That one column is
delegated identity: a human wrote this, or an agent proposed it and a human let
it through.

## Anchors are quotes

A thread anchors to `{exact, prefix, suffix}` — the quoted text and enough
context to disambiguate it — in the style of W3C TextQuoteSelector. **Never
offsets.** Offsets do not survive the next push, and that is precisely the
failure every surveyed competitor has (see [positioning.md](positioning.md)).

On each push, every thread re-anchors: search the new version for the exact
quote, fall back to fuzzy matching, and mark the thread `orphaned` if nothing
matches. Orphaning is shown, not hidden — a comment about text that no longer
exists is information.

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

**The static-page property.** Today `/d/{docId}` is immutable bytes rendered once
at publish time, which is the whole reason serving is cheap. Threads make the
page vary with state. Three ways out, and this is a real decision, not a detail:

1. Serve the document immutably and fetch threads separately — keeps the caching
   model, costs an agent a second request.
2. Compose the page per read — kills caching.
3. Re-render and store on every comment — write amplification, reads stay static.

(1) looks right, and it also settles the open question
[positioning.md](positioning.md) ends on: agents fetch one predictable threads
resource instead of parsing them out of the page.

**Comments need reader identity, and there is none.** Reading currently requires
nothing at all, and an anonymous reader cannot be attributed. Access control —
phase 2 in [cost-at-scale.md](cost-at-scale.md) — is a hard prerequisite, not a
parallel track, and it is the larger piece of work.

## Open questions

- Where threads render (the three options above), which decides whether the
  cheap-serving story survives comments.
- Whether approval batches per agent, per document, or per session. Batching is
  the stated mitigation for approval fatigue, and the shape of it is not obvious.
- Whether resolve may be reopened, and what that does to `resolved_by_version`.
