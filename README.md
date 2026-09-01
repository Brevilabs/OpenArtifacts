# OpenArtifacts

OpenArtifacts turns rendered HTML into a public, versioned link. Publishers use
an authenticated HTTP API; readers open the result without an account. The
Worker stores document bytes in Cloudflare R2 and ownership, version, and
deletion metadata in D1.

Today it is a small API-first publishing service. Obsidian Copilot is the first
client. The longer-term product is a shared artifact where people and agents
comment and iterate together, but reader accounts, permissions, and comments do
not exist yet.

## What works today

- **Publish rendered HTML.** Send a complete HTML document and get a public link.
  Copilot renders Obsidian notes locally so callouts, wikilinks, and Dataview
  output survive.
- **Keep one stable link.** Every push creates a new version. The shared link
  shows the latest version, while pinned `/v2`-style links keep showing the
  version they name.
- **Read without signing in.** Publishing needs a bearer key. Reading needs
  nothing.
- **Keep pages out of search results.** Serving responses carry `noindex`
  directives.
- **Run interactive documents.** Scripts, charts, and simulations work. Pages
  cannot submit forms or be embedded by another site.
- **List and unshare documents.** Deleting destroys the stored files and leaves
  a `410 Gone` tombstone. Copies already in a reader's browser cache cannot be
  recalled.
- **Bound abuse.** The current limits are 10 MB per document, 100 pushes per UTC
  day, and 500 live documents per owner.

On the Brevilabs-hosted service, publishing is included for active Copilot Plus
and lifetime Supporter/Believer users. Keys are checked against the Brevilabs
license service and cached for an hour. A self-hosted deployment can instead
seed its own publisher key in D1; see [Self-host on Cloudflare](#self-host-on-cloudflare).

## Run locally

Requires Node.js 20 or newer. Local development uses the real Workers runtime
with local R2 and D1 data, but needs no Cloudflare account.

```bash
npm install
npm run typecheck
npm test

# Create the local schema and one local publisher.
npx wrangler d1 migrations apply symposium --local
KEY=local-development-key
HASH=$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1)
npx wrangler d1 execute symposium --local --command \
  "INSERT OR REPLACE INTO publishers (key_hash, owner, plan, validated_at)
   VALUES ('$HASH', 'local-owner', 'plus', $(($(date +%s) * 1000)))"

npm run dev
```

In another terminal, exercise the whole publish, read, list, and delete path:

```bash
OPENARTIFACTS_LICENSE_KEY=local-development-key \
  scripts/smoke.sh http://127.0.0.1:8787
```

`local-development-key` is deliberately easy to copy and is only for local
development. Use a generated high-entropy key for any internet-facing
deployment. [Development](docs/development.md) explains the runtime and auth
cache in more detail.

## Self-host on Cloudflare

OpenArtifacts can run in a fresh Cloudflare account without the Brevilabs
license service. You need Workers, R2, D1, and two domains in that account:

- an API hostname on your brand domain; and
- a separate registrable domain for untrusted document HTML.

The separation is important. A document that is reported as phishing should
not take down your API or brand domain. [Serving domain](docs/serving-domain.md)
explains the boundary.

The self-host path is:

1. Create your own Worker, R2 bucket, and D1 database.
2. Replace the Brevilabs resource names, IDs, routes, and host variables in
   `wrangler.jsonc` with your own two hosts.
3. Apply the D1 migrations remotely.
4. Generate a bearer key and insert only its SHA-256 into `publishers` with a
   stable owner and the `plus` plan.
5. Leave `LICENSE_API_URL` and `LICENSE_API_KEY` unset, deploy manually, and run
   the smoke test against your API host.

[Deploying](docs/deploying.md#self-host-on-a-fresh-cloudflare-account) contains
the complete commands. The checked-in GitHub Actions deployment is specific to
Brevilabs. Do not give it a Cloudflare token until you have adapted its account,
database, domain, and deployment-environment settings.

## Brevilabs-hosted service

The cutover deployment establishes this mapping:

| Host | Role |
| --- | --- |
| [openartifacts.site](https://openartifacts.site) | Canonical document host. User HTML lives here and never on the brand domain. |
| [api.openartifacts.ai](https://api.openartifacts.ai) | Canonical publisher API. Key-authenticated, with no browser surface. |
| [symposium.site](https://symposium.site) | Legacy document host. Redirects the exact path and query to `openartifacts.site`. |
| [api.symposium.md](https://api.symposium.md) | Retired API host. Every method and path returns `410 Gone`; it does not serve or redirect authenticated requests. |
| [Cloudflare dashboard](https://dash.cloudflare.com/960579f222ad237394703bd52f28114c/workers/services/view/symposium/production) | Brevilabs deployments, versions, logs, and rollback controls. |

Merges to `main` deploy through [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).
The domain cutover is one CI deployment. That version becomes the rollback
floor: while either new canonical domain or the retired API domain remains
attached, no older version is a safe rollback target.
[Deploying](docs/deploying.md#rolling-back) explains the tradeoff and recovery
path.

## What's coming

Roughly in order. Nothing below is started.

- **Caching with delete purging.** Cloudflare does not cache these extensionless
  HTML URLs by default. The cache rule and purge-on-delete behavior must ship
  together so an unshared document does not remain readable at the edge.
- **Backups independent of D1.** Today D1 is the only record of ownership,
  titles, and deletion state. Per-document manifests in R2 will make that index
  rebuildable.
- **Version retention.** Every push is kept forever today. Agents will make that
  expensive sooner than people do.
- **A standalone publishing subscription.** Paid Copilot plans include
  publishing today; a standalone option is planned.
- **The collaboration product.** Comments anchored to passages, agent-drafted
  replies for human approval, and version-to-version diffs.

The product argument and non-retrofittable constraints are in
[Positioning](docs/positioning.md) and [Cost at scale](docs/cost-at-scale.md).

## Documentation

| Document | Contents |
| --- | --- |
| [HTTP API](docs/http-api.md) | The frozen endpoint and response contract used by Obsidian Copilot. |
| [Development](docs/development.md) | Local Workers, R2, D1, and publisher auth. |
| [Deploying](docs/deploying.md) | Fresh-account self-hosting and Brevilabs production operations. |
| [Hosting](docs/hosting.md) | How Workers, R2, and D1 fit together. Start here if your reference point is Vercel. |
| [Serving domain](docs/serving-domain.md) | Why uploaded HTML uses a separate registrable domain. |
| [Identity](docs/identity.md) | Why documents belong to an owner rather than a credential. |
| [Private sharing](docs/private-sharing.md) | Designed reader-identity phases. Not built. |
| [Comments](docs/comments.md) | Design sketch for the next product step. Not built. |
| [Positioning](docs/positioning.md) | Why the product exists and what it becomes. |
| [Cost at scale](docs/cost-at-scale.md) | Cost model, pricing assumptions, and scaling constraints. |
