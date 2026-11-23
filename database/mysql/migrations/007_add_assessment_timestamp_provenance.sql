-- NeuroLearn MySQL migration 007
-- Record whether assessment_date has verified UTC provenance.
-- Existing rows receive the safe 'unknown' default. This migration only adds
-- metadata; it does not change assessment dates, scores, or historical rows.
--
-- Preflight: inspect assessment and confirm timestamp_provenance is absent.
-- If it exists or a prior attempt was partial, inspect the actual definition
-- before proceeding; do not blindly rerun this migration.

ALTER TABLE assessment
    ADD COLUMN timestamp_provenance ENUM('unknown', 'utc')
        NOT NULL DEFAULT 'unknown';
