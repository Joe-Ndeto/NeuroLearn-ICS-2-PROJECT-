# MySQL database setup and migrations

## Fresh installation

`schema.sql` is the complete fresh-install schema. Create an empty MySQL database, connect to it, and apply this file. It creates tables but does not create or select the database.

With the repository's Docker Compose configuration, the MySQL service mounts `database/mysql/schema.sql` into MySQL's initialization directory. MySQL applies initialization scripts only when it initializes a new data directory:

```powershell
docker compose up -d mysql
```

The scripts are not reapplied when the existing `mysql_data` volume is reused. For a non-Docker installation, select a newly created empty NeuroLearn database and import `schema.sql` with a MySQL client. Provide credentials through local configuration; do not commit credentials.

## Synchronization schema

The schema keeps MySQL as the source of truth for canonical concepts, resources, and approval decisions while storing stable identifiers that can map those records to Neo4j.

- `concept.graph_concept_id` is the nullable, unique Neo4j `Concept.concept_id` mapping. Existing values must be reconciled deliberately. Do not infer mappings automatically from concept names.
- `concept.difficulty_level` is a nullable `VARCHAR(50)` assigned by an administrator when approving a concept (`Beginner`, `Intermediate`, or `Advanced`). Student submissions omit difficulty; historical submission payloads and existing concept values remain intact. The selected value is written to the canonical concept and synchronization outbox transaction, then sent to Neo4j as `Concept.difficulty_level` only when creating the stable-ID node, so retries do not overwrite existing graph properties.
- `learning_resource.graph_resource_id` is nullable and unique so existing resource rows remain valid until their Neo4j IDs are deliberately mapped.
- `concept_course` is a many-to-many mapping from MySQL concepts to existing Neo4j courses. `course_graph_id` stores a Neo4j course identifier; there is no MySQL course table. A concept can map to several courses, and a course can contain several concepts.
- `concept_prerequisite` stores canonical prerequisite relationships. `prerequisite_concept_id` identifies the concept that must be learned first, and `target_concept_id` identifies the concept that depends on it. The pair is unique and both columns reference `concept.concept_id`.
- `knowledge_sync_outbox` stores a synchronization task linked to a submission. `canonical_record_type` and `canonical_record_id` identify the canonical MySQL record created during approval. The ID is polymorphic, so it intentionally has no foreign key to one canonical table; the service must validate the referenced record against the table selected by `canonical_record_type`. The unique `submission_id` key allows at most one task per submission. The intended application workflow creates tasks only for approved submissions; the FK and unique key do not themselves enforce the submission's approval status.
- `manual_retry_requested` marks one administrator-authorized replay. It lets the worker claim that task even when its preserved `attempt_count` has reached the automatic retry limit. Claiming consumes the marker and increments the count, so attempt history remains monotonic.
- Outbox states are `pending`, `processing`, `completed`, and `failed`. Workers should claim work with a claim token and expiring lease so interrupted claims can be recovered and stale workers fenced off.

Keep Neo4j network operations outside open MySQL transactions. Commit the approval decision and outbox task atomically in MySQL; then process the task with retryable, idempotent Neo4j operations. Update the outbox state in a later MySQL transaction. A failure between stores must be recoverable by retrying with the same stable graph IDs.

## Existing installations and numbered migrations

The checked-in schema is for fresh installations; it is not an upgrade script. Existing databases may already have some of these columns or tables. Repository schema and migration files describe intended repository state only; they do not prove which migrations have been applied to any live database. The numbered migrations do not recreate `knowledge_submissions` or modify existing concept graph mappings. Migration 001 adds `learning_resource.graph_resource_id` only when preflight confirms that the column and its unique index do not already exist; migration 002 adds prerequisite records and canonical outbox references; migration 003 adds the nullable concept difficulty field; migration 004 adds the explicit manual-retry marker; migration 005 adds durable quiz attempts and the optional unique assessment-to-attempt reference; migration 006 adds nullable per-concept quiz evidence counts.

