---
title: symposium.md - Business Feasibility - Cost at Scale
date: 2026-07-21
tags:
  - symposium
  - feasibility
  - business
status: draft
---

# symposium.md - Business Feasibility - Cost at Scale

Companion to [[Agent-First Docs - Product Positioning]]. That doc argues *why* the product should exist. This one asks a colder question: **what does it cost to serve, and does the cost curve stay sane from 1k to 100k to 1M users?** (Pricing was revised on 2026-07-25: publishing is paid, reading is free. See §8. Sections written against the earlier free-share plan are flagged where it matters.)

Scope of the launch product being costed: **one-click sharing from Copilot for Obsidian. Push a local md/html file, get a public HTML page on the internet. No accounts for readers, no permissions, no comments.** Later phases (access control, comments, agent APIs) are costed as deltas.

> [!abstract] Verdict up front
> This is one of the cheapest product categories per user that exists. Serving versioned static HTML behind a CDN costs fractions of a cent per user per month. At 1k users the infra bill is under $50/mo; at 100k it is a few hundred; at 1M it is low thousands, which is a rounding error next to even one salary. **Dollars are not the feasibility risk. The two real cost centers are (1) abuse handling on a public-hosting surface and (2) founder time.** Both are manageable if designed for on day one, and the category has multiple existence proofs of solo operators running it profitably.

---

## 1. Why this category is structurally cheap

Three properties of the product shape (from the positioning doc) drive the whole cost story:

1. **The artifact is static.** Every push mints an immutable version. Immutable version URLs are perfectly cacheable, so a doc that goes viral costs approximately nothing extra: the CDN absorbs it, origin serves it once. We are closer to Pastebin than to Google Docs.
2. **No live editor, no realtime sync.** Google Docs' real infrastructure cost is not storage, it is operational-transform sync fanout, presence, and cursors for concurrent editors. Notion carries a heavy block-database and realtime layer. Symposium's model is push-based: the expensive collaborative-editing problem is deliberately not in the architecture. Even comments (phase 3) can be poll-based for a long time before anyone notices.
3. **Zero inference COGS.** The agents are the users' own (Claude Code, Copilot, whatever calls our MCP). Unlike Notion AI or any "AI docs" product, we pay for no tokens, ever. Our marginal cost for agent traffic is a JSON API call. This is the quiet structural advantage of the agent-first posture: the intelligence is BYO.

The sanity checks from the market:

| Blueprint | What it proves |
|---|---|
| **Obsidian Publish** | Charges $8/mo per site for what is essentially static note hosting. The gap between that price and static-hosting COGS is enormous. It is a margin signal and later a pricing anchor. |
| **Bear Blog / mataroa / rentry** | Solo operators run free-tier markdown hosting for tens of thousands of users on VPS-class budgets. Existence proof that one person can operate this category. |
| **telegra.ph** | Telegram ran free, anonymous, no-login publishing at massive scale for years, infra clearly trivial. Also the cautionary tale: it became a phishing haven. The lesson is not "don't do it," it is "abuse is the product's main operating cost, budget for it." |
| **Notion / Google Docs** | SaaS docs at 100M+ users run ~90% gross margins. Their spend is R&D and sales, not serving cost. COGS per user is cents. We inherit the same physics with a simpler artifact. |
| **Vercel / Netlify / GitHub Pages** | Static hosting is such a commodity that it is routinely given away as a loss leader. We are not inventing a cost structure, we are riding one that the industry already treats as ~free. |

---

## 2. The usage model behind the numbers

Assumptions, deliberately on the generous side so the estimates are ceilings, not floors. "Users" = people who have pushed at least one doc via Copilot.

- **Monthly active publishers:** ~30% of registered users push in a given month.
- **Pushes:** ~5 versions per active publisher per month, accumulating over time (every push mints a version; assume 20-40 stored versions per user after a year).
- **Doc size:** 100-200KB average per version including rendered HTML; images create a heavy tail (assume 2-3x storage multiplier once image uploads exist).
- **Views:** this is *sharing*, not blogging. The median doc is read by 2-10 people. Assume ~100 views per user per month with a viral tail, i.e. 100k users ≈ 10-20M page views/mo. Viral tail is absorbed by CDN cache, so it moves egress, not origin load.

