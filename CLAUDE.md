# updoc

Push a local md/html file, get a public HTML page on the internet. v0 scope: HTML
upload → public page, upload API private and programmatic (Obsidian Copilot only).

## Development

```bash
npm install
npm run dev        # wrangler dev
npm run typecheck
npm test
npm run deploy     # wrangler deploy
```

`README.md` carries the details these commands need: running against a local
worker with no license server, and the provisioning sequence a first deploy
requires. `scripts/smoke.sh` checks a *deployed* worker end to end and is run by
hand — it needs a real license key, so it is deliberately not in CI.

Tests run inside workerd against real R2 and D1 (Miniflare), never against test
doubles for them. A binding double asserts our idea of Cloudflare rather than
Cloudflare, so the only ones in the suite are deliberately broken bindings used
to test failure paths.

## The HTTP contract is frozen

`README.md` § HTTP API is the contract Obsidian Copilot is written against, and
it is the source of truth — not this repo's source. Nothing in it changes
without a client release: not a status code, not an error `code`, not a field
name. Adding to it is fine; changing what is there is a cross-repo decision.

Two conventions in it are security properties rather than style, and both are
easy to undo by accident:

- **404, never 403.** A doc belonging to another publisher must be
  indistinguishable from one that never existed, on every endpoint.
- **404 vs 410.** A deleted doc keeps its D1 row forever so its url answers 410.
  Delete destroys the R2 objects; it must never delete the row.

## Product context

`docs/positioning.md` and `docs/cost-at-scale.md` are the source of truth for what
this product is and how it is allowed to be built. Read them before designing
anything non-trivial — especially §6 of the cost doc (architecture) and the wedge
in the positioning doc.

## Non-negotiable design constraints

These are day-one decisions, not retrofits:

- User content is served from a **sacrificial domain**, separate from the brand
  domain. Reputation damage must not land on `updoc.md`.
- Shared docs are **`noindex` + `nofollow` by default**.
- **Publisher-gated, reader-open**: publishing requires a key; reading requires
  nothing.
- **R2 is the system of record**, and the stored format is HTML. D1 holds pointer
  rows only — never content — and must be rebuildable by scanning R2 manifests.
  **This does not hold yet — see below. Do not rely on it.**
- Every push mints an **immutable version** served with `cache-control: immutable`.
  Render at push time, never at read time.
- **No per-MAU or per-seat priced dependency** anywhere in the serving path.
- Quotas and per-key rate limits ship with the feature they protect, not later.

## Owed before there is much data

**D1 is currently the only record of who owns a doc, what it is called, and
whether it was deleted.** R2 holds `docs/{id}/v{n}.html` and nothing else, so the
rebuildability the constraint above claims is not true today:

- publisher, title and timestamps exist only in D1;
- a deleted doc leaves an empty R2 prefix, so a rebuild could not tell a
  withdrawn url from one that never existed, and it would answer 404 where it
  promised 410.

The fix is the per-doc `manifest.json` from `docs/cost-at-scale.md` §6: written
after each push as a snapshot of the doc's D1 state, and left behind as a
tombstone on delete rather than swept with the version objects. Snapshot it, do
not read-modify-write it.

**Not a deploy blocker.** Backfilling manifests needs the D1 they insure
against, which sounds urgent but isn't while a rebuild would be a handful of
rows — and D1 has a 30-day Time Travel window underneath. Do it well before
there is enough data that reconstructing it by hand would hurt. Until then,
treat D1 as a system of record, not as a cache.

## Owed when the real serving domain lands

v0 runs on a `workers.dev` subdomain, which sits outside the CDN cache. Two
things become true the moment user content moves to a real serving domain, and
both are easy to miss because nothing fails loudly without them:

- **Delete must purge the CDN cache.** Pinned `/v{n}` urls are served
  `immutable` for a year. With no shared cache in front of the worker that is
  harmless, but on a cached domain an unshared doc would keep being served from
  the edge. Wire a purge into `deleteDoc`; the private-cache copies readers
  already hold are unrecallable by any design, and the README says so.
- **Set `SERVING_HOST` and `API_HOST`.** The router resolves surface by host
  first and only falls back to path prefixes while both are empty. Leaving them
  unset on a two-domain deployment means `/api/v1` stays reachable on the
  sacrificial domain, which is the whole point of splitting them.

## Git hygiene

Stage explicit paths (`git add src/foo.ts`), never `git add -A` / `git add .`.
Before committing, review the staged set with `git status` **and**
`git diff --cached`, plus `git status --porcelain --untracked-files=all` to catch
untracked files.

All changes ship through a pull request. Never push directly to `main`.
