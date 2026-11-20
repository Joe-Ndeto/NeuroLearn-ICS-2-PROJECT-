-- NeuroLearn MySQL migration 004
-- Add an explicit marker for an administrator-authorized outbox replay.
-- Apply once, manually, after reviewing database/mysql/README.md preflight steps.
-- Preflight: confirm migrations 001, 002, and 003 have been applied, the
-- knowledge_sync_outbox table exists and uses InnoDB, and this column does not
-- already exist. This is a one-time migration; do not blindly rerun it.

ALTER TABLE knowledge_sync_outbox
    ADD COLUMN manual_retry_requested BOOLEAN NOT NULL DEFAULT FALSE
        AFTER attempt_count;
