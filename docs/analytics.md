# Product analytics

**The rule: OpenArtifacts counts documents, never readers.** Four server-side
events tell us how much is being published and how much of it is being read.
Nothing about who read it leaves the Worker, and nothing at all runs in a
reader's browser.

[← README](../README.md) · [Serving domain](serving-domain.md) · [Identity](identity.md)

## What is instrumented today

The three publication outcomes, and nothing else. `createDoc`, `updateDoc` and
`deleteDoc` each record one event on their success path; no other code in the
Worker calls `record`.

| Events | Where | Status |
| --- | --- | --- |
| `document_published`, `document_updated`, `document_unshared` | `createDoc`, `updateDoc`, `deleteDoc`, on their success paths only | Recorded |
| `document_viewed` | `handleServing`, on a successful public document `GET` | Not written |

A PostHog query over `document_viewed` therefore correctly returns nothing. Do
not read that as zero readership; read it as zero readership instrumentation.
The cost gate below is what it is waiting on.

## The events

There are four, and the list is closed. `DocumentEvent` in `src/analytics.ts` is
a union of exactly these shapes, so a new event is a change to that type rather
than a new string somebody passed in.

| Event | Meaning |
| --- | --- |
| `document_published` | A document was created and its first version stored. |
| `document_updated` | A new version of an existing document was stored. |
| `document_unshared` | A document was withdrawn by its owner. |
| `document_viewed` | A reader successfully fetched a public document page. |

Every event is a POST to `{POSTHOG_HOST}/i/v0/e/` carrying exactly this:

```json
{
  "api_key": "<POSTHOG_PROJECT_API_KEY>",
  "event": "document_published",
  "distinct_id": "<the owner account, or the document key for document_viewed>",
  "timestamp": "2026-09-12T17:04:05.678Z",
  "uuid": "<one per recorded event>",
  "properties": {
    "service": "openartifacts",
    "environment": "production",
    "document_key": "doc_<32 hex characters>",
    "$process_person_profile": true,
    "$geoip_disable": true
  }
}
```

### The property allowlist

Those five properties are the whole allowlist, and it is enforced by
construction rather than by a check. The sender builds `properties` itself from
the typed event; there is no property bag, no `Record<string, unknown>`, and no
`Request` anywhere in the module's interface. A call site that wanted to attach
a title has nowhere to put one. `test/analytics.test.ts` asserts the complete
set of keys in the body of all four events, so a field added anywhere in the
payload builder fails a test rather than reaching PostHog.

`$process_person_profile` is `false` for `document_viewed` and `true` for the
three publication events. A reader must never become a PostHog person; the
publisher already is an account this service resolved from a credential it
validated, and "how many distinct publishers" is worth being able to ask.

`$geoip_disable` is `true` on every event. PostHog would otherwise geolocate the
address the capture came from, which is the Worker's egress, so every event
would carry a location that belongs to Cloudflare rather than to anyone.

`timestamp` is when the outcome happened, not when PostHog received it, so a
delivery delayed behind a slow intake still lands in the right interval.

`uuid` is minted once per recorded event. There are no retries today, but if a
bounded one is ever added it resends the same `uuid` and the same `timestamp`,
which is what lets PostHog deduplicate rather than count twice.

## The document analytics key

`document_key` is `"doc_"` followed by the first 16 bytes of
`SHA-256("openartifacts/doc-analytics/v1\n" + docId)`, as lowercase hex.

**What it permits.** One document's publication, its updates, its views and its
withdrawal all carry the same key, forever. That is what makes distinct-page
questions answerable: how many separate documents were published this month, how
many separate documents were read, how the two compare. Correlation at the
document level is the deliberate purpose of the key.

**What it does not permit.** The key is not reversible to a document. A doc id is
a capability — whoever holds the url holds the document — and the key is a
one-way digest of one, domain-separated so it can never collide with another use
of the same id. Nobody reading PostHog can open the page a key refers to, name
it, or say who published it beyond the account id already on the publication
events. Nothing in PostHog ties a key to a reader, because no reader-derived
value is ever sent.

It is unsalted on purpose. A salt would have to survive every deploy and every
rebuild to preserve the one property the key exists for, which makes it a
rotation hazard standing against stability rather than a defence. It also buys
little: a doc id is 80 bits of CSPRNG, so there is no feasible preimage for
anyone who was not already given the link — and anyone who was can already read
the document.

