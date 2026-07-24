# updoc

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

## Product context

`docs/positioning.md` and `docs/cost-at-scale.md` are the source of truth for what
this product is and how it is allowed to be built. Read them before designing
anything non-trivial — especially §6 of the cost doc (architecture) and the wedge
in the positioning doc.

## Non-negotiable design constraints

These are day-one decisions, not retrofits:

- User content is served from a **sacrificial domain**, separate from the brand
  domain. Reputation damage must not land on `updoc.md`.
- Shared docs are **`noindex` + `nofollow` by default**.
- **Publisher-gated, reader-open**: publishing requires a key; reading requires
  nothing.
- **R2 is the system of record**, and the stored format is HTML. D1 holds pointer
  rows only — never content — and must be rebuildable by scanning R2 manifests.
- Every push mints an **immutable version** served with `cache-control: immutable`.
  Render at push time, never at read time.
- **No per-MAU or per-seat priced dependency** anywhere in the serving path.
- Quotas and per-key rate limits ship with the feature they protect, not later.

## Git hygiene

Stage explicit paths (`git add src/foo.ts`), never `git add -A` / `git add .`.
Before committing, review the staged set with `git status` **and**
`git diff --cached`, plus `git status --porcelain --untracked-files=all` to catch
untracked files.

All changes ship through a pull request. Never push directly to `main`.
