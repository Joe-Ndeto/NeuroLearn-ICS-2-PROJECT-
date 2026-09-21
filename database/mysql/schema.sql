CREATE TABLE learner (
    learner_id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL
);

CREATE TABLE concept (
    concept_id INT AUTO_INCREMENT PRIMARY KEY,
    concept_name VARCHAR(150) NOT NULL UNIQUE,
    description TEXT
);

CREATE TABLE learning_path (
    path_id INT AUTO_INCREMENT PRIMARY KEY,
    learner_id INT NOT NULL,
    concept_id INT NOT NULL,
    mastery_level DECIMAL(5,2) DEFAULT 0,
    UNIQUE (learner_id, concept_id),
    FOREIGN KEY (learner_id) REFERENCES learner(learner_id),
    FOREIGN KEY (concept_id) REFERENCES concept(concept_id)
);

CREATE TABLE assessment (
    assessment_id INT AUTO_INCREMENT PRIMARY KEY,
    learner_id INT NOT NULL,
    assessment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    overall_score DECIMAL(5,2) NOT NULL,
    FOREIGN KEY (learner_id) REFERENCES learner(learner_id)
);

CREATE TABLE learning_resource (
    resource_id INT AUTO_INCREMENT PRIMARY KEY,
    concept_id INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    file_url VARCHAR(500),
    FOREIGN KEY (concept_id) REFERENCES concept(concept_id)
);

CREATE TABLE quiz_result (
    result_id INT AUTO_INCREMENT PRIMARY KEY,
    assessment_id INT NOT NULL,
    concept_id INT NOT NULL,
    score DECIMAL(5,2) NOT NULL,
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