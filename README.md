# updoc

Push a local md/html file, get a public HTML page on the internet.

v0 is the wedge, nothing more: **HTML upload → public webpage**. The upload API is
private and programmatic — the only caller is Obsidian Copilot's share action. No
reader accounts, no permissions, no comments.

## Where this is going

updoc is the first step of an agent-first docs product: a shared artifact where
humans and agents comment and iterate together to converge on consensus. The
long-form arguments live in `docs/`:

- [`docs/positioning.md`](docs/positioning.md) — why the product should exist, the
  central hypothesis, the three-step wedge (share → comment → converge).
- [`docs/cost-at-scale.md`](docs/cost-at-scale.md) — whether the free wedge is
  affordable (it is), and the all-Cloudflare, HTML-native architecture that keeps
  it that way.

Read both before proposing architecture. Several day-one decisions in there are
load-bearing and are not retrofittable:

- **Serve user content from a sacrificial domain**, never the brand domain.
- **`noindex` + `nofollow` by default** — this deletes most of the spam incentive.
- **Publisher-gated, reader-open** — publishing needs a key, reading needs nothing.
- **R2 holds the truth as HTML**; D1 is a small rebuildable pointer index.
- **Flat-fee dependencies only** in the serving path — no per-MAU pricing, ever.

## Stack

Cloudflare all the way down: Workers, R2, D1, Durable Objects, Queues, Turnstile.

## Development

```bash
npm install
npm run dev        # wrangler dev
npm run typecheck
npm test
```

## Deployment

`wrangler deploy`. All changes ship through a pull request; never push to `main`.
