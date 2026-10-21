# Comments

Inline comments on a published page. A reader, or an agent acting for one,
selects a passage, comments on it, and the thread stays attached to that passage
across versions. The owner (or the thread's author) resolves it once a later push
addresses it, and the resolution records which version did.

This is step 2 of the wedge in [positioning.md](positioning.md): share, then
comment, then converge. The wire contract is in
[http-api.md](http-api.md#comments); this page is the design and the reasons.

[← README](../README.md) · [Hosting](hosting.md) · [Positioning](positioning.md) · [Private sharing](private-sharing.md)

## What it is

- **Quote-anchored threads.** A thread is anchored to a quote of the page, not to
  a position. Each thread has comments, a state (`open` or `resolved`) and, for
  every version, an anchor status (`anchored` or `orphaned`).
- **The roles are the only control.** There is no per-document switch. Each person
  the owner adds has a role, **Can view** or **Can comment**, in the Share popover,
  the share page or with `openartifacts share <docId> --add <email> --role …`, on
  public and private pages alike. A page has comments when the owner's agent has
  commented or some person holds **Can comment**. A paid plan is required to add
  anyone; a free owner's pages are view-only.
- **People and agents both write.** A person comments through the comments frame
  beside the page; an agent through `/api/v1` with an account token or a license key,
  or the CLI's `openartifacts comments`. Agent comments are labelled "Alice's agent"
  by the API; the frame shows "Alice" with a small sparkle icon ("via Claude Code" when the agent
  named itself in the `OpenArtifacts-Agent` header, else the credential's default, "via
  OpenArtifacts CLI" or "via Copilot"; "via agent" only for comments from before the header). They post immediately.
- **Works on private pages.** The same access model as the page: a private
  document's threads are as private as its bytes.

## Three state machines

| | States | Belongs to |
| --- | --- | --- |
| **Thread** | `open` ⇄ `resolved` (resolving cites a version) | one anchor |
| **Anchor** | `anchored` ⇄ `orphaned`, per version | one quote |
| **Comment** | exists, or is deleted | one author |

They do not interact. A resolved thread whose text disappears in a later push is
still resolved and still cites the version that addressed it, and an open orphan
is ordinary. Collapsing the two would destroy the resolve provenance the design
exists for. Reopening is real and clears the resolution; text that returns in a
later version re-anchors by itself.

A comment is immutable: there is no editing, only deleting. Deleting a thread's
first comment deletes the thread. Replies to a resolved thread are allowed.

## Anchors are quotes

A thread anchors to `{exact, prefix?, suffix?, section?}`, in the style of the W3C
TextQuoteSelector. **Never offsets**: offsets do not survive the next push, which is
the failure every surveyed competitor has ([positioning.md](positioning.md)).

The text a quote is matched in, the *canonical text*, is the concatenated text of
`<body>` (the whole document if there is none), skipping `head`, `script`,
`style`, `template` and `noscript`, with entities decoded, CRLF as LF and NFC.
OpenArtifacts' own bar, spacer, bylines and script are not in the stored HTML and
the page side skips them, so the server and the browser compute the same text. The
server builds it with `HTMLRewriter` from the stored version (`src/comments/anchor.ts`,
`src/comments/entities.ts`) and records the nearest ancestor `id` of each text run,
which is the `section` hint.

For version *n*, a thread that has no anchor row for *n* is resolved by a ladder:

1. **Exact.** One occurrence anchors. Several are scored by how much of the
   `prefix` and `suffix` agree on each side; a unique best wins; a tie falls to the
   candidates inside `section`; still tied is orphaned.
2. **Whitespace-insensitive**, only when rung 1 finds nothing: the same over text
   with runs of whitespace collapsed. A unique winner anchors *and* rewrites the
   thread's stored quote to the matched original text.
3. Otherwise **orphaned** for *n*. There is no edit-distance matching, and no guess.

Posting uses the same ladder against the version the client rendered, and a quote
that does not resolve to one place is `400 anchor_not_found`. The result is stored
as `(thread, version, status, matched text)`, so each version is resolved once, then
remembered. Orphaning is shown, not hidden: a comment about text that no longer
exists is information.

## Where it lives

**One SQLite Durable Object per document** (`DocComments`, bound as `COMMENTS`,
addressed `idFromName(docId)`), holding that document's threads, comments and
anchor rows. Every write to a document serialises through it, which is what makes
the 500-thread and 2,000-comment caps hold under concurrent posts, and it is the
coordinator that v0 deliberately did without ([CLAUDE.md](../CLAUDE.md)) and
comments are the feature that earns.

The Worker authorises and the object enforces:

- **The Worker** (`src/comments/access.ts`, `service.ts`) decides from D1 whether
  the caller can read, can comment and can manage, whether
  the owner's plan has comments and whether the rate limit allows, and derives who the
  author is from the credential. It never takes an author from the request. It then
  calls the object with `{principal, kind, onBehalfOf}`.
- **The object** (`src/comments/object.ts`) enforces what it can see itself: the
  caps, the anchor ladder, who may delete a comment, who may resolve (the Worker
  passes whether the caller manages the document), the state machines and the
  snapshot.
- **D1 holds two flags and a name.** `docs.has_threads` (migration `0016`) is set
  before the first thread is written, so no thread exists while it is unset, and is
  never cleared; it is rebuildable from `threads.json`. With
  the people list it answers "does this page have comments" without asking the
  object. `accounts.display_name` is the name (migration `0015`, which also added
  `docs.comments_enabled`: unread since the roles revision, dropped later). No
  comment body is ever in D1.

The object is the system of record for threads. After every mutation it writes a
full snapshot, `docs/{docId}/threads.json`, to R2: an overwrite, never a
read-modify-write, queued so an older snapshot cannot land after a newer one, and
best-effort (a failure is logged and never fails the mutation). It is what a rebuild
and an export read. The snapshot carries internal ids and is never served.

**Delete.** Unsharing a document (`deleteDoc`) marks it deleted, then purges the
object, then sweeps R2 (which removes `threads.json`), in that order, each
best-effort after the D1 row is safe. A deleted document's object refuses writes
forever, and every comment route and the threads resource answer `404` or `410` by
the rules for the page itself.

## Access

```
canComment = canRead
             AND the owner's plan includes comments
             AND the caller is the owner, OR an account on the document's list whose
                 role is at least `comment`
```

The roles are an ordered ladder, `view` < `comment` (a later `edit` is one more
rung), declared once in `src/roles.ts` with `roleAtLeast` and `ROLE_PLAN_FLAG`.
Link access plays no part: a public link never confers commenting.

`canRead` and `canManage` are the existing predicates; the rest is assembled in
`src/comments/access.ts` from one D1 read (`findCommentableDoc`). A reader invited
as **Can view** reads the threads and cannot write, and so does a signed-in
account that is not on the list, on a public page.

- **Everything refused is `404`, never `403`.** The one exception is given only to
  someone who manages the document, and so reveals nothing: the plan's `402`.
- **Entitlement belongs to the document's owner.** Readers and commenters never
  pay. A lapsed owner keeps the threads readable and stops accepting writes, and
  the people on the list keep their roles. The plan is read from what D1 stores, so
  a comment write costs no license-server call. Accepted for v1: those rows are as
  fresh as the owner's last publish or account refresh, so a lapsed license key
  keeps accepting comments until its owner next publishes.
- **Resolve and reopen**: the owner, or the thread's author while they can still
  comment. There is no moderation of other people's comments; a commenter deletes
  only their own words, and an owner who wants a thread gone resolves it.
- **Authorship is the account.** A license key linked to an account is one author
  with it, so linking after the fact does not orphan a comment's `mine`, its delete
  right or its emails.

Credentials: `/api/v1` takes an account token (`oat_`) or a license key and writes
as an **agent**, named after the account it acts for. The comments frame uses the
Share popover's per-document token (`oas_`) and writes as a **person**, who must
have a display name; nobody is asked for one: sign-in supplies it, else the part of their email before the `@`, without any `+tag`, is stored on the first comment and shown with their comments. Agents are named after their account. One token per
document serves both frames. See
[private-sharing.md](private-sharing.md#credentials-by-capability).

## Serving: threads are separate from the page

The stored document is served exactly as before. Threads would make a page vary
with state between pushes, which would end its cacheability (an immutable `/v{n}`
page; the mutable `/d/{docId}` pointer's 60-second lifetime) and its being a pure
function of the stored version. So comments are a **separate resource**:

- `GET /d/{docId}/threads[?v=n]` on the serving origin, public and unauthenticated,
  on the apex for a public document and on the publisher's origin behind the grant
  cookie for an invited-only one. Same JSON for every reader, `no-store`, no view
  counted, no cookie on the apex.
- The page script (`/embed/page.js`, already on every page for **Share**) fetches it
  same-origin and adds the comments button, the highlights, and the frame. It does
  not ask when the bar says the document has no comments: on the shared link the
  Share link carries `data-comments="on|off"`, derived in the `docs` read the serving
  path already makes (`has_threads`, or a person at `comment` or above) and folded
  into that rendering's etag (`.c0` / `.c1` after the deploy time), so a page with no
  comments costs no second request and a flip reaches readers within the route's
  60 seconds. On a page that stays inert (no thread, nobody at `comment`)
  the first text selection builds the frame hidden, once per page load, and the
  frame's existing `viewer` message says whether this viewer may comment (the owner
  signed in to the frame): if so the page activates and offers **Comment** without the
  Share popover being opened. A document that has never had a thread answers the resource from its
  row alone, without reaching the object. The link also carries
  `data-version`, the version that rendering is, and the script reads and writes
  at it, so comments stay with the text on screen when a push lands while the page
  is open or cached. A pinned `/v{n}` is immutable and carries neither attribute;
  there the script asks, at the version its path names. The owner adding a person, changing a role or closing the
  Share popover makes the open page ask again, so no reload is needed.
- Agents fetch the same resource, or `GET /api/v1/docs/{docId}/threads` with their
  credential for the viewer fields, instead of parsing threads out of a page. That
  settled the question [positioning.md](positioning.md) ended on.

The reader never sees a credential on the document's origin: the frame is on the API
host in a closed `iframe`, with the token in its own storage, and the highlights are
painted with `CSS.highlights`, which mutates nothing in the author's DOM. See
[http-api.md](http-api.md#the-embed-family-not-part-of-the-client-contract) for the
frame, its policy and the `postMessage` protocol.

## Reading and writing on the page

The model is a document editor's comment margin (Google Docs, Notion, Figma):

- **A Comments button** in the bar, just left of **Share** and in its pill shape,
  reads `Comments` and the open-thread count (`Comments 3`); at phone width the
  bubble and the count. It is pressed while the comments are open, and they are
  closed on every page load: nothing is remembered.
- **Highlights are always on.** Every open thread whose passage the page finds is
  one translucent yellow, whether or not the comments are open; the active thread
  and the draft a stronger yellow. On a dark page the same yellows are fainter, so
  the page's light text stays readable on them (4.5:1 or more for light-grey text on a near-black page; any visible tint lowers a page's own contrast, so a medium-dark page that starts near 4.5:1 dips slightly below it).
  No underline, which reads as a link. Resolved threads have none.
- **Wide screens get a sidebar.** Where the viewport is at least 880 px and the
  window is what scrolls the page, opening the comments narrows the page by a
  320 px column on its right (an adopted stylesheet pads `<html>` and sizes it `auto`, so the author's
  own layout reflows and the page's own background fills the column), and closing
  them gives the width back. Nothing else changes the page's width, and the text
  the reader was looking at (the passage being commented on, the active thread's,
  else the line in the middle of the window) stays where it was on screen while
  the page reflows. The column has
  a header (the title, an `N resolved` button whose chevron turns while the resolved
  threads are shown, replaced for a few seconds after a resolve by "Resolved" and an
  **Undo** button, and a close button), then the
  threads whose text changed, under "On text that changed" with their quotes, then
  a card level with the first line of each passage.
- **Cards follow Google Docs when they collide**: in passage order, 8 px apart, the
  active card (the draft, else the focused thread) exactly level with its passage,
  even over the threads listed at the top, the ones above pushed up and the ones
  below pushed down only as far as they must.
  The page re-measures whenever the geometry can change: opening or closing,
  resizing, fonts and images loading, the document resizing, or a card growing.
- **Cards follow the page's theme.** The page reads its own background (the first
  that is not transparent from `<body>` up to `<html>`; when both are transparent,
  what paints the page's left edge halfway down the window, a wrapper that fills
  the page, whose colour the column then paints too; white if nothing does) and
  the frame draws light cards (white, dark text, a hairline border and a soft
  shadow) on a light page and dark-grey cards with light text on a dark one; the
  header, menus, composer, buttons and focus rings follow.
- **Narrow screens get a bottom sheet** from the same button: the list of open
  threads, or the one thread whose highlight was tapped, or the draft. The page
  does not narrow.
- **A highlight opens its thread**, and **Comment** on a selection opens the
  composer level with it, from a closed state too. Posting takes a click on Send;
  Enter is a newline.
- **A selection made before the reader may comment** (before signing in, say)
  gets its **Comment** button as soon as they may, without selecting again.
- **Comment** sits centred over the selection (kept inside the viewport), and
  ⌘⌥M (Ctrl+Alt+M elsewhere) does what it does: it opens the composer on the
  selection and never posts.
- **On a narrow screen Comment docks at the bottom centre** of the visible part
  of the page, 44px tall and 12px above its bottom edge (above the sheet when
  the sheet is open), and follows a pinch zoom or a toolbar that shows and
  hides. A phone's own selection menu (Copy, Look Up) goes just above or just
  below the selection, wherever it finds room, so any place beside the
  selection can end up under it. A selection that ends within about 100px of
  the dock would put that menu over the button, so Comment then docks at the
  top instead, 12px below the bar. A tap keeps the passage it was shown for,
  even if the browser clears the selection on the way.
- **With nothing open** the column says "No comments yet. Select text to
  comment." in plain text, not a card ("No open comments." once every thread is
  resolved). The instruction shows only while no card is beside a passage, so it
  never pushes the cards at the top of the page down; the sheet's thread view
  carries no such line.
- **The keyboard reaches every card**: Tab stops on each card, a card reached that
  way becomes the active one, and the next Tab is in its reply field.
- **Times** read `now`, `5m`, `3h`, `2d`, then a short date (`Oct 9`) after a
  week, with the exact local date and time on hover.
- **After a post** focus moves to the reply field of what was posted, and a
  polite live region in the frame says "Comment posted".
- **Hovering links a passage and its card**: while either is under the pointer,
  the passage takes the active yellow and the card lifts; leaving restores both.
- **Avatars** are each person's initial in one colour picked from their name, from
  a small palette that reads on both themes.

## Plans, limits and abuse

| | |
| --- | --- |
| Plans | `PlanLimits.comments` on `pro` and `pro_lifetime`; the license plans that may publish (`PLUS`, `BELIEVER`) have it. Free owners cannot add anyone, so their pages are never commentable. |
| Per document | 500 threads, 2,000 comments, bodies 4,000 characters, quotes 1,000. |
| Per principal | 30 writes per minute (`COMMENT_WRITE_LIMITER`, namespace `1011`). |
| Per document | 20 notification emails per minute (`COMMENT_EMAIL_LIMITER`, namespace `1012`). |

Both limiters are optional bindings: absent means no limit. A comment body is
plain text, rendered with `textContent` and never HTML, with no links. Bodies and
quotes are bounded before an object is asked. Quotas and limits ship with the
feature they protect, as [CLAUDE.md](../CLAUDE.md) requires.

## Email

A new thread mails the owner (unless they wrote it); a reply or a resolve mails
everyone who wrote in the thread, an agent's comments to the account it acts for,
minus the actor. Reopening mails nobody. Only people who can still read the
document are mailed. The message uses display names only, never another person's
address. It is sent after the response, best effort, only where Email Service is
configured, and never changes what the caller sees.

## Self-hosting

A deployment that has the `COMMENTS` binding and reader sign-in gets the whole
feature; a SQLite Durable Object is available on the free Workers plan. A
deployment on an old configuration without the binding behaves as if the feature
did not exist: every comment route and the threads resource answer `404`, the
frame is absent and the page script stays inert. Documents and pages are
unaffected. [deploying.md](deploying.md#inline-comments) has the steps.

## What is not built

Deliberate non-goals of this version:

- **Approval of agent comments.** Agent comments post immediately and are labelled
  as agents; there is no pending state.
- **@mentions**, whole-document (anchorless) threads, and a list of all comments
  across documents.
- **Editing a comment**, moderating someone else's, and "ask for a change".
- **Live sockets.** The page polls every 30 seconds and the frame refetches after
  its own writes.
- **Edit-distance anchoring.** A quote that no rung finds is orphaned.
- **Clickable links** in bodies, and comments on the free plan.
- **Comments in the manifest.** The per-document `manifest.json` that rebuilds D1
  ([CLAUDE.md](../CLAUDE.md)) holds the comments switch, not the threads: those
  live in the object and its `threads.json` snapshot, and are not rebuilt into D1.
