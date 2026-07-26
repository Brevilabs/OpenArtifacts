# Deploying

Provisioning the Cloudflare resources and shipping. If you have not used
Cloudflare before, read [Hosting](hosting.md) first — it explains what these
commands are creating.

[← README](../README.md) · [Hosting](hosting.md) · [HTTP API](http-api.md)

> **The Worker has not been deployed yet.** Its storage has: on the Brevilabs
> account, steps 1–3 below are done, and `wrangler.jsonc` already carries the
> real `database_id`. What is left is steps 4–8. One thing to know going in: D1
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

**Steps 4–8 ship the Worker.** They have all run on the Brevilabs account; what
follows is the record of how, and the procedure for a fresh account. Step 7 is
the one that makes the Worker reachable: `workers_dev` is `false`, so a Worker
with no custom domain attached answers on nothing at all.

```bash
# 4. Credentials for the license server. Both prompt for the value, so neither
#    ends up in your shell history. LICENSE_API_KEY is *ours*, never a
#    publisher's key. On a first deploy the Worker does not exist yet, so the
#    first of these also asks whether to create it — answer yes; step 5
#    overwrites the placeholder and the secrets survive it.
npx wrangler secret put LICENSE_API_URL     # e.g. https://api.brevilabs.com
npx wrangler secret put LICENSE_API_KEY

# 5. Ship. The Worker has no hostname yet — see below.
npx wrangler deploy

# 6. Set SERVING_HOST and API_HOST in wrangler.jsonc, then redeploy. Still
#    unreachable, which is the point: the hosts go live before any domain does.
npx wrangler deploy

# 7. Attach symposium.site and api.symposium.md as custom domains. This is what
#    makes it reachable, and by now the running version already knows the hosts.

# 8. Check what just shipped, end to end, against the surface that ships.
SYMPOSIUM_LICENSE_KEY=<a real lifetime-tier key> \
  scripts/smoke.sh https://api.symposium.md
```

The smoke script publishes a doc, reads it, lists it, deletes it and confirms the
`410`. It spends one push against that key's daily quota and leaves no live doc
and no stored bytes behind — only the deleted doc's row, which every delete keeps
so the url can go on answering `410`. It is not part of CI — CI has no key and no
deployment.

## There is no workers.dev url

`workers_dev` is `false`, so step 5 uploads a Worker that answers on nothing at
all. That is deliberate, not an unfinished state.

The router resolves by host and falls back to path prefixes when the host matches
neither `SERVING_HOST` nor `API_HOST` — so a `workers.dev` hostname would happily
serve `/d/*`, putting user HTML on a domain we neither control nor can afford to
sacrifice. `workers.dev` is on the Public Suffix List, which makes
`<subdomain>.workers.dev` the unit a Safe Browsing listing applies to: one bad
upload would take down every Worker on the account's subdomain. The serving
domain exists precisely so the blast radius lands somewhere we chose.

So the order is configure, then attach, then test — and the redeploy goes *before*
the attach, not after. Set `SERVING_HOST` and `API_HOST` in `wrangler.jsonc` and
redeploy while the Worker is still unreachable, then attach the domains, then
smoke-test. Attaching first would leave the domains pointing at a version whose
hosts are empty, and the path-prefix fallback would serve `/d/*` on
`api.symposium.md` and `/api/v1/*` on `symposium.site` until the redeploy landed
— the exact split this document argues for, undone for the length of a deploy.
The `url` the API returns follows the vars automatically.

## Later deploys happen in CI

Merging to `main` runs `.github/workflows/deploy.yml`, which typechecks, tests,
refuses to deploy over an unapplied migration, ships, checks both hosts answer,
and records what shipped on the repo page. Nobody deploys from a laptop.

