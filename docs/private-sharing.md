# Private sharing and reader identity

**Status: built.** A document's owner can make it "Only those invited" and add
people by email. Someone who is not on the list can sign in, ask the owner to let
them in, and the owner approves or declines. This file is how it works and why it
has this shape; the endpoints are in [http-api.md](http-api.md), and the one-time
setup is in [deploying.md](deploying.md#private-sharing).

[← README](../README.md) · [Serving domain](serving-domain.md) · [Identity](identity.md) · [Comments](comments.md) · [HTTP API](http-api.md)

## What a person sees

Example: Logan shares a client report with Alice (`alice@acme.com`). Bob
(`bob@other.com`) gets the link forwarded and was not invited. Every page here is
on the API host except the document itself.

| Who opens the link | What they see |
| --- | --- |
| Logan, from Copilot's **Open** | The page, with no sign-in |
| Anyone not signed in, invited or not | **Sign in or create an account to open this document**: Google, GitHub or an emailed code, whichever this server has |
| Signed in, and on the list (or the owner's own account) | The page, on the publisher's own origin |
| Signed in, and not on the list | **This document isn't available to {email}**, with **Request access** and **Use another account**. No title, no content. |
| After pressing **Request access** | **Request sent.** The owner approves or declines; approval sends the invite email. |
| Anyone, after the owner switches the page to **Anyone with the link** | The page, with no sign-in, as before |
| Anyone, after the owner unshares it | `410 Gone`, as before |
| Anyone, on any page, pressing **Share** in the top bar | A popover: **Copy link** and **Sign in to manage**. The owner who signs in there manages the page in place; any other reader sees **Copy link** and who can change access. |

The first screen names nobody, because a stranger holding a forwarded link is
almost never signed in and nobody knows yet who they are. A chat app's link
preview sees only that screen. The "not available to {email}" page comes after
sign-in, when there is an address to name, and it exists to answer one question:
which account did I just use? It is the same page for an id that was never
invited, one the owner removed, one that was deleted and one that never existed,
so it cannot tell a private document from no document.

Alice opens the link, signs in once with the address Logan invited, and reads;
the next 30 days of opens are a few redirects with no prompt. Bob signs in, sees
that the document is not available to him, presses **Request access**, and sees
**Request sent**. Logan gets an email with a **Review request** link to the share
page (below), where **Approve** adds Bob exactly as typing his address would,
so Bob gets the ordinary invite email. **Decline** removes the request and tells
Bob nothing. Removing Alice takes effect on her next request. Switching back to
**Anyone with the link** makes the same url public for everyone, with no sign-in.

**Public documents did not change.** `link_access` is `anyone` for every document
made through `POST /api/v1/docs`, old and new, and the public path serves the same
url, headers, caching and bytes it always did, with no sign-in and no cookie. The
one addition to a public page is the top bar with its **Share** button, described
below.

**The CLI's default for a new page is private (2026-10-15).** For the CLI and its
skill, a new page now starts private; the server and the HTTP contract are
untouched, and Copilot is not changed by this. A page that was ever public may
already have been copied by whoever saw it, and switching it private later cannot
recall those copies. `--public` is the explicit public route and `--private` never
falls back to public; the CLI's package README has the flags and the fallback. The
skill reads `limits.privateSharing` from `openartifacts account` and never offers
private to a plan without it. The owner of a private page opens it with
`openartifacts open <docId>`, which uses `POST …/open`.

## The constraint everything else follows from

`openartifacts.site` runs every publisher's scripts on purpose, with an open
`connect-src`. `src/serve.ts` justifies that policy by what the origin holds:
nothing to steal. A reader session on that origin would falsify it, because any
document a reader opens could use it with a same-origin `fetch` to read every
private document that reader can reach. `HttpOnly` stops a script reading a
cookie, not using it.

A grant alone does not fix a shared origin either. A hostile public document can
`window.open` a private one, wait for the popup to return from sign-in, and read
the grant out of `popup.location`, because both pages are on one origin.

So the rule that replaces "the origin is cookieless" is: **no origin that runs
more than one publisher's scripts ever holds a credential.** The only fix left is
to keep private documents off any origin where another publisher's scripts run.
Isolation per publisher is enough: a publisher's own scripts can reach only
documents that publisher already owns.

## Three hosts, one rule

| Host | Serves | Credential it holds |
| --- | --- | --- |
| `openartifacts.site` | Public documents, unchanged. A redirect for invited-only ones. | None, ever |
| `api.openartifacts.ai` | The bearer API, reader sign-in, `/open/{docId}`, `/open/{docId}/request`, the share page, the top bar's script and the Share popover (`/embed/*`) | The reader session cookie |
| `{label}.openartifacts.site` | One publisher's invited-only documents, every version of each. Later, the publisher's custom domain takes this seat. | That publisher's read-only grant cookie |

`label` is the first 16 bytes of `SHA-256("openartifacts-origin-v1:" + docs.owner)`
in lowercase Crockford base32: 26 characters, derived from the owner id the
serving path already reads, and never stored. It is one-way, so the hostname in
DNS and TLS SNI reveals neither the owner nor the document.

- **`docs.owner` never changes**, not even when a license key is later linked to
  an account (`owner_links` joins scopes and rewrites no row), so a document's
  origin is stable for life. A linked publisher whose documents sit under two
  owner ids has two label hosts, which costs them one extra sign-in redirect and
  nothing else.
- **The label comes from the document's owner, never from the caller.** `/open`
  and the owner route read `docs.owner` from the document's own row. A label
  derived from the reader's account or the caller's key would send a linked
  publisher to a host that answers `404`.
- **A label host answers `404` for any document whose owner does not hash to its
  label**, before it reveals anything else about the document, so a host never
  serves, or even confirms, another publisher's document. The same rule, "this
  host serves this publisher's documents only", is what a custom hostname will
  enforce through a verified host-to-owner mapping.
- **Why per publisher and not per document.** The threat is another publisher's
  script, and a publisher origin runs only one publisher's scripts. Per-document
  origins would protect a publisher from their own documents, which they can
  already read, at three costs: a reader invited to several of one person's
  documents would be sent through sign-in redirects for each, a publisher's
  interactive documents could never share storage, and a custom domain would need
  a wildcard custom hostname per document, which Cloudflare sells only on
  Enterprise. One origin per publisher is one ordinary custom hostname, which
  every plan has.

```
reader  → openartifacts.site/d/{docId}        302, no-store → api.openartifacts.ai/open/{docId}
reader  → api.openartifacts.ai/open/{docId}   session? canRead?
                                              302 → {label}.openartifacts.site/d/{docId}?grant=…   (valid 60 s)
reader  → {label}.openartifacts.site/d/…?grant=…   303 + Set-Cookie (1 h), to the clean url
reader  → {label}.openartifacts.site/d/{docId}     200, private, no-store
```

### What each host does, in order

**`openartifacts.site/d/{docId}[/v{n}]`.** The one D1 read the serving path
always made also returns `link_access`. Unknown ids are `404` and deleted ones
`410`, as ever. For `anyone` the existing path runs unchanged. For `invited` the
answer is `302`, `Cache-Control: no-store`, to `https://{API_HOST}/open/{docId}[/v{n}]`
with the full serving header policy, no body, no cookie and no view event. A
pinned `/v{n}` that does not exist reads the same as one that does.

**`api.openartifacts.ai/open/{docId}[/v{n}]`** (`GET` only):

1. No valid session: the sign-in page, which names no address, and returns to
   this path afterwards.
2. A session, and the document is live and now `anyone`: `302` to the canonical
   public url.
3. A session, and `canRead` says allowed: `302` to
   `https://{label}.{SERVING_HOST}/d/{docId}[/v{n}]?grant=…`, the label being
   that of the document's own owner.
4. Anything else (not on the list, removed, deleted, never existed): `404` with
   **This document isn't available to {email}**, **Request access** and **Use
   another account**. The not-available page exists only here and on the share
   page, so there is exactly one copy of the **Request access** form, and it
   posts with the session cookie.

**`{label}.openartifacts.site/d/{docId}[/v{n}]`** (`GET` and `HEAD`; anything else
is `404`):

1. A `?grant=` that verifies for this label sets `__Host-oa_grant` and answers a
   bodiless `303` to the same path without the query. This step reads no
   database. A grant that is bad, expired or for another label answers `302` to
   `https://{API_HOST}/open/{docId}[/v{n}]`.
2. No cookie, or an invalid or expired one: the same `302` to `/open`, again with
   no database read.
3. A valid cookie: one D1 read returns the document, its owner, and whether the
   cookie's principal passes `canRead`. Then, in this order: unknown id is `404`;
   an owner that does not hash to this label is `404`; deleted is `410`; `anyone`
   is `302` to the public url; not allowed is `302` to `/open`; an allowed
   document with no version is `404`; otherwise `200`.

A label host never renders the not-available page: it must post with the session
cookie, which this origin can never hold. No loop is possible, because `/open`
redirects to a label host only when `canRead` says allowed, the same predicate
this host applies. A reader with a cookie for this origin who opens a second
document from the same publisher gets it in one request if invited, with no
redirect.

Allowed responses go through the existing `serveObject` and `renderServedHtml`
with the same CSP and robots headers as every served document, plus
`Cache-Control: private, no-store` (pinned versions included),
`Cross-Origin-Opener-Policy: same-origin-allow-popups` and
`Cross-Origin-Resource-Policy: same-origin`. The two isolation headers are set on
every response from a label host, errors and redirects included, and a `500`
carries them too.

### The three lifetimes

| | Lifetime | Holds |
| --- | --- | --- |
| Reader session `__Host-oa_session`, on the API host | 30 days | An account id |
| URL grant `?grant=` | 60 seconds | A publisher's origin label and a principal |
| Origin cookie `__Host-oa_grant`, on that publisher's origin | 1 hour | The same grant, re-signed |

All three are `HttpOnly; Secure; SameSite=Lax; Path=/` with no `Domain`, so each
is a `__Host-` cookie (the URL grant is not a cookie). The grant names the
origin, not a document: it is refused on any other label host, and **every
document is checked against `canRead` in D1 again on every request**, which is
why removing a person takes effect on their next request. Sign-out clears the
session at once; a publisher origin's grant cookie can outlive it by up to an
hour, still subject to the live check.

Each value is an HMAC-SHA256 over a short JSON payload with an expiry, keyed by
`READER_SESSION_SECRET`, and **the purpose is part of the signed input**
(`session`, `grant-url`, `grant-cookie`, `login`, `signup`, `email-code`,
`share-token`, `embed-signin`), so a
value minted for one use fails every other: a URL grant cannot be planted as a
cookie, and a session cannot be presented as a grant (`src/session.ts`).
Rotating the secret signs every reader out.

The Share popover adds three shorter-lived values of its own, described under
"The top bar and the Share popover": the popover token `oas_…` (24 hours, purpose
`share-token`), the binding cookie `__Host-oa_embed_{16 hex}` (ten minutes,
purpose `embed-signin`) and the handoff row (one minute, one use).

### Why a publisher's script cannot steal access

- A hostile document can start a grant by navigating to `/open/{target}`, since a
  top-level navigation is the only request that carries the `Lax` session cookie.
  The grant lands on the target's own origin, which the attacker cannot script,
  and `Cross-Origin-Opener-Policy` cuts the attacker's window reference: the
  API-host pages and redirects carry `same-origin`, so the reference is cut
  whichever way /open decides and an opener cannot tell allowed from refused;
  the label host carries `same-origin-allow-popups`.
- A publisher's scripts reach only that publisher's documents: they never see the
  URL grant (the label host answers it with a bodiless `303`), and the cookie they
  can make same-origin requests with opens only documents their publisher
  already owns, and only the ones this reader is invited to. A publisher who
  steals a grant from their own origin gains nothing: it reads their own
  documents and is refused everywhere else.
- Other origins carry no session cookie on `fetch`, frames or subresources, and
  CORS and `Cross-Origin-Resource-Policy: same-origin` stop them reading a label
  host's response.

The URL grant also never stays in the address bar. A grant left there would be a
live credential readers paste to people who were not invited, so the origin swaps
it for a cookie and redirects to the clean url; the redirect and every page
on a publisher's origin carry `Referrer-Policy: no-referrer`.

## Who may read, and who may manage

The unit is the document. Migration `0014` adds `docs.link_access` (`anyone` or
`invited`), `doc_invites (doc_id, email, role)`, `invite_sends (owner,
created_at)`, `doc_access_requests (doc_id, email)`, `email_codes` and `embed_handoffs`. The invite list is independent of the mode: switching
to `anyone` keeps it and the pending requests, and switching back restores them.
At most 100 people and at most 100 pending requests per document, so neither
list needs paging. An owner may also add at most 100 new invites in a rolling 24
hours, across all their documents and credentials (a linked license key and its
account share one allowance). It is counted from `invite_sends`, a table of one
`(owner, created_at)` row per invite ever added, written in the same D1 batch as the
`doc_invites` row: the cap check and both inserts are one transaction, so concurrent
adds cannot race past it and a refused or failed add records nothing. Removal and
unshare never touch `invite_sends`, so the cap bounds sends and not the list, and
looping add and remove frees nothing. Each add prunes that owner's rows older than
24 hours, so the table stays small. Repeats and role changes never count; past
the cap an add answers `429 quota_exceeded` and a pending request stays where
it is. Unshare deletes the
invites and requests with the bytes and keeps the `docs` row for the `410`.

Two predicates, named once, so every surface asks the same question. They live in
`src/db.ts` as SQL fragments (`CAN_READ_SQL`, `CAN_MANAGE_SQL`):

- **`canRead(principal, doc)`**: the document is `anyone`; or the principal is in
  the document's owner scope (`OWNER_SCOPE_SQL`, so a license key and its linked
  account are one owner); or the principal is an account whose email is on the
  invite list. The principal is a reader's account id, or a publisher's owner id
  from the owner route. `/open`, a publisher's origin and the owner route all ask
  it, through `findReadableDoc`. If any of them used a different rule, a reader
  could be sent from one to the other forever.
- **`canManage(principal, doc)`**: the principal is in the owner scope. Access
  changes, the share page, turning comments on, and resolving any thread.

**Every surface answers "not `canRead`" as `404`, never `403`**, and the label
hosts, `/open`, `/share` and the request route all keep the convention that a
document you may not see is indistinguishable from one that never existed.

`canComment` is built (`src/comments/access.ts`): `canRead`, and comments are on
for the document, and the owner's plan has them, and the principal is the owner or
an invited account whose `role` is `comment` (on an `anyone` document, any
signed-in reader, as [comments.md](comments.md) has it). `doc_invites.role` is
`view` or `comment`, defaulting to `comment`; a `view` invitee reads the threads
and cannot write. Both the popover and the share page set it per person.
There is no edit role or manage role: the owner alone updates a document, through
the push route.

When spaces arrive, they add `spaces`, `space_invites` and a nullable
`docs.space_id`, and `canRead` gains "or invited to the document's space". No
existing row moves.

## Reader identity

A reader is an `accounts` row, the same principal a publisher is. There is no
`readers` table.

- **Google and GitHub** reuse the device-code handshake: a `device_codes` row with
  a `reader_` prefix, the shared `/approve/callback/{provider}` (so no new OAuth
  registration), `holdProvenIdentity`, and the Terms page for a first-time
  account, which creates a free account on `DEFAULT_PLAN`. The OAuth `state` is
  also bound to the starting browser by a short-lived signed `__Host-oa_login`
  cookie, cleared when the callback ends the handshake, so a callback link
  forwarded to somebody else does not sign them in.
- **Emailed codes:** six digits, ten minutes, five wrong guesses, stored as a keyed
  hash (an unkeyed one would be recovered instantly from a table of a million
  codes), rate-limited per address and per client. The same page follows for any
  well-formed address, because until the code comes back nothing has proved the
  person typing holds the mailbox. A matching code is then decided three ways: an
  address whose account already signs in with Google or GitHub is refused with
  "That address signs in with Google or GitHub. Use that instead." (the code is
  spent), which keeps [identity.md](identity.md)'s recycled-mailbox refusal true
  for every provider-backed account; an account with no provider (one created by
  Copilot linking, or by a code) is signed in; an address with no account goes to
  the Terms, carrying a signed ten-minute token for the proved address, and
  accepting them creates the free account and signs it in. A request for a new
  code keeps the count of wrong guesses, and a code that has used them all cannot
  be replaced until it expires. There is no newsletter choice for a reader.
- **The session** is `__Host-oa_session` on the API host (`HttpOnly`, `Secure`,
  `SameSite=Lax`, `Path=/`, 30 days): an HMAC over `{accountId, expiresAt}`.
  Stateless, and sign-out (**Use another account**) clears it. Only `/open`,
  `/open/{docId}/request`, `/share/{docId}`, `/signin` and the Share popover's
  popup, `/embed/sign-in`, read it, and `/api/v1` stays bearer-only, so the cookie
  adds no cross-site request surface to the API.
- **Every cookie-authenticated `POST` is held to a same-origin check**
  (`sameOriginPost`). `SameSite=Lax` alone is not enough: every host under the brand
  domain is same-site with the API host, and Lax cookies ride same-site `POST`s.
  The request route and every share-page write require `Sec-Fetch-Site:
  same-origin` (or, from a browser that sends none, an `Origin` equal to the API
  origin); the sign-in forms also accept `none`. A request carrying neither header
  passes only on a sign-in form, which is how `curl` and the tests post.
- **Owners with a license key never sign in.** `POST /api/v1/docs/{docId}/open`
  returns their own page's url with a 60-second grant whose principal is their
  owner id. Clients open it and discard it; publish receipts never carry a grant.
- **The sign-in pages return only to `/open/{docId}[/v{n}]`, `/share/{docId}` or
  the Share popover's popup, `/embed/sign-in?doc=…&h=…`**, rebuilt from the parsed
  document id (and hash), so they cannot become an open redirect.

## Credentials by capability

- The **origin grant cookie reads**: documents, and the threads JSON, on its
  own origin. It is refused by `/api/v1`, by every sign-in page and by the
  comments frame. A document's script can use it; that is why it can do nothing
  but read what its own publisher already holds.
- The **API-host session signs in and mints**: the origin grant, the owner route
  and the Share popover's token; the comments frame reuses that token, with
  no second provider sign-in.
- The **popover token writes, for one document**. It lives in the Share frame's own
  storage on the API host, never on a document's origin, and it is a bearer header
  on the frame's same-origin `fetch`. For that document it can change access, read
  the title, and post, resolve, reopen and delete comments and flip the comments
  switch, as each route's own checks allow. It can also set the account's display
  name (`PUT /embed/api/account`), which is account-wide, so a token for any
  document serves. It cannot publish, list, delete or touch another document. `/api/v1` refuses its `oas_` prefix, the share page, `/open` and
  `/signin` read only the session cookie, and a label host reads only the grant
  cookie.
- **Writes never ride a cookie a document can use.** Approving, declining and
  changing access carry a credential that lives on an origin no publisher's
  scripts run on: a bearer token, or the session on the API host.

## Creating a private document

`POST /api/v1/private-docs` is the same create as `POST /api/v1/docs` (one shared
code path) with `link_access = 'invited'` in the same insert, so the document is
never public, not even for a moment. Its receipt is `{docId, url, version,
linkAccess: "invited"}`. It is a route and not a field on `POST /api/v1/docs`
because an old or self-hosted server ignores unknown fields: a client that
learned the problem from the receipt would already have made a public page and
would then depend on a delete that might not run. A route a server does not have
creates nothing, so it answers `404 not_found`, and the client reports "this
server does not support private documents" and stops. **There is no receipt
check and no withdraw**; a server that has the route and still ignores it is a
server bug, not a compatibility case.

## Request access

A request is tied to a signed-in account, not to a typed address. Taking an
address on an accountless form would let anyone put any address on anyone's list
and make OpenArtifacts email owners on behalf of people who proved nothing. With
the account, the address is already verified, approval is the add that already
exists, and the invite email that add sends is the notice to the requester.

- **Table:** `doc_access_requests (doc_id, email, created_at)`, one pending row
  per document and address, capped at 100 per document. Past the cap a new request
  is dropped silently.
- **Route:** `POST /open/{docId}/request`, on the API host, session required (no
  session shows the sign-in page), same-origin required. One statement inserts
  the row only when the document is live and invited-only, the account cannot
  already read it, no request is pending and the list is under the cap.
- **It says nothing.** The **Request sent** page is the same status and the same
  words for every outcome: stored, repeated, unknown id, deleted, public, already
  allowed, a full list and a rate limit. The owner's email, the one slow step,
  runs after the response is decided. Without an email binding the page says what
  will happen instead ("the link will open for {email}").
- **Rate limit:** per account, by `REQUEST_ACCESS_LIMITER`. Over the limit stores
  nothing and still shows **Request sent**.
- **Approve and decline.** Approving is `PUT …/access/people/{email}` (or **Approve** on
  the share page): one batch inserts the invite and deletes the request, and the
  invite email goes out. It needs the plan, like any add. Declining deletes the
  row, is idempotent, never needs the plan and tells the requester nothing. A
  declined address that asks again is a new row.
- **The owner is emailed on a new row only.** The address is resolved through the
  owner scope: an account owner's own, a license owner's linked account (through
  `owner_links`), nothing for an unlinked license owner, who sees the request in
  Copilot's dialog, in `share` and on the share page. The message is from
  `EMAIL_FROM`, with no reply-to: subject `{requester} asked to open "{title}"`,
  the requester's address, the title, "Nothing has been shared yet.", a **Review
  request** link to `https://{API_HOST}/share/{docId}`, and a line for Copilot
  users. **The link carries no token**, so a forwarded email approves nothing and
  a stale one is harmless, and it is the only link in the message: never a
  requester-chosen url. The requester never learns the owner's address.

## The top bar and the Share popover

Access control belongs on the page itself, where the owner already is: nobody
finds a link in a footer. `renderServedHtml` injects a **top bar** into every
served document, public or private, in place of the header byline, and **Share**
in it opens a popover with the same controls as the share page.

**The bar.** A spacer as the first child of `<body>` (so the author's content
starts below the bar, not under it), one small `<style>` element, a strip fixed to
the top of the viewport, and a `<script defer src="https://{API_HOST}/embed/page.js">`
tag. On the left is the byline's text, "Shared from Copilot for Obsidian", only on
Copilot-rendered HTML that has branding: that text exists only where the header
byline would have, and printing it elsewhere would be false attribution or would
undo a plan that removes it. On the right is **Share**, a plain link to the share
page, so it works with no script. The bar is static HTML with inline styles and
system fonts, and it fetches nothing. **It is the same bytes for every viewer of a
document**: it names no identity, which is what keeps public pages cacheable. The
one stylesheet it adds carries a scroll offset the size of the strip (so an anchor
jump or a focused control does not land under it) and a print rule (so the strip
does not repeat over the top of every printed page). The footer byline is as it
was. The bar is added on the way out and stored nowhere, so the page stays a pure
function of the stored version and the deployment's configuration, and every
document already published picks up the bar, and any later change to it, on its
next rendering (every deploy moves the page's validator).

**Why the owner does not simply see more.** The owner's session lives on the API
host, and a script on the document origin cannot see it: the cookie is
`SameSite=Lax`, and cross-site cookies are blocked in third-party frames by Safari
and Firefox and partitioned in Chrome. A bar that appeared only for owners would
appear for nobody on public pages. So the bar is constant and the popover decides
who is looking.

**The page script.** `GET /embed/page.js` on the API host turns **Share** into a
popover anchored under the button. It is a constant that holds no credential,
reads no cookie and no storage, defines no global and binds only our own link. It
creates the frame on the first click only, so a page view costs no frame request,
then hides and shows it and never reloads it, so a switch made inside the frame
can never re-run its `frame-ancestors` check against the page it is on. The
popover sits in a closed shadow root hanging off `<html>`, out of reach of author
CSS and of a transformed or flex `<body>`. A modified click (a new tab) keeps the
plain link; if the frame does not say it is ready within four seconds (an author
`frame-src` policy, the network) the popover shows a plain link to the share page;
and where the author's own policy blocks the script, **Share** is the link. The
route is a Worker route with a one-hour browser cache and not a Workers Static
Asset: static assets are matched ahead of the Worker on every hostname it is
attached to, which would break the router's fail-closed host allowlist. A page view
still costs no Worker request while the browser's copy is fresh. **The address is
permanent**: pinned `/v{n}` pages are `immutable` for a year and carry the tag, so a
fix to the script reaches them through the cache lifetime and never through a new
path. The serving CSP already admits scripts and frames from `https:`, so it does
not move.

**The frame.** The popover is a frame on the API host, `GET /embed/share?doc={docId}&origin=…`,
because its controls change who can read the document and the credential that does
that must never be on a page whose scripts the author writes.

- **Per-document `frame-ancestors`.** The frame may be embedded only by the
  document's own serving origin: `https://openartifacts.site` for a live public
  document, the publisher's own `https://{label}.openartifacts.site` for a live
  invited-only one, and nobody for an unknown or deleted id. A private document's
  controls can therefore be embedded only by its own publisher's pages, never by
  another publisher's. The request is anonymous and serving pages send
  `no-referrer`, so the server cannot see who embeds it; the page script passes its
  own `origin`, and the policy echoes it only when it equals the document's serving
  origin. Deriving the header from the row alone would put an invited-only
  document's label in a header anyone holding the link can read with `curl -I`,
  tying the document to its publisher's other documents. The browser checks the
  policy against the real ancestor, so a forged `origin` frames nothing. Residual,
  accepted: someone who already knows a label and holds a link can confirm the
  pairing.
- **The frame reveals nothing to non-readers.** Anyone can load it with any id.
  Until a token shows the viewer can read the document, every id looks the same,
  private, public, unknown or deleted: **Copy link** for the canonical url, built
  from the id with no lookup, and **Sign in to manage**. No title, no link-access
  mode, no list. The bodies are equal after replacing the id, except `data-origin`,
  which echoes the caller's own `origin` only when it equals the serving origin
  (what the frame's `postMessage` and `frame-ancestors` need; it tells the caller
  only what it already named). With a token, a non-reader sees what an unknown id
  shows, never `403`.
- **It tells the page around it nothing about its viewer.** It has one fixed
  height (at most 480 px) and scrolls inside it. It posts the page exactly three
  messages: `ready`, once, before it reads its storage; `close`, only after a
  click or key press inside it; and `comments`, only after the owner flips the
  Comments switch inside it, so the page asks for its threads again. That one
  tells the page its visitor is the owner, but only on the owner's own click. Every public page on `openartifacts.site` shares the
  frame's storage partition, and any of them can embed the frame for any id it
  knows; a size report, a focus move or an early message would tell that page, with
  no click, whether its visitor holds a token.
- **Its views** follow the table: the owner gets **Link access**, **Add people**,
  each person with **Remove**, **Requests** with **Approve** and **Decline**, the
  notice after a switch to private, and **Copy link**; any other reader gets **Copy
  link** and "Only the owner can change who can open this."; someone not yet signed
  in gets **Copy link** and **Sign in to manage**. Writes call the same operations
  as `/api/v1` and the share page, so the plan check and the `402` message, both
  invite caps, the invite email and `document_access_changed` are identical on all
  three. Where comments are available it also carries a **Comments** Off/On switch
  under Link access and a **Can view / Can comment** select on each person (the
  owner's view only; see [comments.md](comments.md)).

**Signing in to the popover.** The frame cannot see the reader session, so
**Sign in to manage** opens a top-level popup at `/embed/sign-in?doc={docId}&h=…`,
which does see the cookie. With a session it mints a token for this one document at
once; with none it runs the ordinary sign-in first and returns. Because the page
outside the frame can open any address, the popup must be bound to our frame: it
proceeds only if `Sec-Fetch-Site` is `same-origin` (the navigation was initiated by
an API-host document, which is the frame's `window.open`) or if it carries the
per-handshake cookie (`__Host-oa_embed_…`, ten minutes) that an earlier bound
request set, which is what lets the return leg of a Google or GitHub round trip
through. Otherwise it is refused, even when the owner has a session, so a hostile
page cannot collect a token by opening the popup with a hash it chose. A browser
with no Fetch Metadata falls back to the share page.

**The handoff survives a severed popup.** The sign-in pages send a cross-origin
opener policy, and Google's probably does too, which can cut the popup's link back
to the frame, so a plain `postMessage` may never arrive. Observed on 2026-10-14 with
`curl -D -`: `accounts.google.com/signin/oauth/error` sends `Cross-Origin-Opener-Policy:
same-origin`, enforced; `accounts.google.com/o/oauth2/v2/auth` and
`/v3/signin/identifier` send it as `Cross-Origin-Opener-Policy-Report-Only`; and
`github.com/login` sends none. Our own reader pages send `same-origin`. A navigation
to such a page from a popup whose opener is cross-origin switches browsing-context
group and nulls `window.opener` for good. The browser test shows it needs no provider
at all: the page embedding the frame sends no opener policy and the popup sends
`same-origin`, so Chrome opens the popup in a new group with no opener from the
start. Embedded in a document the frame is therefore always served by the poll, and
the posted token reaches only a frame loaded as a top-level page. So the frame makes a random nonce that
only it knows and passes its hash, `h`, in the popup's URL. The popup stores the
account under that hash on the server, **for one minute and one use**, and **also
posts the token if the opener survives**. The frame collects it with the nonce
itself, `POST /embed/token`, polling every two seconds for at most ten minutes (and
again when its tab becomes visible, for a phone that suspended it behind the popup).
Seeing the popup's URL yields only the hash, which collects nothing; the nonce never
leaves the frame's memory except in the claim, and the claim is rate limited per
client address. The row lives in its own table, `embed_handoffs`, keyed by that hash
(a claim must name the document too), and the next popup to write one sweeps what
was never collected. The token is minted at claim time from the stored account id,
which is equivalent to storing it (it is a stateless signature over the account and the
document), and no bearer value is ever written to D1. The popup's message goes to
its own origin, never `*`, and the frame acts only on a message from the window its
own `window.open` returned, for this document, from this origin: a message from the
embedding page or any other window does nothing.

**The token** is `oas_` and an HMAC under its own purpose, `share-token`, over the
account and the document, valid for 24 hours, kept in the frame's `localStorage`
(with an in-memory copy where storage is blocked). The frame sends it as a bearer
header on same-origin `fetch` with `credentials: "omit"`, and only
`/embed/api/docs/{docId}/…` (the access and comment routes) accepts it, for that document, plus `PUT /embed/api/account` for the display name, checking the
token before the path's document is read. Because the account must still exist and
each call is authorised live, a token carries no more than the account's own
current rights.

**Clickjacking.** A hostile page could try to overlay an invisible popover and
trick the owner into clicking. `frame-ancestors` limits the popover to the
document's own origin. A private document lives on its publisher's origin, which
only that publisher's pages run on, so nobody else can embed its controls. A public
document shares `openartifacts.site` with every public page, so a hostile public
page could embed its popover, but only if the owner's token is already in the
frame's storage, or the owner has been tricked into pressing **Sign in to manage**
in the invisible frame and then completing the popup it opens, which puts the token
there. The worst outcome is making a public page private or adding a name to its list, both visible
in the list the owner sees.

`frame-ancestors` is checked once, when the frame loads, and the frame is never
reloaded, so a hostile public page could keep a frame it embedded while the
document was public after the owner makes the document private. The frame closes
that itself, without reloading (a reload the embedding page could see). Embedded by
the public serving origin, it never draws the full owner view of an invited-only
document: it shows one constant line. The one exception is a frame that made the
switch to invited itself, and that is not proof of anything about the page around
it. A hostile public page can lay the frame invisibly over its own content and
trick the owner into one click on **Only those invited**, and the switch is then
made in the hostile page's frame. So that frame draws only what the owner needs
right after a switch: the mode control, the notice and **Add people**, which needs
typed input. **Approve**, **Decline** and **Remove**, each a single click on a
private document, are left out, with a link to the share page for them. Before every
write on a frame embedded by the public origin the frame also reads the mode
again, so a click on a view drawn while the document was public does nothing once
the document is private, and the read fails closed: a failed, malformed or
non-200 answer stops the write and says nothing was changed. The race left is the
round trip between that read and the write.

## The share page

`https://{API_HOST}/share/{docId}` is the top-level form of the same controls: the
dialog Copilot renders, served by the Worker, so it exists for whoever published the
document and for self-hosters. It is behind the reader session, and it is where
**Share** leads when scripts do not run, where the request email's **Review
request** leads, and the url `share <docId>` prints:

- No session, and a live public document: the reader view below, with **Is this
  your page? Sign in to manage**, which leads to `?signin`. The title and the url are
  all it shows, and anyone holding the link has both.
- No session, otherwise (an invited-only, unknown or deleted id, or `?signin`): the
  sign-in page ("Sign in to manage this document"), returning here. It is the same
  bytes for all three kinds of id, so the page tells a stranger nothing about an id.
- A session whose account is in the document's owner scope (`canManage`): the
  dialog. **Link access** (Anyone with the link / Only those invited), **Add
  people**, **Requests** (only when some are pending, each with **Approve** and
  **Decline**), **Who has access** (**You**, **Owner**, then each invitee with
  **Remove**), **Copy link**, and after a switch from public to private the line
  "People who opened it while it was public may have kept a copy." There is no
  role control.
- A session whose account may read the document but does not manage it: the
  reader view. The title, "Only the owner can change who can open this.", **Copy
  link**, **Use another account**, and a line saying that a page published from
  Copilot is managed from Copilot. That line is for an owner whose license key is
  not linked to a browser account, who looks like any other reader here. It lists no
  people, no mode and no requests. A session whose account has no email row is
  treated as no session.
- Anyone else, and every unknown or deleted id: the same not-available page as
  `/open`, status `404`, never `403`.

Writes are `POST /share/{docId}` with an `op` of `link`, `add`, `remove` or
`decline`, same-origin required, and they call **the same operations as
`/api/v1`** (`src/api/access.ts`) with the session account as the publisher, so
the plan gate, the invite email, idempotency and the `document_access_changed`
event cannot differ between the two. A refused write re-renders the dialog with
the reason, including "Private sharing needs a paid plan." and the upgrade link
(`402`), or the 24-hour invite cap (`429`, "Nothing was changed.");
a successful one redirects (`303`) back to the page. The page is `no-store` with
`frame-ancestors 'none'` and `Referrer-Policy: same-origin` (as on every page of
the API host that holds a form: a form posted from a `no-referrer` page sends
`Origin: null`, which would defeat the `Origin` fallback for browsers without
Fetch Metadata, and `same-origin` still sends no `Referer` anywhere else); its one script, the
Copy button, is allowed by a hash in the page's own policy, and the page works
without it.

## Plans

The plan is checked on write, in the Worker, and only on the operations that spend
it: creating a private document (`POST /api/v1/private-docs`), switching a public
document to invited-only, and adding a person, which includes approving a
request. Removing people, declining a request and switching to `anyone` never
need it, naming the mode a document already has is a repeat that never checks, and
so is adding an address that is already on the list with no role or the role it
already has (`200` with the current `Access` on any plan, no email), and
reading never checks a plan, so invitees never pay. A lapsed plan keeps what
exists: private documents stay private and current invitees keep reading; new
invites and new private documents get `402 limit_reached` with `limit:
"privateSharing"`. A lapse never makes a private document public.

A license-key publisher gets the same code and limit with the message "Your Copilot
plan does not include private sharing." and no `upgrade_url`, because they manage
their plan in Copilot, not with the OpenArtifacts CLI.

Every paid plan includes private sharing. Account plans carry
`"privateSharing": true` in `PLAN_LIMITS` (the hosted `pro` and `pro_lifetime`
plans), and a license key qualifies whenever its plan may publish at all
(`plus`, and `believer`, sold as Supporter), so there is no separate list to keep
in step. A plan that may not publish, an unlisted one, and a lapsed key are
refused.

## Email

Invites, requests to owners and sign-in codes go through the Cloudflare Email
Service `send_email` binding from a dedicated sending subdomain, so abuse cannot
hurt the brand domain's mail reputation. `allowed_sender_addresses` pins what the
Worker may send from. It is optional like the OAuth secrets: without the binding
no email is sent and the code form is not offered, and Google and GitHub still
work.

- **The invite** goes out on the call that adds an address, and an approved
  request sends this same email. It names who shared it when the Worker knows (the
  owner's account email, or the linked account's), the title, the canonical link
  `https://{SERVING_HOST}/d/{docId}`, and "Sign in with this address, {email}, to
  open it." The address is on the list whether or not the email goes out. Invites
  are rate-limited per owner by `INVITE_EMAIL_LIMITER`, and only paid plans can add.
  The limiter only paces email, per colo. The D1 cap of 100 new invites per owner
  per rolling 24 hours counts sends, and removing an invite does not free allowance,
  so the emails an owner can cause are bounded by that cap and then paced by this
  limiter.
- **The request email** is described above. It is rate-limited by the per-account
  request limiter that bounds the rows it comes from.
- **Sign-in codes** are limited by `SIGNIN_EMAIL_LIMITER` per address and
  `SIGNIN_EMAIL_CLIENT_LIMITER` per client.

Links in emails always point at the sacrificial domain or at our own share page,
never at a grant and never at a requester-chosen url. Without an email binding the
`email` field of the access JSON is `false`, the share page says "Invited · send
them the link" instead of "Invited · email sent", and requests are listed without
a notice to the owner.

## Self-hosting

Nothing in the shape changes, and nothing is Brevilabs-specific: the Worker, the
share page, the top bar and the Share popover, the sign-in pages and the email
templates all live in this repo, and plans are configuration.

**One rule: an unconfigured server is an old server.** Reader sign-in is
configured when all of these hold (`readerSignInConfigured`, the one predicate
every gate asks): `READER_SESSION_SECRET` is set and at least 32 characters,
`SERVING_HOST` and `API_HOST` are set, and at least one sign-in method exists:
Google or GitHub (both halves of the OAuth pair) or emailed codes (the `EMAIL`
binding and `EMAIL_FROM`). When it is not, `POST /api/v1/private-docs`, every
`…/access` route, `…/open`, `/open/*`, `/share/*`, `/signin/*` and `/embed/*` answer
`404` exactly as a Worker that predates private sharing does, and served pages
carry no top bar and no page-script tag: the header byline stays as it was. Every client already knows what to do: `publish --private`
reports that the server does not support private documents and creates nothing, and
a plain `publish` publishes a public page instead.
No half-configured state exists. `GET …/html` is not part of the family and keeps
working, and `GET /api/v1/docs` still reports each document's stored `linkAccess`.

Removing the secret from a server that already has invited-only documents takes
them offline and never makes them public: the apex still sends them to `/open`,
which answers `404`.

**One field:** `email` in the access JSON, `true` when the server can send invite
and request emails. A deployment with email but no OAuth app works too: codes are
a complete sign-in method.

**The floor.** Everything here runs on the free Workers plan except email: the
Email Service binding needs Workers Paid and an onboarded sending domain. The
wildcard DNS record and the Worker route are free, and Universal SSL covers the
wildcard when the document host is a zone apex; a document host that is itself a
subdomain needs a paid certificate for `*.docs.example.net`.
[deploying.md](deploying.md#self-hosting) has the steps.

## Revocation and caching

- **Removing a person** takes effect on their next request: 0 seconds, because the
  list is read live. A tab already open keeps what it loaded.
- **Making a public document private** takes effect on the next request. Copies
  fetched while it was public cannot be recalled, including pinned `/v{n}` pages
  a browser may keep for a year. This is the limit [http-api.md](http-api.md)
  already states for unshare, and the share page and the agent both say it.
- **No private bytes reach a shared cache.** Private responses are
  `private, no-store`, pinned versions included, and the redirect on
  `openartifacts.site` is `no-store`. Label hosts are never cache-rule targets:
  the Cache Rule matches the hostname `openartifacts.site` only. When an edge
  cache exists (see [CLAUDE.md](../CLAUDE.md)), "make private" must purge it
  exactly as delete does.
- **Cost:** private reads cannot be cached. A first open costs four Worker
  invocations, three D1 reads and one R2 read; a reload costs one of each.

## What is accepted

- **A publisher's documents share one trust boundary and one browser storage**,
  as the pages of any website do. A third-party script compromised on one of a
  publisher's pages could read the signed-in reader's other documents from that
  same publisher. A page's saved state (`localStorage`, `IndexedDB`) does not
  carry across a switch between public and private, because a private page runs
  on its own origin.
- **The URL grant is not single-use.** Someone who reads one out of a reader's
  browser history within its 60 seconds could open the document as that reader.
  Making it single-use costs a D1 write on every open.
- **Label hosts and the apex are same-site siblings.** `openartifacts.site` is not
  on the Public Suffix List, so `SameSite` does not separate them, and a
  document's script can set a cookie for all of `openartifacts.site`. Isolation
  comes from origin-level controls instead: CORS and `Cross-Origin-Resource-Policy:
  same-origin` keep other origins from reading a label host, `Cross-Origin-Opener-Policy`
  cuts popup references, `frame-ancestors 'none'` stops framing, and the Worker
  reads only its own `__Host-` cookies, so a cookie tossed from the apex can never
  forge a grant.
- **Address variants** (`+tag`, Gmail dots) are not folded; the invited address is
  matched as typed, lowercased. `accounts.email` is the address an account was
  created with, so someone who left `acme.com` and still signs in with the same
  GitHub subject would pass an invite meant for the mailbox's next holder. It needs
  a reassigned mailbox and the link reaching the old holder by another route.
  Reviewed and accepted.
- **An owner whose plan has lapsed** can make a private page public but cannot
  make it private again.
- **A Copilot owner's grant cookie** expires after an hour; "Open" mints a new one.
- **The top bar has limits an author's page can reach.** An author header fixed to
  the very top is covered by the bar; normal-flow content never is. Anchors inside
  an author's own scroll container, rather than the page, still land under the bar,
  and an author `scroll-padding` on `html` replaces ours, as it should.
  The bar is always left-to-right, whatever `direction` the page sets (`all` does
  not reset it), so Share stays at the right edge; a
  transformed `<body>` makes the fixed strip scroll with it; an author script that
  prepends to `<body>` puts its element above our spacer. A collapse control is a
  small addition to the page script if it turns out to matter.
- **After a Google or GitHub round trip, Chrome refuses the done page's
  `window.close()`**, whether or not the page sends an opener policy, so that popup
  stays on "Signed in. You can close this window and go back to the document." The
  frame has already collected its token by then.
- **A person who returns more than a minute after the done page** presses **Sign in
  to manage** again. The handoff row lives one minute, but the session is still
  there, so the second popup completes at once.
- **Two popover sign-ins whose provider steps overlap** fail the earlier one at the
  login binding (`__Host-oa_login` holds one handshake per browser, as for every
  reader sign-in). Pressing **Sign in to manage** again then completes at once from
  the new session. Two that do not overlap are independent, because the popup's
  binding cookie is per handshake.
- **The popover is one fixed height**, so its short views have room to spare; the
  alternative is a frame that reports its size, which would tell any page that can
  embed it whether its visitor manages the document.
- **Browsers with no Fetch Metadata** (Safari before 16.4) cannot sign in to the
  popover and use the share page.
- **A popover token outlives sign-out** by up to 24 hours. It can do only what that
  account may already do to that one document, every call is authorised live, and it
  lives in storage no document's script can read.
- **A waiting frame polls** once every two seconds for at most ten minutes, and
  gives up quietly after that.
- **A Copilot owner whose license key is not linked to a browser account** reaches
  only the reader view, or the none view, in the popover and on the share page,
  which tells them to manage access in Copilot.

## State owed to the manifest

`link_access`, the invite list and the pending requests live only in D1, like the
title and the deleted flag. They belong in the per-document `manifest.json` that
[CLAUDE.md](../CLAUDE.md) owes, with the same debt: until it exists, a rebuild
from R2 would turn every private document public, so treat D1 as the system of
record for them.

## Rollback floor

Once any document is invited-only, a Worker older than the private-sharing deploy
would serve it publicly at its canonical url. That deploy is a hard rollback
floor, beside the domain cutover's; [deploying.md](deploying.md#rollback-floor)
says where to record it and what to do instead of rolling back.

## What is not built

- Domain rules ("anyone at acme.com"), which would be one more `link_access` value.
- Spaces, and folding of address variants.
- Edge caching, which [#33](https://github.com/Brevilabs/OpenArtifacts/issues/33) owns.
- Single-use URL grants.
- Moderation of other people's comments, and approval of agent comments; see
  [What is not built](comments.md#what-is-not-built) in comments.md.

## What comes next

Comments are built on this without moving anything here ([comments.md](comments.md)).
They took the four adjustments this section used to list: every comment route and
the threads resource call `canRead`, a private document's threads are served on the
publisher origin behind the grant cookie, the comments frame derives its
`frame-ancestors` per document from the serving origin as the Share frame does, and
the comment routes accept the Share popover's per-document token, so a reader signs
in once per document for both.

**Custom domains** are the same seat with a different name. `docs.acme.com`
resolves to a publisher through a verified host-to-owner mapping (a future
`publisher_hosts` table: hostname, owner id, verified at), and every rule on the
label host applies unchanged: the host serves that publisher's documents only,
each document is authorised live, and a grant cookie reads and nothing else. The
canonical link stays `https://openartifacts.site/d/{docId}`, because Copilot pins
it and every invite and receipt carries it; `/open` redirects to whatever the
document's serving origin is at that moment, so moving a publisher onto a custom
domain changes no link anyone holds. Nothing is keyed by host: documents,
invites, requests and comments are keyed by `docId`.

Agents as first-class participants (a token scoped to one document, issued by the
human it acts for) is the step after that.
