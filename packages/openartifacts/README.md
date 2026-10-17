# OpenArtifacts CLI

Install the CLI and bundled skill into detected agents:

```bash
npx openartifacts@latest install
```

Alternatively, install only the skill from your project folder using the standard
skills manager:

```bash
npx skills add Brevilabs/OpenArtifacts
```

The skill can run the CLI through `npx --yes openartifacts@latest` when it is not
installed globally. Add `--global` to the skills command to install across projects.

Hermes Agent needs only its native skill install:

```bash
hermes skills install https://cdn.jsdelivr.net/npm/openartifacts@latest/skill/openartifacts/SKILL.md
```

The skill uses an installed `openartifacts` command when available and falls back to
`npx --yes openartifacts@latest`, so no separate CLI installation is required. Run
`hermes skills update` to refresh the skill from that source.

## How publishing works

The agent is the renderer. It reads the user's document, writes a complete HTML
file, and runs the command below. Any request to publish or share a document goes to
OpenArtifacts. When the plan has private pages, the agent publishes a private page
straight away and links the file in its report. Public pages (on request, or on a
plan without private pages) and updates publish straight away too, unless the user
asks to see the page first.

```bash
openartifacts publish notes.html --title "Notes"
```

A page that was ever public may already have been copied by whoever opened it, and
making it private later cannot recall those copies, so a new page starts private
(invited people only) when the plan allows it. With no flag the CLI creates it
through `POST /api/v1/private-docs`; if the plan has no private sharing (a free
account), it publishes the page through `POST /api/v1/docs` instead, and the
`linkAccess` in the receipt says which happened. A server with no private
documents answers that route 404, and then nothing is published. Pass `--public`
to publish for anyone with the link (always
`POST /api/v1/docs`), or `--private` to require a private page: `--private` fails
rather than publishing publicly. `--public` and `--private` cannot be combined, and
neither applies to `--doc-id`.

The command prints `{"docId","url","version","linkAccess"}`, where `linkAccess` is
`"anyone"` for a public page and `"invited"` for a private one. A private publish
also adds `manageUrl`. Updating the same page is the same command with
`--doc-id <docId>`, which serves the next version at the same url and prints
`{"docId","url","version"}`.
`openartifacts unshare <docId>` withdraws a page. `list`, `get`, `tokens`, and
`revoke` round out the account commands.

Republishing never changes who can open a page. `share` changes who can read one:

```bash
openartifacts share <docId> --add alice@acme.com   # invites her (and approves her request)
openartifacts share <docId> --add alice@acme.com --role view   # reads, cannot comment
openartifacts share <docId> --remove alice@acme.com
openartifacts share <docId> --decline bob@other.com # decline a request, silently
openartifacts share <docId> --link anyone          # public again, same url
openartifacts share <docId>                        # print who has access
```

`share <docId>` prints the access JSON: who can open the document, the pending access
requests, whether the server can send invitation emails (`email`), and a `manageUrl`, the
page where the owner manages access in a browser. `--add` also approves a pending
request. Where the server sends email, an added person is emailed the link, though a
per-publisher limit or the mail service can drop one; otherwise, or if the invitee
does not get it, send it to them yourself. A private publish prints `{"docId","url","version","linkAccess","manageUrl"}`.
Invited people sign in once with the invited address (Google, GitHub or an emailed
code) and open the same url. Private sharing is a paid feature. A server that predates
private sharing, or that has no reader sign-in configured, answers 404 to
`publish --private`, and to a plain `publish`: nothing is created, and the CLI says
"This server does not support private documents." `list` shows each page's `linkAccess`, and `get` prints
the owner's stored HTML, private pages included; against an older server that has
no private pages, `get` reads the public url as it always did.

`openartifacts open <docId>` opens your own page in the browser already signed in as
you, so a private page needs no sign-in step. It prints only
`{"opened":true,"docId":"…"}`: the link it opens is a 60-second grant, so it is never
printed.

## Comments

Each person the owner adds to a page has a role, `comment` (the default) or `view`, and
people who can comment, with the owner's agent, comment on quoted passages. Adding
people needs a paid plan; the people you add are named by the owner, and a public link
never lets a stranger comment. `openartifacts share <docId> --add <email> [--role view|comment]`
adds a person, or sets the role of one already listed. The `comments` commands print
the server's JSON:

```bash
openartifacts comments list <docId>                 # open threads; --resolved, --all, --since <iso>
openartifacts comments add <docId> --quote "exact text" --body "…" [--prefix "…"] [--suffix "…"] [--section id] [--version n]
openartifacts comments reply <docId> <threadId> --body "Softened in v4."
openartifacts comments resolve <docId> <threadId> [--version n]
openartifacts comments reopen <docId> <threadId>
openartifacts comments delete <docId> <commentId>   # your own comment; a thread's first one removes the thread
openartifacts comments name "Display name"          # the name your comments carry
```

`comments list` prints `{docId, title, version, latestVersion, threads}`; each thread
has its quote (`anchor`), whether it still `anchored` in the version or is `orphaned`,
its `state` and its `comments`. Comments by an agent carry `kind: "agent"`. Arguments
are checked before any credential is read: a quote is at most 1,000 characters, a
comment 4,000, a prefix or suffix 32, a name 64. Account tokens and license keys both
work. A server without comments and a page you cannot read both answer "Not found, or
this server does not support comments." The skill's "Address the comments" step lists the open threads, revises the
page, publishes the update, then replies on and resolves each thread it addressed.

The CLI never renders Markdown and keeps no record of which file became which page.
Both are the agent's job: it writes the HTML, and it remembers the
docId from the url it reported or from `openartifacts list`.

## Themes

`skill/openartifacts/themes/*.md` are design specs written for the agent, not CSS.
The agent reads the named theme and follows it while writing the HTML. The bundled
`research-memo` theme is the first; `openartifacts install` copies the themes next
to the installed SKILL.md.

## Credentials

The first authenticated command opens the browser device flow and stores the resulting
token with owner-only permissions. Set `OPENARTIFACTS_TOKEN` to supply a credential
without browser sign-in; it accepts an OpenArtifacts token or a Brevilabs license key.
Set `OPENARTIFACTS_API_HOST` to target a self-hosted deployment.

## Account and browser actions

An OpenArtifacts account can publish within the deployment's free limits.
Signing in is separate from purchasing an upgrade. Check current access with:

```bash
openartifacts account
openartifacts account --open
```

`account` prints JSON with the plan, limits, current usage, and whether an external
account is linked, plus refresh status, last check time and paid expiry.
`account --open` prints `{"url":"…","expiresAt":…}` and open
the browser. These links expire after ten minutes and can be used once. Their
availability depends on the deployment's configured account-action service.

Both forms require an OAuth-issued OpenArtifacts token. The CLI uses
the current API host's stored token, or `OPENARTIFACTS_TOKEN` when set. Without a
credential it starts the normal sign-in flow. If the environment contains a
license key, unset it and run `openartifacts login` before these account commands.
A rejected credential is reported; it does not silently start another sign-in.

For linking, enter the license key only on the trusted browser page and confirm
the association there. Never put the key in command arguments or chat. Linking
joins document history while preserving published URLs and existing machine tokens.
It does not itself complete a purchase. On a publishing limit, run `account --open` to
obtain authenticated browser access; an owner ID in a URL is not account proof.

## Hosts

Hosts such as Obsidian Copilot ship their own execution wrapper for agents that run
without Node. They can import the skill text and themes from this package as a
pinned development dependency at build time. Skill and theme edits ship in a new npm
version through the existing release PR workflow.
