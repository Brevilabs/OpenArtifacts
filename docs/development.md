# Development

Running OpenArtifacts on your machine. No Cloudflare account needed.

[← README](../README.md) · [HTTP API](http-api.md) · [Deploying](deploying.md)

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
`publishers` row younger than an hour whose plan may publish, and a key is
identified by the SHA-256 of itself. Use `plus` or `believer`, the two paid plans
entitled to publish. Any other value is refused by the publishing gate.

`owner` is the account the documents get filed under — in production the
`accountId` the license server returns, and locally any string you like, since
nothing checks it against a real account. Use the same one twice to see two keys
share a shelf.

```bash
KEY=any-string-you-like
HASH=$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1)

npx wrangler d1 migrations apply symposium --local
npx wrangler d1 execute symposium --local --command \
  "INSERT OR REPLACE INTO publishers (key_hash, plan, validated_at, owner)
   VALUES ('$HASH', 'plus', $(($(date +%s) * 1000)), 'local-account')"

OPENARTIFACTS_LICENSE_KEY=$KEY scripts/smoke.sh http://127.0.0.1:8787
```

Alternatively, copy `.dev.vars.example` to `.dev.vars` and point
`LICENSE_API_URL` / `LICENSE_API_KEY` at the real license server.

## Signing in from a terminal

The device flow needs no license server and no seeding: `POST /device/code`
mints the code, and the url it returns is the whole of the browser half. It does
need an OAuth client, so register a Google or GitHub app whose callback is
`http://127.0.0.1:8787/approve/callback/{provider}` and put its pair in
`.dev.vars`.

```bash
BASE=http://127.0.0.1:8787

MINT=$(curl -sS -X POST "$BASE/device/code" \
  -H 'content-type: application/json' -d '{"label":"dev laptop"}')

DEVICE_CODE=$(printf '%s' "$MINT" | jq -r .device_code)
open "$(printf '%s' "$MINT" | jq -r .verification_uri_complete)"

# before approving, and again after
curl -sS -X POST "$BASE/device/token" -H 'content-type: application/json' \
  -d "{\"device_code\":\"$DEVICE_CODE\"}"
```

The token that poll returns publishes like a license key, and it is the only
time the value exists outside your terminal:

```bash
TOKEN=oat_…
curl -sS -X POST "$BASE/api/v1/docs" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"Local","html":"<!doctype html><html><body><p>hi</p></body></html>"}'
curl -sS "$BASE/api/v1/tokens" -H "authorization: Bearer $TOKEN"
```

Signing in leaves the account proven and the code unapproved; pressing the
button on the page that follows is what approves it, and Deny on the same page
kills the code instead. The row shows both steps:

```bash
npx wrangler d1 execute symposium --local --command \
  "SELECT d.user_code, d.account_id, d.approved_at, a.email, i.provider, i.subject
     FROM device_codes d
     LEFT JOIN accounts a ON a.id = d.account_id
     LEFT JOIN identities i ON i.account_id = a.id"
```

With no OAuth client configured the page answers `503` and says approval is not
set up, which is the same thing a self-hosted deployment without one does.

## Private sharing locally

`npm run dev` empties every host var (see its flags in `package.json`), so the
router falls back to path prefixes, and a publisher's origin (`{label}.{serving host}`) cannot resolve.
Private sharing is therefore off locally by its own rule: reader sign-in needs a
serving host and an API host, so `POST /api/v1/private-docs`, the `…/access`
routes, `/open`, `/share`, `/signin` and `/embed/*` answer `404`, exactly as on a
server that has no sign-in configured. The test suite covers the whole flow,
including the sign-in pages, the label hosts, the share page and the Share popover's
frame, popup and token, with the hosts set per test.
Trying it by hand needs a deployment: see
[Self-hosting](deploying.md#self-hosting) under Private sharing.

**The top bar cannot be seen from `npm run dev`.** The bar and its **Share**
popover exist only where reader sign-in is configured, so a page served locally
keeps the header byline and has no bar, no script tag and no popover. Nor can it
be switched on there: `wrangler dev` rewrites every local request to one upstream
host (the route's host, wrangler's `getInferredHost`), so the host router never sees
the apex, a label host and the API host as different hosts, and the path-prefix
fallback is the only routing it ever does. The workerd tests set the hosts per test
and cover the bar's markup and the frame's HTTP contract; they cannot load a page,
a frame or a popup. The browser test does:

```bash
npm run test:browser   # Node 22 and Google Chrome
OA_HEADED=1 npm run test:browser             # watch it
OA_SCREENSHOTS=/some/dir npm run test:browser # bar.png, popover-signed-out.png, popover-owner.png, popover-private.png
```

`test/share-popover.browser.mjs` bundles the Worker (`wrangler deploy --dry-run`)
and runs it under Miniflare over HTTPS with real D1 and R2 and no `upstream`, so
the router sees each request's own `Host` and its allowlist runs as in
production. Chrome (the machine's own, through `playwright-core`; no browsers are
downloaded) reaches `openartifacts.site`, a publisher's label host and
`api.openartifacts.ai` through `--host-resolver-rules`, which is the one local
way to see the bar and the popover on their real hosts. It signs a reader session
in Node, opens a page, presses **Share**, signs in through the real popup, and
switches a document to private; it also checks that a hostile page embedding the
frame learns nothing and that the frame says the same about every id a viewer
cannot read. The browser's own policy decides every request (Fetch Metadata,
cookies, CSP, `frame-ancestors`, the opener policy), so the test never uses
`context.route`, which would bypass it. It needs no license server and no network.
