# HTTP API

This document is the contract, and it is frozen: the Obsidian Copilot client is
written against what is below, so nothing here changes without a client release.
It is complete on purpose — a client author should never need to read this
repo's source.

[← README](../README.md) · [Deploying](deploying.md) · [Hosting](hosting.md)

## Surfaces

Two surfaces on two domains:

| Surface | Paths | Auth | Notes |
| --- | --- | --- | --- |
| API | `/api/v1/*` | required | Publisher-facing. JSON in, JSON out. |
| Serving | `/d/*` | none | Reader-facing. Public HTML. Never sets a cookie. |

The API is served from `api.symposium.md` and documents from `symposium.site`.
The `url` field a push returns therefore points at a different host than the one
the client called, which is the reason a client must never build a doc url
itself. **Always use the `url` the API returns.**

`GET /health` → `200 {"ok": true}` is reachable on both, unauthenticated.

## Authentication

Every `/api/v1/*` request carries a Brevilabs license key:

```http
Authorization: Bearer <license key>
```

The key is validated against the Brevilabs license server and cached for an hour.
Only the key's SHA-256 is ever stored; the raw key is never persisted or logged.

**Documents belong to the Brevilabs account, not to the key.** Validation
resolves the key to the account that holds it, and that account owns everything
published with it. So every key on one account sees one list, and any of them
can push a new version of, or unshare, a document another one created. Replacing
a key changes nothing about which documents you have. Nothing in this API takes
an account id as input, and none is ever returned.

**A valid key is not sufficient to publish.** Publishing requires an entitled
plan, and in phase 1 that is **the lifetime tier only** (`BELIEVER` on the
license server, sold as Supporter): a current Plus key authenticates and is
still refused. The refusal is `401 unauthorized` like every other auth failure,
so no client change is needed — only the human-readable `message` distinguishes
it. Widening the entitled set later is a server-side change with no client
release.

The entitlement is **per operation, not per key**, and only `POST /api/v1/docs`
and `PUT /api/v1/docs/{docId}` are gated on it. A publisher whose plan no longer
qualifies keeps `GET /api/v1/docs` and `DELETE /api/v1/docs/{docId}`, so they can
always see what they have published and take it down. Losing the ability to
publish must never mean losing the ability to unshare.

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
{"docId": "9f2k4mvq7t0xbz3n",
 "url": "https://symposium.site/d/9f2k4mvq7t0xbz3n",
 "version": 1}
```

A `docId` is 16 characters of lowercase Crockford base32 (`0-9`, `a-z` without
`i`, `l`, `o`, `u`) — 80 bits of randomness. It is the only access control a doc
has: whoever holds the url holds the doc, so treat the id as a secret and do not
log it anywhere a reader would not already be allowed.

The alphabet is case-insensitive to read but not to send: ids are lowercase, and
an uppercase one is rejected rather than folded.

The API accepts **HTML only**. Copilot renders markdown locally, because that is
the only way callouts, wikilinks and dataview output survive. There is no
markdown branch on the server.

### `PUT /api/v1/docs/{docId}` — publish a new version

Same body as `POST`. Omitting `title` keeps the doc's current title rather than
blanking it — omission is the only thing that means "leave it alone". A `title`
that is present but blank is not a title, and becomes `Untitled` here exactly as
it does on `POST`.

```json
{"docId": "9f2k4mvq7t0xbz3n",
 "url": "https://symposium.site/d/9f2k4mvq7t0xbz3n",
 "version": 2}
```

The `url` never changes. `version` increments by one and the previous version
stays readable forever at `/d/{docId}/v{n}`.

`404 not_found` if the doc does not exist, belongs to another account, or was
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

`404 not_found` if the doc does not exist, belongs to another account, **or was
already deleted**. A retry after a timeout therefore sees `404`, not `204`; what
is idempotent is the outcome, which is the part a client cares about. Treat
`404` from a delete as success.

### `GET /api/v1/docs` — list my docs

Every live doc the calling account holds, newest first by creation time —
whichever of its keys published them.

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer 1–100 | 50 | Anything else is `400 bad_request`. |
| `cursor` | opaque string | — | From a previous response. Pass it back unchanged; do not parse or construct one. Anything else is `400 bad_request`. |

```json
{"docs": [
   {"docId": "9f2k4mvq7t0xbz3n",
    "title": "Q3 architecture review",
    "url": "https://symposium.site/d/9f2k4mvq7t0xbz3n",
    "version": 2,
    "updatedAt": 1785000000000}
 ],
 "cursor": "MTc4NTAwMDAwMDAwMC45ZjJrNG12cTd0MHhiejNu"}
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

