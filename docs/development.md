# Development

Running Symposium on your machine. No Cloudflare account needed.

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
`publishers` row younger than an hour whose plan may publish, and a publisher id
is just the SHA-256 of the key. The plan has to be `believer`: any other value
is not entitled to publish, so the row is skipped and the push falls through to
a license server that is not there.

```bash
KEY=any-string-you-like
HASH=$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1)

npx wrangler d1 migrations apply symposium --local
npx wrangler d1 execute symposium --local --command \
  "INSERT OR REPLACE INTO publishers (key_hash, plan, validated_at)
   VALUES ('$HASH', 'believer', $(($(date +%s) * 1000)))"

SYMPOSIUM_LICENSE_KEY=$KEY scripts/smoke.sh http://127.0.0.1:8787
```

Alternatively, copy `.dev.vars.example` to `.dev.vars` and point
`LICENSE_API_URL` / `LICENSE_API_KEY` at the real license server.
