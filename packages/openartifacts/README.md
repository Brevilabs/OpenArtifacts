# OpenArtifacts CLI

Install the CLI and the OpenArtifacts skill into detected Claude Code, Codex, OpenCode,
and pi installations:

```bash
npx openartifacts install
```

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

The command prints `{"docId","url","version"}`. Updating the same page is the same
command with `--doc-id <docId>`, which serves the next version at the same url.
`openartifacts unshare <docId>` withdraws a page. `list`, `get`, `tokens`, and
`revoke` round out the account commands.

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

## Hosts

Hosts such as Obsidian Copilot ship their own execution wrapper for agents that run
without Node. They can import the skill text and themes from this package as a
pinned development dependency at build time. Skill and theme edits ship in a new npm
version through the existing release PR workflow.
