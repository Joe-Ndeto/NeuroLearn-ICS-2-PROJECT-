# NeuroLearn

An AI-Powered Adaptive Learning System Using Knowledge Graphs

## 1. Project Overview

NeuroLearn is an adaptive learning system designed to help learners identify knowledge gaps and receive personalized learning recommendations. The system combines a Knowledge Graph with learner performance data to represent relationships between educational concepts and support the creation of personalized learning pathways.

NeuroLearn also incorporates a document-processing pipeline that extracts and prepares educational content from uploaded learning materials. This content will support future Natural Language Processing (NLP), automatic concept extraction, and Knowledge Graph construction.

The project aims to make learning more personalized by considering learners' performance, mastery levels, learning progress, and the relationships between educational concepts.

## 2. Project Objectives

NeuroLearn aims to:

- Identify learners' strengths, weaknesses, and knowledge gaps.
- Represent educational concepts and their prerequisite relationships using a Knowledge Graph.
- Generate personalized learning paths based on learner performance and mastery.
- Process educational materials in PDF, DOCX, and PPTX formats.
- Prepare extracted content for NLP-based concept and relationship extraction.
- Support AI-assisted generation of learning summaries and quizzes.
- Track learner progress and update recommendations as new performance data becomes available.

## 3. Key Features

### Document Upload and Preprocessing
The system supports uploading educational documents in PDF, DOCX, and PPTX formats. The backend stores the original files and records their metadata in MySQL. A Python processing service extracts and cleans textual content for subsequent analysis.

The current preprocessing implementation includes duplicate-content detection for PDF pages, PowerPoint slides, and Word paragraphs.

Image extraction and Optical Character Recognition (OCR) are planned enhancements to support educational content embedded in images and scanned documents.

### Knowledge Graph
NeuroLearn uses Neo4j to represent educational concepts and their relationships. The initial graph contains concepts from subjects such as Linear Algebra and Calculus.

Examples of concepts include:
- Vectors
- Matrices
- Matrix Operations
- Determinants
- Limits
- Derivatives

Relationships such as `PREREQUISITE_OF` and `CONTAINS` represent dependencies and broader subject structures.

### Learner Data Management
MySQL stores structured application data, including learner profiles, assessments, learning paths, learning resources, quiz results, recommendations, and uploaded-document metadata.

### Adaptive Learning Recommendations
The planned recommendation engine will use learner performance, mastery levels, and Knowledge Graph relationships to identify learning gaps and suggest suitable concepts and learning activities.

### AI-Assisted Learning
Planned AI functionality includes generating summaries and quizzes from educational materials to support personalized study.

## 4. System Architecture

NeuroLearn consists of the following main components:

1. Frontend: HTML, CSS, and JavaScript for the learner-facing interface.
2. Backend: Node.js and Express.js for API endpoints, document uploads, and communication with data services.
3. Relational Database: MySQL for structured application and learner data.
4. Knowledge Graph: Neo4j for educational concepts and their relationships.
5. Document Processing Service: Python libraries for extracting and cleaning text from supported document formats.
6. AI and NLP Components: Planned modules for concept extraction, relationship identification, summaries, quizzes, and adaptive recommendations.

### High-Level Data Flow

```text
Learner
   |
   v
Frontend
   |
   v
Node.js / Express Backend
   |
   +---------------------------+
   |                           |
   v                           v
MySQL                     Neo4j
Structured Data           Knowledge Graph
   |
   v
Document Processing
   |
   v
Extracted and Cleaned Text
   |
   v
Planned NLP and Concept Extraction
   |
   v
Knowledge Graph Enhancement
   |
   v
Adaptive Learning Recommendations
```

## 5. Document-Processing Pipeline

The current document-processing pipeline prepares educational materials for later NLP analysis.

```text
PDF / DOCX / PPTX Upload
          |
          v
Node.js / Express Backend
          |
          +----------------------+
          |                      |
          v                      v
Original File Storage       MySQL Metadata
storage/uploads/            uploaded_document
          |
          v
Python Document Processor
          |
          v
Text Extraction
          |
          v
Duplicate-Content Detection
          |
          v
Text Cleaning
          |
          v
Processed Text
storage/processed/
          |
          v
Future NLP and Concept Extraction
```

The processor uses:

- **PyMuPDF** to extract text from PDF files.
- **python-docx** to extract text from Word documents.
- **python-pptx** to extract text from PowerPoint presentations.

The extracted text is normalized by removing unnecessary whitespace and empty lines. Duplicate textual content is detected to reduce repetition in the processed output.

Future improvements include image extraction, OCR, and automatic identification of educational concepts and relationships.

