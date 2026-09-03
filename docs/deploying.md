# Deploying

Provisioning the Cloudflare resources and shipping. If you have not used
Cloudflare before, read [Hosting](hosting.md) first — it explains what these
commands are creating.

[← README](../README.md) · [Hosting](hosting.md) · [HTTP API](http-api.md)

> **Brevilabs already has the Worker and storage.** The committed resource names
> and `database_id` belong to that production account. Do not run the
> provisioning commands below against Brevilabs. Its domain cutover is a
> separate one-deploy procedure later in this document.

## Self-host on a fresh Cloudflare account

You need a Cloudflare account, a checkout with `npx wrangler login` completed,
and two domains already added as Cloudflare zones:

- an API hostname on your brand domain; and
- a separate registrable domain for uploaded HTML.

Do not use a subdomain of the brand domain for documents. Uploaded pages may run
JavaScript, so a report against that origin must not affect the API or brand.
[Serving domain](serving-domain.md) explains the boundary.

First choose your own names and create the storage:

```bash
SELF_HOST_BUCKET=openartifacts-docs
SELF_HOST_DB=openartifacts

npx wrangler r2 bucket create "$SELF_HOST_BUCKET"
npx wrangler d1 create "$SELF_HOST_DB"
```

The D1 command prints a `database_id`. Edit `wrangler.jsonc` before continuing:

1. Give `name`, `bucket_name`, `database_name`, and `database_id` values from
   your account.
2. Replace `routes` with exactly two `custom_domain` entries: your document host
   and API host.
3. Keep only `SERVING_HOST` and `API_HOST` under `vars`, set to those same hosts.
   A fresh install has no legacy or retired host.
4. Leave `workers_dev` set to `false`.

Apply the schema, then seed one publisher. Authentication is not pluggable yet:
the hosted service validates Copilot keys against Brevilabs. A self-hoster can
omit both license-service variables and pre-seed a high-entropy bearer key. The
Worker stores only its SHA-256. Possession of the raw key grants publishing,
listing, updating, and deletion for the chosen `owner`, so keep it in a password
manager.

```bash
npx wrangler d1 migrations apply "$SELF_HOST_DB" --remote

SELF_HOST_KEY="$(openssl rand -hex 32)"
SELF_HOST_HASH="$(printf '%s' "$SELF_HOST_KEY" | shasum -a 256 | cut -d' ' -f1)"
SELF_HOST_NOW_MS="$(($(date +%s) * 1000))"
npx wrangler d1 execute "$SELF_HOST_DB" --remote --command \
  "INSERT INTO publishers (key_hash, owner, plan, validated_at)
   VALUES ('$SELF_HOST_HASH', 'self-hosted-owner', 'plus', $SELF_HOST_NOW_MS)"

npx wrangler deploy
OPENARTIFACTS_LICENSE_KEY="$SELF_HOST_KEY" \
  scripts/smoke.sh https://api.example.com
```

Replace `api.example.com` with your API host. Use the same `owner` for multiple
seeded keys that should manage one document shelf. `plus` and `believer` are the
two plan values currently allowed to publish. With the Brevilabs license
variables absent, unknown keys fail closed and seeded keys continue through the
existing license-outage fallback.

### The sign-in limiters

Three routes answer without a credential, because the caller has none yet: the
device-code mint, the approval page's code lookup, and the button that starts a
handshake. Two Workers rate limiter bindings cover them, declared in
`wrangler.jsonc`:

```jsonc
"ratelimits": [
  { "name": "DEVICE_CODE_LIMITER", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } },
  { "name": "APPROVAL_LOOKUP_LIMITER", "namespace_id": "1002", "simple": { "limit": 20, "period": 60 } }
]
```

`DEVICE_CODE_LIMITER` gives five codes a minute per client address, far above
one person signing in a machine or two. `period` accepts only `10` or `60`.
**`namespace_id` is unique across your whole account, not per Worker**, so if
you run another Worker with a limiter, give these numbers that Worker does not
use. `DEVICE_MINT_PERIOD_SECONDS`
in `src/config.ts` is the `Retry-After` a refusal carries and has to match
`period`; nothing else in the code reads these numbers, because the binding
reports a verdict and no counts.

The second limiter, `APPROVAL_LOOKUP_LIMITER`, covers the two approval routes
that take a user code: the page that looks one up and the button that starts a
handshake against it. Twenty a minute per address, and a separate
`namespace_id`, because the two limits protect different things. A mint writes a
row, so its limit is about the write budget; these read a row and conditionally
update one, and their limit is defence in depth behind the code's own 43 bits.
Sharing one bucket would also mean an ordinary sign-in spent three of it, and a
person who reloaded the approval page twice would be told their code had
expired.

