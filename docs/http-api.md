# HTTP API

This document is the contract, and it is frozen: the Obsidian Copilot client is
written against what is below, so nothing here changes without a client release.
It is complete on purpose — a client author should never need to read this
repo's source.

[← README](../README.md) · [Deploying](deploying.md) · [Hosting](hosting.md)

## Surfaces

The surfaces:

| Surface | Paths | Auth | Notes |
| --- | --- | --- | --- |
| API | `/api/v1/*` | required | Publisher-facing. JSON in, JSON out. |
| Serving | `/d/*` | none | Reader-facing. Public HTML on `openartifacts.site`, which never sets a cookie. |
| Private serving | `/d/*` on `{label}.openartifacts.site` | grant cookie | One publisher's invited-only documents per origin. Sets one read-only grant cookie. See [Private documents](#private-documents). |
| Reader | `/open/*` (`GET`, and `POST /open/{docId}/request`), `/signin/*`, `/share/*`, `/embed/sign-in` | session | Human-facing HTML pages on the API host: sign in, the door a private document opens through, requesting access, the share page, and the Share popover's sign-in popup. Not a client surface. |
| Embed | `/embed/page.js`, `/embed/share`, `/embed/sign-in`, `/embed/token`, `/embed/api/*` | none, the session (sign-in only) or the popover token | The top bar's page script, the Share popover frame, its sign-in popup and the routes the frame calls, on the API host. Not a client surface. See [The top bar, the Share popover and the share page](#the-top-bar-the-share-popover-and-the-share-page). |
| Comments | `/api/v1/docs/{docId}/threads…`, `/d/{docId}/threads`, `/embed/api/docs/{docId}/threads…` | token, none, or the popover token | Inline comments: the agent routes, the unauthenticated threads resource on the serving origin, and the JSON a browser frame would call. See [Comments](#comments). |
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
a key changes nothing about which documents you have. Publisher operations never
accept an account id to select whose documents to access; ownership is derived
from the credential. The separate admin API uses account ids for routing, not as publisher
credentials.

**License-key publishing requires a paid plan.** Eligible `PLUS` subscriptions
and `BELIEVER` accounts (sold as Supporter) can publish with a license key,
subject to their hosted-access period. An unknown or otherwise ineligible plan is refused with `401
unauthorized` like every other auth failure, so only the human-readable
`message` distinguishes it.

The entitlement is **per operation, not per key**, and only `POST /api/v1/docs`,
`POST /api/v1/private-docs` and `PUT /api/v1/docs/{docId}` are gated on it. A publisher whose plan no longer
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

**Credential identities stay separate until explicitly linked.** A key resolves
to its Brevilabs account and a token to its OpenArtifacts account. A trusted
service may permanently associate the two after proving control of both; email
matching alone cannot authorize this. Linked credentials see the joined history
and their publishing limits count both owners. Token administration remains tied
to the account that issued the token. Existing document URLs do not change.

**Publishing follows the account's plan.** First approval uses the deployment's
default plan. Every token shares its account's limits, and a plan change takes
effect on the next request without signing in again. The hosted free plan has
three live documents, six publishes/updates per UTC day, and 1 MiB HTML per doc.
Listing and unsharing never require available publishing quota.

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

Reading a public doc requires nothing. `openartifacts.site` never sets a cookie; a
private document's own origin sets one grant cookie
([Private documents](#private-documents)). That origin belongs to the document's
publisher and is shared by all of that publisher's invited-only documents, so it
is one cookie per publisher, not one per document.

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
- **Device approval and browser sign-in set no cookie.** The OAuth handshake is
  kept on the device code's own row rather than in the browser, because the
  browser is not the thing being authorized. The one exception is the shared
  callback `/approve/callback/{provider}` when it ends a *reader's* sign-in
  (see [Private documents](#private-documents)): it reads the `__Host-oa_login`
  cookie that bound the handshake to its browser, clears it, and sets the reader
  session, on the API host only. `openartifacts.site` never sets a cookie.
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
POST   /api/v1/docs           {title?, html}  → 201 {docId, url, version, linkAccess: "anyone"}
POST   /api/v1/private-docs   {title?, html}  → 201 {docId, url, version, linkAccess: "invited"}
PUT    /api/v1/docs/{docId}   {title?, html}  → 200 {docId, url, version}
DELETE /api/v1/docs/{docId}                   → 204
GET    /api/v1/docs?limit&cursor              → 200 {docs[], cursor?}
GET    /api/v1/docs/{docId}/access                      → 200 Access
PUT    /api/v1/docs/{docId}/access  {linkAccess}        → 200 Access
PUT    /api/v1/docs/{docId}/access/people/{email}  {role?}  → 200 Access
DELETE /api/v1/docs/{docId}/access/people/{email}       → 200 Access
DELETE /api/v1/docs/{docId}/access/requests/{email}     → 200 Access
GET    /api/v1/docs/{docId}/html                        → 200 the latest stored HTML
POST   /api/v1/docs/{docId}/open                        → 200 {url, expiresAt}
GET    /api/v1/docs/{docId}/threads?state&since&v       → 200 Threads
POST   /api/v1/docs/{docId}/threads  {anchor, body}     → 201 {threadId, commentId, anchorStatus}
POST   /api/v1/docs/{docId}/threads/{threadId}/comments | resolve | reopen
DELETE /api/v1/docs/{docId}/comments/{commentId}        → 204
PUT    /api/v1/docs/{docId}/settings  {comments}        → 200 {docId, comments}
PUT    /api/v1/account  {displayName}                   → 200 {displayName}
GET    /api/v1/tokens                         → 200 {tokens[]}
DELETE /api/v1/tokens/{tokenId}               → 200 {tokenId, remaining}
POST   /device/code           {label?}        → 200 {device_code, user_code, …}
POST   /device/token          {device_code}   → 200 {access_token, …}
GET    /d/{docId}                             → 200 latest HTML
GET    /d/{docId}/v{n}                        → 200 immutable HTML
GET    /d/{docId}/threads[?v=n]               → 200 Threads (no credential)
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
 "version": 1,
 "linkAccess": "anyone"}
```

A document made here is public, and the receipt says so with `"linkAccess":
"anyone"`. An unknown field is ignored, as it always was, so no field can make a
document private; to create one that is, use `POST /api/v1/private-docs`
([Private documents](#private-documents)). A `PUT` never changes who can read a
document.

A `docId` is 16 characters of lowercase Crockford base32 (`0-9`, `a-z` without
`i`, `l`, `o`, `u`) — 80 bits of randomness. It is the only access control a doc
has: whoever holds the url holds the doc, so treat the id as a secret and do not
log it anywhere a reader would not already be allowed. For a document whose
`linkAccess` is `"invited"`, the url alone opens nothing: a reader must sign in
with an invited address (see [Private documents](#private-documents)). Treat the
id as a secret either way.

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
    "updatedAt": 1785000000000,
    "linkAccess": "anyone"}
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
`If-None-Match` are supported (`304`). These are a public document's lifetimes; an
invited-only document is never cached ([Private documents](#private-documents)).

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
retargeting. The origin is cookieless and holds nothing but already-public docs;
an invited-only document is redirected to sign-in and never served from it.

The following are injected as the document is served: a
`<meta name="robots" content="noindex,nofollow">` in the head, a
`<link rel="icon">` beside it carrying the OpenArtifacts mark as a `data:` URI, a
`Shared from Copilot for Obsidian` byline at the top of the body only for
Copilot-rendered HTML (identified by the
`style#openartifacts-obsidian-publish-baseline` marker in the head, or
`style#symposium-obsidian-publish-baseline` from before the OpenArtifacts
rename), and a
`Powered by openartifacts.ai` byline before `</body>`. Unmarked HTML gets no
source header. The marker identifies a document format, not authenticated
uploader identity. A document that ships its own
icon keeps that markup — both links are then in the head, and which one the tab
shows is the browser's choice. Nothing else is touched — the
markup is never sanitized, rewritten or reformatted, and what R2 stores is the
publisher's document exactly as it was pushed.

On a server with reader sign-in configured, a **top bar** replaces the header
byline: a spacer as the first child of `<body>`, one small `<style>` element, a
strip fixed to the top of the viewport, and a `<script defer
src="https://{API host}/embed/page.js">` tag. The strip carries the byline's text
(`Shared from Copilot for Obsidian`) on the left, only for Copilot-rendered HTML,
and **Share** on the right, a plain link to `https://{API host}/share/{docId}`.
It is the same bytes for every viewer of a document, public or private, and
names no identity, so public pages stay cacheable. The footer byline is as
before. On a server without reader sign-in no page carries the top bar or the
page script, and the header byline is as it was (see [The top bar, the Share
popover and the share page](#the-top-bar-the-share-popover-and-the-share-page)).

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
| `302 Found` | An invited-only document: no body, `no-store`, to the sign-in door on the API host ([Private documents](#private-documents)). |
| `404 Not Found` | A neutral unavailable page for an unknown or malformed link, a missing version, or missing stored bytes. |
| `410 Gone` | An explicit deleted page when the retained doc row proves the author withdrew it. |
| `500 Internal Server Error` | A temporary-unavailable page when a serving dependency fails. |

All of these are `no-store` and retain the serving header policy above. `HEAD`
returns the same status and headers as `GET` without a body. Healthy `200` and
conditional `304` responses are unchanged.

## Private documents

A document is public (`linkAccess: "anyone"`, the default, exactly what this API
always did) or invited-only (`"invited"`). The url is the same either way:
`https://openartifacts.site/d/{docId}` is what a client prints and copies, and the
only url it should ever build is the one the API returned. Everything below is
additive; [private-sharing.md](private-sharing.md) is the design and the reasons.

**On a server with no reader sign-in configured, none of it exists.** A secret
missing or shorter than 32 characters, a missing serving or API host, or no way to
sign in (no Google, GitHub or email) makes the whole family below, and `/embed/*`,
answer `404`,
exactly as a server that predates private sharing does, and no served page carries
the top bar or the page script; the header byline is as before. Documents that were never made invited-only stay public. A
document that is already invited-only goes offline instead: its url still
redirects to `/open`, which answers `404`, and `GET /api/v1/docs` reports its
stored `linkAccess`. It is never made public. A client shows the message it
already has for an old server.

### `POST /api/v1/private-docs` — publish a new invited-only doc

The same body, limits, quotas and errors as `POST /api/v1/docs`, and the same
create (one code path), with the document inserted as invited-only in that same
insert: it is never public, not even for a moment.

```json
{"docId": "9f2k4mvq7t0xbz3n",
 "url": "https://openartifacts.site/d/9f2k4mvq7t0xbz3n",
 "version": 1,
 "linkAccess": "invited"}
```

`url` is the canonical link, never a grant. Publishing a private document needs a
plan with private sharing: `402 limit_reached` with `"limit": "privateSharing"`
otherwise, checked after the usual publishing checks and before anything is
created. A license key gets the message "Your Copilot plan does not include
private sharing." with no `upgrade_url`; an account token gets "Private sharing
needs a paid plan." and the usual `plan` and `upgrade_url`.

It is a route and not a field so that a server which predates private sharing, or
one that has no reader sign-in configured, answers **`404 not_found` and creates
nothing**, after authentication and before any plan check. `POST /api/v1/docs`
accepts no `linkAccess` field and ignores one, as it ignores every unknown field.
**The client rule:** on `404`, report "this server does not support private
documents" and stop. Nothing was created, so there is nothing to withdraw; never
fall back to `POST /api/v1/docs`, which would publish the page to anyone. There is
no receipt to check.

### The access routes

```http
GET    /api/v1/docs/{docId}/access                          → 200 Access
PUT    /api/v1/docs/{docId}/access  {linkAccess}            → 200 Access
PUT    /api/v1/docs/{docId}/access/people/{email}  {role?}  → 200 Access
DELETE /api/v1/docs/{docId}/access/people/{email}           → 200 Access
DELETE /api/v1/docs/{docId}/access/requests/{email}         → 200 Access
GET    /api/v1/docs/{docId}/html                            → 200 the latest stored HTML
POST   /api/v1/docs/{docId}/open                            → 200 {url, expiresAt}
```

All owner-only except `GET …/html`, which anyone who can read the document may call
(see [Comments](#comments)). A document you may not use this way, never existed, or
was deleted is `404 not_found`. A client changes **one address at a time**: it never sends the
whole list, so a retry cannot remove everyone, and a repeated `PUT` or `DELETE`
answers `200` with the same list. An `Access` response is `no-store`.

```json
{"docId": "9f2k4mvq7t0xbz3n",
 "url": "https://openartifacts.site/d/9f2k4mvq7t0xbz3n",
 "linkAccess": "invited",
 "email": true,
 "people": [{"email": "alice@acme.com", "role": "comment", "addedAt": 1785000000000}],
 "requests": [{"email": "bob@other.com", "requestedAt": 1785000100000}]}
```

`url` is always the canonical link, never a grant. `email` says whether this
server can send invite and request emails, not that one was delivered (a
rate limit or the mail service can drop one): when it is `false` the owner
shares the link themselves. `role` is `"view"` or `"comment"`; only `comment` may post threads
(see [Comments](#comments)). `requests` are the addresses that asked to open the document and
have not been answered.

- `PUT …/access` takes `{"linkAccess": "anyone" | "invited"}`. Switching to
  `anyone` keeps the list and the requests, and switching back restores them.
- `PUT …/access/people/{email}` adds one address (URL-encode the `@`; it is
  lowercased and trimmed). The body is optional: `{"role": "view" | "comment"}`,
  default `comment`; any other body, including an unknown role, is `400
  bad_request`. The call that adds an address sends it an invite email where the
  server has email; a repeat does not, and a repeat that names a different role
  updates the role. At most 100 people per document; the 101st is `400`.
  An owner may add at most 100 new invites in a rolling 24 hours, across all
  their documents: past that, an add that would list a new address, approvals
  included, is `429 quota_exceeded`, nothing is stored or sent, and a pending
  request stays. Repeats and role changes never count; removals and unshares do
  not free allowance.
  `DELETE` removes one. Neither needs the address to belong to an account.
- **Approving a request is adding the address.** There is no approve route:
  `PUT …/access/people/{email}` for an address with a pending request lists the
  person and clears the request in one step, and sends the ordinary invite, which
  is how the requester learns the answer. Like any add it needs the plan.
- `DELETE …/access/requests/{email}` declines a request. It is idempotent, sends
  nothing, tells the requester nothing, and never needs the plan. At most 100
  requests are pending per document; past that, new requests are dropped
  silently.
- `GET …/html` returns the latest stored HTML (`text/html`, `private, no-store`,
  sandboxed), so `openartifacts get` keeps working once a page's public url stops
  answering. Anyone who can read the document may call it, not only the owner, so an
  invited reviewer's agent can quote the page; a document the caller cannot read is
  `404`. It is not part of the family that a server without reader sign-in answers
  `404`.
- `POST …/open` returns `{"url", "expiresAt"}`, with `expiresAt` 60 seconds out.
  For an invited-only document `url` is the publisher's own origin with a
  60-second grant, which opens it in a browser with no sign-in; for a public one
  it is the canonical url. **A client opens it and discards it.** Never print it,
  store it, or put it in a publish receipt: agent wrappers print receipts into
  transcripts. No plan is needed.

Errors reuse the existing codes: `404 not_found` for a document that is not yours (for `…/html`, one you cannot read),
`400 bad_request` for an invalid address, role or mode, or a 101st person, and
`402 limit_reached` with `"limit": "privateSharing"` when the plan does not include
it, and `429 quota_exceeded` past the daily invite cap. On a server without reader sign-in configured, every route in this section
except `…/html` answers `404 not_found`, like a server that predates it.

### The plan check

On write, and only on the operations that spend it: `POST /api/v1/private-docs`,
making a document invited-only that is public now (`PUT …/access` from `anyone`
to `invited`), and adding a person, which includes approving a request. Naming
the mode a document already has is a repeat and never checks. So is adding an
address that is already on the list with no role or the role it already has: it
answers `200` with the current `Access` on any plan, and sends no email. Removing people,
**declining a request**, switching to `anyone`, reading, and opening never check
a plan, so invitees never pay and a lapsed plan keeps what exists. A lapse never
makes a private document public. Every paid plan qualifies: a license key whose
plan may publish (`PLUS`, and `BELIEVER`, sold as Supporter), and an account plan
with `privateSharing` (`pro` and `pro_lifetime`). Which plans qualify is
configuration, not part of this contract.

### Reading one

The pages in this section are for people in a browser, not for clients, and none
of them is under `/api/v1`.

Every response from `/open/*`, `/signin/*`, `/share/*` and `/embed/*` on the API
host, pages and redirects alike, carries `Cross-Origin-Opener-Policy:
same-origin`.

`GET /d/{docId}[/v{n}]` on `openartifacts.site` for an invited-only document
answers `302`, `Cache-Control: no-store`, to
`https://{API host}/open/{docId}[/v{n}]`, with no body, no cookie, no view event
and the full serving header policy. Unknown ids are still `404` and deleted ones
`410`. From there:

1. **`GET /open/{docId}[/v{n}]`** on the API host. With no session it shows a
   sign-in page, **Sign in or create an account to open this document**, that names
   no address and offers only the methods this server has (Google, GitHub, an
   emailed code), and returns to this path afterwards. With a session: a document
   that is public now redirects to the canonical url; a reader who may read an
   invited-only one (the owner's account, or an account whose address is on the
   list) is redirected to
   `https://{label}.{serving host}/d/{docId}[/v{n}]?grant=…`; anyone else, and every
   unknown or deleted id, gets `404` with **This document isn't available to
   {email}**, **Request access** and **Use another account**, and no title or
   content. The same page serves not invited, removed, deleted and never existed.
2. **`POST /open/{docId}/request`**, the **Request access** form. It needs the
   session and `Sec-Fetch-Site: same-origin`; the address comes from the session,
   never from the form. It always answers the same **Request sent** page, with the
   same status and words, whether it stored a request, found one already pending,
   or the id is unknown, deleted, public or already allowed. At most one row is
   stored per document and address, and the owner is emailed once per new row
   when the server has their address. It is rate limited per account.
3. **`GET /d/{docId}[/v{n}]` on `{label}.{serving host}`.** The label is a one-way
   hash of the *document owner's* id, so a label host belongs to one publisher
   and answers `404` for any document whose owner does not hash to its label.
   A valid `?grant=` is swapped for a cookie with a bodiless `303` to the clean
   path. A missing, expired or foreign grant or cookie is `302` to
   `https://{API host}/open/{docId}[/v{n}]`. With a valid cookie: deleted is
   `410`, a document that is public now is `302` to the public url, a reader who
   is not allowed is `302` to `/open` (a label host never renders the unavailable
   page), and an allowed one is served.

| | Lifetime | Holds |
| --- | --- | --- |
| Reader session `__Host-oa_session`, on the API host | 30 days | An account id. Read only by `/open/*`, `/share/*`, `/signin/*` and `/embed/sign-in`; `/api/v1` ignores it. |
| Popover token, in the Share frame's own storage | 24 hours | An account id and one document id; prefixed `oas_`, which `/api/v1` refuses. Accepted only by `/embed/api/docs/{docId}/…` for that document, and by `PUT /embed/api/account` (the display name) with a token for any document. |
| URL grant `?grant=` | 60 seconds | An origin label and a principal. Never stays in the address bar. |
| Origin cookie `__Host-oa_grant`, on the publisher's origin | 1 hour | An origin label and a principal. Every document is checked again on every request. |

Each cookie is `HttpOnly; Secure; SameSite=Lax; Path=/` with no `Domain`. The
grant names an origin, not a document, so one cookie opens every invited-only
document of that publisher the reader may read, and the invite list is read again
on every request. Removing a person takes effect on their next request; copies a
reader already fetched cannot be recalled.

Responses from a label host that serve a document are `Cache-Control: private,
no-store`, pinned versions included, with `Cross-Origin-Opener-Policy:
same-origin-allow-popups` and `Cross-Origin-Resource-Policy: same-origin`
(present on every response from that host, errors and redirects too), and carry
the same CSP and robots headers as every served document.

### The top bar, the Share popover and the share page

Everything here is for people in a browser. None of it is under `/api/v1`, and
none of it is part of the client contract; it is documented because it is on the
wire. [private-sharing.md](private-sharing.md) has the reasons.

**The page script.** `GET` or `HEAD https://{API host}/embed/page.js` is the
script every served page loads, from the tag in the top bar. It is a constant:
`Content-Type: text/javascript`, `Cache-Control: public, max-age=3600,
stale-while-revalidate=86400`, an `ETag` (`If-None-Match` answers `304`),
`Cross-Origin-Resource-Policy: cross-origin`, and no cookie in either direction.
**Its address is permanent**: pinned `/v{n}` pages are served `immutable` for a
year and carry the tag, so the path never moves or changes meaning, and a fix to
the script reaches pages through that cache lifetime. It turns **Share** into a
popover and does nothing else. It holds no credential and reads no cookie or
storage. Where a page's own policy blocks it, or scripts do not run, **Share** is
still the plain link to the share page.

**The popover frame.** `GET https://{API host}/embed/share?doc={docId}&origin=…`
is what the popover draws, in an `iframe` on the API host: the credential that
changes who can read a document must never be on a page whose scripts the author
writes. `origin` is the page's own origin, which the script fills in.

- *Per-document `frame-ancestors`.* A public document may be framed by
  `https://{serving host}`; an invited-only one by its publisher's own origin
  `https://{label}.{serving host}` only; an unknown or deleted one by nobody
  (`'none'`). The policy names that origin only when the caller's `origin`
  parameter equals it, so the header echoes what the caller already named and
  never publishes an invited-only document's label. The browser checks it against
  the real ancestor, so a forged `origin` frames nothing.
- *The frame reveals nothing to non-readers.* Anyone can load it with any id.
  Until a token shows the viewer can read the document, the body is the same for
  a public, an invited-only, an unknown and a deleted id once the id is replaced:
  **Share**, "Only the owner can change who can open this.", **Copy link** for the
  canonical address (built from the id, with no lookup) and "Is this your page?
  **Sign in to manage**". No title, no mode, no list. The one thing that varies is
  `data-origin`, which echoes the caller's own `origin` when it matches the
  document's serving origin. With a token, a non-reader gets what an unknown id
  gets, never `403`.
- *It tells the page around it nothing about its viewer.* The frame has one fixed
  size, and posts only `ready`, before it reads its storage, and `close`, after a
  click inside it. On a public document any page on `openartifacts.site` can embed
  the frame, and they share its storage.
- It sets no cookie, no `Access-Control-Allow-*` header and no
  `X-Frame-Options`; it is `no-store`.

**Signing in to the popover.** The frame cannot see the reader session, because
browsers block or partition cross-site cookies in frames. **Sign in to manage**
opens a top-level popup at `/embed/sign-in?doc={docId}&h={sha256 hex}`. Before it,
the frame makes a random nonce only it knows and passes the nonce's hash as `h`.

- The popup is refused unless it was opened from the frame (`Sec-Fetch-Site:
  same-origin`) or is the return leg of a sign-in that was (a per-handshake
  cookie, `__Host-oa_embed_…`, set for ten minutes), so a page that opens the
  address with a hash of its own collects nothing. Browsers with no Fetch Metadata
  get the share page instead.
- With no session the popup shows the ordinary sign-in, then returns to itself.
  With a session it stores the account under `h` **for one minute and one use**,
  and also posts the token to its opener if the opener survives.
- `POST /embed/token {doc, nonce}` is how the frame collects it: the row is found
  by the hash of the nonce, so only the frame that made the nonce can take it, once.
  Pending, unknown, used and expired all answer `404`. A claim over the
  per-address limit answers `400 slow_down`, which the frame treats like any other
  non-`200` and keeps polling. Every API-host page sends a
  cross-origin opener policy and Google's sign-in pages probably do too, which can
  sever the popup's link to the frame, so the frame polls (every two seconds, for
  at most ten minutes, and again when its tab becomes visible) rather than waiting
  for a message. Seeing the popup's address yields only the hash, which collects
  nothing.

**The token.** `oas_…`, signed with the reader secret under its own purpose,
valid for 24 hours, naming one account and one document, and kept in the frame's
own storage. It is a bearer credential accepted only by
`/embed/api/docs/{docId}/…` (the access routes and the comment routes) for that document, and by
`PUT /embed/api/account`, which sets the account's display name and takes a token for any document.
`/api/v1` refuses its prefix, and the share page, `/open` and `/signin` read only the session cookie.
It cannot publish, list, delete or touch another document; the display name is the one account-wide thing it changes.

**The frame's JSON.** `GET`, `PUT` and `DELETE /embed/api/docs/{docId}/access…`
are the five access operations of [The access routes](#the-access-routes) under
that token, with no CORS. They run the same operations as the access routes and
the share page, so the plan check and its `402`, both invite caps, the invite email
and the analytics event are unchanged. `GET` answers `{"viewer": "owner", …}` with
the `Access` fields, the title and `changed` (whether the write changed the link
access or the invite list; a decline, a `GET` and a repeat answer `false`) for the owner, `{"viewer": "reader", "account",
"docId", "url", "title"}` for a signed-in account that may read the document but
does not manage it, and `404` for everyone else. A missing, expired or foreign
token is `401`.

**The share page.** `GET https://{API host}/share/{docId}` is the same controls as
a page, with the session cookie. It is where **Share** leads with no script, the
request email's **Review request** and the url `share` prints.

| Who | What the page shows |
| --- | --- |
| No session, a live public document | The title, "Only the owner can change who can open this.", **Copy link**, and "Is this your page? **Sign in to manage**" (`?signin` selects the sign-in page) |
| No session, anything else, or `?signin` | The sign-in page, the same bytes for an invited-only, an unknown and a deleted id, returning to `/share/{docId}` |
| A signed-in account that owns the document | **Link access**, **Add people**, **Requests** with **Approve** and **Decline**, **Who has access** with **Remove**, **Copy link**, and, after a switch from public to private, the line "People who opened it while it was public may have kept a copy." |
| A signed-in account that may read it | The title, the same sentence, **Copy link**, **Use another account** and a line telling a Copilot owner to manage access in Copilot |
| A signed-in account that may not, unknown, deleted | The unavailable page as `/open`, `404`, never `403` |

Its writes are `POST /share/{docId}` forms (`op` of `link`, `add`, `remove` or
`decline`), same-origin only, and they run the same operations as the access
routes with the signed-in account as the principal, so the plan check and its `402`
are unchanged: a refused write re-renders the dialog with the reason and the
upgrade link.

### Old clients

Copilot 4.0.14 and CLI 0.2.x keep publishing, updating, listing and unsharing and
ignore `linkAccess`; their documents stay public. For a document another client
made private, an old Copilot's "Open" goes through sign-in like any reader, and an
old CLI's `get` prints the sign-in page.

## Comments

Readers and agents can comment on a quoted passage of a page, reply, and resolve
the thread once a later version addresses it. Everything here is additive: no
existing route, status or field changed meaning, and an older client that never
calls these routes sees no difference. [comments.md](comments.md) is the design
and the reasons.

**On a server without reader sign-in configured, or without the `COMMENTS`
Durable Object binding, none of it exists.** Every route under a document in this
section answers `404 not_found` (the document routes are part of the
private-sharing family, so they need reader sign-in as well), so does
`PUT /api/v1/account`, and the threads resource answers `404`. A client
shows "Not found, or this server does not support comments."

### The routes

```http
GET    /api/v1/docs/{docId}/threads?state=&since=&v=      → 200 Threads
POST   /api/v1/docs/{docId}/threads  {anchor, body, version?}                → 201 {threadId, commentId, anchorStatus}
POST   /api/v1/docs/{docId}/threads/{threadId}/comments  {body, version?}    → 201 {commentId}
POST   /api/v1/docs/{docId}/threads/{threadId}/resolve  {version?}           → 200 Thread
POST   /api/v1/docs/{docId}/threads/{threadId}/reopen   {version?}           → 200 Thread
DELETE /api/v1/docs/{docId}/comments/{commentId}                             → 204
PUT    /api/v1/docs/{docId}/settings  {comments}                             → 200 {docId, comments}
PUT    /api/v1/account  {displayName}                                        → 200 {displayName}
```

Every response is `no-store`, JSON apart from the `204`. The credential is an
account token (`oat_…`) or a license key. `/api/v1` still refuses the Share
popover's `oas_` token. A comment written through `/api/v1` is an **agent
comment**: it is labelled as the agent of the account it acts for (below). Any
other method or path under a document is `404 not_found`, as before.

| Route | Who may call it |
| --- | --- |
| `GET …/threads` | Anyone who can read the document. |
| `POST …/threads`, `POST …/comments` | Anyone who can comment (below). |
| `POST …/resolve`, `POST …/reopen` | The document's owner, or the thread's author while they can still comment. |
| `DELETE …/comments/{commentId}` | The comment's author, on any document they can still read. |
| `PUT …/settings` | The document's owner. |
| `PUT /api/v1/account` | An account token, or a license key whose owner is linked to an account (it names that account). An unlinked key has no account to name: `404 not_found`. Like every route in this section, it answers `404 not_found` on a server without reader sign-in or the `COMMENTS` binding. |

**Who can comment.** The caller can read the document, the owner has turned
comments on, the owner's plan includes comments, and the caller is the owner, an
invited account whose `role` is `comment`, or, on a document whose `linkAccess`
is `anyone`, any signed-in account or key. A reader invited with `role: "view"`
can read the threads and nothing more. Readers and commenters never pay: only the
document owner's plan is checked, so a free reader can comment on a Pro owner's
page, and an owner whose plan lapses keeps their threads readable and stops
accepting new writes. License keys whose plan may publish (`PLUS`, `BELIEVER`) and
accounts on a plan with `comments` (`pro`, `pro_lifetime`) qualify; the free plan
does not. Which plans qualify is configuration, not part of this contract. An
author's identity survives linking a license key to an account: a comment written
by the key stays the account's.

**Turning comments on.** `PUT …/settings` takes `{"comments": true | false}` and
nothing else (`400 bad_request` for any other body). Turning it on needs the
owner's plan (`402 limit_reached`, `limit: "comments"`, with an `upgrade_url` for
an account); turning it off never does, and deletes nothing. Naming the state the
document is already in is a repeat and answers `200`. Comments are off for every
document until the owner turns them on. `GET …/access` and `PUT …/access…` carry
the switch as `"comments": true | false` in the `Access` response (an added
field).

**`GET …/html` is now readable by anyone who can read the document**, not only
the owner, so a reviewer's agent can quote the page it was invited to. The
owner's behaviour is unchanged, and a document the caller cannot read is still
`404`. A `200` from this route therefore no longer proves the caller owns the
document, and a client must not use it as an ownership check.

### Threads

```json
{"docId": "9f2k4mvq7t0xbz3n",
 "title": "Q3 report",
 "version": 2,
 "latestVersion": 2,
 "threads": [
   {"threadId": "th_b7q3k9x2m4",
    "anchor": {"exact": "Revenue grew twelve percent.", "prefix": "dog. ", "suffix": "", "section": "intro"},
    "anchorStatus": "anchored",
    "matchedText": "Revenue grew twelve percent.",
    "createdAtVersion": 1,
    "createdAt": 1785000000000,
    "state": "resolved",
    "resolution": {"by": {"name": "Alice's agent", "kind": "agent"}, "atVersion": 2, "at": 1785000900000},
    "comments": [
      {"commentId": "cm_c5r8n1t6w0", "author": {"name": "Bob", "kind": "human"},
       "body": "Twelve percent of what?", "createdAt": 1785000000000, "atVersion": 1},
      {"commentId": "cm_d2h7j4v9s3", "author": {"name": "Alice's agent", "kind": "agent"},
       "body": "Clarified in v2.", "createdAt": 1785000800000, "atVersion": 2}
    ]}
 ]}
```

| Field | Meaning |
| --- | --- |
| `version` | The version the anchors were computed for: the newest, or the `v` asked for. |
| `latestVersion` | The newest version. |
| `anchor` | What the thread was created on: `exact` (1 to 1,000 characters) with optional `prefix` and `suffix` (up to 32 characters each) and `section` (the nearest element id, up to 128). `exact` is rewritten to the matched text when only a whitespace-insensitive match was found. |
| `anchorStatus` | `anchored` when the quote is found in `version`, `orphaned` when it is not. Independent of `state`: a resolved thread whose text is gone is still resolved, and an open orphan stays open. Text that returns in a later version re-anchors. |
| `matchedText` | The text of `version` the quote matched, or `null` when orphaned. |
| `createdAtVersion` | The version the author was reading. |
| `state` | `open` or `resolved`. |
| `resolution` | `null` while open; else who resolved it, in which version, and when. |
| `comments[]` | In order. `atVersion` is the version the author was reading. |
| `author`, `by` | `{name, kind}`: the only identity ever sent. `kind` is `human` or `agent`. |

Times are epoch milliseconds, as in `Access`. Threads are ordered by `createdAt`.
**No account id and no email address ever appears.** A person is shown by their
display name (`Someone` if they have none). An agent is named after the account it
acts for, `"<display name>'s agent"`; with no name on file the document owner's
agent is `"Owner's agent"` and any other is `"An agent"`.

`GET …/threads` takes `state` (`open`, `resolved` or `all`, default `all`),
`since` (an ISO 8601 date or timestamp: only threads with activity after it,
where a reopen counts) and `v` (a version number, `/^[1-9][0-9]{0,8}$/`, to
compute the anchors for that version, `404` if it does not exist). A bad `state`,
`since` or `v` is `400 bad_request`. Anchors are computed once per thread and
version and then remembered, so an old version costs one pass.

The authenticated variants (this API, and the embed API with a token) add
`"viewer": {"canComment", "canManage", "name"}` at the top, `"canResolve"` on each
thread and `"mine"` on each comment. The unauthenticated variant on the serving
origin carries none of them.

**Creating a thread.** `POST …/threads` takes `{"anchor": {...}, "body": "…",
"version"?: n}`, and nothing else (`400 bad_request`). `body` is plain text,
1 to 4,000 characters; `version` defaults to the newest and is the version the
quote was copied from. The quote must occur exactly once in that version's text
(or, if several times, be disambiguated by its `prefix`, `suffix` and `section`),
else `400 anchor_not_found`. The text is the page's visible text: the
concatenated text of `<body>` without `script`, `style`, `template` and `noscript`,
with entities decoded and normalised to NFC; OpenArtifacts' own bar and bylines
are not part of it. A `version` that does not exist is `404`.

Replying (`…/comments`, `{"body": "…", "version"?}`) works on a thread in either
state. Resolving takes an optional `version`: the version that addressed the
comment, recorded on the resolution and shown as "Resolved in v{n}". Resolving a
resolved thread, or reopening an open one, is a repeat: `200` with the thread, the
original resolver kept. Reopening clears the resolution. Deleting a comment that
is a thread's first deletes the thread and its replies; any other deletes just
that comment.

### Limits and the order of refusals

A document holds at most **500 threads** and **2,000 comments**; past that a
write is `402 limit_reached` with `limit: "threads"` or `limit: "comments"` and no
`upgrade_url`. A principal may write **30 comments a minute** (create, reply,
resolve and reopen share the allowance; delete and the settings switch do not),
else `429 quota_exceeded` with `Retry-After: 60`. A write is checked in this
order. A write refused at steps 1 to 5 never spends the rate limit:

1. The caller can read the document, and comments are available on this server:
   else `404`. A deleted document is `404`, and its comment object refuses writes
   forever.
2. Comments are on: else `409 comments_off` to someone who manages the document
   and `404` to everyone else.
3. The caller's role allows writing (owner, invited `comment`, or signed in on an
   `anyone` document): else `404`. A `view` invitee gets `404`, never `403`.
4. The owner's plan has comments: else `402 limit_reached` (`limit: "comments"`) to
   the owner and `404` to everyone else.
5. A person has a display name: else `409 name_required`. Agents are exempt, being
   named after their account. `PUT /api/v1/account` (or `PUT /embed/api/account`)
   sets it: trimmed, 1 to 64 characters, no control characters, else `400`.
6. The rate limit.

A write that passes the rate limit and is then refused for its content (a malformed
or over-long body or quote, `anchor_not_found`, a `version` that does not exist, the
500 and 2,000 caps, or an unknown or forbidden `threadId`) has spent one unit of the
allowance.

Anything else the caller may not see or do (another publisher's document, a
`threadId` or `commentId` that is not theirs to touch, a resolve by someone who is
neither the owner nor the thread's author) is `404 not_found`, indistinguishable
from an id that never existed. Malformed JSON, an unknown field, a body over 4,000
characters or a quote over 1,000 is `400 bad_request`. Reading and deleting ask
only for read access and authorship, so a switch turned off or a lapsed plan never
costs anyone their own words; reading with comments off is `409 comments_off` to
the owner and `404` to everyone else.

### Email

When the server has Email Service configured, a new thread emails the document's
owner (unless they wrote it) and a reply or a resolve emails everyone who has
written in the thread, an agent's comments to the account it acts for, minus
whoever just acted. Reopening mails nobody. Only accounts that can still read the
document are mailed, so a removed invitee hears nothing. The message names people
by display name, never address, and carries the title, the quote, the comment and
the page's link. It is sent after the response, bounded by 20 emails a minute per
document, and never changes the response: a failed or skipped send costs the
recipient an email and nothing else.

### The threads resource on the serving origin

```http
GET|HEAD https://openartifacts.site/d/{docId}/threads[?v={n}]            a public document
GET|HEAD https://{label}.openartifacts.site/d/{docId}/threads[?v={n}]    an invited-only one
```

The same `Threads` JSON, unauthenticated: no `viewer`, `canResolve` or `mine`, and
the same bytes for every reader. It is what an agent can fetch without a credential for a public
document. It counts no view, is `Cache-Control: no-store`, `Content-Type:
application/json`, carries the full serving header policy, and never sets a cookie
on the apex.

- On the apex only a public document answers. An invited-only one is `404` JSON,
  never the redirect to `/open` a page request gets, since a script cannot follow a
  sign-in. Without reader sign-in on the server, the apex answers `404` too.
- On a publisher's origin the grant cookie is required, and the label, deleted,
  public and `canRead` chain is the page's own. `?grant=` is never swapped here. No
  cookie or an unreadable document is `404` JSON.
- An unknown id, comments off, comments unavailable, a malformed `v` and a version
  that does not exist are `404`; a deleted document is `410`, decided before the
  version so `?v=` cannot tell a deleted document from one that never had it.

### The embed API (not part of the client contract)

The remainder is for a browser frame, documented because it is on the wire. No
page draws such a frame yet; see [What is not built](comments.md#what-is-not-built).

**The embed JSON.** The same operations under the Share popover's token:

```http
GET    /embed/api/docs/{docId}/threads?state=&since=&v=      the token is optional
POST   /embed/api/docs/{docId}/threads
POST   /embed/api/docs/{docId}/threads/{threadId}/comments | resolve | reopen
DELETE /embed/api/docs/{docId}/comments/{commentId}
PUT    /embed/api/docs/{docId}/settings                      the comments switch
PUT    /embed/api/account                                    the display name
```

They run the same functions as `/api/v1`, so every status, the plan gate, the caps,
the rate limit and the emails are identical; the difference is that the author is
**a person** (`kind: "human"`, named by their display name, subject to
`name_required`), where `/api/v1` writes agents. The token (`oas_…`) must name the
route's document: one minted for another document is `401 unauthorized`, as is a
missing, expired or malformed one on a route that needs it. `PUT /embed/api/account`
takes a token for any document, since the name is about the person. A `GET …/threads`
with no `Authorization` header is the anonymous reader: the same answer as the
serving origin, `404` for a document only an invited person can read. A token that
is present but wrong is `401`, never quietly anonymous. There is no CORS and no
cookie.

The Share popover's `PUT …/access/people/{email}` also takes `{"role": "view" |
"comment"}` (as `PUT /api/v1/docs/{docId}/access/people/{email}` does), and its
owner view carries `"comments": true | false`, left out where `COMMENTS` is unbound.

### Old clients

Copilot and CLI releases that predate comments never call these routes and are
unaffected. A client that does, against a server that predates them, gets
`404 not_found` on `…/threads` and `…/settings`, which it should read as "this
server does not support comments". `PUT /api/v1/account` on such a server answers
`404 not_found` to an account token but `401 unauthorized` to a license key,
because that server's account routes take account tokens only. A license-key
client should therefore decide whether comments are supported from the
`…/threads` or `…/settings` `404`, never from that one status, and should not
treat the `401` as a revoked key. (On a current server an unlinked license key
also gets `404` there, so that status alone does not prove the server lacks
comments.)

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
| `bad_request` | 400 | Malformed JSON, `html` missing, empty or not a string, non-string `title`, junk `limit` or `cursor`. On the access routes also an invalid email, mode or role, or a 101st person. |
| `unauthorized` | 401 | No `Authorization: Bearer` header, the license server rejected the key, or — on `POST` and `PUT` only — the key's plan is not entitled to publish. Carries `WWW-Authenticate: Bearer`. |
| `not_found` | 404 | No such doc, not yours, already deleted, or no route. |
| `gone` | 410 | Every request to the retired `api.symposium.md` host. The canonical API does not emit this code. |
| `too_large` | 413 | `html` over 10MB. |
| `quota_exceeded` | 429 | License-key publishing ceiling, device-flow rate limit, or the daily invite cap reached. |
| `limit_reached` | 402 | Account-token publish would exceed a plan limit. Carries the exceeded limit's identifier (`limit`), current plan name (`plan`), and optional `upgrade_url` inside `error`. Also returned, for license keys as well as account tokens, for a private-sharing operation the plan does not include (`limit: "privateSharing"`). |
| `anchor_not_found` | 400 | A new comment's quote is not in the version it names. See [Comments](#comments). |
| `comments_off` | 409 | A caller who manages the document used a comment route while comments are off. Everyone else gets `404`. |
| `name_required` | 409 | A person (not an agent) with no display name tried to write a comment. |
| `internal` | 500 | Our fault, including the license server being unreachable for a key we have never seen. |
| `authorization_pending` | 400 | `POST /device/token`: nobody has approved the code yet. |
| `slow_down` | 400 | `POST /device/token`: polled faster than the `interval`. Also `POST /embed/token`, over its per-address limit. |
| `expired_token` | 400 | `POST /device/token`: the code expired, was collected, or was never issued. |
| `access_denied` | 400 | `POST /device/token`: someone pressed Deny on the approval page. |

The last four appear on `POST /device/token`, and `slow_down` also on
`POST /embed/token` (the Share popover's claim, not a client surface) when the
per-address limit is hit; they appear nowhere else. They are RFC 8628 §3.5's
names, carried in this envelope so a client parses one error shape.

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
  That holds on every route that names a document, not only `/api/v1`: `/open`,
  `/share`, `/embed/api` and a publisher's own origin all answer an unavailable `404` (or a
  redirect to the page that does) for a document the caller may not see, and the
  request route answers the same **Request sent** page for every id, so all of
  them are indistinguishable from a document that never existed.

## Account plans

Worker var `PLAN_LIMITS` is a JSON string mapping plan names to positive integer
ceilings, plus the optional boolean `privateSharing` (the plan may make documents
invited-only and add people to them; absent means it may not). HTML is measured in UTF-8 bytes and cannot exceed the 10 MiB safety bound:

```json
{"free":{"documents":3,"pushesPerDay":6,"htmlBytes":1048576},"pro":{"documents":500,"pushesPerDay":100,"htmlBytes":10485760}}
```

`DEFAULT_PLAN` (default `free`) selects the plan for newly created accounts.
Apply `0005_account_plans.sql` before deploying this version, following the
[migration procedure](deploying.md#later-deploys-happen-in-ci). Existing accounts become
`free`; their tokens and documents remain valid. Unknown plans or malformed
configuration fail closed for publishing, but do not block listing or unsharing.
Absent or blank `PLAN_LIMITS` uses the built-in map with one `free` entry:
3 documents, 6 pushes/day and 1 MiB HTML. `PLAN_LIMITS` replaces that map.

### Change an account's plan

`PUT /admin/v1/accounts/{owner}/plan` on the API host accepts `{"plan":"pro"}`
and returns `200 {"owner":"…","plan":"pro"}`. Authorize with
`Authorization: Bearer <ADMIN_API_KEY>`, a separate Worker secret held only by
your billing service. Use a long, cryptographically random secret (at least 32
random bytes); this route has no application-level rate limiter. Publisher
tokens and license keys cannot administer plans.
No configured secret disables the route (`404`); incorrect credentials return
`401`, an unknown plan `400`, and a missing account `404`. Retrying the same
change is safe. Every account token sees the new plan on its next request.

Optional `UPGRADE_URL` adds a generic absolute HTTP(S) account-page link to
plan-limit errors. It carries no account identity. The account page requires a
fresh `openartifacts account --open` handoff before any authenticated action. No billing or admin secret belongs
in a CLI, skill, public link, or this repository.

## Quotas

Publishing limits follow the authenticated account, not the token, key, agent,
or device. Explicitly linked license-key and account-token owners share their
collection and usage; linking does not grant a second allowance.

| Limit | Hosted free account | Hosted paid account / paid license |
| --- | --- | --- |
| HTML per doc | 1 MiB | 10 MiB |
| Pushes per UTC day | 6 | 100 |
| Live docs held | 3 | 500 |

Account plan refusals use `402 limit_reached`. License-key refusals are unchanged:
`413 too_large` for HTML size, `429 quota_exceeded` for document/daily limits.
The absolute 10 MiB HTML ceiling and the bounded request reader remain safety
limits on every plan; exceeding those returns `413 too_large`.

Two credentials on one account share one daily allowance and one document
ceiling rather than getting two. The document ceiling never resets with time.

Both `POST` and `PUT` spend one push. A rejected push spends nothing: a `413`,
a `400`, or a `PUT` at a doc you do not own leaves the day's allowance intact.
Unsharing a doc frees a document slot. Updating an existing doc uses a daily
push but no new document slot. Accounts already above their document ceiling
keep their existing documents and can update, list, and unshare them; they
cannot create another until they are below the ceiling. Updates must still fit
the active daily and byte limits. Downgrades do not remove existing content,
including documents larger than the new plan permits uploading.

`limit` identifies which limit was hit (`documents`, `pushesPerDay`, or
`htmlBytes` today); `plan` names the account's current plan.
These are values, not fixed enums: clients must accept unfamiliar strings and
must not treat either field as proof of paid entitlement.

For example, the current account-token document-cap response is:

```json
{"error":{"code":"limit_reached","message":"...","limit":"documents","plan":"free"}}
```

Waiting until tomorrow only resets daily pushes, not document capacity.
Signing in on another machine resets neither. The CLI displays the refusal
and account link when present. Run `openartifacts account --open` to manage
hosted access.

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

1. First share of a note: `POST /api/v1/docs`, or `POST /api/v1/private-docs` to
   make it invited-only from its first moment. The server mints the `docId`.
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
# → {"docId":"9f2k…","url":"https://openartifacts.site/d/9f2k…","version":1,"linkAccess":"anyone"}

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

## Account status and trusted browser actions

These additive routes are served on the API host. They use no browser cookies.
`GET /api/v1/account` requires a live OAuth-issued bearer token. License keys
cannot access it. It returns `200` with `cache-control: no-store`:

```json
{"accountId":"oa_…","plan":"free","limits":{"documents":3,"pushesPerDay":6,"htmlBytes":1048576},"usage":{"documents":1,"pushesToday":2},"externalLinked":false,"refresh":{"status":"refreshed","checkedAt":1800000000000,"expiresAt":null}}
```

Limits reflect the deployment configuration. Usage counts live documents and
UTC-day reservations across linked owners, including uploads still pending.
The external identity and email are not included in this publisher response.

`POST /api/v1/account/handoffs` requires the same token and opens a generic
account action. It needs no request body; identity comes only from the token.
It returns `200` with `{"url":"https://trusted.example/actions?code=…","expiresAt":1800000600000}`
and `cache-control: no-store`. The timestamp is epoch milliseconds. The URL is
configured by `ACCOUNT_ACTION_URL`; it must be absolute HTTPS without credentials
or a fragment. HTTP is allowed only for localhost, 127.0.0.1, or [::1]. An absent
configuration returns `404` without creating a code; invalid configuration fails
closed with `500`. Do not send the publisher token to this URL.

Codes contain 256 random bits, expire after ten minutes, and are stored only as
hashes. At most five actions may remain outstanding per account; the sixth
returns `429 quota_exceeded`. Minting clears that account's expired entries.
Revoking the originating machine token also invalidates its unconsumed codes.
There are no action-purpose fields. Account routes reject license credentials with `401`.

### Trusted service endpoints

These routes require `Authorization: Bearer <ADMIN_API_KEY>`, never a publisher
credential. They return `404` if the service API is unconfigured and `401` for an
incorrect credential. Successful responses use `cache-control: no-store`.

`POST /admin/v1/handoffs/consume` accepts exactly `{"code":"…"}`. It atomically
consumes a live code once and returns:

```json
{"accountId":"oa_…","email":"user@example.test","externalOwner":null}
```

`externalOwner` is the linked identity or null. The service must consume only after
an explicit browser POST and preserve this server-verified account identity through
its confirmation flow; email is informational, never account proof. Replayed,
expired, unknown, or originating-token-revoked codes all return `404 not_found`.
Malformed codes or extra body fields return `400`. A failed authorization does
not consume the code. Never log codes, include them in analytics, or forward
these action URLs to third-party resources. The trusted page should remove the
code from its browser URL after exchange and require explicit confirmation for
consequential actions; a GET of that page must not itself link an account.

`PUT /admin/v1/accounts/{accountId}/external-owner` accepts exactly
`{"externalOwner":"…"}`. The trusted caller must freshly prove the external
identity and obtain the account holder's confirmation before calling this route;
a license outage cache or matching email does not prove ownership. Success and
an identical retry return `200` with `{"accountId":"oa_…","externalOwner":"…"}`.
A conflicting association returns `409 conflict`; invalid identities return
`400`; a missing local account returns `404`. Associations are permanent and do
not change plans, credential permissions, document IDs, or stored versions.

### Pulled account entitlement

OAuth identity remains local. On publishing, an hour-old plan cache or an expired
paid snapshot triggers a read-only entitlement pull. `GET /api/v1/account` always
tries to refresh; listing, withdrawal and token administration never call the
entitlement service. A new account starts with a fresh default-plan cache, so its
first free publication needs no remote call.

The Worker POSTs `{"json":{"accountId":"oa_…","externalOwner":"…"}}` to
`${LICENSE_API_URL}/api/trpc/license.openArtifactsEntitlement`, authenticating with
its existing server `LICENSE_API_KEY`. `externalOwner` is omitted when unlinked;
no user token, license key, email or document content is sent. The superjson result
`result.data.json` is `{plan:"default"|"plus",expiresAt:number|null}`. Timestamps
are Unix milliseconds. `default` maps to `DEFAULT_PLAN`, `plus` to configured `pro`.
No automatic retry is made; the request times out after eight seconds.

`plan_checked_at` records fetch-start time, independently of `plan_expires_at`.
Only a newer fetch may replace the cached plan, and the association must still
match the one observed before that fetch. Losing or failed requests reread the
winning stored state. Linking clears freshness; manual `{plan}` assignments reset
expiry and advance freshness to prevent an older pending response overwriting them.
Neither operation changes document ownership, usage, or tokens.

Failed refreshes preserve the last snapshot only until its paid expiry, then the
local default plan applies. Free publishing, listing and withdrawal remain usable.
A lifetime snapshot has no expiry: during a prolonged outage it remains paid until
a successful refresh. Refunds or cancellations may therefore lag by the one-hour
TTL, or longer during an outage. Account output includes
`refresh:{status:"refreshed"|"cached"|"unavailable",checkedAt:number|null,expiresAt:number|null}`;
`cached` can mean a concurrent refresh or manual assignment won. An unavailable
refresh is never represented as proof of a completed upgrade.

Self-hosts without the entitlement service retain configured local plans and
manual assignment. Missing or invalid paid-plan configuration never grants access.
Apply `0008_plan_cache.sql` before deploying this code; the previous unshipped
revision migration is replaced, not upgraded in place.


### Explicit retained-content allowance

The trusted entitlement response may additionally include
`storageAllowance: "lifetime_5gib"` with `plan: "plus"`. Only this explicit
signal maps to configured `pro_lifetime`; absent/null retains the previous
mapping. A plain `pro` plan or null expiry never implies a storage allowance.
The resolved plan follows the same cache, outage and newer-refresh rules above.
`pro_lifetime` has 500 documents, 100 daily pushes, 10 MiB per upload and
5,368,709,120 bytes across retained HTML versions and outstanding writes, and
includes private sharing like `pro`.

Account responses add `usage.storedBytes`; capped plans add `limits.storageBytes`.
The CLI's `account` command prints these when supplied and remains compatible
with servers that omit them. Older CLIs can still publish, read, list and unshare;
they may omit the new figures from their account display.

Exceeding this allowance returns the existing `402 limit_reached` response with
`limit: "storageBytes"` and cleanup guidance. The exact limit is allowed. All
versions and concurrent uploads share the linked-owner allowance. Existing
content remains readable/listable, and `unshare` still withdraws a document.
Only confirmed object removal releases its bytes. See
[storage accounting and recovery](storage-allowance.md) before activation.
