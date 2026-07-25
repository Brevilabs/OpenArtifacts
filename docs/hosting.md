# Hosting

What Symposium runs on, assuming you know how web apps get deployed but have never
used Cloudflare. If your reference point is Vercel and Vercel Postgres, the
[translation table](#coming-from-vercel) maps most of it in one screen.

[← README](../README.md) · [Deploying](deploying.md) · [Development](development.md)

## The four things

**Worker** — your code. A single JavaScript entry point (`src/index.ts`) that
Cloudflare runs in all of its data centers. It takes a `Request` and returns a
`Response`, like a `fetch` handler in a browser. There is no server process to
start, no port to listen on, and no region to choose: requests are handled
wherever the caller happens to be.

It runs in a V8 isolate — the sandbox that isolates one browser tab from another
— rather than a container or a VM. Isolates start in about a millisecond, so
Cloudflare keeps them warm and cold starts are not something you design around.
The trade is that it is **not Node**. You get web-standard APIs (`fetch`,
`Request`, `Response`, `crypto`, streams, `URL`); Node's own built-ins are
available only behind an opt-in `nodejs_compat` flag that this project does not
set, so libraries reaching for `fs`, `net` or `http` will not run here. That is
why this repo has no Express, no `pg`, and no ORM. See
[Gotchas](#gotchas) for how that failure actually presents, because it is not
where you would expect.

**R2** — object storage. S3's API, with no charge for data leaving it. You `put`
and `get` blobs by key. Symposium keeps every published version as one immutable
object at `docs/{docId}/v{n}.html`; reading a document is one `get`, streamed
straight back to the reader.

**D1** — a SQL database. It is **SQLite**, not Postgres, and that difference does
real work — see [D1 in practice](#d1-in-practice). Symposium uses it purely as an
index: who owns a doc, what it is called, which versions exist, whether it was
deleted. No document content is ever stored in it.

**workers.dev** — a free subdomain Cloudflare gives every account, so a Worker is
reachable the moment you deploy without owning a domain or touching DNS. Ours
will be `symposium.<account-subdomain>.workers.dev`. From the caller's side it
behaves like any other URL; the catch is that it sits outside Cloudflare's CDN
cache, so every request reaches your Worker. It is meant for development and
early testing, which is exactly where Symposium is.

Two more names you will meet: **wrangler**, the CLI that does everything
(`wrangler dev`, `wrangler deploy`, `wrangler d1 …`), and **workerd**, the
open-source runtime it runs locally — the same runtime that runs in production,
so local behavior is real behavior.

## How the code reaches storage

This is where Cloudflare departs most from what you are used to.

You never open a connection to R2 or D1. There is no connection string, no
credentials in the environment, no pool. `wrangler.jsonc` declares **bindings**:

```jsonc
"r2_buckets":   [{ "binding": "DOCS", "bucket_name": "symposium-docs" }],
"d1_databases": [{ "binding": "DB",   "database_name": "symposium", … }]
```

and Cloudflare hands the code an already-connected client for each, as
properties of the `env` object every request receives:

```ts
const object = await env.DOCS.get(key);                  // R2
const row = await env.DB.prepare(sql).bind(id).first();  // D1
```

Everything that normally sits between a serverless function and its database —
pooling, PgBouncer, Neon's HTTP driver, "too many connections" under load — has
no equivalent here, because there is no connection to run out of. Bindings are
also the access-control model: a Worker can reach exactly the buckets and
databases its config names, and nothing else.

## Coming from Vercel

| Vercel | Cloudflare | Worth knowing |
| --- | --- | --- |
| Project | Worker | One deployable unit. Ours is named `symposium`. |
| Serverless / Edge Function | Worker | Only one kind here. |
| `vercel dev` | `wrangler dev` | Runs the production runtime locally, with local storage. |
| `vercel deploy` | `wrangler deploy` | CLI, not git-triggered — see [Deploys](#deploys-are-explicit). |
| Environment Variables | Vars and Secrets | Vars are committed config; secrets are set by CLI. |
| Vercel Postgres (Neon) | D1 | SQLite. Different enough to read the section below. |
| Vercel Blob | R2 | S3-compatible, no egress charge. |
| Vercel Edge Network | Cloudflare CDN | Here it is the same company as the compute. |
| Preview deployments | Versions | Every deploy is a rollback target; no per-PR URLs by default. |
| `vercel.json` + dashboard env | `wrangler.jsonc` | One committed file, and it beats the dashboard. |

## A request, end to end

```
reader → Cloudflare edge → Worker (src/index.ts)
                             ├─ D1  — which version? is it deleted?
                             └─ R2  — the stored HTML, streamed back
```

The Worker's first decision is which of two surfaces a request belongs to:
`/api/v1/*` is the publisher API and needs a key, `/d/*` is public reading. They
are split so they can later sit on separate domains — user content on a
throwaway one, the API on the brand one — for reasons in
[cost-at-scale.md](cost-at-scale.md) §5.

**Nothing is cached today**, and attaching a domain would not by itself change
that. Two independent reasons:

1. `workers.dev` bypasses the CDN cache entirely.
2. Cloudflare does not cache HTML by default *on any domain*. Eligibility is
   decided by file extension — not MIME type, and not the `Cache-Control` the
   Worker sends — and `/d/{docId}` has no extension.

Caching therefore needs an explicit **Cache Rule** on the serving zone, or the
Cache API inside the Worker. Until one exists, every read invokes the Worker and
touches D1 and R2. That is fine at current volume, which is why it has not been
done — but it does mean the cheap-serving argument in `cost-at-scale.md` is not
in effect yet. Whenever it is switched on, deletes have to purge the cache in the
same change, or unshared documents keep being served. Both are tracked in
`CLAUDE.md`.

## D1 in practice

Postgres reflexes to unlearn:

- **It is SQLite.** Five storage classes, no `SERIAL`, no `JSONB`, no extensions,
  no `pg_*`. `migrations/0001_init.sql` reads accordingly.
- **Migrations are plain `.sql` files** in `migrations/`, applied with
  `wrangler d1 migrations apply`. No Prisma, no Drizzle — queries are written by
  hand in `src/db.ts`.
- **A database is single-threaded**, processing queries one at a time. Ideal for
  the small indexed lookups Symposium makes; not where an analytical query goes.
- **Writes go to one region**, reads can be replicated. Barely matters here: a
  read touches D1 once for a pointer, and the document itself comes from R2.
- **Backups are Time Travel** — restore to any point in the last 30 days by
  timestamp. No `pg_dump` to schedule, no Neon-style branching.

Limits and price: 10 GB per database, 50,000 databases per account, 1,000
queries per Worker invocation. Billing is per row read and written, with 25
billion reads and 50 million writes included monthly, so at Symposium's shape it is
effectively free.

## R2 in practice

R2 is S3's API without S3's egress bill, and that second half is why the cost
model in [cost-at-scale.md](cost-at-scale.md) works at all: a document read by
100,000 people costs essentially nothing to serve.

Storage is $0.015/GB-month; writes (Class A) $4.50 per million, reads (Class B)
$0.36 per million. A push is a couple of writes, a read is one.

Because objects are immutable and HTML is finished at publish time, serving is a
straight read-and-stream — the Worker never re-renders anything.

## Config, vars and secrets

`wrangler.jsonc` is the whole deployment config: bindings, compatibility date,
and plain variables. It is committed, and it overrides the dashboard — settings
edited in Cloudflare's UI are overwritten by the next deploy.

Two kinds of configuration, and the split is enforced:

- **Vars** — plaintext in `wrangler.jsonc`, committed. `SERVING_HOST` and
  `API_HOST` are vars.
- **Secrets** — never in any file. `wrangler secret put NAME` prompts and stores
  the value encrypted; code reads it off the same `env` object, indistinguishable
  from a var. `LICENSE_API_KEY` is a secret.

Locally, secrets come from `.dev.vars` (gitignored; copy `.dev.vars.example`).

The `database_id` in `wrangler.jsonc` looks like a credential and is not. It is
an identifier, the binding will not resolve without it, and it is committed.

## Deploys are explicit

Pushing to `main` deploys nothing. `wrangler deploy` uploads the current working
tree, from whoever runs it. Cloudflare does offer a git integration; we have not
set one up, so shipping is a deliberate act.

Every deploy is retained as a version, and `wrangler rollback` returns to an
earlier one. There are no per-PR preview URLs unless we configure them.

## Local development

`wrangler dev` runs workerd on your machine against local R2 and D1 — the real
runtime and real storage engines, not mocks, and no Cloudflare account needed.
`npm test` does the same through `@cloudflare/vitest-pool-workers`, which is why
the suite needs neither credentials nor a deployment.

Local state lives in `.wrangler/`, and a local D1 starts empty, so migrations get
applied to it separately. [Development](development.md) has the sequence,
including the license-server workaround a local push needs.

## Gotchas

- **A Node-oriented package installs fine and then fails.** `npm install`
  resolves it happily; the break comes at bundling or runtime when it reaches for
  an API that is not there. A clean install proves nothing. Cloudflare does offer
  a `nodejs_compat` compatibility flag that provides a large subset of Node's
  built-ins — it is opt-in, needs a compatibility date of 2024-09-23 or later,
  and **we do not set it**, so today none of those built-ins are available here.
- **Nowhere to put a file.** `nodejs_compat` does provide `node:fs`, but the
  filesystem behind it is virtual and in-memory: `/tmp` is writable and scoped to
  a single request, and nothing written there is visible to any other request.
  Persistent storage is R2 or D1, and there is no third option.
- **No work after the response is sent.** Use `waitUntil`, a Queue, or a Cron
  Trigger.
- **The dashboard is not the source of truth.** Change `wrangler.jsonc`.
- **`console.log` goes nowhere by default.** `wrangler tail` streams it live, and
  the dashboard's Logs tab keeps it (observability is on in our config).

## Why this stack, and where it strains

The decisive property is R2's lack of egress fees. Symposium is, at bottom, a service
that hands the same immutable bytes to many readers, and everywhere else that
shape is dominated by bandwidth — S3 plus CloudFront is roughly $0.085/GB, which
at scale *is* the business, and is zero here. The rest follows: immutable version
URLs cache perfectly, HTML is rendered once at publish time, and the compute per
read is a lookup and a stream. No component in the serving path is priced per
user or per seat, which is the other way this category usually gets expensive.

The weak link is D1, and it is worth being clear-eyed. One database is capped at
10 GB, is single-threaded, and takes writes in a single region. Symposium's shape
keeps that comfortable — a push is a handful of small writes, a read is one
indexed lookup — but a write-heavy future (agents pushing on every edit, then
comment threads) would eventually reach it. Two escape hatches are already in the
design rather than bolted on later: an account can hold 50,000 databases, so the
index can shard by publisher; and [cost-at-scale.md](cost-at-scale.md) §6 moves
per-document state into Durable Objects, giving each document its own embedded
SQLite instead of one shared database. That is where the headroom lives.

Two caveats to hold onto:

- **The property that makes D1 a safe choice is not true yet.** The design treats
  it as a disposable index rebuildable from R2, which is what makes a young,
  limited database an acceptable home for it. Today R2 holds only version
  objects, so ownership and deletion state exist nowhere else. Until per-doc
  manifests ship (`CLAUDE.md`), D1 is a real system of record and deserves to be
  treated as one.
- **This is a concentrated bet on one vendor**, and the usual reassurance does
  not hold yet either. Documents are already portable — files behind an
  S3-compatible API. The index is not: copy R2 and replay the schema today and
  ownership is gone entirely, and every deleted document's url degrades from 410
  to 404, because the tombstone exists only in D1. Manifests are what would make
  "leaving means copying objects" true; until they ship it is the plan, not the
  situation.

For a document-sharing service specifically, this is a strong fit, and more so
the larger it gets. It would be the wrong stack for something transactional,
relationally complex, or CPU-heavy per request — Symposium is none of those.

It also holds for where the product is going. Comments (see
[comments.md](comments.md)) are the workload Durable Objects exist for: a
document is a natural partition key, so per-document coordinators shard for free
with no cross-document contention — where a single Postgres would have every
document's threads contending on the same tables. Re-anchoring comments across a
rewrite is CPU-bound string matching with no I/O, which is the cheapest thing
there is to run here, and live updates later have a path through DO WebSockets
without changing the model. The strain shows up in two places: a DO lives in one
region, so a distant commenter pays a round trip on writes, and threads make the
served page vary with state — which turns the caching decision above from
theoretical into load-bearing.
