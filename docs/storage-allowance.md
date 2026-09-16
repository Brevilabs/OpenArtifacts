# Retained-content allowance

Storage accounting is separate from entitlement. `storage_usage` reserves one
row per immutable HTML object before the R2 write. The atomic reservation sums
both linked owners, including deleted documents and outstanding writes. A put
or metadata failure does not discard its reservation. Ordinary free, monthly,
legacy-license and existing manual plans keep their existing limits; recording
bytes does not by itself impose an allowance.

Withdrawal continues to mark the document deleted before removing its objects.
It credits only exact version keys whose R2 deletion has returned successfully.
A write arriving after the withdrawal's listing cleans up its own object and
reservation. A repeated credit is a no-op. There is no retention timer or
background cleanup job, and no automatic removal of a reader's content.

## Readiness and deployment order

Migration execution, deployment and CLI publication require separate operator
authorization. Keep the new allowance disabled in the entitlement service until
all of the following are verified:

1. Apply `0013_storage_usage.sql` and deploy this Worker. Older code does not
   reserve bytes, so do not roll back to it while issuing capped entitlements.
2. Reconcile historical R2 objects with the ledger during an authorized pause
   of uploads and withdrawals. The migration seeds **all** known version rows,
   including withdrawn ones, conservatively. It cannot discover an older R2
   write that never reached D1, or prove an old deletion actually succeeded.
3. For every document prefix, page through all R2 objects. For each
   `docs/{docId}/v{n}.html`, ensure a `storage_usage(doc_id,n,size)` row matches
   its actual byte size, even if the document is tombstoned or has no version
   metadata. Keep the document row: ownership and 410 behavior depend on it.
   Investigate objects without a document row; do not silently exclude them.
4. Remove a stale ledger entry only after confirming its exact R2 key is absent
   **and** no older upload can still complete. Do not derive absence from a
   missing version row, a timeout, a tombstone or an arbitrary reservation age.
   Retain an audit of checked prefixes, discrepancies and repairs. Recheck totals
   against the complete R2 inventory before restoring writes.
5. Verify an explicit allowance refresh, account figures, a bounded cap/reject/
   unshare/retry fixture, and unchanged existing plans before enabling the new
   signal. The CLI display addition can be released separately; older clients
   already handle the quota error and withdrawal commands.

For rollback after activation, stop issuing new capped grants/purchases and
coordinate existing grants before replacing the Worker. Reapply the inventory
check if any uploads bypassed accounting. Do not drop the ledger to make an
account fit.

## Recovering uncertain failures

An R2 timeout can mean stored bytes, and a failed withdrawal can leave objects
behind even though its URL correctly serves 410. These bytes remain charged.
The account command includes outstanding reservations in `usage.storedBytes`.

For an authorized recovery, quiesce writes for the affected account and its
linked identity, then inspect its document prefixes as above. Retry object
removal for **already withdrawn** documents; do not delete live content without
its owner's instruction. After confirmed removal, delete only the matching
ledger rows. An upload that never produced an object can have its reservation
removed only after proving there is no still-running write. Keep unresolved
entries charged and report them for investigation. Resume writes and verify the
account total and that withdrawn URLs still return 410.

This intentionally prefers temporary conservative accounting to granting space
while an uncertain write or deletion can still leave billable objects behind.
