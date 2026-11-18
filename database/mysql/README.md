# MySQL database setup

## Fresh installation

`schema.sql` defines the MySQL tables for a fresh NeuroLearn installation. Create an empty MySQL database, then run the schema while connected to that database. The schema creates tables; it does not create or select the database itself.

With the repository's Docker Compose configuration, the MySQL service mounts `database/mysql/schema.sql` into MySQL's initialization directory. On the first startup with an empty MySQL data volume, MySQL initializes the configured database and applies the schema:

```powershell
docker compose up -d mysql
```

The initialization scripts run only when MySQL initializes a new data directory. Starting the service again with an initialized volume does not reapply `schema.sql`. For a non-Docker installation, select a newly created, empty NeuroLearn database and import `schema.sql` using your MySQL client. Supply credentials through your local configuration; do not commit credentials to this repository.

## Schema represented here

The checked-in schema includes these authentication and graph-mapping fields:

- `learner.password_hash` is nullable so accounts authenticated through Google can exist without a password hash.
- `learner.google_id` is nullable and has a unique index.
- `learner.role` is `ENUM('student','admin')`, is required, and defaults to `student`.
- `concept.graph_concept_id` is nullable and has the unique index `uq_concept_graph_id` for an optional Neo4j concept identifier.

It also defines `knowledge_submissions`, including the `CONCEPT`, `PREREQUISITE`, and `RESOURCE` submission types; `pending`, `approved`, and `rejected` statuses; submitter and reviewer learner foreign keys; and the status, submitter, and reviewer indexes. `submitted_at` is `TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP`.

These definitions reflect the confirmed live schema export. The current live NeuroLearn database already contains these changes; this README and `schema.sql` document the fresh-install structure and do not imply that the live database needs them applied again.

## Existing installations: verify before migrating

Do not treat `schema.sql` as an upgrade script. Before considering any migration, inspect the target database's actual table definitions, indexes, and foreign keys and compare them with the checked-in schema. For example, these are read-only inspection statements:

```sql
SHOW CREATE TABLE learner;
SHOW CREATE TABLE concept;
SHOW CREATE TABLE knowledge_submissions;
```

Also verify the definitions of the other application tables and check whether the intended indexes and constraints already exist. The live export confirms the learner and submission relationships to `learner.learner_id`; verify the target database directly before planning changes.

**Do not blindly rerun the `CREATE TABLE` statements or apply duplicate `ALTER TABLE` statements.** Existing installations may already contain some or all of these columns, indexes, tables, or constraints. Repeating DDL can fail or create an unsafe partial upgrade. This repository does not currently provide a migration script or migration runner. No migration is needed for the current live database based on the confirmed export; any other installation must be assessed from its own schema first.

## Backup tables

The live database also contains `concept_backup_20261117` and `learner_backup_20261116`. These backup tables are intentionally not part of the fresh-install schema. Preserve them in existing installations; this setup documentation does not direct users to create, drop, or alter them.
