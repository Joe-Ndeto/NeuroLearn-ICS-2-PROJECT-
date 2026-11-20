-- NeuroLearn MySQL migration 003
-- Add the optional canonical concept difficulty value.
-- Apply once, manually, after reviewing database/mysql/README.md preflight steps.
-- Preflight: confirm migration 001 and 002 have been applied, the concept table
-- exists and uses InnoDB, and difficulty_level does not already exist. This is
-- a one-time migration; do not blindly rerun it.

ALTER TABLE concept
    ADD COLUMN difficulty_level VARCHAR(50) NULL AFTER description;