It needs one secret, `CLOUDFLARE_API_TOKEN` — an *environment* secret on
`production`, never a repository one, for the reasons below. The token holds two
account permissions on the Brevilabs account: **Workers Scripts: Edit** to
deploy, and
**D1: Edit** to read the `d1_migrations` table. Not a Global API Key, which
would also reach DNS and every other zone setting. Create it under My Profile →
API Tokens → Create Token; the *Edit Cloudflare Workers* template is a fine
starting point, but it does **not** include D1, so add that row by hand. Scope
Account Resources to the one account and Zone Resources to `symposium.site` and
`symposium.md` specifically, which is what authorizes the custom-domain routes.
Leave Client IP filtering empty: GitHub's runners have no stable egress IPs.

D1: Edit is broader than the guard needs — it only runs a `SELECT` — but the
query endpoint takes arbitrary SQL, so a read-only permission may not authorize
it and an under-scoped token fails every deploy rather than degrading. The cost
is real and worth naming: this token can write the production database, which is
the price of checking the schema from CI at all.

Add it under Settings → Environments → production → **Environment secrets**, and
set that environment's **deployment branch policy** to `main`. Both halves are
load-bearing, and the reason is that `workflow_dispatch` runs the workflow
definition from whatever ref it is given: a branch carrying an edited copy of
`deploy.yml` with the guard removed would otherwise deploy itself. The branch
policy refuses the job, and a branch that strips the `environment:` block to
escape the policy loses the only path to the secret. A repository secret has
neither property — every workflow in the repo can read it, so the guard in
`deploy.yml` would be the only thing standing between a feature branch and
production, and that guard lives in the file such a branch is editing.

The `main` rule must be **branch**-typed. GitHub's rules carry a ref type, and
the API reports this one as `{"name":"main","type":"branch"}`. A tag-typed rule
named `main` — or any `*` tag rule — would let someone push a tag called `main`
and dispatch from it, which no branch rule matches and no in-file guard survives.
Check with:

```bash
gh api repos/Brevilabs/symposium/environments/production/deployment-branch-policies \
  --jq '.branch_policies[] | {name, type}'
```

Required reviewers would gate this further, but GitHub rejects that protection
rule on this billing plan for a private repo, so the branch policy is the whole
of the platform-level control.

**Until that secret exists the workflow cannot run**, and deploys stay manual:
steps 5 and 8 above, plus step 3 whenever a migration is added.

Two things the workflow deliberately does not do:

- **It does not apply migrations.** It compares `migrations/` against the
  `d1_migrations` table and fails when they disagree. Applying them from CI
  would let a merged PR silently alter the production database; failing cannot
  corrupt anything and turns a code/schema mismatch into a red build. Apply them
  by hand, then merge.

  It also fails if an already-applied migration was **changed or deleted**,
  which the name comparison alone cannot see: `d1_migrations` stores names and
  timestamps, no checksums, so an edited file looks applied while the database
  never ran the new SQL. The evidence comes from git, against the last
  successful production deployment rather than the previous commit — a failed
  deploy leaves the bad file on `main`, where a commit-to-commit check would
  stop noticing it. Once applied, a migration is append-only: add a new file.
- **It does not smoke-test.** That needs a real lifetime key, spends a push from
  its daily quota, and writes to production R2 and D1 on every merge. `/health`
  on both hosts is the liveness check instead. Run `scripts/smoke.sh` by hand
  when the change warrants it.

What remains ungated is that a merge to `main` deploys with no pause. That is
the same exposure as the manual `wrangler deploy` it replaces, minus the laptop,
and closing it needs a billing plan that allows required reviewers.

## Rolling back

Every deploy creates an immutable version and Cloudflare keeps them all.

```bash
npx wrangler versions list          # ids, timestamps, and the commit in Message
npx wrangler rollback <version-id>
```

Or the dashboard: **Compute (Workers) → symposium → Deployments**, then
**⋯ → Rollback** on a version. The workflow passes `--message` so that list
reads as commits rather than uuids.

**Rollback reverts code and nothing else.** D1 rows and R2 objects written by
the bad version stay written, which is the other half of why migrations are not
applied from CI. Nothing records a rollback either, so the deployment records on
the repo page will name the commit that was deployed forward until the next
merge corrects them.

All changes ship through a pull request; never push to `main`.