## Which outcomes record

An event is recorded once its outcome is a fact rather than a reservation, and
it carries the timestamp the handler has already written to D1 — so an event and
the row it describes can never be counted in different reporting intervals.

| Event | Recorded | `atMs` equals |
| --- | --- | --- |
| `document_published` | `createDoc`, on the 201 path, after the first version's bytes are stored | `docs.created_at`, and `versions.created_at` for version 1 |
| `document_updated` | `updateDoc`, on the 200 path, after `commitVersionMetadata` | `versions.created_at` for the version this push wrote |
| `document_unshared` | `deleteDoc`, on the 204 path, as soon as `softDeleteDoc` marks the row | `docs.deleted_at` |

An update is dated by its own version row rather than by `docs.updated_at`,
because those two part company under overlapping pushes. `commitVersionMetadata`
advances `updated_at` only when the version it commits is the newest one, so the
older of two pushes that store out of order leaves it alone — deliberately,
since `updated_at` describes what the public url is serving. Dating the event
that way would have it name a value no column holds.

`ownerId` is `publisher.owner` on all three: the account the validated
credential resolved to, always derived and never accepted as input.
[Identity](identity.md) is why that is a security property rather than a
convention — an endpoint that took an owner id as a parameter would turn every
account id into a password.

Nothing at all is recorded for:

- a malformed push, or one over the HTML ceiling;
- a doc-count, daily-push or storage refusal;
- a push that loses the race against a concurrent delete and answers 404 — the
  url it would have handed back serves 410;
- a push or a withdrawal against a doc that is not the caller's, or that does
  not exist;
- a second `DELETE` on an already-withdrawn doc.

**Repeated no-op withdrawals are not new outcomes.** A client retrying after a
timeout receives 404 and produces nothing, so a flaky network cannot be read as
churn.

**`document_unshared` is not bounded by `document_published`.** A `DELETE` that
beats an in-flight create marks the row, answers 204 and records, while the
create it beat answers 404 and records nothing. The withdrawal is real — the
publisher asked for it and got it — but the document it withdrew never became a
page. Even with perfect delivery, subtracting one stream from the other can go
negative, which is a second reason the inventory below comes from D1.

**An update is never a new page.** `document_updated` is a name of its own for
exactly one reason: "new pages published" counts `document_published` alone, and
a document pushed twenty times is one page. Emitting the same name twice would
make one diligent author indistinguishable from twenty documents that do not
exist.

**The withdrawal follows the row, not the bytes.** A delete marks the `docs` row
and then sweeps R2, and it answers 204 whether or not that sweep succeeds — past
the row the doc is withdrawn from every reader regardless. An event placed after
the sweep would go missing on exactly the path where the withdrawal happened
anyway, and the count would then disagree with the 404 a retry receives.
Orphaned objects are reported separately, by `delete left objects behind` in the
logs; they are a storage problem, not an unrecorded withdrawal.

## Coverage

Event-derived figures are **observed usage since instrumentation began**, and
every published number needs that sentence beside it.

Publication events start at the deployment that landed these call sites.
Anything published before it produced no event, and no event can be
reconstructed for it — D1 is what knows about those documents, and the section
below is how to ask.

There is no legacy event stream to reconcile against and nothing is
dual-emitted. A 90-day query of production PostHog project 119931 on September
12, 2026 found a single `openartifacts_command_copied` event and no `symposium_*`
publication or withdrawal events of any kind. There is no migration contract to
write because there is nothing to migrate from.

## Counting pages: the authoritative aggregate

**Current inventory comes from D1, never from the events.** Delivery is best
effort, so an event-derived count is a floor; deriving "currently published" by
subtracting withdrawals from publications compounds two incomplete streams
instead of cancelling them out. There is no ingestion job and no counter table,
because `docs` and `versions` already hold the answer and a third copy of it
would be one more thing that can be wrong.

Two facts decide the shape of both queries, and `test/analytics.test.ts` pins
both:

- **A `docs` row with no `versions` row is not a page.** Two things leave one: a
  create whose first push died between inserting the row and writing the bytes,
  and a create that lost the race to a delete, which removes the version row it
  had just written. `createDoc` inserts the `docs` row first so the doc ceiling
  cannot be raced, and returns the id only once the version is stored, so in
  both cases the id was never handed to anyone. Such a row counts against its
  publisher's ceiling and appears in their own list, so they can delete it; no
  reader could ever have opened it.
- **A withdrawal keeps the `versions` rows.** `deleteDoc` marks
  `docs.deleted_at`, destroys the R2 objects and releases the `storage_usage`
  rows. It does not touch `versions` at all. That is the whole reason "ever
  published" is answerable: a withdrawn doc still carries the row proving it was
  published, and `versions.created_at` still says when.

Currently published pages:

```bash
npx wrangler d1 execute symposium --remote --command \
  "SELECT COUNT(*) AS pages
     FROM docs d
    WHERE d.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM versions v WHERE v.doc_id = d.id)"
```

Pages ever published, withdrawals included:

```bash
npx wrangler d1 execute symposium --remote --command \
  "SELECT COUNT(*) AS pages
     FROM docs d
    WHERE EXISTS (SELECT 1 FROM versions v WHERE v.doc_id = d.id)"
```

Swap `--remote` for `--local` to ask a `wrangler dev` database the same two
questions.

The historical baseline for "new pages published" comes from the same two
tables. A page's publication date is the instant its first version landed, which
no later push moves:

```bash
npx wrangler d1 execute symposium --remote --command \
  "SELECT d.id, MIN(v.created_at) AS first_published, d.deleted_at
     FROM docs d JOIN versions v ON v.doc_id = d.id
    GROUP BY d.id
    ORDER BY first_published"
```

Bucket those epoch-millisecond instants into whichever timezone the report uses.
Doing it in SQLite would hard-code a UTC offset, and the epic reports in
America/Los_Angeles, where that offset is wrong for half the year.

### What D1 cannot give back

- **Readership, entirely.** D1 holds no view history and never has. Nothing that
  happened before a `document_viewed` call site ships is reconstructible by any
  means.
- **Anything before `0002_own_docs_by_owner.sql`.** That migration dropped
  `docs`, `versions`, `publishers` and `push_quota` rather than carrying them
  across, because every row was development data filed under a license-key hash.
  No publication history survives it.
- **A withdrawn document's content.** Deliberately: that the bytes are gone is
  the entire point of unshare. `versions.size` survives, so the row still
  remembers how large each version was.
- **Anything whose `docs` row is gone.** Only `rollbackCreate` deletes one, and
  only for a create that stored no bytes, so in practice this is empty — but a
  row removed by hand takes its publication history with it, and D1's Time Travel
  window is 30 days wide.

## What is deliberately excluded

None of the following is sent, and none of it can be, because no event shape has
a field for it:

- reader identities of any kind, including invented or derived ones;
- IP addresses, raw user agents, `Referer`, and any other request-derived
  metadata;
- public document ids, document urls, and document titles;
- document content, in whole or in part;
- license keys, API tokens, and every other credential.

Published pages load no analytics SDK and set no analytics cookie. Readers are
counted by the Worker that served them and in no other way.

## Configuration

| Name | Kind | Value |
| --- | --- | --- |
| `POSTHOG_PROJECT_API_KEY` | secret | The project's `phc_` ingest key. |
| `POSTHOG_HOST` | var | Optional. Defaults to `https://us.i.posthog.com` in code. |
| `ANALYTICS_ENVIRONMENT` | var | `production` on the deployed Worker. |

Delivery is gated on the ingest key alone:

```bash
npx wrangler secret put POSTHOG_PROJECT_API_KEY
```

It must be the project's `phc_` **ingest** key, which authorizes capture and
nothing else. A `phx_` personal API key reads and writes everything in the
PostHog account and must never be used here.

Absence is a supported deployment. A Worker with no secret makes no analytics
request at all, which is the right default for a self-hoster and is what keeps
every local checkout and the whole test suite silent without a second flag.

`ANALYTICS_ENVIRONMENT` labels every event and is what separates real usage from
everything else. **Every business query must filter on
`environment = "production"`.** An unset value means `development`, so an
unlabelled deployment stays out of the totals rather than joining them. A local
run that deliberately turns delivery on must override it:

