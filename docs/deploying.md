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
   and API host. Private sharing is optional and needs one more route, the
   wildcard `{ "pattern": "*.{your document host}/*", "zone_name": "{your document
   host}" }`, and its DNS record. Add both before you set `READER_SESSION_SECRET`:
   the Worker cannot see routes or DNS, so without them private documents can
   still be created but nobody can open them. See [Self-hosting](#self-hosting)
   under Private sharing.
3. Keep `SERVING_HOST` and `API_HOST` under `vars`, set to those same hosts. A
   fresh install has no legacy or retired host. `EMAIL_FROM` and the `send_email`
   block ship pointing at Brevilabs' sending address: set `EMAIL_FROM` and
   `allowed_sender_addresses` to an address on a domain you have onboarded to
   Email Service, or delete both if you do not use email (the binding needs
   Workers Paid).
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

### The product-analytics secret

The Worker can report publishing and readership counts to PostHog. It is off
until one secret is set, and there are two steps:

```bash
npx wrangler secret put POSTHOG_PROJECT_API_KEY   # the project's phc_ ingest key
```

Use the project's `phc_` ingest key, which authorizes capture and nothing else;
a `phx_` personal API key reads and writes the whole PostHog account and must
never go here. `ANALYTICS_ENVIRONMENT` is an ordinary var in `wrangler.jsonc`;
a self-hoster in another PostHog region adds a `POSTHOG_HOST` var beside it.

**Then declare the view-event limiter**, in the same `ratelimits` array as the
sign-in limiters below:

```jsonc
{ "name": "VIEW_EVENT_LIMITER", "namespace_id": "1005", "simple": { "limit": 60, "period": 60 } }
```

One event is sent per read of a public document, and `/d/{docId}` is the one
surface that answers without a credential — so without a bound the event volume
is a function of how much a document is read by anyone, including a loop. This
binding caps it at sixty events per document per minute, keyed by the document
so that a loop against one public url can only spend that page's allowance and
every other document keeps counting. A refused event never reaches the reader:
the document is served identically, with no delay and no extra header.

**Unlike the sign-in limiters, deleting this block does not mean "no limit" — it
means no view events at all.** Those protect your own D1 write budget, so an
absent one costs only your installation; this one is the only thing between an
anonymous public url and a metered PostHog bill, so its absence has to refuse
rather than allow. A deployment without it records publication events and no
readership. `namespace_id` is unique per account, like the sign-in and private-sharing
limiters below.

**Then set a billing limit on the PostHog project, before the deploy rather than
after it.** The limiter is per document; the bill is not, and the aggregate
worst case is still the number of published documents times that ceiling. Set it
in PostHog under **Billing → Set a billing limit**, on product analytics.

The two are not interchangeable and the billing limit is the weaker one: it caps
the invoice, and a tripped cap makes PostHog drop events for *every* document,
which is the feature going dark rather than a bill being bounded. The binding is
what keeps one looped url from reaching that state.
[Product analytics](analytics.md#cost-view-events-need-a-ceiling) has the
arithmetic, both rejected alternatives, and what the bound costs the numbers.

**Skipping all of this is supported and changes nothing else.** With no secret
the Worker makes no analytics request at all, which is the right default for an
installation nobody else is measuring. [Product analytics](analytics.md) is what
the events carry, what they deliberately never carry, and how to read a delivery
failure.

### The sign-in limiters

Four request shapes answer without a credential, because the caller has none
yet: the device-code mint and poll, the approval page's code lookup, and the
button that starts a handshake. Four Workers rate limiter bindings cover them,
declared in `wrangler.jsonc` alongside the analytics one above; polling needs
both its per-code interval and an aggregate ceiling on random misses:

```jsonc
"ratelimits": [
  { "name": "DEVICE_CODE_LIMITER", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } },
  { "name": "APPROVAL_LOOKUP_LIMITER", "namespace_id": "1002", "simple": { "limit": 20, "period": 60 } },
  { "name": "DEVICE_POLL_LIMITER", "namespace_id": "1003", "simple": { "limit": 1, "period": 10 } },
  { "name": "DEVICE_POLL_CLIENT_LIMITER", "namespace_id": "1004", "simple": { "limit": 20, "period": 10 } }
  // and VIEW_EVENT_LIMITER from the analytics step above, in this same array
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

`DEVICE_POLL_LIMITER` allows one poll per device code every ten seconds. It is
keyed by the hash of the secret code, so two machines behind one address do not
share a bucket and the raw credential never becomes limiter metadata. Keeping
the interval in the binding makes a pending poll a D1 read rather than a write.
`DEVICE_POLL_INTERVAL_SECONDS` is advertised to clients and has to match this
binding's `period`.

`DEVICE_POLL_CLIENT_LIMITER` runs first and allows twenty total polls per client
address every ten seconds. The per-code limiter cannot bound an attacker who
invents a fresh random code for every request; this aggregate bucket keeps those
D1 misses finite while remaining generous to devices behind a shared address.

**Deleting any of these four is supported.** A deployment that declares no
limiter puts no corresponding limit on that endpoint, which is the right answer
for a private deployment nobody else can reach. Without `DEVICE_POLL_LIMITER`,
the returned polling interval is advisory; without `DEVICE_POLL_CLIENT_LIMITER`,
random misses have no aggregate ceiling. Everything else works the same either
way. `VIEW_EVENT_LIMITER` is the exception and reads the other way round, for
the reason given with it above.

The limiter is not a D1 counter on purpose. A counter in a row costs a write for
every attempt including every refused one, so under sustained abuse the limiter
itself would exhaust the account's daily write budget — see
[cost at scale](cost-at-scale.md).

For a public deployment, add WAF rate limiting rules on `POST /device/code`,
`POST /device/token`, `/approve` and `/signin` as a second layer. The binding runs inside
the Worker, so a request it refuses has still been billed as a request; a WAF
rule refuses at the edge before that.

The checked-in GitHub Actions workflow is Brevilabs-specific. It names the
production database, domains, repository environment, and deployment records.
Deploy manually until you have adapted all of those values for your account.

`workers_dev` is disabled, so the Worker answers nowhere until the two custom
domains attach. The first deploy creates their DNS records; do not create
conflicting records by hand.

### The private-sharing limiters

Five more optional bindings protect the email, request and popover paths private
sharing adds. Each is declared in the same `ratelimits` array, with its own
`namespace_id`, and each follows the rule of the four above: **absent means no
limit**, and everything else works the same.

| Binding | Namespace | Allowance | Keyed by |
| --- | --- | --- | --- |
| `SIGNIN_EMAIL_LIMITER` | `1006` | 3 per 60 s | the address a sign-in code is sent to (hashed) |
| `SIGNIN_EMAIL_CLIENT_LIMITER` | `1009` | 10 per 60 s | the client address, so one caller cannot use the form to mail codes to many addresses |
| `INVITE_EMAIL_LIMITER` | `1007` | 20 per 60 s | the publisher (hashed), so a license key, its linked account and the share page draw on one allowance. Over it, the person is still added and only the email is skipped. |
| `REQUEST_ACCESS_LIMITER` | `1008` | 10 per 60 s | the requesting account (hashed). Over it, nothing is stored and the page still says "Request sent". It bounds both the rows an account can write and the emails those rows send owners. |
| `EMBED_TOKEN_LIMITER` | `1010` | 20 per 10 s | the client address. The Share popover's frame polls `POST /embed/token` every two seconds while a sign-in is in progress; this bounds a flood of misses against the D1 read budget and leaves room for several frames behind one address. |

Starting a Google or GitHub reader sign-in, and checking a code that was sent, are
counted by `APPROVAL_LOOKUP_LIMITER`, per client; the existing binding is reused,
not a sixth one. So is the Share popover's sign-in popup when it stores a handoff
for a signed-in reader (`GET /embed/sign-in`).

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

Every deploy creates an immutable version and Cloudflare keeps them all. There are
three hard floors, and the effective floor is **the newest of the three**. Once
the comments deploy ships, that is the comments floor.

- **The domain cutover.** Never activate a version older than the
  `Current Version ID` recorded in `Brevilabs/OpenArtifacts#47` while any of the
  two new domains or the retired API domain remains attached. Older versions
  route the new hosts by path, exposing the wrong surface, and make
  `api.symposium.md` a working API again.
- **Private sharing.** Never activate a version older than the first version that
  contains private sharing once any document is invited-only: older versions serve
  it publicly at its canonical url. See [Rollback floor](#rollback-floor).
- **Comments.** The first version that carries the `DocComments` Durable Object
  migration. Cloudflare refuses a rollback across a Durable Object class lifecycle
  change, so nothing can be activated below it. See
  [Comments rollback floor](#comments-rollback-floor).

```bash
npx wrangler versions list          # ids, timestamps, and the commit in Message
npx wrangler rollback <version-id>  # the newest of the floors, or later
```

Or the dashboard: **Compute (Workers) → symposium → Deployments**, then
**⋯ → Rollback** on a version at or above the newest recorded floor. Do not use
the default immediate-predecessor rollback for the initial cutover because that
predecessor is unsafe.

Use this procedure only while no document is invited-only (check
`SELECT COUNT(*) FROM docs WHERE link_access = 'invited'` against the remote
database). Once one is, a pre-cutover version serves its bytes to anyone with the
link on `symposium.site`: do not use this procedure, roll forward.

If a pre-cutover version is ever required, first detach all three of these custom
domains and verify none invokes this Worker:

- `openartifacts.site`;
- `api.openartifacts.ai`; and
- `api.symposium.md`.

Use **Compute (Workers) → symposium → Settings → Domains & Routes** and remove
those three entries from the Worker. Removing a DNS record alone is not enough.
Refresh that page and proceed only when `symposium.site` is the sole custom
domain still attached. Then roll back. Documents will serve natively on the old
host, but every API will be offline until a corrected four-host version is
deployed. This is the only pre-cutover rollback that keeps the retired API retired
and prevents cross-surface access. Never run `wrangler deploy` from an old
checkout: its config would reattach the old API.

Once the comments deploy is live, this pre-cutover procedure can no longer be
carried out: Cloudflare refuses any rollback below the comments floor, detached
domains or not.

**There is no equivalent emergency procedure below the private-sharing floor.**
Detaching domains does not help: any version below the private-sharing floor
serves an invited-only document's bytes to anyone with the link, on whatever
document host (the apex or the legacy `symposium.site`) it still answers on. Once
a document is invited-only, fix forward, with a new deploy.

**Rollback reverts code and nothing else.** D1 rows and R2 objects written by
the bad version stay written, which is the other half of why migrations are not
applied from CI. Nothing records a rollback either, so the deployment records on
the repo page will name the commit that was deployed forward until the next
merge corrects them.

All changes ship through a pull request; never push to `main`.


## Private sharing

The Worker that introduces private sharing needs four settings made once, before
the deploy, and each one is harmless to the Worker that is running now. Then the
launch is three merges in one sitting. [private-sharing.md](private-sharing.md)
says what each piece is for.

### One-time setup, before the deploy

1. **The signing secret.** At least 32 random characters; a shorter one counts as
   unset. Without it, or on a server that has no way to sign anyone in (see
   [Self-hosting](#self-hosting)), private sharing is off: the whole private
   family and `/embed/*` answer `404 not_found` exactly as the Worker running now
   does, no page carries the top bar or its script tag (the header byline stays),
   and a document that was never invited-only stays public.

   ```bash
   openssl rand -hex 32 | npx wrangler secret put READER_SESSION_SECRET
   ```

   Rotating it signs every reader out. **Removing it after documents have gone
   invited-only takes them offline and never makes them public:** the apex still
   sends them to `/open`, which answers `404`.
2. **The wildcard DNS record.** In the `openartifacts.site` zone, a proxied
   `*.openartifacts.site` record, `AAAA` to `100::`. The route that catches it,
   `*.openartifacts.site/*`, is in `wrangler.jsonc` (a custom domain cannot be a
   wildcard). Universal SSL already covers first-level wildcards. The Worker
   serves only a 26-character label there and fails closed on every other
   subdomain. This is one publisher origin per publisher
   (`{label}.openartifacts.site`), not one per document, so it is the only record
   and route needed however many documents there are.
3. **The sending domain.** Onboard `mail.openartifacts.ai` in Cloudflare Email
   Service (Compute → Email Service → Email Sending → Onboard Domain). The
   `send_email` binding (with `allowed_sender_addresses` pinned to the sender) and
   `EMAIL_FROM` (`share@mail.openartifacts.ai`) are in `wrangler.jsonc`; a
   subdomain keeps abuse off the brand domain's mail reputation. Without the
   binding no email is sent and the emailed-code form is not offered; Google and
   GitHub still work.
4. **Migration `0014`.** `npx wrangler d1 migrations apply symposium --remote`.
   The deploy workflow refuses to ship over an unapplied migration, and the
   running Worker ignores the new column and tables. Apply it from the pull
   request's final, approved head (the exact commit that will be merged), just
   before merging, never from an earlier draft: `0014` changed while the pull
   request was open, and the immutability check sees a file that is new since the
   last deploy as an addition, so it would not catch a draft's version having
   been applied.

Google and GitHub reader sign-in reuse the OAuth apps and the
`/approve/callback/{provider}` redirect URLs already registered for device
approval, so no new OAuth registration is needed. The five private-sharing
limiters are declared in `wrangler.jsonc` and described under
[The private-sharing limiters](#the-private-sharing-limiters).

Every paid plan includes private sharing, and the pull request sets it:
`"privateSharing": true` on the `pro` and `pro_lifetime` account plans in
`PLAN_LIMITS`, and any license plan that may publish (`plus`, `believer`) through
`PUBLISHING_PLANS` in `src/auth.ts`. It is not a step an operator performs.

### Launch, in one sitting

1. Merge the privacy policy and Terms change in `Brevilabs/app-sites`; it deploys
   on merge, so the legal copy is live first.
2. Merge the OpenArtifacts pull request. CI deploys the Worker; approve the npm
   release prompt. Its title is the CLI's next patch version, so the one merge
   also starts the CLI release.
3. Publish the Obsidian Copilot release, and announce.

If the deploy in step 2 fails, fix it before step 3. Until then, the legal pages
are the only visible change.

### Rollback floor

Once any document is invited-only, a Worker older than this deploy would serve it
publicly at its canonical url. **Never activate a version older than the first
version that contains private sharing.** After the deploy in step 2, record that
version's `Current Version ID`, the deployed commit SHA and the workflow-run link
in a comment on `Brevilabs/OpenArtifacts#95`, the issue that tracks this work, as
the cutover did on `#47`; that comment is the durable record. The effective floor
is the newer of this one and the cutover floor, and [Rolling back](#rolling-back)
says what to do instead of going below it: nothing, because there is no safe
pre-floor emergency rollback once a document is invited-only. Roll forward.

### Self-hosting

Private sharing needs no Brevilabs service, and a self-hoster gets the whole
feature. It is on when **reader sign-in is configured**, which is all of:

- `READER_SESSION_SECRET` set to at least 32 characters (step 1 above);
- `SERVING_HOST` and `API_HOST` set (the Worker's `vars`);
- at least one way to sign in: a Google or GitHub OAuth app (both halves of the
  pair, as for device approval) or Email Service for emailed codes.

Before you set the secret, also add the wildcard route `{ "pattern":
"*.{SERVING_HOST}/*", "zone_name": "{SERVING_HOST}" }` to `routes` and a proxied
wildcard DNS record `*.{SERVING_HOST}` `AAAA` to `100::` in the zone. These are
prerequisites the Worker cannot detect: with the four conditions above met but no
route or record, private documents can be created and switched to invited-only,
and nobody, the owner included, can open them.

Without a sign-in method, or without the secret, the server answers the family
`404` like a Worker that predates the feature, and clients say "this server does
not support private documents". Documents that were never invited-only stay
public. A document that is already invited-only goes offline instead, and is never
made public. The Worker's conditions are all or nothing: it is never half
configured.

**The document host must be a zone apex.** Universal SSL covers `*.example.net`
only when `example.net` is the zone. A document host that is itself a subdomain
(`docs.example.net`) would need a paid wildcard certificate for
`*.docs.example.net`, so use a registrable domain as the document host.

Optional pieces, none of which blocks the rest:

- **Google and GitHub.** Register the callback URLs as for device approval; nothing
  else is new.
- **Email Service**, for invite emails, request emails and sign-in codes. It needs
  Workers Paid and a sending domain you have onboarded. Set `EMAIL_FROM` and
  `allowed_sender_addresses` in `wrangler.jsonc` to an address on that domain. On a
  free plan, delete the `send_email` block and `EMAIL_FROM`; the access JSON then
  reports `"email": false`, the share page says "Invited · send them the link", and
  the owner sends the link themselves. A deployment with email and no OAuth app
  works too: codes are a complete sign-in method.
- **The five limiters** in [The private-sharing limiters](#the-private-sharing-limiters).

Plans are configuration. A seeded key with `plan = 'plus'` or `'believer'` gets
private sharing as it gets publishing, and browser accounts get it
through `"privateSharing": true` in your own `PLAN_LIMITS` plus `DEFAULT_PLAN`. The
license server stays optional. `scripts/smoke.sh` is unchanged; the private flow
needs a browser and is verified by hand: publish with `--private`, open the link
signed out, sign in, read, request access as another account, approve, remove, and
switch to `anyone`.

## Inline comments

Comments add a SQLite Durable Object, one D1 migration and two rate limiters. None
of it needs a new secret or service, and a SQLite-backed Durable Object is available
on the free Workers plan.

**Order for Brevilabs (and any deployment that applies migrations by hand):**

1. Apply the D1 migration **before** the deploy:
   `npx wrangler d1 migrations apply symposium --remote`. `0015_comments.sql` adds
   `docs.comments_enabled` (default `0`, so nothing turns on) and
   `accounts.display_name`. It is additive and backward compatible: the Worker
   that is live while it applies ignores both columns. The deploy workflow
   refuses to ship over an unapplied migration.
2. Deploy. `wrangler deploy` applies the Durable Object itself: the `COMMENTS`
   binding in `durable_objects.bindings` and the
   `migrations: [{"tag": "v1", "new_sqlite_classes": ["DocComments"]}]` block in
   `wrangler.jsonc` create the class as part of the upload, and the class must
   exist for a Worker that binds it to upload at all. It is not a separate command,
   and it is not part of the D1 migrations. A self-hoster adds both blocks to their
   config and nothing else. Keep the `tag` (and add later migrations with new tags);
   never edit a tag that has been applied.
3. The comment limiters are in the same deploy; see below.

**The comment limiters.** Two more optional `ratelimits` bindings, on the same
rule as the others (absent means no limit). `namespace_id` is unique across the
whole account:

| Binding | Namespace | Allowance | Keyed by |
| --- | --- | --- | --- |
| `COMMENT_WRITE_LIMITER` | `1011` | 30 per 60 s | the writing principal (hashed). Create, reply, resolve and reopen share it. |
| `COMMENT_EMAIL_LIMITER` | `1012` | 20 per 60 s | the document (hashed), over comment notification emails. |

**Plans.** Comments are a plan feature: add `"comments": true` to the plans that
should have them in your `PLAN_LIMITS` (Brevilabs: `pro` and `pro_lifetime`, not
`free`). License keys whose plan may publish (`PLUS`, `BELIEVER`) have them
without a flag. Nothing turns on by itself: each owner switches a document on.

**Self-hosting.** The feature is on when the Worker has the `COMMENTS` binding and
reader sign-in is configured ([Self-hosting](#self-hosting)). A deployment whose
config predates the binding is not broken: every comment route and the threads
resource answer `404`, the frame is absent and pages are served as before. Email is
optional; without it comments work and nobody is notified.

### Comments rollback floor

The first deploy that carries migration `v1` (`new_sqlite_classes: ["DocComments"]`)
is a hard rollback floor that Cloudflare enforces. `wrangler rollback`,
`wrangler versions deploy` and the dashboard Rollback all refuse a version older
than it, because a rollback cannot cross a Durable Object class lifecycle change.
After it ships, record its `Current Version ID`, the deployed commit SHA and the
workflow-run link in the tracking issue's record, as for the other two floors. It
supersedes them: the effective floor is now the newest of the three, which is this
one.

Comments cannot be backed out by rolling back. To turn them off in an incident,
roll forward: switch the affected documents off, remove `comments` from
`PLAN_LIMITS`, or deploy a build that answers `404` on the comment routes. Keep
the `COMMENTS` binding and the `migrations` entry in `wrangler.jsonc` in every
later version. Removing the class would be a further lifecycle change and deletes
the class's storage.

The Durable Object's storage and the D1 columns persist across any later deploy,
so rolling forward always finds every thread as it was.

## Standalone account launch order

Apply additive D1 migrations through `0012_newsletter_delivery.sql` before this Worker.
The unshipped revision/purpose migrations were replaced; do not apply their old
draft versions. Hosted `ACCOUNT_ACTION_URL` and `UPGRADE_URL` must both be
`https://openartifacts.ai/account`; CI and `npm run deploy` check this. Self-hosted
origins can omit the browser service and retain local plans.

Before enabling the landing offer, verify the private read-only entitlement
procedure and account page are deployed with matching server credentials, then
deploy this Worker and verify that three Free document creates succeed and a
fourth is rejected by the document limit. Publish the approved `v0.2.3` CLI release
and verify npm `latest` is `0.2.3` and a clean install exposes
`account --open`. Only then enable the landing entry point. No deploy, npm publish,
or payment-provider operation is authorized by these instructions alone.

A successful `openartifacts account` refresh is the paid-access verification step.
Its `refresh.status` reports failure explicitly. No background synchronization is
required. An outage retains a finite paid snapshot only until expiry; a lifetime
snapshot remains paid until a later successful pull. Withdrawals and listing do
not wait on the entitlement service.

### Linked-account rollback floor

Before enabling permanent owner links, record the first link-aware Worker version ID in the deployment record. After any owner link exists, never roll back below that version: older Workers ignore the associations and split histories and quotas. Later credential-rejection markers also require a rejection-aware rollback target; record the first version supporting migration 0011 as the new floor. Keep the additive schema when rolling back compatible code.

## Browser account sign-in

Deploy the Worker before the paired websites. Browser Google/GitHub sign-in
reuses the existing `device_codes` schema, OAuth provider registrations,
`ADMIN_API_KEY`, and `ACCOUNT_ACTION_URL`. It creates account access proofs only,
not publishing tokens, and needs no schema migration. Rolling back the Worker
disables browser sign-in while transient rows expire.

External account sign-in stays in the websites. The trusted website uses
`GET /admin/v1/external-owners/{owner}` to look up an association, and after
explicit consent uses `POST /admin/v1/accounts` to create a linked account or
the existing `PUT /admin/v1/accounts/{id}/external-owner` to link an account it
has separately authenticated. These routes need only the existing admin key.
No partner sign-in secret or partner proof endpoint is configured on the Worker.
Permanent associations survive website or Worker rollback.
