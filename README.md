# Where people and agents get on the same page

Every version and every thread live at one address, so anyone who opens it can
catch up without being briefed.

---

That is what **Symposium** is for, not what it does today. Only the first step
exists: push a local md/html file and get a public HTML page on the internet.
The upload API is private and programmatic, its only caller is Obsidian
Copilot's share action, and there are no reader accounts, no permissions, and no
comments.

## What works today

Everything here is built, tested, and live. See [Production](#production) for
where it runs.

- **Publish a note.** Send rendered HTML, get back a link. Obsidian Copilot
  renders the note locally, so callouts, wikilinks and dataview output survive —
  a server-side markdown pipeline would have flattened them.
- **Re-publish and the link stays the same.** Every push saves a new version, and
  the link you already shared shows the latest one. Old versions keep working
  forever at their own `/v2`-style urls, so a link you sent last week still shows
  what you sent.
- **Anyone with the link can read it.** No account, no sign-in, nothing to
  install. Publishing needs a key; reading needs nothing.
- **Pages are not indexed.** Every page tells search engines to skip it, so a
  shared doc doesn't turn up in Google.
- **Interactive documents work.** Scripts, charts and embedded simulations run,
  which is the reason to serve HTML rather than sanitized markdown. Pages are
  blocked from submitting forms or being embedded in other sites, which is what
  keeps that safe to allow.
- **Unshare.** Delete a doc and its link starts saying it was withdrawn, and the
  stored files are destroyed. Copies already sitting in someone's browser cache
  can't be recalled — no design can do that.
- **See your docs.** List everything you've published, newest first.
- **Publishing is gated to lifetime license holders.** Phase 1 is deliberately
  narrow: the lifetime tier is a small, known group, which is the right size of
  audience for the first public-hosting surface we run. A current Plus key
  authenticates and is still refused, and is told why. Keys are checked against
  the existing license server and the answer is cached for an hour, so a
  license-server outage doesn't stop someone who has published before. Only
  publishing is gated — anyone whose plan lapses keeps listing and unshare, so
  no one is ever locked out of taking down what they already made public.
- **Limits that stop abuse, not people.** 10MB per doc, 100 pushes a day, 500
  docs — generous enough that a real user never notices.

## What's coming

Roughly in order. Nothing below is started.

- **The Obsidian side.** A right-click "share" in Copilot that calls this API and
  remembers the doc's id in the note. Without it, the only way to publish is
  `curl` — this is the next thing to build.
- **Caching.** Cloudflare does not cache HTML by default, so every read today
  invokes the Worker and touches D1 and R2. It needs a cache rule, and then
  deletes have to purge the cache in the same change or unshared documents keep
  being served. The domain split it sits on top of is already live: documents on
  `symposium.site`, the API on `api.symposium.md`, and no `workers.dev` url at
  all, since the router would serve documents there and a `workers.dev` listing
  takes every Worker on the account's subdomain with it.
  [`docs/serving-domain.md`](docs/serving-domain.md) explains why that split
  could not have been added later.
- **Backups that don't depend on the database.** Right now the database is the
  only record of who owns a doc and what it's called. The plan is for each doc to
  carry its own description alongside its files, so the database could be rebuilt
  from scratch. Not urgent while there is little data; it should land well before
  there is a lot.
- **Keeping old versions from piling up.** Every push is kept forever today.
  Fine for people, less fine once agents push on every edit.
- **Opening publishing beyond lifetime holders.** Plus first, then a standalone
  subscription around $2.99/mo for people who don't use Copilot at all. Widening
  it is adding a string to one set in `src/auth.ts`, so the gate moves when the
  abuse tooling and the support load say it can, not when the code is ready.
  Publishing stays paid either way — reading is free and always will be, and free
  publishing is not on the roadmap.
  [`docs/cost-at-scale.md`](docs/cost-at-scale.md) §8 has the reasoning,
  including what the gate costs us in distribution.
- **Then the actual product**: comments anchored to passages, agents drafting
  them for a human to approve, and version-to-version diffs. That is the wedge in
  [`docs/positioning.md`](docs/positioning.md) — share, then comment, then
  converge — and [`docs/comments.md`](docs/comments.md) sketches what the first
  half of it would take. Note the ordering constraint hiding in there: comments
  need to know who is commenting, so reader identity comes first.

## Where this is going

Symposium is the first step of an agent-first docs product: a shared artifact where
humans and agents comment and iterate together to converge on consensus. The
argument for it, and the constraints it has to respect, are in
[`docs/positioning.md`](docs/positioning.md) and
[`docs/cost-at-scale.md`](docs/cost-at-scale.md). Read both before proposing
architecture — several decisions in them are not retrofittable, and `CLAUDE.md`
lists the ones that bind day to day.

## Production

| | |
| --- | --- |
| [symposium.site](https://symposium.site) | Serves published documents. User HTML lives here and never on the brand domain. |
| [api.symposium.md](https://api.symposium.md) | The publisher API. Key-authenticated, no browser surface. |
| [Cloudflare dashboard](https://dash.cloudflare.com/960579f222ad237394703bd52f28114c/workers/services/view/symposium/production) | The Worker itself: deployments, versions, logs, and the rollback button. |

Deploys run from [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
on merge to `main`. [Deploying](docs/deploying.md) covers how, and how to roll
back.

## Docs

| | |
| --- | --- |
| [HTTP API](docs/http-api.md) | Every endpoint, in full. The frozen contract Obsidian Copilot is built against. |
| [Hosting](docs/hosting.md) | How this runs on Cloudflare. **Start here if you know Vercel but not Workers.** |
| [Serving domain](docs/serving-domain.md) | Why user content lives on `symposium.site` and never on the brand domain. |
| [Identity](docs/identity.md) | Who owns a document, why it is the account and not the license key, and how symposium.md sign-in slots in. |
| [Private sharing](docs/private-sharing.md) | How reader identity works, and the phases from public links to agents. Designed, not built. |
| [Deploying](docs/deploying.md) | Provisioning the resources and shipping. |
| [Development](docs/development.md) | Running it locally, including the license-server workaround. |
| [Comments](docs/comments.md) | Design sketch for the next step of the product. Not planned, not built. |
| [Positioning](docs/positioning.md) | Why the product exists and what it becomes. |
| [Cost at scale](docs/cost-at-scale.md) | What it costs to serve, who pays, and the architecture that keeps both cheap. |

## Quick start

```bash
npm install
npm test           # no credentials, no deployment — runs in the real runtime
npm run dev        # local worker, local R2 and D1, no Cloudflare account
```

Cloudflare all the way down: Workers for the code, R2 for the documents, D1 for
the index. [Hosting](docs/hosting.md) explains what each of those is and how it
differs from the Vercel equivalent.