The repository has no migration runner or migration library. SQL files under `migrations/` use a simple, manually applied, zero-padded numeric prefix (`NNN_description.sql`) and are applied in numeric order after review. The backend does not discover or execute these files automatically. Migration order is 001 through 006; apply each once after its preflight, based on inspection of the target database rather than assumptions about applied versions. Migration 002 requires an empty `knowledge_sync_outbox`: existing tasks cannot safely be assigned canonical record references automatically. Migration 003 requires the `concept` table to exist and use InnoDB, and the `difficulty_level` column to be absent. Migration 004 requires `knowledge_sync_outbox` to exist and use InnoDB, and `manual_retry_requested` to be absent. Migration 005 requires `learner`, `uploaded_document`, and `assessment` to exist and use InnoDB, compatible referenced ID types, and the new table/column/index/constraint names to be unused. It preserves historical assessments with a NULL `quiz_attempt_id`. Migration 006 requires `quiz_result` to exist and both evidence columns to be absent.

Migration 005 uses MySQL `JSON`, supported from MySQL 5.7, and the repository's `utf8mb4_0900_ai_ci` collation requires MySQL 8.0. Confirm the actual server version and collation support during preflight; do not infer compatibility from the checked-in schema. Migration 006 adds nullable unsigned integer `question_count` and `correct_count` fields to `quiz_result`.

New quiz submissions store the exact number of questions assigned to each concept and how many were answered correctly, alongside the existing percentage score. Historical rows retain NULL counts because their exact counts cannot be inferred safely from percentages; migration 006 does not backfill. Application code validates that counts are positive/integer and that correct counts are between zero and the question count. No database CHECK constraint is used because enforcement differs among MySQL 8.0 releases; validate the actual server version if considering such a constraint separately.

### Preflight before migration

1. Take and verify a restorable backup of the target database.
2. Record the server version and inspect the actual table definitions, storage engines, indexes, and foreign keys. Do not assume the target matches `schema.sql` or the live export.
3. Check whether `learning_resource.graph_resource_id`, its unique index, `concept_course`, `concept_prerequisite`, or `knowledge_sync_outbox` already exists. Resolve partial prior attempts manually before applying the migration; it is not an idempotent rerunnable script.
4. Confirm `concept` and `knowledge_submissions` exist, and that referenced columns have compatible signedness and types. Confirm participating tables use InnoDB.
5. Review existing graph mappings and determine a deliberate reconciliation plan. Do not populate graph IDs by matching names automatically.
6. For migration 002, verify that `knowledge_sync_outbox` is empty before adding its required canonical reference columns. Existing outbox tasks have no safe automatic canonical mapping.
7. For migration 003, confirm `concept.difficulty_level` does not already exist and that `concept` uses InnoDB.
8. For migration 004, confirm `knowledge_sync_outbox.manual_retry_requested` does not already exist and that `knowledge_sync_outbox` uses InnoDB.
9. For migration 005, confirm `quiz_attempt` does not exist, `assessment.quiz_attempt_id` and its unique index/FK do not exist, and `learner`, `uploaded_document`, and `assessment` use InnoDB with compatible key types.
10. For migration 006, inspect `quiz_result` and confirm `question_count` and `correct_count` are both absent; resolve any partial prior application before proceeding. Confirm a backup is available because MySQL DDL may implicitly commit.
11. Check whether quiz attempts need any deployment-specific retention policy before accumulating expired attempts; do not delete submitted attempts or their linked assessments/results.
12. Apply migrations 001 through 006 only after individual preflights using an approved MySQL client and the intended database, then verify the resulting columns, indexes, FK definitions, and row counts. The repository files alone do not identify the live database's migration state.

Useful read-only inspection statements include:

```sql
SHOW CREATE TABLE concept;
SHOW CREATE TABLE learning_resource;
SHOW CREATE TABLE knowledge_submissions;
SHOW CREATE TABLE knowledge_sync_outbox;
SHOW CREATE TABLE concept_prerequisite;
SHOW TABLE STATUS;
```

