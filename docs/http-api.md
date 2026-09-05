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
| Approval | `/approve/*` | none | Human-facing. HTML pages on the API host. Not a client surface. |
| Device | `/device/*` | none | How a client with no credential gets one. JSON, on the API host. |

The API is served from `api.openartifacts.ai` and documents from `openartifacts.site`.
The `url` field a push returns therefore points at a different host than the one
the client called, which is the reason a client must never build a doc url
itself. **Always use the `url` the API returns.**

Compatibility is read-only. `symposium.site` returns `307` for GET and HEAD to
the exact same path and query on `openartifacts.site`; other methods fail with a
serving-surface `404`. `api.symposium.md` is not an API alias. Every method and
path on that retired host returns `410 gone` before authentication, without a
redirect.

`GET /health` → `200 {"ok": true}` is reachable on both canonical hosts. The
legacy document host redirects it, and the retired API host returns `410`.

## Authentication

Every `/api/v1/*` request carries a credential in one header. There are two
kinds and the header is the same for both.

### A Brevilabs license key

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

**Publishing requires a paid plan.** Both current license-server paid plans are
entitled: `PLUS` subscriptions and the lifetime `BELIEVER` plan (sold as
Supporter). An unknown or otherwise ineligible plan is refused with `401
unauthorized` like every other auth failure, so only the human-readable
`message` distinguishes it.

The entitlement is **per operation, not per key**, and only `POST /api/v1/docs`
and `PUT /api/v1/docs/{docId}` are gated on it. A publisher whose plan no longer
qualifies keeps `GET /api/v1/docs` and `DELETE /api/v1/docs/{docId}`, so they can
always see what they have published and take it down. Losing the ability to
publish must never mean losing the ability to unshare.

### An OpenArtifacts token

```http
Authorization: Bearer oat_hy3m…
```