Key modeling point: because readers need no accounts, **cost scales with publishers and bytes, not with audience size**. A doc seen by 100k people costs a few dollars of egress at worst, and $0 on the right CDN.

**Two cohorts, and only one of them appears anywhere in this document.** Every "user" counted below is a *publisher*, and since publishing is paid (§8), every one of them is also a paying customer. Readers are unbounded, unauthenticated, free to us and free to them, and they are deliberately absent from every table here — a reader population two or three orders of magnitude larger than the publisher count is the expected shape and changes none of these numbers. Anywhere this document says "users", read "publishers, all of whom pay".

---

## 3. Cost centers by phase

### Phase 1 - public share (the Copilot wedge)

| Cost center | What drives it | How big |
|---|---|---|
| Blob storage (versions) | pushes x size x retention | Tiny. R2 at $0.015/GB-mo; even 1TB is $15/mo |
| Egress / CDN | views x doc size | ~$0 on Cloudflare (R2 has no egress fees); $0.005-0.01/GB on Bunny as fallback; only S3+CloudFront ($0.085/GB) makes this a real line item, so don't use it |
| Compute (render + serve) | a streaming rewrite per uncached read | Negligible: HTMLRewriter is a single tokenizing pass over bytes already in flight, and the CDN absorbs the repeat reads. Workers paid plan $5/mo baseline |
| Metadata DB | pointer index (see section 6) | D1, effectively $0 at this scale; content lives in R2, not the DB |
| Auth (publishers only) | Copilot users pushing | Stateless signed sessions + a D1 keys table, ~$0; do NOT use per-MAU pricing like Clerk ($0.02/MAU = $1.8k/mo at 100k, a self-inflicted wound) |
| **Abuse / trust & safety** | public hosting of user-uploaded HTML | **The real one. See section 5.** The paid publishing gate (§8) lowers the rate; [serving-domain.md](serving-domain.md) is why it does not lower the blast radius |
| Legal boilerplate | ToS, privacy, DMCA agent ($6 registration) | One-time, small |

### Phase 2 delta - access control

- Auth for *readers* now exists: MAU count jumps from publishers to publishers+readers. Still fine on flat-fee auth.
- Private docs can't be dumb-cached publicly: serving goes through an edge worker checking a signed cookie/URL. Cloudflare Workers: $5/mo + $0.30 per million requests. At 20M requests/mo that is ~$11. Not a cost center, just an architecture change to make before habits calcify.
- Email (invites, magic links): SES/Resend at ~$0.10 per 1k emails. Noise.

### Phase 3 delta - comments and replies

- Threads, anchors, and notifications arrive, but in the HTML-native design (section 6) they land as R2 thread fragments plus per-doc Durable Object state, not as central-DB growth. Write load is human-scale (comments are rare events); the cost shows up as DO requests and duration, dollars per month, not a database tier.
- Re-anchoring on push (the core engineering asset per the positioning doc) is CPU-bounded string matching, microseconds to milliseconds per thread. It concentrates *engineering* cost, not *serving* cost. This is the right kind of moat: expensive to build, free to run.
- Notification email volume rises; still cents per thousand.
- **T&S surface expands**: user-generated comments on public pages is a second abuse channel (spam links in comments). Same tooling, more queue.

### Phase 4 delta - agent APIs / MCP

- Zero inference cost (BYO agents), but agent traffic patterns are 10-100x chattier than humans: an agent will happily poll threads every few seconds. **Metering and per-key rate limits are a launch requirement of this phase, not an optimization.** With them, agent traffic is just cheap JSON requests through the same worker layer.
- OAuth for MCP: engineering time, not opex.

---

## 4. The numbers at each scale

Infra estimates assume the cheap-by-construction stack (section 6). Ranges are honest, the upper bound assumes sloppiness.

