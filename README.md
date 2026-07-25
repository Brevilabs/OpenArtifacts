# updoc

Push a local md/html file, get a public HTML page on the internet.

v0 is the wedge, nothing more: **HTML upload → public webpage**. The upload API is
private and programmatic — the only caller is Obsidian Copilot's share action. No
reader accounts, no permissions, no comments.

## What works today

Everything here is built and tested. Nothing is deployed yet, so none of it is
reachable on the internet until someone runs [Deploying](#deploying).

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
- **Publishing is gated to Copilot Plus.** Keys are checked against the existing
  license server, and the answer is cached for an hour so a license-server outage
  doesn't stop someone who has published before.
- **Limits that stop abuse, not people.** 10MB per doc, 100 pushes a day, 500
  docs — generous enough that a real user never notices.

## What's coming

Roughly in order. Nothing below is started.

- **The Obsidian side.** A right-click "share" in Copilot that calls this API and
  remembers the doc's id in the note. Without it, the only way to publish is
  `curl` — this is the next thing to build.
- **A real domain.** Today's `workers.dev` url works but sits outside
  Cloudflare's cache, so every read hits the server. Real domains also let user
  content live somewhere separate from the brand, so a bad doc can't damage
  `updoc.md`'s reputation.
- **Backups that don't depend on the database.** Right now the database is the
  only record of who owns a doc and what it's called. The plan is for each doc to
  carry its own description alongside its files, so the database could be rebuilt
  from scratch. Not urgent while there is little data; it should land well before
  there is a lot.
- **Keeping old versions from piling up.** Every push is kept forever today.
  Fine for people, less fine once agents push on every edit.
- **Publishing for free users.** Only Plus license holders can publish, which
  suits a design-partner launch and contradicts the free-wedge thesis long-term.
- **Then the actual product**: comments anchored to passages, agents drafting
  them for a human to approve, and version-to-version diffs. That is the wedge in
  `docs/positioning.md` — share, then comment, then converge.

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
  (Not yet — v0 stores only version objects, so ownership, titles and deletion
  tombstones live solely in D1. See "What's coming" above and `CLAUDE.md`.)
- **Flat-fee dependencies only** in the serving path — no per-MAU pricing, ever.

## Stack

Cloudflare all the way down: Workers, R2, D1, Durable Objects, Queues, Turnstile.

---

# HTTP API

This section is the contract, and it is frozen: the Obsidian Copilot client is
written against what is below, so nothing here changes without a client release.
It is complete on purpose — a client author should never need to read this
repo's source.

## Surfaces

Two surfaces, which will eventually be two domains:

| Surface | Paths | Auth | Notes |
| --- | --- | --- | --- |
| API | `/api/v1/*` | required | Publisher-facing. JSON in, JSON out. |
| Serving | `/d/*` | none | Reader-facing. Public HTML. Never sets a cookie. |

In v0 both run on one `workers.dev` subdomain and the path prefix decides which
is which. Later they split across a brand domain and a sacrificial serving
domain; when that happens the `url` field returned by a push starts pointing at
the serving domain, which is the only reason a client should never build a doc
url itself. **Always use the `url` the API returns.**

`GET /health` → `200 {"ok": true}` is reachable on both, unauthenticated.

## Authentication

Every `/api/v1/*` request carries a Copilot Plus license key:

```http
Authorization: Bearer <copilot plus license key>
```

The key is validated against the Brevilabs license server and cached for an hour.
Only the key's SHA-256 is ever stored; the raw key is never persisted or logged.
A publisher *is* that hash, so the same key always sees the same docs.

Reading a doc requires nothing. Serving responses never set a cookie.

## Endpoints

```http
POST   /api/v1/docs           {title?, html}  → 201 {docId, url, version}
PUT    /api/v1/docs/{docId}   {title?, html}  → 200 {docId, url, version}
DELETE /api/v1/docs/{docId}                   → 204
GET    /api/v1/docs?limit&cursor              → 200 {docs[], cursor?}
GET    /d/{docId}                             → 200 latest HTML
GET    /d/{docId}/v{n}                        → 200 immutable HTML
```

Any other method or path under `/api/v1` is `404 not_found`.

### `POST /api/v1/docs` — publish a new doc

`Content-Type: application/json`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `html` | string | yes | A whole HTML document. Max 10MB encoded as UTF-8. |
| `title` | string | no | Display name in the doc list. Trimmed, capped at 512 characters. Missing, null or blank becomes `Untitled`. |

```json
{"title": "Q3 architecture review", "html": "<!doctype html><html>…</html>"}
```

```json
{"docId": "9f2k4mvq7t0xbz3ncrhs5wda1p",
 "url": "https://updoc.example.workers.dev/d/9f2k4mvq7t0xbz3ncrhs5wda1p",
 "version": 1}
```

A `docId` is 26 characters of lowercase Crockford base32 (`0-9`, `a-z` without
`i`, `l`, `o`, `u`) — 128 bits of randomness. It is the only access control a doc
has: whoever holds the url holds the doc.

The API accepts **HTML only**. Copilot renders markdown locally, because that is
the only way callouts, wikilinks and dataview output survive. There is no
markdown branch on the server.

### `PUT /api/v1/docs/{docId}` — publish a new version

Same body as `POST`. Omitting `title` keeps the doc's current title rather than
blanking it — omission is the only thing that means "leave it alone". A `title`
that is present but blank is not a title, and becomes `Untitled` here exactly as
it does on `POST`.

```json
{"docId": "9f2k4mvq7t0xbz3ncrhs5wda1p",
 "url": "https://updoc.example.workers.dev/d/9f2k4mvq7t0xbz3ncrhs5wda1p",
 "version": 2}
```

The `url` never changes. `version` increments by one and the previous version
stays readable forever at `/d/{docId}/v{n}`.

`404 not_found` if the doc does not exist, belongs to another publisher, or was
deleted — see [Not found, never forbidden](#not-found-never-forbidden).

### `DELETE /api/v1/docs/{docId}` — unshare

`204 No Content`, no body.

The doc's stored bytes are destroyed and its url starts answering `410 gone`
— for the shared link and every pinned `/v{n}` alike. `410` rather than `404` is
deliberate: a reader holding the link learns it was withdrawn instead of
concluding they mistyped it.

What delete cannot do is recall a copy someone already has. Pinned `/v{n}` urls
are served `immutable` with a one-year lifetime, because a version's bytes never
change and that is what lets a widely-read doc cost one origin read; a cache
holding one will go on serving it without asking us again. Unshare stops new
readers, not readers who already fetched — the same way it cannot un-download a
file. Treat it as withdrawing the link, not as revoking the content.

`404 not_found` if the doc does not exist, belongs to another publisher, **or was
already deleted**. A retry after a timeout therefore sees `404`, not `204`; what
is idempotent is the outcome, which is the part a client cares about. Treat
`404` from a delete as success.

### `GET /api/v1/docs` — list my docs

Only the calling publisher's live docs, newest first by creation time.

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer 1–100 | 50 | Anything else is `400 bad_request`. |
| `cursor` | opaque string | — | From a previous response. Pass it back unchanged; do not parse or construct one. Anything else is `400 bad_request`. |

```json
{"docs": [
   {"docId": "9f2k4mvq7t0xbz3ncrhs5wda1p",
    "title": "Q3 architecture review",
    "url": "https://updoc.example.workers.dev/d/9f2k4mvq7t0xbz3ncrhs5wda1p",
    "version": 2,
    "updatedAt": 1785000000000}
 ],
 "cursor": "MTc4NTAwMDAwMDAwMC45ZjJrNG12cTd0MHhiejNuY3JoczV3ZGExcA"}
```

- `updatedAt` is epoch milliseconds — the last push, not the creation.
- `version` is the newest version that has bytes. It is `null` in one rare case:
  a doc whose very first push failed partway. Such a doc serves nothing, and it
  is listed only so its publisher can delete it and free the slot.
- `cursor` is present **only when another page exists**, so the walk ends when it
  is absent rather than on an empty page.

Paging is keyset, not offset: a doc published while you are walking pages appears
on no page you have already read, and no doc is ever served twice or skipped.

### `GET /d/{docId}` and `GET /d/{docId}/v{n}` — read

Unauthenticated. `GET` and `HEAD` only; anything else is `404`.

| | `/d/{docId}` | `/d/{docId}/v{n}` |
| --- | --- | --- |
| Serves | latest version | version `n`, forever |
| `Cache-Control` | `public, max-age=60` | `public, max-age=31536000, immutable` |

`{n}` is a decimal with no leading zeros and starts at 1. `ETag` and
`If-None-Match` are supported (`304`).

Every response on this surface — including its errors — carries:

```http
X-Robots-Tag: noindex, nofollow
Content-Security-Policy: …; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

Uploaded scripts **do** run — interactive figures and embedded simulations are
why the client uploads HTML at all. What the policy forbids is a doc using the
origin against its readers: no form submission, no framing, no `<base>`
retargeting. The origin is cookieless and holds nothing but already-public docs.

Two things are injected into the document at push time, so the stored bytes and
the served bytes are the same thing: a `<meta name="robots" content="noindex,nofollow">`
in the head, and a small `Shared with updoc` footer before `</body>`. Nothing
else is touched — the markup is never sanitized, rewritten or reformatted.

`404` for an unknown id or version; `410` once the doc is deleted.

## Errors

Every failure, on both surfaces, is:

```json
{"error": {"code": "not_found", "message": "No doc with id ..."}}
```

Match on `code`. `message` is human-facing and free to change.

| `code` | HTTP | When |
| --- | --- | --- |
| `bad_request` | 400 | Malformed JSON, `html` missing, empty or not a string, non-string `title`, junk `limit` or `cursor`. |
| `unauthorized` | 401 | No `Authorization: Bearer` header, or the license server rejected the key. Carries `WWW-Authenticate: Bearer`. |
| `not_found` | 404 | No such doc, not yours, already deleted, or no route. |
| `gone` | 410 | The doc was deleted by its author. |
| `too_large` | 413 | `html` over 10MB. |
| `quota_exceeded` | 429 | Daily push or doc-count ceiling reached. |
| `internal` | 500 | Our fault, including the license server being unreachable for a key we have never seen. |

Two of these are worth handling deliberately in a client:

- **`internal` is not `unauthorized`.** A license-server outage answers `500
  internal`, never `401`, precisely so the client does not prompt for a new key
  over a key that is perfectly good. Retry instead.
- <a id="not-found-never-forbidden"></a>**Not found, never forbidden.** There is
  no `403`. A doc belonging to another publisher answers exactly like a doc that
  never existed, because a distinguishable reply would confirm the id is real.

## Quotas

Per license key. They cap the abuse and hoarding tail; a real user never reaches
one.

| Limit | Value | Exceeded |
| --- | --- | --- |
| HTML per doc | 10 MB | `413 too_large` |
| Pushes per day | 100 (UTC day, rolls at midnight) | `429 quota_exceeded` |
| Live docs held | 500 | `429 quota_exceeded` |

Both `POST` and `PUT` spend one push. A rejected push spends nothing: a `413`,
a `400`, or a `PUT` at a doc you do not own leaves the day's allowance intact.
Deleting a doc frees a slot against the 500.

## The docId round trip

This is the whole client-side protocol, and getting it right is what makes
re-sharing a note update the page instead of minting a second link.

1. First share of a note: `POST /api/v1/docs`. The server mints the `docId`.
2. **The client writes that `docId` into the note's own frontmatter** and keeps
   it there.
3. Every later share of the same note: `PUT /api/v1/docs/{docId}` with the id
   from frontmatter. Same url, next version, and whoever already has the link
   sees the update.

```yaml
---
updoc: 9f2k4mvq7t0xbz3ncrhs5wda1p
---
```

If a `PUT` answers `404`, the stored id is stale — the doc was deleted, or the
note travelled to a vault signed in with a different license key. Fall back to
`POST` and replace the id in frontmatter with the new one.

## A whole round trip

```bash
BASE=https://updoc.example.workers.dev
KEY=<copilot plus license key>

# publish
curl -sS -X POST "$BASE/api/v1/docs" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"title":"Notes","html":"<!doctype html><html><body><p>hello</p></body></html>"}'
# → {"docId":"9f2k…","url":"https://…/d/9f2k…","version":1}

curl -sS "$BASE/d/9f2k…"                       # the public page, no auth
curl -sS "$BASE/api/v1/docs?limit=10" -H "authorization: Bearer $KEY"
curl -sS -X DELETE "$BASE/api/v1/docs/9f2k…" -H "authorization: Bearer $KEY" -i
curl -sS "$BASE/d/9f2k…" -o /dev/null -w '%{http_code}\n'   # → 410
```

`scripts/smoke.sh` runs exactly this sequence against a deployment and checks
every status.

---

# Development

```bash
npm install
npm run typecheck
npm test           # vitest, inside workerd, against real R2 and D1 (Miniflare)
npm run dev        # wrangler dev — local R2 and D1, no Cloudflare account needed
```

Tests need no credentials and no deployment: `@cloudflare/vitest-pool-workers`
runs them in the real runtime with the migrations in `migrations/` applied to a
per-test D1. CI runs `npm run typecheck` and `npm test`, and nothing else.

`wrangler dev` needs a wrangler whose bundled runtime is new enough for the
`compatibility_date` in `wrangler.jsonc`; if it refuses to start, `npm install
wrangler@latest`.

There is no license server locally, so the first push against `wrangler dev`
fails with `internal`. Warm the validation cache by hand — the worker trusts a
`publishers` row younger than an hour, and a publisher id is just the SHA-256 of
the key:

```bash
KEY=any-string-you-like
HASH=$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1)