The migrations are additive: migration 001 adds a nullable resource mapping and creates the course association and outbox tables; migration 002 creates the prerequisite table and adds required canonical reference columns to the empty outbox; migration 003 adds a nullable `VARCHAR(50)` difficulty field to concepts; migration 004 adds a default-false manual-retry marker to outbox rows; migration 005 creates quiz-attempt records and adds a nullable unique attempt reference to assessments; migration 006 adds nullable unsigned question/correct counts to quiz results. Existing assessments remain unlinked, historical quiz-result counts remain NULL, and the migration does not alter scores or learning-path history. MySQL DDL may implicitly commit, so do not assume a migration can be rolled back as one transaction. If an operation fails partway, stop and inspect the actual resulting schema before continuing; do not blindly rerun the file.

For migration 006, verify the resulting definitions with `SHOW CREATE TABLE quiz_result;` and confirm historical row counts and scores remain unchanged. Check that pre-existing rows have NULL in both new fields and that new application submissions write both counts. Application validation enforces count consistency; because no CHECK constraint is added, other database writers must follow the same validation policy.

### Verification and recovery

After applying each migration, compare the schema with the migration and fresh-install definitions, verify the unique keys, foreign keys, canonical reference columns, and row counts, and confirm that existing row counts and identifiers remain unchanged. Keep the pre-migration backup until verification is complete.

Prefer a corrective roll-forward for failures. Dropping `knowledge_sync_outbox` can discard pending tasks and sync history; dropping graph ID columns can discard reconciled mappings. Do not remove these structures during rollback without reviewing their data, preserving it, and planning how to resume synchronization safely. Expired `processing` leases can be reclaimed only after the worker's lease has expired; stale workers must be prevented from completing tasks with an obsolete claim token.

The live database also contains `concept_backup_20261117` and `learner_backup_20261116`. These backup tables are intentionally excluded from fresh-install schema and migration changes. Preserve them; this migration does not create, drop, or alter them.

## Knowledge synchronization worker

The worker is a separate Node.js process. From the `backend` directory, start it with:

```powershell
npm run worker:knowledge-sync
```

It uses the backend's existing MySQL and Neo4j environment configuration. Do not put credentials in command-line arguments or logs. Worker behavior can be tuned with these optional environment variables (defaults are shown):

| Variable | Default | Purpose |
| --- | ---: | --- |
| `KNOWLEDGE_SYNC_POLL_INTERVAL_MS` | 2000 | Delay between queue polls |
| `KNOWLEDGE_SYNC_BATCH_SIZE` | 5 | Maximum rows claimed in one batch |
| `KNOWLEDGE_SYNC_CONCURRENCY` | 3 | Maximum tasks processed concurrently in this process |
| `KNOWLEDGE_SYNC_LEASE_SECONDS` | 120 | Claim lease duration; must exceed the Neo4j transaction timeout by at least 10 seconds |
| `KNOWLEDGE_SYNC_NEO4J_TIMEOUT_MS` | 30000 | Neo4j transaction timeout |
| `KNOWLEDGE_SYNC_MAX_ATTEMPTS` | 8 | Maximum attempts before a retryable task is terminally failed |
| `KNOWLEDGE_SYNC_RETRY_BASE_SECONDS` | 5 | Initial exponential retry delay |
| `KNOWLEDGE_SYNC_RETRY_MAX_SECONDS` | 3600 | Maximum retry delay before jitter |
| `KNOWLEDGE_SYNC_HEALTH_PORT` | 5001 | Worker process liveness endpoint port |
| `KNOWLEDGE_SYNC_HEALTH_HOST` | `127.0.0.1` | Worker health listener bind address; change only when a probe must reach it over the container or host network |
| `KNOWLEDGE_SYNC_HEALTH_ALLOW_EXTERNAL` | `false` | Must be explicitly set to `true` before binding the unauthenticated health listener to a non-loopback address |