### ~1,000 users (design partners + early Copilot adopters)

| Line | $/mo |
|---|---|
| Storage (~10-20GB R2) | ~$0 |
| Egress (~50GB) | $0 |
| Workers paid plan + D1/DO usage | $5-15 |
| Email, domains (product + sacrificial serving domain), misc | $10-20 |
| **Total** | **$15-35/mo** |

Effectively free. The entire cost of this stage is founder time. This matters strategically: **the wedge can run indefinitely without revenue pressure**, which is exactly what a "must stand alone as a good product" step needs. It also means the $2.99 publishing price in §8 is set by what feels trivial to a user, not by what the infrastructure costs.

### ~100,000 users

| Line | $/mo |
|---|---|
| Storage (~0.5-1.5TB with versions + images) | $10-25 |
| Egress (~3-6TB, 10-20M views) | $0 (R2, no egress fees) |
| Edge compute (~30M Workers req + DO usage) | $15-50 |
| D1 (pointer index, reads mostly cached) | $5-25 |
| Email (invites, notifications) | $10-30 |
| Abuse tooling (scanning is mostly free APIs; queue/observability) | $50-150 |
| Observability, backups, misc | $50-150 |
| **Total** | **$150-500/mo** |

That is **$0.0015-0.005 per registered user per month**. For contrast: one part-time contractor costs 10x the entire infra bill. Every one of those 100k publishers is already paying — $2.99 standalone or bundled into Copilot Plus (§8) — so the base is ~$260k/mo of net receipts against <$1k of COGS, before anyone upgrades to a higher tier. The margin structure is boringly good.

### ~1,000,000 users

| Line | $/mo |
|---|---|
| Storage (10-50TB, version dedupe matters now) | $150-750 |
| Egress (~50-100TB) | $0-1,000 (at this scale you have a Cloudflare sales conversation; Bunny volume pricing ~$500 as the honest fallback) |
| Edge compute (~300-500M Workers req + DO usage, agents included) | $150-500 |
| D1 + DO storage (pointer index + per-doc SQLite) | $100-400 |
| Queues, search, notifications | $200-500 |
| Email at volume | $50-200 |
| Abuse tooling + review support | $500-1,500 |
| Observability, backups | $200-800 |
| **Total** | **$1.5k-5.5k/mo** |

Still under a penny per user per month. And this is the point where the honest accounting flips: **at 1M users the infra line is 3-8% of the cost of the 3-6 person team you will need** (on-call, T&S response, support, product). The business question at 1M users is headcount and upgrade rate, never servers — note that "conversion" no longer means free-to-paid, since the base tier is paid. What is being converted is a paying publisher to a higher tier.

### The one-table summary

| Scale | Infra $/mo | Infra $/user/mo | Dominant real cost |
|---|---|---|---|
| 1k | $15-35 | ~$0.02 | Founder time |
| 100k | $150-500 | ~$0.003 | Abuse queue + founder time |
| 1M | $1.5k-5.5k | ~$0.004 | Team (~$60-120k/mo), T&S ops |

Note the per-user cost *falls* then flattens: fixed costs amortize, and variable costs are dominated by cheap bytes. There is no scale at which infra breaks this business.

---

## 5. The real risk: abuse, not AWS bills

Public + no permission system + one-click publish = **the exact recipe for phishing kits, scam pages, and SEO spam**. This is what actually kills or maims hosting products, and it fails catastrophically, not gradually: if Google Safe Browsing flags the serving domain, every doc shows a red interstitial in every browser and the product is dead that afternoon. Notion, Google Docs, and telegra.ph have all been burned here at scale.

The paid publishing gate (§8) removes the *free* term from that equation, which genuinely helps: a card on file makes each bad actor traceable and gives us an account to terminate, so expect a lower incident rate than telegra.ph's. It changes nothing below. $2.99 is not a deterrent to anyone running a phishing campaign, and the domain is flagged by the first bad document rather than the hundredth.

Day-one mitigations, all cheap in dollars:

1. **Serve user content from a separate domain** than the product/brand domain (the `notion.site` / `googleusercontent.com` pattern). Reputation damage lands on the sacrificial domain, not on `symposium.md` itself. This is the single highest-leverage decision and it costs $10/yr.
2. **`noindex` + `nofollow` by default.** Shared docs are for invited readers, not search engines. This deletes the SEO-spam incentive entirely, which is most of the spam volume. (Publishers can opt into indexing later, as a feature, maybe a paid one.)
3. **Publisher-gated, reader-open.** Publishing requires a paid plan — active Copilot Plus and lifetime licenses today, with a standalone subscription planned; reading requires nothing. The abuse funnel is throttled at the account layer: new-account rate limits, velocity checks on pushes.
4. **Automated scanning on push**: outbound links against Google Safe Browsing (free API); if/when image upload ships, CSAM hash-matching via Cloudflare's free tool (also a legal obligation, not a nice-to-have).
5. **Report button + fast takedown path + registered DMCA agent** ($6). At small scale the takedown queue is minutes per week of founder time; budget real tooling for it around 100k users.

Honest framing: at 1k-10k Copilot-sourced users this is a non-issue (the distribution channel is itself a filter, Copilot users are not phishers). It becomes a weekly chore at ~100k and a part-time job at 1M. It never becomes expensive in dollars, it becomes expensive in attention, which is why the tooling should exist before it is needed.

---

## 6. Architecture: all-Cloudflare, HTML-native, minimal database

Decision (2026-07-21): the whole stack runs on the Cloudflare bundle - DNS, CDN, Workers, R2, Durable Objects, D1, Queues, Turnstile. One vendor, one bill, zero egress fees, and every component is flat-fee or usage-priced in fractions of a cent. The design principle on top of it: **HTML-native**. All text content, the docs and the comments, lives as HTML files in R2. The database is demoted to a tiny, rebuildable index.

### The layer model

**R2 holds the truth, HTML is the format, Durable Objects hold the locks, D1 holds the pointers.**

**R2 - canonical store, everything is HTML:**

- `docs/{id}/v{n}.html` - immutable versions, content-addressed, `cache-control: immutable`. Dedupe identical chunks across versions so "every push mints a version" doesn't compound into a storage tax. Immutability means the CDN does the serving business for us; a viral doc costs origin one read.
- `docs/{id}/threads/{tid}.html` - each comment thread is a self-contained HTML fragment with semantic markup: `<article class="thread" data-anchor-quote="...">` containing nested comments carrying `data-author`, `data-state="pending|posted|resolved"`, `data-resolved-by-version`. Agents parse the exact markup humans render. This settles the open design question in [[Agent-First Docs - Product Positioning]] (structured endpoint vs parsing served HTML): the served HTML *is* the API, because the markup is designed to be machine-legible.
- `docs/{id}/manifest.json` - one small file per doc: version list, thread list, grant list. Each doc is a fully self-describing R2 prefix: delete the prefix and the doc is gone; export it and the doc is portable. R2 holds the publisher's own bytes; Symposium's additions go in at read time, so a byline change - or a paid plan that removes one - reaches documents already published without rewriting a single stored object. The cost is a streaming pass per uncached read, which the CDN makes rare.

**Durable Objects - one coordinator per doc.** A DO per doc serializes all writes to that doc: append comment, re-anchor threads on push, update manifest, invalidate cache. DOs carry embedded SQLite, so each doc's working index (anchors, thread states) lives inside the doc's own object - ten million tiny databases, one per doc, instead of one big one. Each is rebuildable from its doc's R2 prefix, and per-doc state dies with the doc.

**D1 - the cross-doc index only, pointer rows, no content ever:**

| Table | Rows contain | Powers |
|---|---|---|
| `users` | id, email, created_at | identity |
| `keys` | key-hash → user | push auth, agent API auth |
| `docs` | slug → doc id, owner, visibility | slug uniqueness, "my docs" |
| `grants` | email → doc id | "shared with me" (phase 2) |
| `inbox` | user → pending-approval pointers | approval queue (phase 3) |

