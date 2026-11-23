-- NeuroLearn MySQL migration 001
-- Add stable graph mappings, concept-course associations, and sync outbox.
-- Apply once, manually, after reviewing database/mysql/README.md preflight steps.
-- Preflight: this migration is for an existing NeuroLearn database where
-- concept and knowledge_submissions already exist and both use InnoDB. Their
-- referenced ID columns must have compatible integer definitions. Ensure
-- learning_resource has neither graph_resource_id nor its unique index, and
-- that concept_course and knowledge_sync_outbox do not already exist. This is
-- a one-time migration; do not blindly rerun it.

ALTER TABLE learning_resource
    ADD COLUMN graph_resource_id VARCHAR(100) NULL,
    ADD UNIQUE KEY uq_learning_resource_graph_id (graph_resource_id);

CREATE TABLE concept_course (
    concept_id INT NOT NULL,
    course_graph_id VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (concept_id, course_graph_id),
    KEY idx_concept_course_graph_id (course_graph_id),
    CONSTRAINT fk_concept_course_concept FOREIGN KEY (concept_id)
        REFERENCES concept (concept_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE knowledge_sync_outbox (
    outbox_id BIGINT NOT NULL AUTO_INCREMENT,
    submission_id INT NOT NULL,
    sync_status ENUM('pending', 'processing', 'completed', 'failed')
        NOT NULL DEFAULT 'pending',
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_expires_at DATETIME NULL,
    claim_token CHAR(36) NULL,
    last_error TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    PRIMARY KEY (outbox_id),
    UNIQUE KEY uq_knowledge_sync_outbox_submission (submission_id),
    KEY idx_knowledge_sync_outbox_claim
        (sync_status, available_at, lease_expires_at, outbox_id),
    CONSTRAINT fk_knowledge_sync_outbox_submission FOREIGN KEY (submission_id)
        REFERENCES knowledge_submissions (submission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