**Deleting either block is supported.** A deployment that declares no limiter
puts no limit on those endpoints, which is the right answer for a private
deployment nobody else can reach. Failing closed instead would mean a Worker
that signs nobody in until its operator had read this page. Everything else
works the same either way.

The limiter is not a D1 counter on purpose. A counter in a row costs a write for
every attempt including every refused one, so under sustained abuse the limiter
itself would exhaust the account's daily write budget — see
[cost at scale](cost-at-scale.md).

For a public deployment, add a WAF rate limiting rule on `POST /device/code` and
`/approve` as a second layer. The binding runs inside the Worker, so a request it refuses has
still been billed as a request; a WAF rule refuses at the edge before that.

The checked-in GitHub Actions workflow is Brevilabs-specific. It names the
production database, domains, repository environment, and deployment records.
Deploy manually until you have adapted all of those values for your account.

`workers_dev` is disabled, so the Worker answers nowhere until the two custom
domains attach. The first deploy creates their DNS records; do not create
conflicting records by hand.

## Brevilabs one-deploy cutover

Brevilabs storage, migrations, Worker secrets, and both old domains already
exist. Wait until the `openartifacts.ai` and `openartifacts.site` zones and the
landing-page social image are ready, then merge the reviewed cutover change.
The resulting `main` workflow performs the only production deployment:

1. `api.openartifacts.ai` becomes the only working API.
2. `openartifacts.site` serves documents.
3. `symposium.site` redirects GET and HEAD with the exact path and query.
4. `api.symposium.md` stays attached but returns `410 Gone` for every method and
   path, before authentication.

Watch the workflow to completion. Record its printed `Current Version ID` as
the OpenArtifacts cutover floor, then verify the behavior end to end:

```bash
CUTOVER_RUN_ID="$(gh run list --repo Brevilabs/OpenArtifacts --workflow deploy.yml \
  --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$CUTOVER_RUN_ID" --repo Brevilabs/OpenArtifacts --exit-status

curl -sS -o /dev/null -w '%{http_code}\n' https://api.openartifacts.ai/health
curl -sS -o /dev/null -w '%{http_code}\n' https://openartifacts.site/health
curl -sS -o /dev/null -w '%{http_code}\n' https://api.symposium.md/health
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  'https://symposium.site/health?probe=cutover'

OPENARTIFACTS_LICENSE_KEY="$PAID_COPILOT_KEY" \
  scripts/smoke.sh https://api.openartifacts.ai
```

The four curl results must be `200`, `200`, `410`, and an exact `307` to
`https://openartifacts.site/health?probe=cutover`. The smoke script publishes,
reads, lists, deletes, and confirms the document's `410`. It spends one push and
leaves only the deleted D1 row required for that tombstone. Set
`PAID_COPILOT_KEY` in the operator shell before running it; do not paste that
key into this repository. Before closing the rollout, post the floor version
ID, the full deployed commit SHA, and the workflow-run link to
`Brevilabs/OpenArtifacts#47`; that issue is the durable rollback-floor record.

Wrangler activates the new Worker version before reconciling custom domains.
During that short window the old API already returns `410`, while the new API
may not be attached yet and the old document host may redirect to a target that
is not attached yet. If trigger reconciliation fails, the state is unavailable
but fail-closed: retry or roll forward. The one-deploy requirement deliberately
trades away a zero-downtime cutover and a pre-cutover rollback target.

## There is no workers.dev url

`workers_dev` is `false`. A fresh self-host answers nowhere until its custom
domains attach. That is deliberate, not an unfinished state.

The router resolves by an explicit host allowlist and fails closed on unknown
hosts once any host var is configured. It falls back to path prefixes only when
all host vars are empty, which is useful locally but would make a `workers.dev`
hostname serve `/d/*`. That would put user HTML on a domain we neither control
nor can afford to sacrifice. `workers.dev` is on the Public Suffix List, which makes
`<subdomain>.workers.dev` the unit a Safe Browsing listing applies to: one bad
upload would take down every Worker on the account's subdomain. The serving
domain exists precisely so the blast radius lands somewhere we chose.

For the Brevilabs cutover, add both new zones but do not attach their custom
domains by hand to the old router. The one CI deployment activates the
four-host router and then reconciles the routes. New API responses always return
document URLs on `openartifacts.site`.

## Later deploys happen in CI

Merging to `main` runs `.github/workflows/deploy.yml`, which typechecks, tests,
refuses to deploy over an unapplied migration, ships once, checks the canonical
hosts, legacy document redirect, and retired API host, and records what shipped
on the repo page. Nobody deploys Brevilabs production from a laptop during the
normal path.

