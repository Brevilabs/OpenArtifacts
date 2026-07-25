# Hosting

How updoc runs, written for someone whose mental model is Vercel + Vercel
Postgres (Neon). Cloudflare uses different words for most of the same jobs, and
is genuinely different in two places that matter.

[← README](../README.md) · [Deploying](deploying.md) · [Development](development.md)

## The one-paragraph version

There is no server, no container, and no Postgres. Your code is one JavaScript
function that Cloudflare runs in every one of its data centers; it reads and
writes two storage services that it talks to through variables rather than
connection strings. You ship it with `wrangler deploy`, which uploads the bundle
in a few seconds. That is the whole system.

## Translation table

| Vercel | Cloudflare | Notes |
| --- | --- | --- |
| Project | Worker | One deployable unit. Ours is named `updoc`. |
| Serverless / Edge Function | Worker | Same thing here — there is only one kind. |
| `vercel deploy` | `wrangler deploy` | CLI-driven by default, no git integration required. |
| `vercel dev` | `wrangler dev` | Runs the real runtime locally, with local storage. |
| Environment Variables | Vars and Secrets | Vars live in `wrangler.jsonc`; secrets are set by CLI. |
| Vercel Postgres (Neon) | **D1** | SQLite, not Postgres. See below. |
| Vercel Blob / S3 | **R2** | S3-compatible object storage, no egress fees. |
| Vercel Edge Network | Cloudflare CDN | Same job; here it is the same company as the compute. |
| Preview deployments | Versions / environments | Exists, but not wired to PRs by default. |

## What actually runs the code

A Worker is not a container and not a Lambda. It is a V8 isolate — the same
sandbox a browser tab uses — and Cloudflare keeps thousands of them warm in each
data center. That has two consequences worth internalizing:

- **Cold starts effectively don't exist.** There is no container to boot, so you
  don't need the warming tricks or the "avoid heavy imports" discipline that
  Lambda-based hosting teaches.
- **It is not Node.** You get web-standard APIs — `fetch`, `Request`, `Response`,
  `crypto`, streams — not `fs`, `net`, or most of npm's server ecosystem. That is
  why this repo has no Express, no Prisma, and no `pg`. If a library expects
  Node's networking, it will not run.

Your code runs wherever the reader is, not in one region you picked.

Billing is $5/month for the account, including 10 million requests and 30 million
CPU-milliseconds. Note **CPU**-milliseconds: waiting on R2 or D1 is not billed,
only time actually computing. A request that spends 200ms fetching and 2ms
assembling a response bills 2ms. Default limit is 30 seconds of CPU per request,
which nothing here comes close to.

## D1 is SQLite, and that is the biggest adjustment

This is where the Neon mental model will actively mislead you.

- **It is SQLite.** No `SERIAL`, no `JSONB`, no extensions, no `pg_*`. Types are
  SQLite's five. Our schema is in `migrations/0001_init.sql` and reads like it.
- **There is no connection string and no pool.** You do not open a connection —
  a `DB` variable is handed to your code, already connected. All the
  serverless-Postgres tax you're used to (pooling, PgBouncer, "too many
  connections" under load, Neon's serverless driver) simply doesn't apply.
- **One database is single-threaded** and processes queries one at a time. Fine
  for pointer lookups; it is not where you put a heavy analytical query.
- **It has one primary region.** Reads can be replicated, writes go to one place.
  For updoc that is irrelevant — reads are served from R2 through the cache and
  barely touch D1.
- **Limits:** 10 GB per database, 50,000 databases per account, 1,000 queries per
  request. Pricing is per row read/written, with 25 billion reads and 50 million
  writes included monthly. At updoc's shape this is free indefinitely.
- **Backups are "Time Travel":** any point in the last 30 days, restored by
  timestamp. There is no `pg_dump` to schedule and no Neon-style branching.

Migrations are plain `.sql` files in `migrations/`, applied with
`wrangler d1 migrations apply`. There is no Prisma, no Drizzle, no ORM at all —
queries are written by hand in `src/db.ts`.

