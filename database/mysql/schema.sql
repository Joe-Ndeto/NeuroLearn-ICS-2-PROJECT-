CREATE TABLE learner (
    learner_id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NULL,
    google_id VARCHAR(255) NULL,
    role ENUM('student', 'admin') NOT NULL DEFAULT 'student',
    UNIQUE KEY uq_learner_google_id (google_id)
);

CREATE TABLE concept (
    concept_id INT AUTO_INCREMENT PRIMARY KEY,
    concept_name VARCHAR(150) NOT NULL UNIQUE,
    description TEXT,
    difficulty_level VARCHAR(50) NULL,
    graph_concept_id VARCHAR(100) NULL,
    UNIQUE KEY uq_concept_graph_id (graph_concept_id)
);

CREATE TABLE concept_course (
    concept_id INT NOT NULL,
    course_graph_id VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (concept_id, course_graph_id),
    KEY idx_concept_course_graph_id (course_graph_id),
    CONSTRAINT fk_concept_course_concept FOREIGN KEY (concept_id)
        REFERENCES concept (concept_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

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

CREATE TABLE knowledge_submissions (
    submission_id INT NOT NULL AUTO_INCREMENT,
    submission_type ENUM('CONCEPT', 'PREREQUISITE', 'RESOURCE') NOT NULL,
    submission_data JSON NOT NULL,
    status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
    submitted_by INT NOT NULL,
    reviewed_by INT DEFAULT NULL,
    review_notes TEXT,
    submitted_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP NULL DEFAULT NULL,
    PRIMARY KEY (submission_id),
    KEY fk_submission_reviewer (reviewed_by),
    KEY idx_submission_status (status),
    KEY idx_submission_submitter (submitted_by),
    CONSTRAINT fk_submission_reviewer FOREIGN KEY (reviewed_by)
        REFERENCES learner (learner_id),
    CONSTRAINT fk_submission_submitter FOREIGN KEY (submitted_by)
        REFERENCES learner (learner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE knowledge_sync_outbox (
    outbox_id BIGINT NOT NULL AUTO_INCREMENT,
    submission_id INT NOT NULL,
    canonical_record_type ENUM('CONCEPT', 'PREREQUISITE', 'RESOURCE') NOT NULL,
    canonical_record_id INT NOT NULL,
    sync_status ENUM('pending', 'processing', 'completed', 'failed')
        NOT NULL DEFAULT 'pending',
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    manual_retry_requested BOOLEAN NOT NULL DEFAULT FALSE,
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

CREATE TABLE learning_path (
    path_id INT AUTO_INCREMENT PRIMARY KEY,
    learner_id INT NOT NULL,
    concept_id INT NOT NULL,
    mastery_level DECIMAL(7,4) DEFAULT 0,
    UNIQUE (learner_id, concept_id),
    FOREIGN KEY (learner_id) REFERENCES learner(learner_id),
    FOREIGN KEY (concept_id) REFERENCES concept(concept_id)
);

CREATE TABLE assessment (
    assessment_id INT AUTO_INCREMENT PRIMARY KEY,
    learner_id INT NOT NULL,
    quiz_attempt_id CHAR(36) NULL,
    assessment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    timestamp_provenance ENUM('unknown', 'utc') NOT NULL DEFAULT 'unknown',
    overall_score DECIMAL(5,2) NOT NULL,
    UNIQUE KEY uq_assessment_quiz_attempt (quiz_attempt_id),
    FOREIGN KEY (learner_id) REFERENCES learner(learner_id)
);

CREATE TABLE learning_resource (
    resource_id INT AUTO_INCREMENT PRIMARY KEY,
    concept_id INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    file_url VARCHAR(500),
    graph_resource_id VARCHAR(100) NULL,
    UNIQUE KEY uq_learning_resource_graph_id (graph_resource_id),
    FOREIGN KEY (concept_id) REFERENCES concept(concept_id)
);

CREATE TABLE quiz_result (
    result_id INT AUTO_INCREMENT PRIMARY KEY,
    assessment_id INT NOT NULL,
    concept_id INT NOT NULL,
    score DECIMAL(5,2) NOT NULL,
    -- NULL preserves historical unknown evidence; only new submissions have exact counts.
    question_count INT UNSIGNED NULL,
    correct_count INT UNSIGNED NULL,
    FOREIGN KEY (assessment_id) REFERENCES assessment(assessment_id),
    FOREIGN KEY (concept_id) REFERENCES concept(concept_id)
);

CREATE TABLE recommendation (
    recommendation_id INT AUTO_INCREMENT PRIMARY KEY,
    learner_id INT NOT NULL,
    concept_id INT NOT NULL,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (learner_id) REFERENCES learner(learner_id),
    FOREIGN KEY (concept_id) REFERENCES concept(concept_id)
);

CREATE TABLE uploaded_document (
    document_id INT AUTO_INCREMENT PRIMARY KEY,
    learner_id INT NOT NULL,
    filename VARCHAR(255) NOT NULL,
    file_type VARCHAR(20) NOT NULL,
    file_size BIGINT NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    upload_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    processing_status VARCHAR(30) DEFAULT 'uploaded',
    FOREIGN KEY (learner_id) REFERENCES learner(learner_id)
);

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
    ADD CONSTRAINT fk_assessment_quiz_attempt
        FOREIGN KEY (quiz_attempt_id) REFERENCES quiz_attempt (quiz_id);