It needs one secret, `CLOUDFLARE_API_TOKEN` — an *environment* secret on
`production`, never a repository one, for the reasons below. It is configured on
the Brevilabs repo; what follows is how it was built and how to rebuild it. The
token holds two account permissions: **Workers Scripts: Edit** to deploy, and
**D1: Edit** to read the `d1_migrations` table. It also needs the zone-level
**Workers Routes: Edit** permission so Wrangler can inspect and reconcile the
four custom domains. Not a Global API Key, which would also reach DNS and every
other zone setting. Create it under My Profile → API Tokens → Create Token; the
*Edit Cloudflare Workers* template is a fine starting point, but it does **not**
include D1, so add that row by hand. Scope Account Resources to the one account
and Zone Resources to `openartifacts.site`, `openartifacts.ai`,
`symposium.site`, and `symposium.md` specifically, which is what authorizes the
canonical, legacy, and retired custom-domain routes. Keep the `symposium.md`
scope: the retired API route remains attached intentionally. Leave Client IP
filtering empty: GitHub's runners have no stable egress IPs.

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
gh api repos/Brevilabs/OpenArtifacts/environments/production/deployment-branch-policies \
  --jq '.branch_policies[] | {name, type}'
```

Required reviewers would gate this further, but GitHub rejects that protection
rule on this billing plan for a private repo, so the branch policy is the whole
of the platform-level control.

Without the secret the workflow cannot run at all. Deploys then fall back to a
manual `npx wrangler deploy` from the reviewed `main` SHA, plus a remote
migration apply whenever a migration is added. For the cutover, that one manual
deploy replaces the one CI deployment; record its version id and run the same
four host checks before the smoke test.

Migrations remain manual in every case. Apply them remotely, then merge; the
workflow fails rather than applying one.

**That order leaves the old Worker running against the new schema**, from the
moment the migration lands until the deploy that follows the merge finishes.
Whatever the old code reads or writes that the migration changed will fail for
those few minutes. A migration must therefore be **backward compatible with the
Worker already deployed**: add nullable columns, do not drop or rename ones the
live code still uses, and split anything else into two releases — widen, deploy,
backfill, then narrow in a later migration.

The one migration that ignores this is `0002`, which drops and recreates every
table. It was applied before there were users or data, where a few minutes of
`500`s cost nothing. That licence expires the day someone else is publishing.

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
- **It does not smoke-test.** That needs a real paid license key, spends a push from
  its daily quota, and writes to production R2 and D1 on every merge. `/health`
  on the canonical, legacy, and retired hosts is the liveness check instead. Run
  `scripts/smoke.sh` by hand when the change warrants it.

What remains ungated is that a merge to `main` deploys with no pause. That is
the same exposure as the manual `wrangler deploy` it replaces, minus the laptop,
and closing it needs a billing plan that allows required reviewers.

## Rolling back

Every deploy creates an immutable version and Cloudflare keeps them all. The
OpenArtifacts cutover has a hard floor: never activate a version older than the
`Current Version ID` recorded in `Brevilabs/OpenArtifacts#47` while any of the
two new domains or the retired API domain remains attached. Older versions
route the new hosts by path, exposing the wrong surface, and make
`api.symposium.md` a working API again.

```bash
npx wrangler versions list          # ids, timestamps, and the commit in Message
npx wrangler rollback <version-id>  # cutover floor or newer only
```

Or the dashboard: **Compute (Workers) → symposium → Deployments**, then
**⋯ → Rollback** on a version at or above the recorded cutover floor. Do not use
the default immediate-predecessor rollback for the initial cutover because that
predecessor is unsafe.

If a pre-floor version is ever required, first detach all three of these custom
domains and verify none invokes this Worker:

- `openartifacts.site`;
- `api.openartifacts.ai`; and
- `api.symposium.md`.

Use **Compute (Workers) → symposium → Settings → Domains & Routes** and remove
those three entries from the Worker. Removing a DNS record alone is not enough.
Refresh that page and proceed only when `symposium.site` is the sole custom
domain still attached. Then roll back. Documents will serve natively on the old
host, but every API will be offline until a corrected four-host version is
deployed. This is the only pre-floor rollback that keeps the retired API retired
and prevents cross-surface access. Never run `wrangler deploy` from an old
checkout: its config would reattach the old API.

**Rollback reverts code and nothing else.** D1 rows and R2 objects written by
the bad version stay written, which is the other half of why migrations are not
applied from CI. Nothing records a rollback either, so the deployment records on
the repo page will name the commit that was deployed forward until the next
merge corrects them.

All changes ship through a pull request; never push to `main`.