The worker exposes `GET /health` on its own process listener. It reports process state, last successful queue poll, last successful synchronization, and in-flight task count. HTTP 200 indicates that the worker process is running (including while idle); it does not claim that Neo4j synchronization has recently succeeded. A worker that has not started or has stopped returns HTTP 503. The endpoint binds to loopback by default and does not expose credentials or claim data. It accepts only `localhost` or IP literals. A non-loopback bind, including wildcard addresses, requires the deliberate `KNOWLEDGE_SYNC_HEALTH_ALLOW_EXTERNAL=true` override; protect that listener with deployment network controls.

Claims use short MySQL transactions with `FOR UPDATE SKIP LOCKED`; due pending rows, expired processing leases, and processing rows with a null lease below the maximum attempt count are eligible. A null lease is treated as genuinely unleased; rows with a non-null future lease are left alone. Expired, null-lease, or due tasks already at the maximum are transactionally changed to `failed`, with the old token and lease state checked, lease fields cleared, and a diagnostic stored. Each new claim gets a fresh token and increments `attempt_count`. Completion, retry, failure, and lease renewal updates require the current token and an unexpired lease. The worker renews active leases periodically and checks ownership around Neo4j operations and before commit. These checks reduce stale work, but cannot atomically fence a Neo4j commit against a concurrent MySQL lease change. The worker uses bounded Neo4j transaction timeouts and waits for active tasks during SIGINT/SIGTERM shutdown. A process crash leaves the task leased until expiration, after which it is claimable again.

Transient Neo4j failures and missing graph dependencies retry with capped exponential delay and jitter. Invalid or missing canonical MySQL records are marked failed immediately. Retryable work becomes `failed` when it reaches the configured maximum attempts. Failed rows retain a concise `last_error`; inspect them and queue status using read-only queries such as:

```sql
SELECT outbox_id, submission_id, canonical_record_type, canonical_record_id,
       sync_status, attempt_count, available_at, lease_expires_at, last_error
FROM knowledge_sync_outbox
WHERE sync_status = 'failed'
ORDER BY updated_at, outbox_id;

SELECT sync_status, COUNT(*) AS task_count
FROM knowledge_sync_outbox
GROUP BY sync_status;
```

Before replay, back up or record the failed row, inspect its canonical record and graph dependencies, and resolve the cause. An operator may then deliberately reset only that reviewed task in a transaction, guarded by its `outbox_id` and `sync_status = 'failed'`: set it to `pending`, set `available_at = CURRENT_TIMESTAMP`, reset `attempt_count` to zero, clear `lease_expires_at`, `claim_token`, `completed_at`, and `last_error`, then commit and verify the row. Do not replay active or leased work, change canonical IDs, or bulk-reset failed rows. The replay repeats stable-ID `MERGE` operations and is designed to be idempotent.

Deployment prerequisites: apply and verify migrations 001 through 004 on an existing installation; ensure Neo4j uniqueness constraints for course, concept, and resource IDs exist; provision every selected course before its concept task runs; and complete a deliberate reconciliation plan for legacy graph records. In particular, do not map legacy `C001`–`C008` concepts by name or automatically create replacement nodes. Legacy graph reconciliation is a separate deployment prerequisite. The checked-in seed data also uses concept-to-concept `CONTAINS` relationships, while the current course association uses course-to-concept `CONTAINS`; confirm their semantics before relying on legacy data. No worker operation deletes graph records or propagates canonical edits/deletions.

If ownership is lost before the worker starts the Neo4j commit, it signals the task operation, avoids commit, attempts rollback, and does not update the outbox using that stale claim. A narrow race remains if ownership changes after the final MySQL ownership check and before Neo4j accepts commit; MySQL and Neo4j do not share a transaction. Recovery is at-least-once, using stable-ID `MERGE` operations to make replay safe.

The automated tests use mocks and verify query shape and application behavior only. They do not prove MySQL's actual `SKIP LOCKED` concurrency semantics or Neo4j transaction isolation and rollback. Before production use, run integration tests against the intended MySQL and Neo4j versions and verify recovery, lease expiry, and duplicate delivery behavior. This worker implementation is not by itself a production-readiness sign-off.