At a few hundred bytes per user and per doc, even 1M users / 10M docs is a couple of GB - inside D1's limits for years.

### Is a database a must?

Not as a system of record - but a strongly consistent coordination-and-index layer is, for four irreducible jobs that HTML files in object storage cannot do:

1. **Write coordination.** Two commenters hit the same thread file simultaneously, or an agent pushes mid-comment: append is read-modify-write, and without serialization one write silently clobbers the other. Same for slug allocation and bumping the "latest" pointer. R2's conditional writes allow hand-rolled CAS retry loops, but that is a lock service built badly; the per-doc DO does it properly.
2. **Inverted queries.** R2 objects are organized by doc; "my docs", "docs shared with me", "my pending approvals", and notification fan-out all cut across docs and have no home in per-doc files. Listing R2 prefixes to answer them is slow, costs per-operation, and degrades linearly.
3. **Identity.** Token → user on every push and every private read cannot live in content files.
4. **Counters.** Rate limits, quotas, abuse velocity: high-frequency tiny writes, the worst possible workload for object storage. These go in the Workers rate-limiting binding or the DO, never in D1 rows.

Phase 1 (public share only) could genuinely ship with zero D1: slug uniqueness via R2 conditional create-if-absent, a per-user `index.html` written only through that user's own serialized path, per-user key objects, stateless signed-cookie sessions. We stand up the five-table D1 on day one anyway - it costs approximately nothing on the Workers paid plan, and avoiding it means hand-rolling CAS dances over R2 to dodge a database the size of a floppy disk. "Shared with me" in phase 2 forces the inverted index into existence regardless.

### The operating discipline that keeps the footprint minimal

- **Every D1 row is derivable by scanning R2 manifests.** The backup of the database is R2, not a database dump. A DB that can be regenerated from the content store is not a system of record, it is a cache with a schema - if it corrupts or we outgrow it, re-scan and rebuild.
- **Stateless sessions** (signed cookies / JWTs): no session table; D1 is touched at login and key creation, never per-request.
- **Flat-fee dependencies only.** The killer at scale is per-MAU and per-seat pricing anywhere in the serving path (auth, analytics, feature flags). The Cloudflare bundle satisfies this by construction; hold the line on anything added later.
- **Quotas from day one**: e.g. ~100 docs / 1GB / a pushes-per-day ceiling, enforced in the DO. Not to monetize - to cap the hoarding and abuse tails. Generous enough that no legitimate publisher ever hits them. These apply to paying publishers too; a paid gate lowers the abuse rate, it does not remove the ceiling.
- **Vendor concentration is the accepted trade.** All-Cloudflare is a single point of failure and a lock-in bet; the mitigation is that the entire product state is a set of portable HTML files and JSON manifests in R2-compatible (S3-API) storage, and the D1 layer is rebuildable. Migrating off is copying files, not migrating a database.

---

## 7. Build vs adopt: why not Outline as the core

