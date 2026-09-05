-- Additive only: preserve every account, token and document. Deploy before the Worker.
-- Existing accounts start on the generic free plan; new ones use DEFAULT_PLAN.
ALTER TABLE accounts ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
