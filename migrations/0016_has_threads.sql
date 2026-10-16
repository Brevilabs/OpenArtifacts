-- Whether a document has ever had a thread: the "a thread exists" half of "this
-- page has comments" (the other half is a person on the list at role `comment`
-- or above). Additive: the running Worker ignores the column, so this can be
-- applied before the Worker that uses it ships. The second statement is the one
-- data change: see below.
--
-- The service sets it to 1 after every successful thread create and never
-- clears it. It is rebuildable: a document has threads exactly when
-- `docs/{id}/threads.json` in R2 holds one. No existing row has threads (comments
-- were never on for any document), so 0 is right for every row.
ALTER TABLE docs ADD COLUMN has_threads INTEGER NOT NULL DEFAULT 0;

-- Every invite stored so far has role `comment`, because 0014 defaulted to it, but
-- while comments were off for a document that role changed nothing. The new rule
-- makes `comment` mean "may comment", so a person an owner never meant to allow
-- would start commenting at the deploy. Lower them to `view`, the role they have
-- held in effect; documents whose owner switched comments on keep theirs.
UPDATE doc_invites SET role = 'view'
 WHERE doc_id IN (SELECT id FROM docs WHERE comments_enabled = 0);