Outline is the nearest existing product ([[Agent-First Docs - Product Positioning#Why nobody serves this today]]), which makes "just build on it" tempting. Decision (2026-07-23): no. The downsides are structural, not cosmetic:

- **License.** Outline is BUSL-1.1, which prohibits offering it as a commercial hosted service - exactly what symposium.md is. Building on it means a commercial agreement with the named incumbent-to-beat.
- **Wrong data model.** Workspace-wiki (teams, collections, members) vs our per-doc unit with its own audience. Per-doc grantees and "my docs" would be surgery on the spine; single-team instances vs hosting a million individuals likewise.
- **Editor-centric where we are push-centric.** Its heart is a realtime ProseMirror/Yjs editor; anchors are marks in editor state, which is the exact fragility we differentiate against (whole-doc replace destroys anchors). Our quote-based re-anchoring engine doesn't exist there and would be built against a hostile representation, while we inherit the sync tax section 1 designed out.
- **Not HTML-native, not our stack.** Sanitized ProseMirror/markdown pipeline vs HTML-as-API (section 6); needs Node + Postgres + Redis + websockets, which forfeits the all-Cloudflare cost structure and makes a big Postgres the system of record.
- **The moat is still 100% on us.** Agent identity, pending comments, resolve-cites-version provenance, rendered diffs: none exist in Outline. We'd adopt ~100k+ encumbered LOC for the commodity 20% and still build the hard part inside someone else's schema.
- **Fork treadmill.** Outline ships fast (anchored comments May 2026, MCP patching Apr 2026); a heavily diverged fork means perpetual merges from the competitor most likely to close our gaps.

Right use of Outline: reference implementation and the benchmark to beat on anchors, resolve, and sharing. Phase 1's scope (push, render, mint version, serve from CDN) is genuinely less work to build than bending Outline into this shape.

## 8. Who pays, and for what

**Publishing is paid. Reading is free and always will be.** That split is the
whole pricing model, and it follows the cost curve: readers are cheap to serve
because R2 has no egress fees, while publishers are the ones who consume storage,
create abuse risk, and get the value.

*Revised 2026-07-25. An earlier version of this section made public sharing free
forever and gated access control at $5-8/mo. That is no longer the plan — see
"what this costs us" below, which is the honest bill for the change.*

- **Free forever:** reading. No account, no sign-in, nothing to install. This is
  not a tier, it is a property of the product.
- **Paid to publish (~$2.99/mo):** the price is deliberately below the threshold
  where anyone deliberates. It is meant to read as trivially cheap rather than as
  a purchase decision, and to sit far under Obsidian Publish's $8 so it never
  invites the comparison.
- **Copilot Plus** includes publishing. The cheap standalone tier is how someone
  who does not use Copilot gets in, not a downgrade for someone who does.
- **Paid (team, later):** shared spaces, org identity, the agent-approval
  workflows from the positioning doc. This is where Notion-class ARPU lives if the
  thesis holds.

**The current launch gate includes every paid Copilot license.** Active Plus
subscriptions and lifetime Supporter/Believer licenses can publish. The
standalone Symposium subscription above is still planned; until it exists,
publishing requires a paid Copilot license. The explicit set in `src/auth.ts`
keeps unknown or future plans closed until their entitlement is deliberate.

### Break-even, on net receipts

**Payment processing is a first-class line item at this price, not a rounding
error.** At Stripe's standard 2.9% + $0.30, a $2.99 monthly charge nets $2.60.
The percentage is trivial; the fixed $0.30 is the whole story, and it makes the
effective take rate **12.9%**. Fixed per-transaction fees punish cheap
subscriptions specifically, which is a property of the price point and not
something to be optimized away later.

| | Monthly at $2.99 | Annual at $35.88 |
|---|---|---|
| Charges per year | 12 | 1 |
| Processing fees per year | $4.64 | $1.34 |
| Net per year | $31.24 | $34.54 |
| Effective take rate | 12.9% | 3.7% |

Annual billing collapses twelve fixed fees into one and is the obvious
mitigation. It should be the default offer while the price stays this low.

**Break-even stops being a milestone worth tracking.** A break-even publisher
count is a concept from the model this section replaced, where a free majority
was subsidised by a paying minority. Every publisher now pays, so revenue and
infrastructure both scale with the publisher count — and revenue scales about two
orders of magnitude faster, because §2 puts the marginal publisher at fractions
of a cent per month against $2.60 of net receipts.

| Scale (§4) | Infra | Net receipts | Publishers needed to cover infra |
|---|---|---|---|
| 1k publishers | ~$25/mo | ~$2.6k/mo | ~10 |
| 100k publishers | ~$150-500/mo | ~$260k/mo | ~193 |
| 1M publishers | ~$1.5-5.5k/mo | ~$2.6M/mo | ~2,100 |

The last column is the honest version of the old break-even number: at every
scale it is well under 1% of the publisher base, and the ratio improves as the
product grows. Infrastructure is never what this product has to earn its way past
— §10's point about headcount stands unchanged.

**Readers do not appear in this arithmetic at all.** §2 is explicit that cost
scales with publishers and bytes rather than audience size, and R2's lack of
egress fees is what makes a document read by 100k people cost approximately
nothing to serve. Treat the reader population as a distribution asset, not a
cost centre. The two cohorts are modelled separately and only publishers pay.

### What this costs us, stated plainly

A publishing gate is a distribution tax. The positioning doc's wedge runs
*share, then comment, then converge*, and the first step is the one that spreads
— every shared document is an advert seen by people who do not have the product.
Charging for step one throttles exactly that. $2.99 is small in absolute terms and
still infinitely more than free, because the friction is the card, not the
amount.

The compensating argument is that a paid gate is also the cheapest abuse control
available. It puts a real identity behind every publisher and gives us an account
to terminate, which matters for a service whose core risk is a bad document
poisoning a domain ([serving-domain.md](serving-domain.md)). It does not remove
the need for a separate serving domain — see that doc for why one incident is
enough regardless of rate — but it makes incidents rarer.

Worth revisiting if publisher growth stalls, since the free-share wedge is the
strategy this doc was originally written to cost.

---

## 9. Failure modes and honest caveats

- **A viral doc is not a risk** (CDN absorbs it), but **a hot *private* doc post-phase-2 is mildly interesting**: auth-checked serving can't be dumb-cached. Signed URLs with short TTLs keep the cache hit rate; solvable, just don't forget it.
- **Version storage compounding**: the "40 versions/user" assumption goes wrong if agents push on every iteration loop (they will). Dedupe + a retention policy on old versions (e.g. keep last N + weekly snapshots) caps it. Decide the policy before agents make it a bill. Note that every publisher is now a paying publisher (§8), so retention is a quota question applied uniformly, not a free-tier restriction.
- **Agent traffic post-phase-4** is the only line that could surprise: a misbehaving agent in a loop is a one-key DoS. Rate limits per key are the whole answer; ship them with the API.
- **The estimates assume Cloudflare's economics persist.** They have for a decade and Bunny prices the fallback at <2x. Even the fallback numbers don't change any conclusion.
- **What this doc does not de-risk:** demand. Cost feasibility at 1M users is only interesting if wedge step 1 gets its first thousand. That risk lives in [[Agent-First Docs - Product Positioning#Risks and falsifiers]], not here.

---

## 10. Bottom line

- **1k users: ~$25/mo.** Run it off pocket change indefinitely. Publishing is paid from launch (§8), but at this scale the subscription is not what keeps the lights on — founder time is the cost, and the price exists to gate abuse and prove willingness to pay, not to fund servers.
- **100k users: ~$150-500/mo.** Still solo-operable; the constraint is the abuse queue and support, not servers. Infrastructure is under 0.2% of net receipts here (§8), so the product is long past cash-positive; what it has to earn its way past is founder time. Access control is the next paid feature above the publishing line rather than the first paid tier.
- **1M users: ~$1.5-5.5k/mo infra, but a $60-120k/mo team reality.** Infra never becomes the story; headcount and upgrade rate do, which is the *normal* SaaS story with unusually good COGS.

The structural gifts: static immutable artifacts (perfect caching), no realtime editor (no sync tax), BYO agents (no inference COGS), and the HTML-native all-Cloudflare stack (content is portable files, the database is a rebuildable pointer index). The structural debt: public hosting of user-uploaded HTML attracts abuse, so the sacrificial serving domain ([serving-domain.md](serving-domain.md)), noindex defaults, publisher gating, and scanning must be day-one decisions, not retrofits. The paid publishing gate lowers the incident rate but not the blast radius of any one incident, so it substitutes for none of them.

**Feasible? Yes, unusually so. This can start as a $50/mo side surface of Copilot and grow to 1M users without a single scary infrastructure invoice. The scarce resources to guard are founder attention and domain reputation, not dollars.**

---

*Assumptions and vendor prices (R2, Workers, Bunny, SES, Supabase) as of 2026-07; revisit if any serving-path dependency moves to per-user pricing.*
