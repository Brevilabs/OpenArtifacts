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

## Exercising the approval page

The approval page needs a pending device code to bind, and minting one belongs to
the device flow in
[#57](https://github.com/Brevilabs/OpenArtifacts/issues/57), so insert the row by
hand until that lands. It also needs an OAuth client;
register a Google or GitHub app whose callback is
`http://127.0.0.1:8787/approve/callback/{provider}` and put its pair in
`.dev.vars`.

```bash
CODE=WDJB-MJHT

npx wrangler d1 execute symposium --local --command \
  "INSERT OR REPLACE INTO device_codes (user_code, expires_at, created_at)
   VALUES ('$CODE', $((($(date +%s) + 900) * 1000)), $(($(date +%s) * 1000)))"

open "http://127.0.0.1:8787/approve?user_code=$CODE"
```

Signing in leaves the account proven and the code unapproved; pressing the button
on the page that follows is what approves it. The row shows both steps:

```bash
npx wrangler d1 execute symposium --local --command \
  "SELECT d.user_code, d.account_id, d.approved_at, a.email, i.provider, i.subject
     FROM device_codes d
     LEFT JOIN accounts a ON a.id = d.account_id
     LEFT JOIN identities i ON i.account_id = a.id"
```

With no OAuth client configured the page answers `503` and says approval is not
set up, which is the same thing a self-hosted deployment without one does.
