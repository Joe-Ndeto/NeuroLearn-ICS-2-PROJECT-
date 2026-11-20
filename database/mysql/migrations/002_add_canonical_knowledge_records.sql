-- NeuroLearn MySQL migration 002
-- Add canonical prerequisite records and outbox-to-canonical-record mapping.
-- Apply once, manually, after reviewing database/mysql/README.md preflight steps.
-- Preflight: migration 001_add_knowledge_sync_outbox.sql must already have
-- been applied. The concept and knowledge_sync_outbox tables, and the tables
-- referenced by their foreign keys, must exist and use InnoDB. Confirm that
-- knowledge_sync_outbox is empty before adding NOT NULL canonical reference
-- columns; existing tasks cannot be assigned canonical records safely or
-- automatically. This is a one-time migration; do not blindly rerun it.

CREATE TABLE concept_prerequisite (
    prerequisite_id INT AUTO_INCREMENT PRIMARY KEY,
    prerequisite_concept_id INT NOT NULL,
    target_concept_id INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_concept_prerequisite_pair
        (prerequisite_concept_id, target_concept_id),
    KEY idx_concept_prerequisite_target (target_concept_id),
    CONSTRAINT fk_concept_prerequisite_prerequisite
        FOREIGN KEY (prerequisite_concept_id)
        REFERENCES concept (concept_id),
    CONSTRAINT fk_concept_prerequisite_target
        FOREIGN KEY (target_concept_id)
        REFERENCES concept (concept_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE knowledge_sync_outbox
    ADD COLUMN canonical_record_type
        ENUM('CONCEPT', 'PREREQUISITE', 'RESOURCE') NOT NULL,
    ADD COLUMN canonical_record_id INT NOT NULL;
