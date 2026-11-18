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
- `learning_resource.graph_resource_id` is nullable and unique so existing resource rows remain valid until their Neo4j IDs are deliberately mapped.
- `concept_course` is a many-to-many mapping from MySQL concepts to existing Neo4j courses. `course_graph_id` stores a Neo4j course identifier; there is no MySQL course table. A concept can map to several courses, and a course can contain several concepts.
- `knowledge_sync_outbox` stores a synchronization task linked to a submission. The unique `submission_id` key allows at most one task per submission. The intended application workflow creates tasks only for approved submissions; the FK and unique key do not themselves enforce the submission's approval status.
- Outbox states are `pending`, `processing`, `completed`, and `failed`. Workers should claim work with a claim token and expiring lease so interrupted claims can be recovered and stale workers fenced off.

Keep Neo4j network operations outside open MySQL transactions. Commit the approval decision and outbox task atomically in MySQL; then process the task with retryable, idempotent Neo4j operations. Update the outbox state in a later MySQL transaction. A failure between stores must be recoverable by retrying with the same stable graph IDs.

## Existing installations and numbered migrations

The checked-in schema is for fresh installations; it is not an upgrade script. Existing databases may already have some of these columns or tables. The current live installation already contains `knowledge_submissions` and `concept.graph_concept_id`. This migration does not recreate `knowledge_submissions` or modify existing concept graph mappings. It adds `learning_resource.graph_resource_id` only if the preflight confirms that the column and its unique index do not already exist.

The repository has no migration runner or migration library. SQL files under `migrations/` use a simple, manually applied, zero-padded numeric prefix (`NNN_description.sql`) and are applied in numeric order after review. The backend does not discover or execute these files automatically. Migration `001_add_knowledge_sync_outbox.sql` is intended to be applied once to an existing installation after preflight.

### Preflight before migration

1. Take and verify a restorable backup of the target database.
2. Record the server version and inspect the actual table definitions, storage engines, indexes, and foreign keys. Do not assume the target matches `schema.sql` or the live export.
3. Check whether `learning_resource.graph_resource_id`, its unique index, `concept_course`, or `knowledge_sync_outbox` already exists. Resolve partial prior attempts manually before applying the migration; it is not an idempotent rerunnable script.
4. Confirm `concept` and `knowledge_submissions` exist, and that referenced columns have compatible signedness and types. Confirm participating tables use InnoDB.
5. Review existing graph mappings and determine a deliberate reconciliation plan. Do not populate graph IDs by matching names automatically.
6. Apply the numbered migration once using an approved MySQL client and the intended database, then verify the resulting columns, indexes, FK definitions, and row counts.

Useful read-only inspection statements include:

```sql
SHOW CREATE TABLE concept;
SHOW CREATE TABLE learning_resource;
SHOW CREATE TABLE knowledge_submissions;
SHOW TABLE STATUS;
```

The migration is additive: it adds a nullable resource mapping and creates two new tables. It does not update or delete existing concept, resource, learner, or submission rows. MySQL DDL may implicitly commit, so do not assume the migration can be rolled back as one transaction. If an operation fails partway, stop and inspect the actual resulting schema before continuing; do not blindly rerun the file.

### Verification and recovery

After applying the migration, compare the schema with the migration and fresh-install definitions, verify the unique keys and foreign keys, and confirm that existing row counts and identifiers remain unchanged. Keep the pre-migration backup until verification is complete.

Prefer a corrective roll-forward for failures. Dropping `knowledge_sync_outbox` can discard pending tasks and sync history; dropping graph ID columns can discard reconciled mappings. Do not remove these structures during rollback without reviewing their data, preserving it, and planning how to resume synchronization safely. Expired `processing` leases can be reclaimed only after the worker's lease has expired; stale workers must be prevented from completing tasks with an obsolete claim token.

The live database also contains `concept_backup_20261117` and `learner_backup_20261116`. These backup tables are intentionally excluded from fresh-install schema and migration changes. Preserve them; this migration does not create, drop, or alter them.
