-- NeuroLearn MySQL migration 006
-- Store exact per-concept question and correct-answer counts for new results.
-- Both columns are nullable so historical rows remain unknown; no counts are
-- backfilled or inferred from percentage scores.
--
-- Apply manually once after preflight. Confirm quiz_result exists and that
-- neither column already exists; inspect partial prior applications before retrying.

ALTER TABLE quiz_result
    ADD COLUMN question_count INT UNSIGNED NULL,
    ADD COLUMN correct_count INT UNSIGNED NULL;
