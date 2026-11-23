# NeuroLearn setup and deployment requirements

This document describes the checked-in application configuration. It does not establish that any live database has the required schema or that a deployment has been configured.

## Local development

1. Install the Node.js and Python dependencies.
2. Copy `.env.example` to `backend/.env` and fill in local settings privately. The sample is intentionally blank; never commit a populated environment file.
3. Start MySQL and Neo4j only when explicitly authorized for the development environment. Use a private local Docker network and do not expose database ports to an untrusted network.
4. From `backend/`, run `npm install`, then `npm start` for the API. Start the synchronization worker as a separate process with `npm run worker:knowledge-sync`.
5. Create a Python virtual environment under `ai-service/.venv`, install `ai-service/requirements.txt`, and set `PYTHON_EXECUTABLE` only when the default interpreter path is unsuitable.
6. Serve `frontend/` with a local static-file server. The browser uses the local API default on loopback.

Supported, processable learning documents are PDF, DOCX and PPTX. New DOC and PPT uploads are rejected; the extractor uses PyMuPDF, python-docx and python-pptx. DOCX/PPTX uploads must contain the expected OOXML package parts, root relationship and content-type declarations. ZIP inspection is bounded by the configured upload limit (and a 50 MiB hard archive cap), 2,048 entries, a 64 MiB total expanded size, a 32 MiB per-entry size and a 200:1 maximum compression ratio. Image OCR is not included.

## Production configuration

Provide configuration through a deployment secret manager or private environment injection. The following variable **names** are read by the application; values are intentionally omitted here:

**API and authentication:** `NODE_ENV`, `PORT`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `GOOGLE_CLIENT_ID`, `GEMINI_API_KEY`.

**CORS:** `CORS_ALLOWED_ORIGINS`. In production this must be an explicit comma-separated list of exact HTTP(S) frontend origins. Wildcards, paths and credentials in origins are rejected. The API also permits requests without an `Origin` header for same-origin and server-to-server traffic; CORS is not authentication.

**MySQL:** `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.

**Neo4j:** `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`.

**Document processing and limits:** `PYTHON_EXECUTABLE`, `RESOURCE_UPLOAD_MAX_BYTES`, `HEALTH_CHECK_TIMEOUT_MS`.

**Worker tuning and health:** `KNOWLEDGE_SYNC_POLL_INTERVAL_MS`, `KNOWLEDGE_SYNC_BATCH_SIZE`, `KNOWLEDGE_SYNC_CONCURRENCY`, `KNOWLEDGE_SYNC_LEASE_SECONDS`, `KNOWLEDGE_SYNC_MAX_ATTEMPTS`, `KNOWLEDGE_SYNC_NEO4J_TIMEOUT_MS`, `KNOWLEDGE_SYNC_RETRY_BASE_SECONDS`, `KNOWLEDGE_SYNC_RETRY_MAX_SECONDS`, `KNOWLEDGE_SYNC_HEALTH_PORT`, `KNOWLEDGE_SYNC_HEALTH_HOST`, `KNOWLEDGE_SYNC_HEALTH_ALLOW_EXTERNAL`.

Set `CORS_ALLOWED_ORIGINS` to the actual frontend origin(s). The static frontend supports an explicit `window.NEUROLEARN_CONFIG.apiBaseUrl`; if omitted, it uses same-origin `/api` for a deployed site and loopback for local development. Never put server credentials or AI provider keys in `frontend/config.js`.

The API and worker are separate Node.js processes. The worker currently requires MySQL and Neo4j connectivity. Its health listener defaults to loopback, and the API admin proxy calls that local listener. Deploy the API and worker so that this loopback probe works (for example, co-located processes in the same host/network namespace); do not publish the worker health port publicly. A separate-container layout needs a deliberately designed private health-proxy arrangement before the existing admin health panel can reach it.

## Python runtime

The document processor invokes one explicit interpreter. `PYTHON_EXECUTABLE`, when set, selects that executable. Otherwise Windows uses `ai-service/.venv/Scripts/python.exe`, and Linux/macOS uses `ai-service/.venv/bin/python`. The application does not fall back to an unrelated system Python. A missing interpreter or dependency produces an actionable document-processing failure; install the dependencies from `ai-service/requirements.txt` and verify the configured interpreter before enabling uploads.

## Health checks

- `GET /health/live` returns HTTP 200 while the API process is running; it does not prove dependency availability.
- `GET /health/ready` (also available as `/health/readiness`; the legacy `GET /health` path is retained) checks MySQL and Neo4j with read-only bounded queries. It returns HTTP 200 only when both are connected, otherwise HTTP 503 with safe per-dependency states.
- The worker has its own loopback `GET /health` endpoint. Administrators use the authenticated API proxy at `/api/admin/submissions/worker-health`.
- Health response bodies do not include credentials, connection strings or stack traces.

## Persistent private document storage

Current files are local filesystem paths under `storage/uploads/`, `storage/resource-submissions/` and `storage/processed/`. The application does not currently provide an object-storage adapter or a configurable storage root. Production must mount durable, private storage at the application `storage/` path, back it up, and prevent static/public serving of these directories. If API instances are replicated, they must share the same storage or a later storage adapter must replace this assumption. The synchronization worker does not read document files; the API and its Python child process do.

## Schema and deployment checks

The repository has no migration runner. `database/mysql/schema.sql` is the fresh-install schema; existing installations require a reviewed, ordered migration procedure. Confirm the target schema and migration state before deploying application code that uses course, course-prerequisite, evidence-count, timestamp-provenance or mastery-precision fields. Do not apply migrations as part of application startup.

The current Compose file is for local development, not a production security boundary. Production must keep MySQL/Neo4j on private networks, use managed secrets, terminate TLS at a trusted ingress, restrict API origins and access, and configure durable storage and backups before accepting learner uploads.
