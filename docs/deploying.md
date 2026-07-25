# Deploying

Provisioning the Cloudflare resources and shipping. If you have not used
Cloudflare before, read [Hosting](hosting.md) first — it explains what these
commands are creating.

[← README](../README.md) · [Hosting](hosting.md) · [HTTP API](http-api.md)

> **The Worker has not been deployed yet.** Its storage has: on the Brevilabs
> account, steps 1–3 below are done, and `wrangler.jsonc` already carries the
> real `database_id`. What is left is steps 4–6. One thing to know going in: D1
> is currently the only record of who owns a doc, what it is called, and whether
> it was deleted, so until per-doc manifests ship, back-ups mean D1's own 30-day
> Time Travel window rather than "rebuild it from R2". That is fine at low volume
> and should be fixed well before it isn't — see `CLAUDE.md`.

Run in order, from a checkout with `npx wrangler login` already done, against
whichever account wrangler is logged into.

**Steps 1–3 provision storage, and are already done on the Brevilabs account.**
Run them only when standing the service up on a fresh account — re-running them
against Brevilabs' would fail on the existing names, or create duplicates under
new ones.

```bash
# 1. The R2 bucket. The name must match `bucket_name` in wrangler.jsonc.
npx wrangler r2 bucket create symposium-docs

# 2. The D1 database. This prints a `database_id`.
npx wrangler d1 create symposium
```

On a fresh account, **now edit `wrangler.jsonc`** and replace the committed
`database_id` with the id step 2 printed. It is not a secret; the binding will
not resolve without it. On the Brevilabs account the committed id is already the
right one — leave it alone.

```bash
# 3. Create the schema on the real database (--remote, not --local).
#    Already applied on Brevilabs'; re-running it is a no-op.
npx wrangler d1 migrations apply symposium --remote
```

**Steps 4–6 ship the Worker, and are what is actually outstanding.**

```bash
# 4. Credentials for the license server. Both prompt for the value, so neither
#    ends up in your shell history. LICENSE_API_KEY is *ours*, never a
#    publisher's key. On a first deploy the Worker does not exist yet, so the
#    first of these also asks whether to create it — answer yes; step 5
#    overwrites the placeholder and the secrets survive it.
npx wrangler secret put LICENSE_API_URL     # e.g. https://api.brevilabs.com
npx wrangler secret put LICENSE_API_KEY

# 5. Ship. This prints the workers.dev url.
npx wrangler deploy

# 6. Check what just shipped, end to end.
SYMPOSIUM_LICENSE_KEY=<a real lifetime-tier key> \
  scripts/smoke.sh https://symposium.<subdomain>.workers.dev
```

The smoke script publishes a doc, reads it, lists it, deletes it and confirms the
`410`. It spends one push against that key's daily quota and leaves no live doc
and no stored bytes behind — only the deleted doc's row, which every delete keeps
so the url can go on answering `410`. It is not part of CI — CI has no key and no
deployment.

`SERVING_HOST` and `API_HOST` stay empty in `wrangler.jsonc` for v0: one
workers.dev subdomain hosts both surfaces and the router falls back to path
prefixes. Filling them in later moves doc serving onto the sacrificial domain
without a code change — and the `url` the API returns follows automatically.

Later deploys are steps 5 and 6 alone, plus step 3 whenever a migration is added.
All changes ship through a pull request; never push to `main`.
