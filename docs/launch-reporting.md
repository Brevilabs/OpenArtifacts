# Launch reporting

These signals describe publishing and account linking. They do not attribute
website visits to installs, CLI use, payment, or publication.

## Observed publishing refusals

The existing Worker console emits `publishing_limit_reached` with exactly two
fields: `limit` (`documents`, `pushesPerDay`, or `htmlBytes`) and `authKind`
(`account` or `license`). No owner, document ID, URL, content, title, email, token,
plan name, upgrade URL, or error message is included in this event.

The event is emitted when `limitReached` returns an account-plan refusal. Current
legacy license quota/size errors use their existing response paths and do not
emit it. Repeated attempts count repeatedly; this is not a unique-user count.
Successful pushes, suspension, authentication failures and foreign-document
errors do not emit this event. Its response contract is unchanged.

`wrangler.jsonc` enables observability. The repository does not explicitly set
sampling or retention; deployed capture settings and retention have not been
verified here. Label any log-derived totals **observed refusals**, with the query
interval and available log coverage. Do not present them as exhaustive totals.
Use the event name and enum fields in existing Worker logs; no new analytics
service or per-refusal database write is required.

## Persisted publication and account-link aggregates

[scripts/launch-report.sql](../scripts/launch-report.sql) is a read-only report over
existing D1 rows. Make a local copy, edit its two UTC dates, and verify the target
database and half-open interval before running it with authorized database access.
For a disposable local database, the command is:

```sh
npx wrangler d1 execute DB --local --file /absolute/path/launch-report.sql
```

For a deployment, use its normal approved read-only database access. This change
does not execute production queries or alter Cloudflare configuration. Retain the
query, interval, execution time and aggregate output together for comparison.
An absent day/metric row means zero matching records in the current database.

- `first_persisted_publication` counts each currently joined publisher once, on
  the earliest retained `versions.created_at`, across all their documents.
  Withdrawn documents still count; failed empty reservations do not. It counts
  persisted version evidence, not proof that an HTTP success reached the client.
  The timestamp is the push's recorded time, not a database commit timestamp.
- `immutable_account_link` counts `owner_links.created_at`, independently of
  publication. It proves an association was stored, not entitlement delivery,
  paid eligibility, or completion of a private service's synchronization.

The report groups external owners through their current immutable association.
Linking two histories can move or merge a first-publication cohort, including
moving it outside an earlier report's interval. Historical cohorts can therefore
restate after a link. The report deliberately considers all retained version
history before filtering dates; filtering versions first would count returning
publishers as new. Deleted version records cannot be reconstructed by this query.
No identifiers or document content appear in its output. Billing acquisition and
renewal reporting belongs to the private billing service, not this Worker.