## R2 is where the actual content lives

R2 is S3's API without S3's egress bill — that last part is the reason the whole
cost argument in [cost-at-scale.md](cost-at-scale.md) works. Serving a document
that gets read by 100,000 people costs approximately nothing.

Every published version is one immutable object at `docs/{docId}/v{n}.html`, and
serving is a straight read-and-stream. Like D1, you get a `DOCS` variable rather
than credentials and a region.

Storage is $0.015/GB-month. Writes (Class A) are $4.50/million, reads (Class B)
$0.36/million. A push is a couple of writes; a read is one.

## How a request actually flows

```
reader → Cloudflare edge → [cache hit? serve, done]
                         ↓ miss
                       Worker (src/index.ts)
                         ├─ D1: which version, is it deleted?
                         └─ R2: the stored HTML → streamed back
```

The Worker decides which of two surfaces a request belongs to before anything
else — `/api/v1/*` is the publisher API and needs a key, `/d/*` is public
reading. That split exists so the two can later live on different domains, which
matters for reasons covered in [cost-at-scale.md](cost-at-scale.md) §5.

One thing to know now: **`workers.dev` URLs are not cached.** Today every read
reaches the Worker. Caching switches on when a real domain is attached, which is
a DNS change, not a code change.

## Config, vars and secrets

`wrangler.jsonc` is the whole deployment config — it is `vercel.json`,
the dashboard's env screen, and your infra-as-code, in one file. It declares
which R2 bucket and which D1 database get handed to the code as `DOCS` and `DB`.

Two kinds of configuration, and the distinction is enforced:

- **Vars** are plaintext in `wrangler.jsonc`, committed. `SERVING_HOST` and
  `API_HOST` are vars.
- **Secrets** never appear in any file. `wrangler secret put NAME` prompts for
  the value and stores it encrypted; the code reads it off the same `env` object,
  indistinguishable from a var. `LICENSE_API_KEY` is a secret.

Locally, secrets come from `.dev.vars` (gitignored; copy `.dev.vars.example`).

The `database_id` in `wrangler.jsonc` looks like a secret and isn't — it is just
an identifier, and the binding won't resolve without it, so it gets committed.

## Deploys are not git-triggered

The habit to unlearn: pushing to `main` deploys nothing. `wrangler deploy`
uploads the current working tree, from whoever's machine runs it. Cloudflare does
offer a git integration, and we may add one, but today shipping is deliberate.

Every deploy is kept as a version you can roll back to
(`wrangler rollback`). There are no per-PR preview URLs unless we set them up.

## Local development is the real thing

`wrangler dev` runs the actual Cloudflare runtime (`workerd`) on your machine
with local R2 and D1 — not mocks, and no account required. The test suite does
the same, which is why `npm test` needs no credentials and no deployment.

The practical difference from `vercel dev`: local state lives in `.wrangler/`,
and a local D1 starts empty, so migrations are applied against it separately.
[Development](development.md) has the sequence.

## Things that will bite you coming from Vercel

- **`npm install <server library>` often won't work.** No Node networking APIs.
- **No filesystem.** Nothing to write to; R2 or D1 or nothing.
- **No long-running background work.** A request ends when the response is sent.
  Deferred work needs `waitUntil`, a Queue, or a Cron Trigger.
- **SQLite, not Postgres.** Worth repeating, because the schema is where the
  assumption hides.
- **The dashboard is not the source of truth.** Editing config in Cloudflare's UI
  gets overwritten by the next `wrangler deploy`. Change `wrangler.jsonc`.

## Where to look when something breaks

- `wrangler tail` streams live logs from the deployed Worker.
- Observability is on in `wrangler.jsonc`, so requests and `console.error` output
  are queryable in the Cloudflare dashboard under Workers → updoc → Logs.
- `wrangler d1 execute updoc --remote --command "select ..."` queries production
  D1 directly.
- `scripts/smoke.sh <url>` checks a deployment end to end.
