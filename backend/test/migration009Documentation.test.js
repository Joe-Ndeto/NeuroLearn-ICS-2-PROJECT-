'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const migration = fs.readFileSync(path.join(root, 'database/mysql/migrations/009_course_submissions_and_prerequisites.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'database/mysql/schema.sql'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'database/mysql/README.md'), 'utf8');

test('migration 009 enums and course tables match the fresh-install schema', () => {
    for (const definition of [
        "ENUM('CONCEPT', 'PREREQUISITE', 'RESOURCE', 'COURSE', 'COURSE_PREREQUISITE') NOT NULL"
    ]) {
        assert.equal(migration.match(new RegExp(definition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length, 2);
        assert.ok(schema.includes(definition));
    }
    for (const table of ['course', 'course_prerequisite']) {
        assert.match(migration, new RegExp(`CREATE TABLE ${table}\\s*\\(`));
        assert.match(schema, new RegExp(`CREATE TABLE ${table}\\s*\\(`));
    }
    for (const key of [
        'uq_course_graph_id', 'uq_course_normalized_title', 'uq_course_approved_submission',
        'uq_course_prerequisite_pair', 'idx_course_prerequisite_target',
        'fk_course_creator', 'fk_course_approver', 'fk_course_submission',
        'fk_course_prerequisite_source', 'fk_course_prerequisite_target'
    ]) {
        assert.ok(migration.includes(key), `migration is missing ${key}`);
        assert.ok(schema.includes(key), `fresh schema is missing ${key}`);
    }
});

test('migration 009 documentation covers one-time preflight, outbox preservation, worker pause, verification and reconciliation', () => {
    assert.match(migration, /queue need not be[\s\S]*?-- empty/i);
    assert.match(migration, /worker is paused/i);
    assert.match(migration, /Stop on partial state rather than rerunning/i);
    assert.match(readme, /Migration order is 001 through 009/);
    assert.match(readme, /migration 009.*course.*course_prerequisite/s);
    assert.match(readme, /partial state/i);
    assert.match(readme, /submission_type.*canonical_record_type/s);
    assert.match(readme, /storage engines|InnoDB/i);
    assert.match(readme, /referenced.*types|key types/i);
    assert.match(readme, /indexes.*foreign keys|index.*constraint/i);
    assert.match(readme, /pending.*processing.*failed/s);
    assert.match(readme, /Pause every knowledge synchronization worker instance/);
    assert.match(readme, /does not require an empty outbox/i);
    assert.match(readme, /not safely rerunnable/i);
    assert.match(readme, /SHOW CREATE TABLE knowledge_submissions/);
    assert.match(readme, /SHOW CREATE TABLE knowledge_sync_outbox/);
    assert.match(readme, /SHOW CREATE TABLE course_prerequisite/);
    assert.match(readme, /information_schema\.COLUMNS.*STATISTICS.*KEY_COLUMN_USAGE/s);
    assert.match(readme, /do not import.*graph-only courses|does not import or alter Neo4j-only courses/i);
    assert.match(readme, /do not infer course membership by title/i);
});