## 6. Technologies Used

| Component | Technologies |
|---|---|
| Frontend | HTML, CSS, JavaScript |
| Backend | Node.js, Express.js |
| Relational Database | MySQL |
| Knowledge Graph | Neo4j |
| Document Processing | Python, PyMuPDF, python-docx, python-pptx |
| Containerization | Docker, Docker Compose |
| Development Environment | Visual Studio Code |
| Database Tools | DBeaver, Neo4j Browser |
| Version Control | Git and GitHub |

## 7. Database Design

### MySQL

The current database includes the following tables:

- `learner` — stores learner account information.
- `concept` — stores educational concept information.
- `learning_path` — stores learner-to-concept learning and mastery records.
- `assessment` — stores assessment information and overall scores.
- `learning_resource` — stores learning resources associated with concepts.
- `quiz_result` — stores assessment results for individual concepts.
- `recommendation` — stores learner recommendations.
- `uploaded_document` — stores metadata and processing status for uploaded documents.

### Neo4j

Neo4j stores educational concepts as graph nodes and their relationships as graph edges. The initial graph provides a foundation for modelling prerequisite dependencies and supporting future personalized learning recommendations.

## 8. Development Setup

### Prerequisites

Install the following tools:

- Node.js and npm
- Python
- Docker Desktop with the WSL 2 backend on Windows
- Git
- Visual Studio Code

### Start the Databases

From the project root, run:

```powershell
docker compose up -d
```

Check the services:

```powershell
docker compose ps
```

The configured services use these ports:

| Service | Address |
|---|---|
| MySQL | `localhost:3306` |
| Neo4j Browser | `http://localhost:7474` |
| Neo4j Bolt | `bolt://localhost:7687` |

Use the credentials configured in your local environment. Do not publish real passwords or secret keys in the repository.

### Start the Backend

```powershell
cd backend
npm install
npm start
```

The backend is configured to run at:

`http://localhost:5000`

The health-check endpoint is:

`http://localhost:5000/health`

It reports the backend's connectivity status for MySQL and Neo4j.

### Set Up the Python Environment

From the project root:

```powershell
.\ai-service\.venv\Scripts\Activate.ps1
```

Install the Python dependencies if necessary:

```powershell
python -m pip install -r ai-service\requirements.txt
```

### Process a Document

From the project root, run:

```powershell
python ai-service\document_processor.py "storage\uploads\linear_algebra_notes.pdf"
```

Replace the example path with the path to an existing supported document.

The extracted and cleaned text is saved in `storage/processed/`.

## 9. Project Structure

```text
NeuroLearn/
├── ai-service/
│   ├── document_processor.py
│   └── requirements.txt
├── backend/
│   ├── package.json
│   └── src/
│       ├── app.js
│       ├── server.js
│       ├── config/
│       ├── controllers/
│       ├── routes/
│       └── services/
├── database/
│   ├── mysql/
│   │   └── schema.sql
│   └── neo4j/
│       └── seed.cypher
├── storage/
│   ├── uploads/
│   └── processed/
├── docker-compose.yml
├── .gitignore
└── README.md
```

This structure describes the main project components. Additional files and directories may be present as development continues.

## 10. Development Status

### Completed
- Development environment configured.
- Docker and Docker Compose configured for MySQL and Neo4j.
- Initial MySQL schema created.
- Initial Neo4j Knowledge Graph populated.
- Node.js and Express backend implemented.
- Database health-check endpoint implemented.
- Document-upload endpoint implemented.
- PDF, DOCX, and PPTX text extraction implemented.
- Document metadata stored in MySQL.
- Duplicate textual content detection implemented.
- Processed text saved for subsequent analysis.
- Git and GitHub version-control workflow established.

### In Progress
- Image extraction from educational documents.
- OCR for text contained in images and scanned documents.
- Improvements to document preprocessing and output organization.

### Planned
- NLP-based educational concept extraction.
- Automatic prerequisite and relationship extraction.
- Automatic Knowledge Graph population from learning materials.
- Adaptive recommendation engine.
- AI-generated summaries and quizzes.
- Learner performance analysis and mastery tracking.
- Personalized learning pathways.
- System evaluation and testing.

## 11. Version Control

The project uses Git and GitHub to manage source code and development progress. Work is organized into sprint branches, with completed work committed and pushed regularly. Once a sprint is complete, a pull request is used to merge the changes into the `main` branch.

## 12. Expected Outcome

The expected outcome is an adaptive learning system that combines structured learner data, educational concept relationships, document preprocessing, and AI-assisted learning features to provide personalized recommendations and help learners address knowledge gaps.

**Project status:** Under development.
