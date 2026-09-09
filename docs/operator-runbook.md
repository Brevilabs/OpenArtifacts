# Publisher suspension and document removal

Use the trusted service API on the configured API host. These operations require
`ADMIN_API_KEY`; publisher tokens and license keys cannot call them. Never put a
credential in a report, URL, issue, transcript, or committed script.

1. Record the reported URL and reason privately. Verify the exact serving host,
   document ID and any pinned version. Inspect suspicious content in an isolated
   browser without signing in or following its links.
2. Identify the publisher from the document's D1 `docs.owner` row using authorized
   database access. Inspect `owner_links` for its joined identity. Do not infer
   identity from email, page content, or the person submitting the report.
3. Verify the deployment, document ID, owner and intended action before changing
   anything. Suspension blocks future publishing; removal permanently withdraws
   one document. Neither refunds a payment or changes a plan.

Load the service secret into `ADMIN_API_KEY` through your normal secret manager.
Set `API_ORIGIN` to the verified API origin and `OWNER` / `DOC_ID` to the exact
verified targets. Disable shell tracing. The examples pass authorization through
stdin rather than a process argument; do not capture curl input in logs.

```sh
printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_API_KEY" |
  curl --config - --fail-with-body -X PUT \
    -H 'Content-Type: application/json' --data '{"suspended":true}' \
    "$API_ORIGIN/admin/v1/publishers/$OWNER/suspension"

printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_API_KEY" |
  curl --config - --fail-with-body -X DELETE \
    "$API_ORIGIN/admin/v1/docs/$DOC_ID"
```

Suspension returns `{owner,suspended:true}`. It applies to both joined identities,
including an identity linked later. Existing pages remain readable; publishers
can still list and unshare, manage tokens, and inspect their account. New creates
and updates return `403 publisher_suspended`; another owner's or withdrawn doc
still returns `404`. A version committed before suspension remains published.
To restore publishing after review, repeat the PUT with `{"suspended":false}`.
This removes suspension records across the whole current joined identity.

Removal returns `204` only after the document's R2 prefix is cleared. D1 is
marked deleted first and its tombstone is permanent. If cleanup returns `500`,
retry the same DELETE: the document is already withdrawn and the retry finishes
removing leftover objects. An unknown ID returns `404`. Verify both the current
URL and a previously published pinned URL return `410`, and verify the R2 prefix
is empty after success. Record the target, outcome and verification privately.
Removal cannot recall copies readers already saved. No shared edge cache is
currently enabled; enabling one requires cache purge support before rollout.
