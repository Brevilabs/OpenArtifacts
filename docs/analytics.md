# Product analytics

Symposium deliberately splits product analytics by surface:

- Successful authenticated publishing operations go to the existing Brevilabs
  PostHog project.
- Public document requests remain in Cloudflare's aggregate HTTP analytics.

Published pages do not load a PostHog SDK, set analytics cookies, or identify a
reader. No document id, url, title, content, license key, storage key, exact
size, raw error, referrer, IP address, or reader identifier is sent to PostHog.

## PostHog publishing events

The Worker emits these events only after a successful API response:

| API operation | Event | Properties |
| --- | --- | --- |
| `POST /api/v1/docs` (`201`) | `symposium_publish` | `distinct_id`, `operation=create`, `service=symposium`, `environment`, `$process_person_profile=false` |
| `PUT /api/v1/docs/{id}` (`200`) | `symposium_publish` | `distinct_id`, `operation=update`, `service=symposium`, `environment`, `$process_person_profile=false` |
| `DELETE /api/v1/docs/{id}` (`204`) | `symposium_unshare` | `distinct_id`, `service=symposium`, `environment`, `$process_person_profile=false` |

`distinct_id` is the Brevilabs account id authentication already resolves as
the document owner. Capture runs through `ExecutionContext.waitUntil()`, so an
analytics outage never delays or changes the publishing response.

`POSTHOG_HOST` and `ENVIRONMENT` are non-secret bindings in `wrangler.jsonc`.
Configure the project ingest key once on the deployed Worker:

```bash
npx wrangler secret put POSTHOG_PROJECT_API_KEY
```

Use the project's `phc_...` ingest key, not a `phx_...` personal API key. For
local development, copy `.dev.vars.example` to the ignored `.dev.vars` file.
When the secret is absent, capture is disabled.

PostHog trends can report:

- documents created: count `symposium_publish` where `operation=create`;
- unique creators: unique users for that same series;
- repeat publishing: count `symposium_publish` where `operation=update`;
- documents withdrawn: count `symposium_unshare`.

## Recent public document views in Cloudflare

Cloudflare already receives every request to `symposium.site`. Use its GraphQL
Analytics API to count successful end-user document `GET`s without exporting a
document path or reader identifier to another system.

Create a Cloudflare API token with read access to the `symposium.site` zone's
analytics and set these shell variables locally; neither belongs in this repo:

```bash
export CLOUDFLARE_ANALYTICS_TOKEN="..."
export CLOUDFLARE_ZONE_TAG="..."
```

This query counts successful `GET /d/*` requests on only the serving hostname.
It excludes `HEAD`, API traffic, health checks, cache-purge traffic, errors, and
redirects. `200` and `304` are included because both mean a reader successfully
used a document representation.

```bash
curl --silent https://api.cloudflare.com/client/v4/graphql \
  --header "Authorization: Bearer $CLOUDFLARE_ANALYTICS_TOKEN" \
  --header "Content-Type: application/json" \
  --data @- <<JSON | jq .
{
  "query": "query DocumentViews($zoneTag: string, $start: Time, $end: Time) { viewer { zones(filter: { zoneTag: $zoneTag }) { views: httpRequestsAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_lt: $end, clientRequestHTTPHost: \"symposium.site\", clientRequestHTTPMethod: \"GET\", clientRequestPath_like: \"/d/%\", requestSource: \"eyeball\", OR: [{ edgeResponseStatus: 200 }, { edgeResponseStatus: 304 }] }) { count avg { sampleInterval } confidence(level: 0.95) { count { estimate lower upper sampleSize } } } } } }",
  "variables": {
    "zoneTag": "$CLOUDFLARE_ZONE_TAG",
    "start": "2026-08-01T00:00:00Z",
    "end": "2026-09-01T00:00:00Z"
  }
}
JSON
```

`count` is the estimated request total. The confidence fields and
`sampleInterval` make adaptive sampling visible. It is a view/request metric,
not a count of people: reloads and unidentified bots can contribute.

### Discover the account-specific retention window

Cloudflare retention and maximum query duration depend on the zone's plan and
the token's access. Query the settings node instead of assuming a plan window:

```bash
curl --silent https://api.cloudflare.com/client/v4/graphql \
  --header "Authorization: Bearer $CLOUDFLARE_ANALYTICS_TOKEN" \
  --header "Content-Type: application/json" \
  --data @- <<JSON | jq '.data.viewer.zones[0].settings.httpRequestsAdaptiveGroups'
{
  "query": "query AnalyticsLimits($zoneTag: string) { viewer { zones(filter: { zoneTag: $zoneTag }) { settings { httpRequestsAdaptiveGroups { enabled maxDuration notOlderThan maxPageSize } } } } }",
  "variables": { "zoneTag": "$CLOUDFLARE_ZONE_TAG" }
}
JSON
```

`notOlderThan` is retention in seconds; `maxDuration` is the widest time range
one query may cover. Record the observed production values when access to the
owning Cloudflare account is available.

Cloudflare recent analytics is the current view destination. If the team later
needs a permanent all-time history beyond `notOlderThan`, add a separate design
that persists only daily aggregate totals. Do not add per-view PostHog events or
reader identifiers.
