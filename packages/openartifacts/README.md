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
file, tells the user where the file is, and ends its turn. When the user later asks
to publish, the agent runs:

```bash
openartifacts publish notes.html --title "Notes"
```

The command prints `{"docId","url","version","linkAccess"}`, where `linkAccess` is
`"anyone"` for a public page and `"invited"` for a private one. A private publish
also adds `manageUrl`. Updating the same page is the same command with
`--doc-id <docId>`, which serves the next version at the same url and prints
`{"docId","url","version"}`.
`openartifacts unshare <docId>` withdraws a page. `list`, `get`, `tokens`, and
`revoke` round out the account commands.

Pages are public by default. `publish --private` creates a page for invited people
only, through `POST /api/v1/private-docs`, and `share` changes who can read one:

```bash
openartifacts share <docId> --add alice@acme.com   # invites her (and approves her request)
openartifacts share <docId> --remove alice@acme.com
openartifacts share <docId> --decline bob@other.com # decline a request, silently
openartifacts share <docId> --link anyone          # public again, same url
openartifacts share <docId>                        # print who has access
```

`share <docId>` prints the access JSON: who can open the document, the pending access
requests, whether the server sends invitation emails (`email`), and a `manageUrl`, the
page where the owner manages access in a browser. `--add` also approves a pending
request. Where the server sends email, an added person is emailed the link; otherwise
send it to them yourself. `publish --private` prints `{"docId","url","version","linkAccess","manageUrl"}`.
Invited people sign in once with the invited address (Google, GitHub or an emailed
code) and open the same url. Private sharing is a paid feature. A server that predates
private sharing, or that has no reader sign-in configured, answers 404 to
`publish --private`: nothing is created, and the CLI says "This server does not
support private documents." `list` shows each page's `linkAccess`, and `get` prints
the owner's stored HTML, private pages included.

The CLI never renders Markdown and keeps no record of which file became which page.
Both are the agent's job: it writes the HTML the user reviewed, and it remembers the
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
