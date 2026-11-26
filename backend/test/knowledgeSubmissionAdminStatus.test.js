'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const servicePath = require.resolve('../src/services/knowledgeSubmissionService');
const originalLoad = Module._load;
const rows = [
    { submission_id: 1, submission_type: 'CONCEPT', status: 'pending', sync_status: null, sync_attempt_count: null },
    { submission_id: 2, submission_type: 'CONCEPT', status: 'approved', sync_outbox_id: 22, sync_status: 'pending', sync_attempt_count: 0, sync_updated_at: 'updated-2' },
    { submission_id: 3, submission_type: 'RESOURCE', status: 'approved', sync_outbox_id: 33, sync_status: 'processing', sync_attempt_count: 2, sync_updated_at: 'updated-3' },
    { submission_id: 4, submission_type: 'PREREQUISITE', status: 'approved', sync_outbox_id: 44, sync_status: 'completed', sync_attempt_count: 1, sync_completed_at: 'completed-4', sync_updated_at: 'updated-4' },
    { submission_id: 5, submission_type: 'RESOURCE', status: 'approved', sync_outbox_id: 55, sync_status: 'failed', sync_attempt_count: 4, sync_last_error: 'Neo4j unavailable', sync_updated_at: 'updated-5' },
    { submission_id: 6, submission_type: 'CONCEPT', status: 'rejected', sync_status: null, sync_attempt_count: null }
].map(row => ({
    submission_type: 'CONCEPT',
    submission_data: '{}',
    submitted_at: 'submitted',
    reviewed_by: null,
    review_notes: null,
    reviewed_at: null,
    submitter_learner_id: 10,
    submitter_username: 'learner',
    submitter_email: 'learner@example.test',
    reviewer_learner_id: null,
    reviewer_username: null,
    reviewer_email: null,
    ...row
}));
const queries = [];
let databaseConceptCourses = [{ course_id: 'COURSE-11111111-1111-4111-8111-111111111111', name: 'Database Concepts' }];
let conceptDiagnostics = { total_concepts: 0, domain_associated_concepts: 0, graph_mapped_concepts: 0, missing_graph_concept_id: 0 };
let conceptOptionRows = [];

const mysql = {
    async execute(query, values = []) {
        queries.push(query);
        assert.doesNotMatch(query, /claim_token|lease_expires_at/i);
        if (query.includes('AS total_concepts')) return [[conceptDiagnostics], []];
        if (query.includes('SELECT DISTINCT c.concept_id, c.concept_name')) return [conceptOptionRows, []];
        let filtered = [...rows];
        if (query.includes('s.status = ?')) filtered = filtered.filter(row => row.status === values[0]);
        if (query.includes('s.submission_type = ?')) {
            const typeIndex = query.includes('s.status = ?') ? 1 : 0;
            filtered = filtered.filter(row => row.submission_type === values[typeIndex]);
        }
        if (query.includes('o.sync_status = ?')) {
            const index = Number(query.includes('s.status = ?')) + Number(query.includes('s.submission_type = ?'));
            filtered = filtered.filter(row => row.sync_status === values[index]);
        }
        if (query.includes('SELECT COUNT(*)')) return [[{ total: filtered.length }], []];
        if (query.includes('WHERE s.submission_id = ?')) {
            return [filtered.filter(row => row.submission_id === values[0]), []];
        }
        const paginationMatch = query.match(/LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/i);

        assert.ok(paginationMatch, 'Expected query to contain validated LIMIT and OFFSET values');

        const limit = Number(paginationMatch[1]);
        const offset = Number(paginationMatch[2]);

        return [filtered.slice(offset, offset + limit), []];
    }
};