A token is issued to one machine by [the device flow](#signing-in-from-a-terminal),
and it is the only credential an agent ever holds. It is an opaque string
beginning `oat_`, and that prefix is the whole of its format: do not parse the
rest, and do not put it in a url or a log.

Only the token's SHA-256 is stored, and the raw value is returned exactly once —
in the response to the poll that collected it. There is no endpoint that shows a
token again. A lost token is replaced by approving a new one, never recovered.

**Documents belong to the account, exactly as they do for a key.** Every token
on one account sees one list, shares one daily push allowance and one document
ceiling, and any of them can push a new version of, or unshare, a document
another one created. Revoking a token changes nothing about which documents the
account holds.

**The two credentials never mix.** A key resolves to the Brevilabs account that
holds it and a token to the OpenArtifacts account it was issued to; the two id
spaces cannot collide, so neither can ever see the other's documents. A Copilot
subscriber who wants the documents their plugin published presents the same
license key the plugin does — this API accepts it from a terminal like any other
caller.

**Publishing works on a new account.** A token's account can hold three live
documents by default, starting with its first approval. Creating another at
the ceiling returns `402 limit_reached`; updating an existing document remains
allowed. The ceiling is per account across all tokens and does not reset daily.
Self-hosters can set `ACCOUNT_MAX_DOCS` to choose a different ceiling. Per-account
paid plans and the admin plan API remain in
[#60](https://github.com/Brevilabs/OpenArtifacts/issues/60).

**Revocation is immediate.** A revoked token fails on its very next request,
where a revoked license key keeps working until its cached validation ages out.
Nothing about a token is cached, because its owner is a row in this deployment's
own database rather than an answer from another service.

### `OPENARTIFACTS_TOKEN`

A client reads the credential from `OPENARTIFACTS_TOKEN` when that variable is
set, and from its own configuration otherwise. It exists so a script or a CI job
can publish where no browser can be opened. The variable is a client convention
rather than a server behaviour, and it carries whatever goes in the header — a
token or a license key alike, since nothing downstream of the header cares which
it was.

Reading a doc requires nothing. Serving responses never set a cookie.

## The approval page

`/approve` on the API host is where a person creates an OpenArtifacts account,
by proving an email address with Google or GitHub and approving a device code
their terminal is waiting on. **A client never calls it and never parses it**:
every response is an HTML page for a human, not the JSON envelope below, and its
paths are not part of the contract a client is written against. It is documented
here only so nothing mistakes it for an API route.

```http
GET  /approve                      the page that asks for a code
GET  /approve?user_code=…          the page that offers the providers
POST /approve/start/{provider}     redirects to the provider
GET  /approve/callback/{provider}  where the provider redirects back
POST /approve/confirm              the press that approves the code
POST /approve/deny                 the press that refuses it
```

Three consequences worth stating, because all three are promises made elsewhere:

- **Nothing under `/api/v1` changes.** The approval paths are additive and sit
  outside that prefix, so every response a license-key caller receives is exactly
  what it was.
- **This Worker sets no cookie, anywhere.** The OAuth handshake is kept on the
  device code's own row rather than in the browser, so the serving origin's
  cookieless guarantee is a property of the whole Worker rather than of one host.
- **Proving an identity and approving a device are two steps.** The provider's
  redirect back is a `GET`, and it only ever renders a confirmation; the approval
  is a `POST` a person presses. RFC 8628 §5.4 is why: a `GET` that completed an
  approval could be caused by a link, and a visitor already signed in to their
  provider would pass through it without a prompt.

A deployment that configures no OAuth client answers `/approve` with a page
saying so. Nothing else about it changes: documents keep serving and license-key
publishing keeps working.

## Endpoints

```http
POST   /api/v1/docs           {title?, html}  → 201 {docId, url, version}
PUT    /api/v1/docs/{docId}   {title?, html}  → 200 {docId, url, version}
DELETE /api/v1/docs/{docId}                   → 204
GET    /api/v1/docs?limit&cursor              → 200 {docs[], cursor?}
GET    /api/v1/tokens                         → 200 {tokens[]}
DELETE /api/v1/tokens/{tokenId}               → 200 {tokenId, remaining}
POST   /device/code           {label?}        → 200 {device_code, user_code, …}
POST   /device/token          {device_code}   → 200 {access_token, …}
GET    /d/{docId}                             → 200 latest HTML
GET    /d/{docId}/v{n}                        → 200 immutable HTML
```

Any other method or path under `/api/v1` is `404 not_found`. The two `/device`
paths are the only ones outside it that answer a client, and they carry no
credential — see [Signing in from a terminal](#signing-in-from-a-terminal).

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
 "url": "https://openartifacts.site/d/9f2k4mvq7t0xbz3n",
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
 "url": "https://openartifacts.site/d/9f2k4mvq7t0xbz3n",
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
    "url": "https://openartifacts.site/d/9f2k4mvq7t0xbz3n",
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

### `GET /api/v1/tokens` — list my tokens

Every live token the calling account holds, newest first. Values are not
returned and cannot be: only hashes are stored.

```json
{"tokens": [
   {"tokenId": "tok_9f2k4mvq7t0xbz3n",
    "label": "Claude Code on loganmac",
    "createdAt": 1785000000000,
    "lastUsedAt": 1785003600000}
 ]}
```

- `label` is what the machine called itself when it asked for its device code,
  and it is `null` when it named nothing. It is text a client supplied: escape
  it before displaying it.
- `lastUsedAt` is the last request this token authenticated, to the nearest
  hour, and `null` for a token that has never been used. Coarse on purpose —
  refreshing it exactly would put a database write behind every read, and the
  question it answers is which machine is still using this.
- Revoked tokens are not listed. **There is no paging and none is needed**: an
  account holds at most 100 live tokens, which is also everything this returns,
  so the list is always complete. Nothing an account holds can hide behind a
  limit, which matters because revoking is the only way to manage a token and a
  token nobody can see is a token nobody can withdraw.
- **The hundred and first token replaces the least recently used one**, which is
  revoked as the new one is issued. Never-used goes first, then oldest use. This
  is a rolling window rather than a wall, so signing in a new machine always
  works — an account that filled up over years of replaced laptops is never
  locked out by tokens nobody holds any more. Approving a device proves the
  account's identity, which is a stronger claim than any token, so it is safe
  for that approval to displace one.

A license key's account holds no tokens, so it gets an empty list rather than a
refusal.

### `DELETE /api/v1/tokens/{tokenId}` — revoke a token

`200`, with a body — unlike a document delete, because what the caller needs to
know is what it has left.

```json
{"tokenId": "tok_9f2k4mvq7t0xbz3n", "remaining": 0}
```

`remaining` is how many live tokens the account still holds. **Revoking the last
one is allowed**, and `remaining: 0` is how a client knows to say so: nothing on
that account can publish until somebody approves a new device. The documents are
untouched and stay exactly where they are.

Revoking the token making the request succeeds — this request has already
authenticated, and the next one will not.

`404 not_found` if the token does not exist, belongs to another account, or was
already revoked, exactly as for a document. A retry after a timeout therefore
sees `404`, not `200`; treat it as success.

An account holds at most 100 live tokens. Signing in a new machine past that
revokes the least recently used one rather than failing, so revoking is never
the only way back in. Nobody reaches this by signing in machines; it is the
bound that lets the list above have no cursor.

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
`<link rel="icon">` beside it carrying the OpenArtifacts mark as a `data:` URI, a
`Shared from Copilot for Obsidian` byline at the top of the body, and a
`Powered by openartifacts.ai` byline before `</body>`. A document that ships its own
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

Every Worker-controlled reader outcome where no document can be displayed is a
self-contained HTML page:

| Status | Reader sees |
| --- | --- |
| `404 Not Found` | A neutral unavailable page for an unknown or malformed link, a missing version, or missing stored bytes. |
| `410 Gone` | An explicit deleted page when the retained doc row proves the author withdrew it. |
| `500 Internal Server Error` | A temporary-unavailable page when a serving dependency fails. |

All three are `no-store` and retain the serving header policy above. `HEAD`
returns the same status and headers as `GET` without a body. Healthy `200` and
conditional `304` responses are unchanged.

## Signing in from a terminal

A client with no credential gets one here. It asks for a code, prints a url,
and polls; a person opens that url on any device, signs in, and approves. The
client's next poll returns a token it stores and uses from then on. Nobody
reads a secret aloud and nothing is pasted, which is the point: a token pasted
into an agent's conversation is a token in a transcript.

**RFC 8628 shaped, not RFC 8628 wire compatible.** The two endpoints, the two
codes, the polling interval and the four poll conditions are the standard's, so
a client written against it will recognise them. The differences are that
requests are JSON like the rest of this API rather than form encoded, and that a
failure carries this API's own `{"error": {"code", "message"}}` envelope with
the RFC's code name inside it, so a client still has one error shape to parse.
Field names in the two success bodies are the RFC's, which is why they are
`snake_case` where the rest of this document is `camelCase`.

Neither endpoint authenticates, which is why neither is under `/api/v1`.

**Both require `Content-Type: application/json`**, including a mint with no
body, and anything else is `400 bad_request` before the request is looked at
further. That is a security check rather than strictness about types: these are
unauthenticated `POST`s, so a page a person happens to visit could otherwise aim
a form-encoded request at them from that person's address. `application/json` is
not a type a form can send, so a browser has to preflight it, and this host
answers no CORS headers, so the preflight fails and the request never leaves the
browser.

### `POST /device/code` — ask for a code

`Content-Type: application/json`. The body is optional.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `label` | string | no | What this machine and agent are, for the person approving it and for the token afterwards. Terminal and bidirectional controls are stripped, ordinary RTL text is isolated when rendered, and the result is cut at 80 characters. Missing or blank means the page names no machine. |

```json
{"label": "Claude Code on loganmac"}
```

```json
{"device_code": "hy3m…",
 "user_code": "WDJBM-JHTQR",
 "verification_uri": "https://api.openartifacts.ai/approve",
 "verification_uri_complete": "https://api.openartifacts.ai/approve?user_code=WDJBM-JHTQR",
 "expires_in": 900,
 "interval": 10}
```

- `device_code` is the secret half and never leaves the client. It is the only
  thing that can collect the token, so a person who reads the `user_code` off a
  screen has learned nothing.
- `user_code` is ten letters from a twenty-consonant alphabet, shown as two
  groups of five — about 43 bits. No digits and no vowels, so nothing in it is
  confusable when read aloud and no draw can spell a word. Case and surrounding
  space do not matter: the approval page folds both.
- `verification_uri_complete` is what a client prints and opens. The bare
  `verification_uri` is short enough to read off a terminal and type into a
  phone, and it shows a field for entering the `user_code` by hand. Print both:
  the complete one is the fast path and the bare one is the one that works when
  the terminal cannot be copied from.
- `expires_in` and `interval` are seconds. Use the `interval` the response gives
  rather than a number of your own.

`429 quota_exceeded`, with `Retry-After: 60`, when one address asks for more
than five codes in a minute. The limit exists because an endpoint that mints
approval urls is an endpoint somebody would otherwise use to send strangers
approval urls. One person signing in a machine or two never reaches it, and a
self-hosted deployment may switch it off entirely — see
[Deploying](deploying.md).

### `POST /device/token` — collect the token

`Content-Type: application/json`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `device_code` | string | yes | Exactly as `POST /device/code` returned it. |

Poll no faster than the `interval` you were given, until the code expires.

```json
{"access_token": "oat_hy3m…",
 "token_type": "Bearer",
 "token_id": "tok_9f2k4mvq7t0xbz3n",
 "label": "Claude Code on loganmac"}
```

**This response is the only time the token exists outside the client.** Store it
with owner-only permissions and never print it. `token_id` is its public name,
which `GET /api/v1/tokens` also reports and `DELETE` takes.

Until then, every answer is a `400` carrying one of four codes:

| `code` | Meaning | What a client does |
| --- | --- | --- |
| `authorization_pending` | Nobody has approved it yet. | Wait one interval and poll again. |
| `slow_down` | You polled faster than the interval. | Wait longer, then poll again. |
| `expired_token` | The code expired, was already collected, or was never issued. | Start again with a new code. |
| `access_denied` | Someone pressed Deny on the approval page. | Stop. Do not start again on your own. |

The hosted deployment rate-limits each device code to one poll per interval, so
concurrent polls normally get `slow_down`. It also caps aggregate polls from one
client address, so inventing fresh random codes cannot create unbounded database
misses. The limiters are deliberately not part of token-issue correctness:
collection is transactional, so even permissive distributed counters or a
self-hosted deployment without them cannot issue twice. Poll from one place, on
the `interval` the mint returned.

A device code is spent by the poll that collects it, so a replayed one is
`expired_token` — the same answer an unknown code gets, deliberately, because a
distinguishable reply would confirm which random strings are real.

### A whole sign-in

```bash
BASE=https://api.openartifacts.ai

MINT=$(curl -sS -X POST "$BASE/device/code" \
  -H 'content-type: application/json' \
  -d '{"label":"Claude Code on loganmac"}')

DEVICE_CODE=$(printf '%s' "$MINT" | jq -r .device_code)
printf '%s' "$MINT" | jq -r .verification_uri_complete   # open this, and approve

# poll every `interval` seconds until it answers with a token
curl -sS -X POST "$BASE/device/token" \
  -H 'content-type: application/json' \
  -d "{\"device_code\":\"$DEVICE_CODE\"}"
# → {"error":{"code":"authorization_pending", …}}   before the approval
# → {"access_token":"oat_…","token_type":"Bearer", …}  after it
```

## Errors

Every publisher-facing API failure, and every retired-host response, is JSON:

```json
{"error": {"code": "not_found", "message": "No doc with id ..."}}
```

Match on `code`. `message` is human-facing and free to change.

The public serving surface uses the HTML status pages above instead. It never
exposes this API payload to a reader.

| `code` | HTTP | When |
| --- | --- | --- |
| `bad_request` | 400 | Malformed JSON, `html` missing, empty or not a string, non-string `title`, junk `limit` or `cursor`. |
| `unauthorized` | 401 | No `Authorization: Bearer` header, the license server rejected the key, or — on `POST` and `PUT` only — the key's plan is not entitled to publish. Carries `WWW-Authenticate: Bearer`. |
| `not_found` | 404 | No such doc, not yours, already deleted, or no route. |
| `gone` | 410 | Every request to the retired `api.symposium.md` host. The canonical API does not emit this code. |
| `too_large` | 413 | `html` over 10MB. |
| `quota_exceeded` | 429 | Daily push ceiling or license-key doc-count ceiling reached. |
| `limit_reached` | 402 | Account-token create would exceed its live-document ceiling. Carries the exceeded limit's identifier (`limit`) and the account's current plan name (`plan`) as strings inside `error`. |
| `internal` | 500 | Our fault, including the license server being unreachable for a key we have never seen. |
| `authorization_pending` | 400 | `POST /device/token`: nobody has approved the code yet. |
| `slow_down` | 400 | `POST /device/token`: polled faster than the `interval`. |
| `expired_token` | 400 | `POST /device/token`: the code expired, was collected, or was never issued. |
| `access_denied` | 400 | `POST /device/token`: someone pressed Deny on the approval page. |

The last four appear on `POST /device/token` and nowhere else. They are RFC 8628
§3.5's names, carried in this envelope so a client parses one error shape.

Three of these are worth handling deliberately in a client:

- **`unauthorized` covers a token too.** A token this deployment never issued,
  and one that has been revoked, are both refused with `401 unauthorized` and
  `WWW-Authenticate: Bearer`, exactly like a bad key. Only the human-readable
  `message` distinguishes them. A client holding a token that starts failing
  this way should sign in again rather than retry.

- **`internal` is not `unauthorized`.** A license-server outage answers `500
  internal`, never `401`, precisely so the client does not prompt for a new key
  over a key that is perfectly good. Retry instead.
- <a id="not-found-never-forbidden"></a>**Not found, never forbidden.** There is
  no `403`. A doc belonging to another account answers exactly like a doc that
  never existed, because a distinguishable reply would confirm the id is real.

## Quotas

Publishing limits follow the authenticated account, not the token, key, agent,
or device. License-key and account-token identities remain separate.

| Limit | Value | Exceeded |
| --- | --- | --- |
| HTML per doc | 10 MB | `413 too_large` |
| Pushes per day | 100 (UTC day, rolls at midnight) | `429 quota_exceeded` |
| Live docs held, license-key account | 500 | `429 quota_exceeded` |
| Live docs held, account-token account | 3 by default | `402 limit_reached` |

Two credentials on one account share one daily allowance and one document
ceiling rather than getting two. The document ceiling never resets with time.

Both `POST` and `PUT` spend one push. A rejected push spends nothing: a `413`,
a `400`, or a `PUT` at a doc you do not own leaves the day's allowance intact.
Unsharing a doc frees a document slot. Updating an existing doc uses a daily
push but no new document slot. Accounts already above their document ceiling
keep their existing documents and can update, list, and unshare them; they
cannot create another until they are below the ceiling.

The account-token document ceiling is configured with the optional Worker var
`ACCOUNT_MAX_DOCS`: a positive safe integer, defaulting to 3 when omitted.
An invalid value returns `500 internal` on account-token creates before any
document or daily quota write; other operations and license-key caps are
unchanged. No database migration is required.

`limit` identifies which limit was hit; `plan` names the account's current plan.
These are values, not fixed enums: clients must accept unfamiliar strings and
must not treat either field as proof of paid entitlement. The
current values are `"documents"` and `"account"`, respectively; real account
plan names will replace the latter when per-account plans ship.

For example, the current account-token document-cap response is:

```json
{"error":{"code":"limit_reached","message":"...","limit":"documents","plan":"account"}}
```

Waiting until tomorrow or signing in on another machine does not free a slot.
The CLI already handles this refusal without suggesting a daily reset. No
`upgrade_url` is returned until a real upgrade flow is configured; subscription
checkout and individual paid account plans are separate follow-up work.

Two further limits sit outside all of this. On `POST /device/code`, a single
client address may ask for five sign-in codes a minute, and past that the mint
answers `429 quota_exceeded` with `Retry-After`. On `POST /device/token`, one
poll per device code is served every ten seconds, with a separate ceiling of
twenty polls per client address in that window; faster requests answer
`slow_down`. Neither is a publishing quota, no authenticated call can reach
them, and a self-hosted deployment can remove the corresponding bindings.

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
BASE=https://api.openartifacts.ai
KEY=<paid Copilot license key>

# publish
curl -sS -X POST "$BASE/api/v1/docs" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"title":"Notes","html":"<!doctype html><html><body><p>hello</p></body></html>"}'
# → {"docId":"9f2k…","url":"https://openartifacts.site/d/9f2k…","version":1}

# The document reads use the `url` that push returned, never "$BASE/d/…": the
# page lives on the serving domain, and the API host resolves every path to the
# API surface, which would answer these unauthenticated reads 401.
DOC=https://openartifacts.site/d/9f2k…

curl -sS "$DOC"                                # the public page, no auth
curl -sS "$BASE/api/v1/docs?limit=10" -H "authorization: Bearer $KEY"
curl -sS -X DELETE "$BASE/api/v1/docs/9f2k…" -H "authorization: Bearer $KEY" -i
curl -sS "$DOC" -o /dev/null -w '%{http_code}\n'            # → 410
```

`scripts/smoke.sh` runs exactly this sequence against a deployment and checks
every status.