npx wrangler d1 migrations apply updoc --local
npx wrangler d1 execute updoc --local --command \
  "INSERT OR REPLACE INTO publishers (key_hash, plan, validated_at)
   VALUES ('$HASH', 'plus', $(($(date +%s) * 1000)))"

UPDOC_LICENSE_KEY=$KEY scripts/smoke.sh http://127.0.0.1:8787
```

Alternatively, copy `.dev.vars.example` to `.dev.vars` and point
`LICENSE_API_URL` / `LICENSE_API_KEY` at the real license server.

# Deploying

> **Nothing has been deployed yet.** The sequence below is complete and creates
> real resources on a real account. One thing to know going in: D1 is currently
> the only record of who owns a doc, what it is called, and whether it was
> deleted, so until per-doc manifests ship, back-ups mean D1's own 30-day Time
> Travel window rather than "rebuild it from R2". That is fine at low volume and
> should be fixed well before it isn't — see `CLAUDE.md`.

Run once, in order, from a checkout with `npx wrangler login` already done. This
creates real Cloudflare resources on whichever account wrangler is logged into.

```bash
# 1. The R2 bucket. The name must match `bucket_name` in wrangler.jsonc.
npx wrangler r2 bucket create updoc-docs

# 2. The D1 database. This prints a `database_id`.
npx wrangler d1 create updoc
```

**Now edit `wrangler.jsonc`** and replace the `database_id` placeholder
(`00000000-0000-0000-0000-000000000000`) with the id step 2 printed, then commit
it. It is not a secret; the binding will not resolve without it.

```bash
# 3. Create the schema on the real database (--remote, not --local).
npx wrangler d1 migrations apply updoc --remote

