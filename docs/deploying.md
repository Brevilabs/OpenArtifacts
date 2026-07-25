# Deploying

Provisioning the Cloudflare resources and shipping. If you have not used
Cloudflare before, read [Hosting](hosting.md) first — it explains what these
commands are creating.

[← README](../README.md) · [Hosting](hosting.md) · [HTTP API](http-api.md)

> **Nothing has been deployed yet.** The sequence below is complete and creates
> real resources on a real account. One thing to know going in: D1 is currently
> the only record of who owns a doc, what it is called, and whether it was
> deleted, so until per-doc manifests ship, back-ups mean D1's own 30-day Time
> Travel window rather than "rebuild it from R2". That is fine at low volume and
> should be fixed well before it isn't — see `CLAUDE.md`.

Run once, in order, from a checkout with `npx wrangler login` already done. This
creates real Cloudflare resources on whichever account wrangler is logged into.

```bash
# 1. The R2 bucket. The name must match `bucket_name` in wrangler.jsonc.
npx wrangler r2 bucket create updoc-docs

# 2. The D1 database. This prints a `database_id`.
npx wrangler d1 create updoc
```

**Now edit `wrangler.jsonc`** and replace the `database_id` placeholder
(`00000000-0000-0000-0000-000000000000`) with the id step 2 printed, then commit
it. It is not a secret; the binding will not resolve without it.

```bash
# 3. Create the schema on the real database (--remote, not --local).
npx wrangler d1 migrations apply updoc --remote

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
UPDOC_LICENSE_KEY=<a real Copilot Plus key> \
  scripts/smoke.sh https://updoc.<subdomain>.workers.dev
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