```bash
npx wrangler dev --var POSTHOG_HOST:http://127.0.0.1:8999 \
  --var ANALYTICS_ENVIRONMENT:development
```

## Cost, and the gate before view events ship

**This is the one part of the design that needs a decision before readership is
instrumented, and it belongs here rather than in a PR that has already spent the
money.**

PostHog product analytics is priced per event. The three publication events are
bounded by the per-day push quota that already exists, so their volume is a
function of how many people publish and cannot run away. `document_viewed` is
different in kind: `/d/{docId}` is unauthenticated, carries no rate limiter, and
is read by a population two or three orders of magnitude larger than the
publisher count. One event per read makes the analytics bill a function of
audience size.

[Cost at scale](cost-at-scale.md) makes the opposite promise — cost scales with
publishers and bytes, not with audience size — and §6 names analytics as the
category where that promise usually dies. Per-event pricing is not the per-MAU
pricing that section forbids, and `$process_person_profile: false` means no
reader ever becomes a billable person. The failure mode is the same one anyway,
because the multiplier is the same.

Two things must therefore be true before a `document_viewed` call site ships,
and neither is true today:

- **A project billing limit is set in PostHog and recorded here.** An
  unauthenticated endpoint with no ceiling is an attacker-controlled bill: a
  loop against one public url mints billable events at line rate.
- **View events carry a bound of their own.** Either a fixed sampling rate,
  carried as a property so the multiplier is recoverable, or a per-document
  counter aggregated before it leaves the Worker. `CLAUDE.md` requires that
  quotas ship with the feature they protect rather than after it.

Publication events need neither and can ship without them.

## Delivery is best effort

An event is scheduled on `ctx.waitUntil` after the response is already decided,
with a two-second timeout and no retries. A PostHog outage therefore costs a
lost count, never a failed publish and never a slow page. That is the trade the
design makes on purpose: these events answer "roughly how many" questions, and
buying exactly-once delivery for them would put a queue, a consumer and a replay
story in the path of every push and every read.

Two consequences follow, and both belong on anything built from these numbers:

- **Totals are observed usage since instrumentation began, not all-time counts.**
  Nothing published or read before the call sites landed produced an event, and
  there is no way to reconstruct it — the events are the only record, and D1
  holds no view history at all. Any cumulative figure has to state its coverage
  start next to the number.
- **Counts are a floor, not an exact figure.** A dropped delivery is invisible:
  nothing is queued, nothing is replayed, and nothing reports the gap. Treat a
  small shortfall as expected rather than as evidence of a problem.

- **An edge cache will change what a view event counts.** `CLAUDE.md` owes the
  serving zone an explicit Cache Rule, and `/d/{docId}` is uncached until it
  lands. Afterwards a cache hit never invokes the Worker, so `document_viewed`
  counts origin misses rather than reads — roughly one per edge location per
  TTL, and for a pinned `/v{n}` url served `immutable` for a year, about one
  event per location per year. That is not a smaller version of the same
  number, it is a different quantity, and whichever of the two lands second
  must restate what the metric means.

Distinct-page metrics must be recomputed for each interval from the underlying
events. Summing daily distinct-document counts into a weekly one double-counts
every document read on more than one day.

The wire format is verified end to end against a local capture server, not
against PostHog itself. Confirming that project 119931 accepts this body — one
hand-sent event, and the date it was accepted — is owed here before any figure
derived from these events is reported as fact.

## Inspecting delivery failures

Every failure — a network error, a timeout, or any non-2xx from PostHog — is
logged once and swallowed:

```
analytics delivery failed { event: "document_published", status: 429 }
```

`status` is the HTTP status PostHog returned, or `null` when the request never
got one (a network error or the two-second timeout). `event` is the event name.
Nothing else is ever logged: not the payload, not the owner, not the doc id, not
the document key, and not the response body — that last one is written by a
third party, and quoting it would let PostHog decide what appears in our logs.

Read them with the Worker's live logs or in the dashboard, which
`"observability": { "enabled": true }` in `wrangler.jsonc` already feeds:

```bash
npx wrangler tail --format pretty --search "analytics delivery failed"
```

A steady trickle is the design working. A sustained run of one status is worth
acting on: `401` means the ingest key is wrong, `429` means the project is being
rate limited, and a run of `null` means the intake host is unreachable from the
Worker.