# 4. Credentials for the license server. Both prompt for the value, so neither
#    ends up in your shell history. LICENSE_API_KEY is *ours*, never a
#    publisher's key. On a first deploy the Worker does not exist yet, so the
#    first of these also asks whether to create it — answer yes; step 5
#    overwrites the placeholder and the secrets survive it.
npx wrangler secret put LICENSE_API_URL     # e.g. https://api.brevilabs.com
npx wrangler secret put LICENSE_API_KEY

# 5. Ship. This prints the workers.dev url.
npx wrangler deploy

# 6. Check what just shipped, end to end.
UPDOC_LICENSE_KEY=<a real Copilot Plus key> \
  scripts/smoke.sh https://updoc.<subdomain>.workers.dev
```

The smoke script publishes a doc, reads it, lists it, deletes it and confirms the
`410`. It spends one push against that key's daily quota and leaves no live doc
and no stored bytes behind — only the deleted doc's row, which every delete keeps
so the url can go on answering `410`. It is not part of CI — CI has no key and no
deployment.

`SERVING_HOST` and `API_HOST` stay empty in `wrangler.jsonc` for v0: one
workers.dev subdomain hosts both surfaces and the router falls back to path
prefixes. Filling them in later moves doc serving onto the sacrificial domain
without a code change — and the `url` the API returns follows automatically.

Later deploys are steps 5 and 6 alone, plus step 3 whenever a migration is added.
All changes ship through a pull request; never push to `main`.
