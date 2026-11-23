-- NeuroLearn MySQL migration 008
-- Preserve four-decimal mastery values produced by masteryCalculator.js.
-- Preflight the live definition first. Expected: DECIMAL(5,2) NULL DEFAULT 0.
-- Do not apply blindly if type, nullability, or default differs.
-- This DDL widens the scale; it does not recalculate existing mastery values.

ALTER TABLE learning_path
    MODIFY COLUMN mastery_level DECIMAL(7,4) NULL DEFAULT 0;
