-- NeuroLearn migration 009: canonical course submissions and course prerequisites.
-- Preflight: verify migrations 001-008 are applied; inspect and preserve all
-- existing knowledge_sync_outbox task types and states (the queue need not be
-- empty); verify the worker is paused; and confirm the new tables/enum values
-- are not already present. Stop on partial state rather than rerunning. This
-- DDL is not fully transactional in MySQL; take a backup and apply statements
-- in order. Existing graph courses and concept mappings are not imported or changed.

ALTER TABLE knowledge_submissions
    MODIFY submission_type ENUM('CONCEPT', 'PREREQUISITE', 'RESOURCE', 'COURSE', 'COURSE_PREREQUISITE') NOT NULL;

ALTER TABLE knowledge_sync_outbox
    MODIFY canonical_record_type ENUM('CONCEPT', 'PREREQUISITE', 'RESOURCE', 'COURSE', 'COURSE_PREREQUISITE') NOT NULL;

CREATE TABLE course (
    course_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    graph_course_id VARCHAR(100) NOT NULL,
    title VARCHAR(200) NOT NULL,
    normalized_title VARCHAR(200) NOT NULL,
    description TEXT,
    difficulty_level ENUM('Beginner', 'Intermediate', 'Advanced') NOT NULL,
    created_by INT NOT NULL,
    approved_by INT NOT NULL,
    approved_submission_id INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_course_graph_id (graph_course_id),
    UNIQUE KEY uq_course_normalized_title (normalized_title),
    UNIQUE KEY uq_course_approved_submission (approved_submission_id),
    CONSTRAINT fk_course_creator FOREIGN KEY (created_by) REFERENCES learner (learner_id),
    CONSTRAINT fk_course_approver FOREIGN KEY (approved_by) REFERENCES learner (learner_id),
    CONSTRAINT fk_course_submission FOREIGN KEY (approved_submission_id) REFERENCES knowledge_submissions (submission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE course_prerequisite (
    course_prerequisite_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    prerequisite_course_id INT NOT NULL,
    target_course_id INT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_course_prerequisite_pair (prerequisite_course_id, target_course_id),
    KEY idx_course_prerequisite_target (target_course_id),
    CONSTRAINT fk_course_prerequisite_source FOREIGN KEY (prerequisite_course_id) REFERENCES course (course_id),
    CONSTRAINT fk_course_prerequisite_target FOREIGN KEY (target_course_id) REFERENCES course (course_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