Module._load = function (request, parent, isMain) {
    if (parent.filename === servicePath && request === '../config/mysql') return mysql;
    if (parent.filename === servicePath && request === './knowledgeGraphService') {
        return {
            CourseValidationError: Error,
            validateCourseIds: async ids => ids,
            async getAllCourses() { return databaseConceptCourses; }
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const service = require('../src/services/knowledgeSubmissionService');
Module._load = originalLoad;

test('administrator list returns review and synchronization state for all outbox states', async () => {
    const result = await service.getAdminSubmissions({ limit: 10, offset: 0 });
    assert.equal(result.total, 6);
    assert.deepEqual(result.submissions.map(row => row.sync.status), [
        null, 'pending', 'processing', 'completed', 'failed', null
    ]);
    assert.equal(result.submissions[0].status, 'pending');
    assert.equal(result.submissions[5].status, 'rejected');
    assert.deepEqual(result.submissions[0].sync, {
        outboxId: null, status: null, attemptCount: 0, lastError: null, completedAt: null, updatedAt: null
    });
    assert.equal(result.submissions[4].sync.outboxId, 55);
    assert.equal(result.submissions[4].sync.attemptCount, 4);
    assert.equal(result.submissions[4].sync.lastError, 'Neo4j unavailable');
    assert.equal(result.submissions[3].sync.completedAt, 'completed-4');
    assert.ok(result.submissions.every(row => row.sync && !('claimToken' in row.sync) && !('leaseExpiresAt' in row.sync)));
    assert.ok(queries.some(query => query.includes('LEFT JOIN knowledge_sync_outbox')));
});

test('administrator list preserves filters, limit, and offset without N+1 lookups', async () => {
    queries.length = 0;
    const result = await service.getAdminSubmissions({ status: 'approved', type: 'RESOURCE', limit: 1, offset: 1 });
    assert.equal(result.total, 2);
    assert.equal(result.submissions[0].submissionId, 5);
    assert.equal(queries.length, 2);
    assert.match(queries[1], /LIMIT 1 OFFSET 1/i);
    assert.ok(queries[1].includes('LEFT JOIN knowledge_sync_outbox'));
});

test('administrator detail returns synchronization status without exposing lease internals', async () => {
    queries.length = 0;
    const result = await service.getAdminSubmission(5);
    assert.equal(result.sync.status, 'failed');
    assert.equal(result.sync.lastError, 'Neo4j unavailable');
    assert.equal(result.sync.outboxId, 55);
    assert.equal(result.status, 'approved');
    assert.equal(Object.hasOwn(result.sync, 'claim_token'), false);
    assert.equal(Object.hasOwn(result.sync, 'lease_expires_at'), false);
    assert.equal(queries.length, 1);
    assert.ok(queries[0].includes('LEFT JOIN knowledge_sync_outbox'));
});

test('administrator list can efficiently filter by synchronization status and returns the actual outbox ID', async () => {
    queries.length = 0;
    const result = await service.getAdminSubmissions({ syncStatus: 'failed', limit: 20, offset: 0 });
    assert.equal(result.total, 1);
    assert.equal(result.submissions[0].submissionId, 5);
    assert.equal(result.submissions[0].sync.outboxId, 55);
    assert.ok(queries[0].includes('LEFT JOIN knowledge_sync_outbox'));
    assert.ok(queries[0].includes('o.sync_status = ?'));
    assert.ok(queries[1].includes('o.outbox_id AS sync_outbox_id'));
});

test('resource concept options explain missing course, approved concepts, association, and graph mapping', async t => {
    await t.test('missing course', async () => {
        databaseConceptCourses = [];
        queries.length = 0;
        const result = await service.getDatabaseConceptOptions();
        assert.equal(result.domainAvailable, false);
        assert.equal(result.emptyReason, 'course_missing');
        assert.equal(queries.length, 0);
    });

    databaseConceptCourses = [{ course_id: 'COURSE-11111111-1111-4111-8111-111111111111', name: 'Database Concepts' }];
    await t.test('no approved concepts', async () => {
        conceptDiagnostics = { total_concepts: 0, domain_associated_concepts: 0, graph_mapped_concepts: 0, missing_graph_concept_id: 0 };
        conceptOptionRows = [];
        queries.length = 0;
        const result = await service.getDatabaseConceptOptions();
        assert.equal(result.domainAvailable, true);
        assert.equal(result.emptyReason, 'no_approved_concepts');
    });
    await t.test('missing course association', async () => {
        conceptDiagnostics = { total_concepts: 2, domain_associated_concepts: 0, graph_mapped_concepts: 0, missing_graph_concept_id: 0 };
        const result = await service.getDatabaseConceptOptions();
        assert.equal(result.emptyReason, 'missing_course_association');
    });
    await t.test('missing graph concept ID', async () => {
        conceptDiagnostics = { total_concepts: 2, domain_associated_concepts: 2, graph_mapped_concepts: 0, missing_graph_concept_id: 2 };
        const result = await service.getDatabaseConceptOptions();
        assert.equal(result.emptyReason, 'missing_graph_concept_id');
    });
    await t.test('valid associated concepts are returned', async () => {
        conceptDiagnostics = { total_concepts: 2, domain_associated_concepts: 2, graph_mapped_concepts: 2, missing_graph_concept_id: 0 };
        conceptOptionRows = [{ concept_id: 30, concept_name: 'Keys', description: '', difficulty_level: 'Beginner' }];
        const result = await service.getDatabaseConceptOptions();
        assert.equal(result.emptyReason, null);
        assert.deepEqual(result.concepts.map(row => row.concept_id), [30]);
    });
});
