# Symposium

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

`docs/development.md` carries the details these commands need — including the
license-server workaround a local push needs — and `docs/deploying.md` has the
provisioning sequence a first deploy requires. `docs/hosting.md` explains the
Cloudflare model itself. `scripts/smoke.sh` checks a *deployed* worker end to end and is run by
hand — it needs a real license key, so it is deliberately not in CI.

Tests run inside workerd against real R2 and D1 (Miniflare), never against test
doubles for them. A binding double asserts our idea of Cloudflare rather than
Cloudflare, so the only ones in the suite are deliberately broken bindings used
to test failure paths.

## The HTTP contract is frozen

`docs/http-api.md` is the contract Obsidian Copilot is written against, and it
is the source of truth — not this repo's source. Nothing in it changes
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

- User content is served from a **sacrificial domain** (`symposium.site`),
  separate from the brand domain. Reputation damage must not land on
  `symposium.md`. `docs/serving-domain.md` is why, and why a subdomain does not
  substitute. There is no migration path once links are in the wild.
- Shared docs are **`noindex` + `nofollow` by default**.
- **Publisher-gated, reader-open**: publishing requires a key; reading requires
  nothing.
- **Documents belong to an account, not to the credential that published them.**
  `docs.owner` is an app-sites `User.id`, and it is always *derived* — from a
  validated license key, later from a signed session — and **never accepted as
  input**. An endpoint that took an owner id as a parameter would turn every id
  into a password, and would not look like a security change when written.
  `docs/identity.md` is the whole model.
- **R2 is the system of record**, and the stored format is HTML. D1 holds pointer
  rows only — never content — and must be rebuildable by scanning R2 manifests.
  **This does not hold yet — see below. Do not rely on it.**
- Every push mints an **immutable version** served with `cache-control: immutable`.
  R2 stores the publisher's own bytes; Symposium's additions (the robots meta,
  the favicon, the social card and the two bylines) are injected on the way out by
  `renderServedHtml`, so a byline change — or a plan that removes one — reaches
  documents already published.
  Nothing else is composed per read: the additions are a pure function of the
  stored version, so the page stays cacheable.
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

## Owed now that the serving domain has landed

The domains are attached: documents on `symposium.site`, the API on
`api.symposium.md`. `workers_dev` stays `false` — the router would otherwise
serve `/d/*` on a `workers.dev` hostname, and that domain is on the Public
Suffix List, so a listing against it would take every Worker on the account's
subdomain. Two things came due the moment user content moved to a real serving
domain, and both are easy to miss because nothing fails loudly without them:

- **Caching needs a Cache Rule, not just a domain.** Cloudflare does not cache
  HTML by default — eligibility is decided by file extension, not MIME type and
  not the `Cache-Control` the worker sends, and `/d/{docId}` has no extension.
  Without an explicit Cache Rule on the serving zone (or the Cache API inside the
  worker), attaching a domain changes nothing and every read still hits D1 and R2.
- **Then delete must purge that cache.** Pinned `/v{n}` urls are served
  `immutable` for a year, so the moment there is an edge cache, an unshared doc
  would keep being served from it. Wire a purge into `deleteDoc` in the same
  change that turns caching on — the two belong together, and shipping the first
  without the second is how a withdrawn doc stays readable. The private-cache
  copies readers already hold are unrecallable by any design, and the README says
  so.
`SERVING_HOST` and `API_HOST` are already set, which is what makes the router
resolve surface by host instead of falling back to path prefixes. Leave them
set: unset on a two-domain deployment, `/api/v1` becomes reachable on the
sacrificial domain, which is the whole point of splitting them.

## Git hygiene

Stage explicit paths (`git add src/foo.ts`), never `git add -A` / `git add .`.
Before committing, review the staged set with `git status` **and**
`git diff --cached`, plus `git status --porcelain --untracked-files=all` to catch
untracked files.

All changes ship through a pull request. Never push directly to `main`.