Four things are injected as the document is served: a
`<meta name="robots" content="noindex,nofollow">` in the head, a
`<link rel="icon">` beside it carrying the Symposium mark as a `data:` URI, a
`Shared from Copilot for Obsidian` byline at the top of the body, and a
`Powered by symposium.md` byline before `</body>`. A document that ships its own
icon keeps that markup — both links are then in the head, and which one the tab
shows is the browser's choice. Nothing else is touched — the
markup is never sanitized, rewritten or reformatted, and what R2 stores is the
publisher's document exactly as it was pushed.

Serving therefore adds to the stored bytes rather than reproducing them. That is
what lets a byline change reach documents already published. Two consequences
worth knowing:

- `Content-Length` is absent on `HEAD`. The served length is not knowable without
  running the transform, and reporting the stored one would be reporting a wrong
  number.
- The `ETag` identifies **the stored version and the rendering applied to it**,
  not the stored version alone — a byline change moves it even though the stored
  bytes are untouched, which is what stops a revalidating cache serving an old
  rendering forever. Treat it as opaque, as always: its shape is not a contract
  and it will change again. What is stable is the behaviour — the same document
  and the same rendering always produce the same tag, and `If-None-Match` with
  it returns `304`.

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
| `unauthorized` | 401 | No `Authorization: Bearer` header, the license server rejected the key, or — on `POST` and `PUT` only — the key's plan is not entitled to publish. Carries `WWW-Authenticate: Bearer`. |
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
  no `403`. A doc belonging to another account answers exactly like a doc that
  never existed, because a distinguishable reply would confirm the id is real.

## Quotas

Per license key. They cap the abuse and hoarding tail; a real user never reaches
one.

| Limit | Value | Exceeded |
| --- | --- | --- |
| HTML per doc | 10 MB | `413 too_large` |
| Pushes per day | 100 (UTC day, rolls at midnight) | `429 quota_exceeded` |
| Live docs held | 500 | `429 quota_exceeded` |

Both limits are **per account, not per key**: two keys on one account share one
daily allowance and one 500-document ceiling rather than getting two.

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
symposium: 9f2k4mvq7t0xbz3n
---
```

If a `PUT` answers `404 not_found`, treat the update as terminal: stop and
surface the failure for identity reconciliation. Do not automatically `POST` a
replacement or remove or overwrite the saved `docId`. The response deliberately
does not reveal whether the id is unknown, deleted, or belongs to another
account.

Publishing as a new document is a separate action that requires explicit user
confirmation.

## A whole round trip

```bash
BASE=https://api.symposium.md
KEY=<lifetime license key>

# publish
curl -sS -X POST "$BASE/api/v1/docs" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"title":"Notes","html":"<!doctype html><html><body><p>hello</p></body></html>"}'
# → {"docId":"9f2k…","url":"https://symposium.site/d/9f2k…","version":1}

# The document reads use the `url` that push returned, never "$BASE/d/…": the
# page lives on the serving domain, and the API host resolves every path to the
# API surface, which would answer these unauthenticated reads 401.
DOC=https://symposium.site/d/9f2k…

curl -sS "$DOC"                                # the public page, no auth
curl -sS "$BASE/api/v1/docs?limit=10" -H "authorization: Bearer $KEY"
curl -sS -X DELETE "$BASE/api/v1/docs/9f2k…" -H "authorization: Bearer $KEY" -i
curl -sS "$DOC" -o /dev/null -w '%{http_code}\n'            # → 410
```

`scripts/smoke.sh` runs exactly this sequence against a deployment and checks
every status.
