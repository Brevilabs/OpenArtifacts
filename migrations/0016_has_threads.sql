-- Whether a document has ever had a thread: the "a thread exists" half of "this
-- page has comments" (the other half is a person on the list at role `comment`
-- or above). Additive: the running Worker ignores the column, so this can be
-- applied before the Worker that uses it ships.
--
-- The service sets it to 1 before every thread create and never clears it. It is
-- rebuildable: a document has threads exactly when `docs/{id}/threads.json` in R2
-- holds one. A thread could only be written while the owner had switched comments
-- on, so every such document is marked: a mark with no thread costs that page one
-- threads request, and a missing one would hide its threads.
--
-- The invites are not touched here. 0014 defaulted every invite to `comment`,
-- which meant nothing while a document's comments were off, and the new rule makes
-- it a grant. Lowering those must read the owner's last switch, which the old
-- Worker can still change until the deploy, so it runs after the deploy, with the
-- rest of the reconciliation (docs/deploying.md).
ALTER TABLE docs ADD COLUMN has_threads INTEGER NOT NULL DEFAULT 0;
UPDATE docs SET has_threads = 1 WHERE comments_enabled = 1;
