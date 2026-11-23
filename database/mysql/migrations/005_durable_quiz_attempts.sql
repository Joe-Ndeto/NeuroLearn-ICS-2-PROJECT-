-- NeuroLearn MySQL migration 005
-- Persist quiz attempts and link each attempt to at most one assessment.
-- This milestone intentionally does not add quiz_result.question_count or
-- quiz_result.correct_count; those are reserved for M7B-2B.
--
-- Apply manually once, after checking the preflight requirements in the
-- project database documentation. Do not blindly rerun this migration.
-- Preflight: migrations 001-004 are reviewed/applied as appropriate;
-- quiz_attempt does not exist; assessment.quiz_attempt_id and its index/FK do
-- not exist; learner, uploaded_document, and assessment use InnoDB; their IDs
-- have compatible types; and uploaded_document.document_id is a valid FK target.

CREATE TABLE quiz_attempt (
    quiz_id CHAR(36) NOT NULL,
    learner_id INT NOT NULL,
    document_id INT NOT NULL,
    questions_json JSON NOT NULL,
    status ENUM('open', 'submitted', 'expired') NOT NULL DEFAULT 'open',
    expires_at DATETIME NOT NULL,
    answers_hash CHAR(64) CHARACTER SET ascii NULL,
    response_json JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    submitted_at DATETIME NULL,
    PRIMARY KEY (quiz_id),
    KEY idx_quiz_attempt_learner_created (learner_id, created_at),
    KEY idx_quiz_attempt_document (document_id),
    KEY idx_quiz_attempt_expiry (status, expires_at),
    CONSTRAINT fk_quiz_attempt_learner FOREIGN KEY (learner_id)
        REFERENCES learner (learner_id),
    CONSTRAINT fk_quiz_attempt_document FOREIGN KEY (document_id)
        REFERENCES uploaded_document (document_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE assessment
    ADD COLUMN quiz_attempt_id CHAR(36) NULL,
    ADD UNIQUE KEY uq_assessment_quiz_attempt (quiz_attempt_id),
    ADD CONSTRAINT fk_assessment_quiz_attempt
        FOREIGN KEY (quiz_attempt_id) REFERENCES quiz_attempt (quiz_id);
