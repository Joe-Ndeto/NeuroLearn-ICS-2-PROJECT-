'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const servicePath = require.resolve('../src/services/knowledgeSubmissionService');
const originalLoad = Module._load;
let state;

function reset(overrides = {}) {
    state = {
        task: {
            outbox_id: 9,
            sync_status: 'failed',
            canonical_record_type: 'RESOURCE',
            canonical_record_id: 55,
            attempt_count: 6,
            last_error: 'previous Neo4j error',
            claim_token: 'stale-token',
            lease_expires_at: 'expired',
            manual_retry_requested: false,
            completed_at: null
        },
        missingTask: false,
        invalidCanonical: false,
        malformedCanonical: false,
        canonicalGraphId: 'CONCEPT-stable',
        malformedCanonicalType: null,
        incompleteCanonicalType: null,
        cyclicPrerequisite: false,
        canonicalCalls: [],
        transactionCommits: 0,
        transactionRollbacks: 0,
        releases: 0,
        destroys: 0,
        connectionCount: 0,
        reconcileQueries: 0,
        commitMode: 'success',
        commitPersisted: false,
        rollbackFails: false,
        releaseFails: false,
        reconcileFails: false,
        ...overrides
    };
    state.lockTail = Promise.resolve();
}

const mysql = {
    async execute(query) {
        assert.match(query, /FROM knowledge_sync_outbox/);
        assert.match(query, /SUM\(/);
        assert.match(query, /MIN\(/);
        assert.doesNotMatch(query, /SELECT\s+.*claim_token|SELECT\s+.*lease_expires_at/i);
        return [[{
            pending_count: 3,
            processing_count: 2,
            completed_count: 10,
            failed_count: 4,
            expired_processing_count: 1,
            oldest_pending_at: 'oldest-pending',
            total_outstanding: 5
        }], []];
    },
    async getConnection() {
        state.connectionCount += 1;
        const connectionNumber = state.connectionCount;
        let releaseRowLock;
        let transactionSnapshot;
        let transactionWrites = false;
        return {
            async beginTransaction() { transactionSnapshot = structuredClone(state.task); },
            async commit() {
                state.transactionCommits += 1;
                if (connectionNumber === 1 && state.commitMode === 'before') {
                    throw new Error('commit rejected before persistence');
                }
                if (connectionNumber === 1 && state.commitMode === 'after') state.commitPersisted = true;
                releaseRowLock?.();
                releaseRowLock = null;
                if (connectionNumber === 1 && ['after', 'uncertain'].includes(state.commitMode)) {
                    throw new Error('commit acknowledgement lost');
                }
            },
            async rollback() {
                state.transactionRollbacks += 1;
                if (state.rollbackFails || state.commitPersisted) throw new Error('rollback failed');
                if (transactionSnapshot && transactionWrites && !state.commitPersisted) {
                    state.task = structuredClone(transactionSnapshot);
                }
                releaseRowLock?.();
                releaseRowLock = null;
            },
            release() {
                state.releases += 1;
                releaseRowLock?.();
                if (state.releaseFails && connectionNumber === 1) throw new Error('release failed');
            },
            destroy() { state.destroys += 1; releaseRowLock?.(); },
            async execute(sql, params = []) {
                const query = sql.replace(/\s+/g, ' ').trim();
                if (query.startsWith('SELECT outbox_id') && query.includes('manual_retry_requested')) {
                    state.reconcileQueries += 1;
                    if (state.reconcileFails) throw new Error('reconciliation read failed');
                    return state.task ? [[{ ...state.task }], []] : [[], []];
                }
                if (query.startsWith('SELECT outbox_id')) {
                    const previous = state.lockTail;
                    state.lockTail = new Promise(resolve => { releaseRowLock = resolve; });
                    await previous;
                    if (state.missingTask || Number(params[0]) !== state.task.outbox_id) return [[], []];
                    return [[{ ...state.task }], []];
                }
                if (query.startsWith('SELECT course_graph_id')) {
                    state.canonicalCalls.push('courses');
                    if (state.invalidCanonical || state.incompleteCanonicalType === 'CONCEPT') return [[], []];
                    return [state.malformedCanonicalType === 'CONCEPT'
                        ? [{ course_graph_id: 'bad-course-id' }]
                        : [{ course_graph_id: 'COURSE-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], []];
                }
                if (query.startsWith('SELECT concept_id, concept_name')) {
                    state.canonicalCalls.push('concept');
                    if (state.invalidCanonical) return [[], []];
                    return [[{
                        concept_id: 3,
                        concept_name: state.malformedCanonicalType === 'CONCEPT' ? ' ' : 'Canonical concept',
                        description: null,
                        difficulty_level: null,
                        graph_concept_id: state.incompleteCanonicalType === 'CONCEPT' ? null : state.canonicalGraphId
                    }], []];
                }
                if (query.startsWith('SELECT p.prerequisite_id')) {
                    state.canonicalCalls.push('prerequisite');
                    if (state.invalidCanonical || state.incompleteCanonicalType === 'PREREQUISITE') return [[], []];
                    return [[{
                        prerequisite_id: 32,
                        prerequisite_concept_id: 3,
                        target_concept_id: state.malformedCanonicalType === 'PREREQUISITE' ? 3 : 4,
                        prerequisite_name: 'Before',
                        prerequisite_description: null,
                        prerequisite_difficulty_level: null,
                        prerequisite_graph_id: 'CONCEPT-before',
                        target_name: 'After',
                        target_description: null,
                        target_difficulty_level: null,
                        target_graph_id: 'CONCEPT-after'
                    }], []];
                }
                if (query.startsWith('SELECT prerequisite_concept_id, target_concept_id')) {
                    return [state.cyclicPrerequisite
                        ? [{ prerequisite_concept_id: 4, target_concept_id: 3 }]
                        : [], []];
                }
                if (query.startsWith('SELECT r.resource_id')) {
                    state.canonicalCalls.push('resource');
                    if (state.invalidCanonical) return [[], []];
                    return [[{
                        resource_id: state.task.canonical_record_id,
                        concept_id: 3,
                        title: state.malformedCanonicalType === 'RESOURCE' ? ' ' : 'Notes',
                        resource_type: 'document',
                        file_url: state.incompleteCanonicalType === 'RESOURCE' ? null : 'https://example.test/notes',
                        graph_resource_id: state.malformedCanonical ? ' ' : 'RESOURCE-stable',
                        concept_name: 'Canonical concept',
                        description: null,
                        difficulty_level: null,
                        concept_graph_id: state.incompleteCanonicalType === 'RESOURCE' ? null : 'CONCEPT-stable'
                    }], []];
                }
                if (query.startsWith('SELECT updated_at')) return [[{ updated_at: 'updated-now' }], []];
                if (query.startsWith('SELECT updated_at')) {
                    return [[{ updated_at: 'updated-now' }], []];
                }
                if (query.startsWith('UPDATE knowledge_sync_outbox')) {
                    const [outboxId, type, canonicalId] = params;
                    if (state.task.sync_status !== 'failed' || Number(outboxId) !== state.task.outbox_id ||
                        type !== state.task.canonical_record_type || Number(canonicalId) !== state.task.canonical_record_id) {
                        return [{ affectedRows: 0 }, []];
                    }
                    state.task.sync_status = 'pending';
                    state.task.claim_token = null;
                    state.task.lease_expires_at = null;
                    state.task.completed_at = null;
                    state.task.manual_retry_requested = true;
                    state.task.updated_at = 'updated-now';
                    transactionWrites = true;
                    return [{ affectedRows: 1 }, []];
                }
                throw new Error(`Unexpected mock SQL: ${query}`);
            }
        };
    }
};

Module._load = function (request, parent, isMain) {
    if (parent.filename === servicePath && request === '../config/mysql') return mysql;
    if (parent.filename === servicePath && request === './knowledgeGraphService') {
        return { CourseValidationError: Error, validateCourseIds: async ids => ids };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const service = require('../src/services/knowledgeSubmissionService');
Module._load = originalLoad;

test('outbox statistics return aggregate counts and oldest pending timestamp', async () => {
    reset();
    assert.deepEqual(await service.getOutboxStatistics(), {
        pending: 3,
        processing: 2,
        completed: 10,
        failed: 4,
        expiredProcessing: 1,
        oldestPendingAt: 'oldest-pending',
        totalOutstanding: 5
    });
});

test('retries a failed task after validating its canonical record and preserves attempt history', async () => {
    reset();
    const result = await service.retryFailedOutboxTask(9);
    assert.equal(result.outcome, 'retried');
    assert.deepEqual(result.sync, {
        status: 'pending', attemptCount: 6, lastError: 'previous Neo4j error',
        completedAt: null, updatedAt: 'updated-now'
    });
    assert.equal(state.task.sync_status, 'pending');
    assert.equal(state.task.attempt_count, 6);
    assert.equal(state.task.last_error, 'previous Neo4j error');
    assert.equal(state.task.claim_token, null);
    assert.equal(state.task.lease_expires_at, null);
    assert.equal(state.task.manual_retry_requested, true);
    assert.deepEqual(state.canonicalCalls, ['resource']);
    assert.equal(state.transactionCommits, 1);
    assert.equal(state.releases, 1);
});

test('validates canonical mappings for each supported type before retry', async t => {
    for (const [canonicalType, canonicalId, expectedCall] of [
        ['CONCEPT', 31, 'concept'],
        ['PREREQUISITE', 32, 'prerequisite'],
        ['RESOURCE', 33, 'resource']
    ]) {
        await t.test(canonicalType, async () => {
            reset({ task: {
                outbox_id: 9, sync_status: 'failed', canonical_record_type: canonicalType,
                canonical_record_id: canonicalId, attempt_count: 2, last_error: 'diagnostic'
            } });
            const result = await service.retryFailedOutboxTask(9);
            assert.equal(result.outcome, 'retried');
            assert.ok(state.canonicalCalls.includes(expectedCall));
        });
    }
});

test('returns not found for a missing outbox task', async () => {
    reset({ missingTask: true });
    assert.deepEqual(await service.retryFailedOutboxTask(900), { outcome: 'not_found' });
    assert.equal(state.transactionCommits, 0);
    assert.equal(state.transactionRollbacks, 1);
});

test('rejects retry for pending, processing, and completed tasks', async t => {
    for (const syncStatus of ['pending', 'processing', 'completed']) {
        await t.test(syncStatus, async () => {
            reset({ task: { ...state.task, sync_status: syncStatus } });
            const result = await service.retryFailedOutboxTask(9);
            assert.equal(result.outcome, 'not_failed');
            assert.equal(state.transactionCommits, 0);
            assert.equal(state.canonicalCalls.length, 0);
        });
    }
});

test('rejects missing or invalid canonical records without changing the task', async () => {
    reset({ invalidCanonical: true });
    const result = await service.retryFailedOutboxTask(9);
    assert.equal(result.outcome, 'invalid_canonical_record');
    assert.equal(state.task.sync_status, 'failed');
    assert.equal(state.transactionCommits, 0);
    assert.equal(state.transactionRollbacks, 1);
});

test('rejects malformed canonical graph mappings without requeueing', async () => {
    reset({ malformedCanonical: true });
    const result = await service.retryFailedOutboxTask(9);
    assert.equal(result.outcome, 'invalid_canonical_record');
    assert.equal(state.task.sync_status, 'failed');
    assert.equal(state.transactionCommits, 0);
});

test('shared canonical validation rejects malformed and incomplete records of every type', async t => {
    for (const [type, id] of [['CONCEPT', 31], ['PREREQUISITE', 32], ['RESOURCE', 33]]) {
        await t.test(`${type} malformed`, async () => {
            reset({
                task: { outbox_id: 9, sync_status: 'failed', canonical_record_type: type, canonical_record_id: id, attempt_count: 2 },
                malformedCanonicalType: type
            });
            assert.equal((await service.retryFailedOutboxTask(9)).outcome, 'invalid_canonical_record');
            assert.equal(state.task.sync_status, 'failed');
        });
        await t.test(`${type} incomplete`, async () => {
            reset({
                task: { outbox_id: 9, sync_status: 'failed', canonical_record_type: type, canonical_record_id: id, attempt_count: 2 },
                incompleteCanonicalType: type
            });
            assert.equal((await service.retryFailedOutboxTask(9)).outcome, 'invalid_canonical_record');
            assert.equal(state.task.sync_status, 'failed');
        });
    }
});

test('shared graph ID validation accepts legacy and UUID IDs and rejects whitespace or invalid values before manual retry', async t => {
    for (const graphId of [
        ['legacy ID', 'C001', true],
        ['UUID-style ID', 'CONCEPT-123e4567-e89b-12d3-a456-426614174000', true],
        ['leading whitespace', ' C001', false],
        ['trailing whitespace', 'C001 ', false],
        ['whitespace only', '   ', false],
        ['blank', '', false],
        ['non-string', null, false],
        ['too long', 'x'.repeat(101), false]
    ]) {
        await t.test(graphId[0], async () => {
            reset({
                task: {
                    outbox_id: 9, sync_status: 'failed', canonical_record_type: 'CONCEPT',
                    canonical_record_id: 3, attempt_count: 2, last_error: 'diagnostic'
                },
                canonicalGraphId: graphId[1]
            });

            const result = await service.retryFailedOutboxTask(9);
            assert.equal(result.outcome, graphId[2] ? 'retried' : 'invalid_canonical_record');
        });
    }
});

test('rejects a prerequisite row that would create a canonical learning cycle', async () => {
    reset({
        task: { outbox_id: 9, sync_status: 'failed', canonical_record_type: 'PREREQUISITE', canonical_record_id: 32, attempt_count: 2 },
        cyclicPrerequisite: true
    });
    assert.equal((await service.retryFailedOutboxTask(9)).outcome, 'invalid_canonical_record');
    assert.equal(state.task.sync_status, 'failed');
});

test('concurrent retry requests transition a failed row only once', async () => {
    reset();
    const results = await Promise.all([
        service.retryFailedOutboxTask(9),
        service.retryFailedOutboxTask(9)
    ]);
    assert.deepEqual(results.map(result => result.outcome).sort(), ['not_failed', 'retried']);
    assert.equal(state.transactionCommits, 1);
    assert.equal(state.task.sync_status, 'pending');
    assert.equal(state.task.attempt_count, 6);
});

test('reconciles commit acknowledgement loss after a committed retry using a fresh connection', async () => {
    reset({ commitMode: 'after' });
    const result = await service.retryFailedOutboxTask(9);
    assert.equal(result.outcome, 'retried');
    assert.equal(result.sync.status, 'pending');
    assert.equal(result.sync.updatedAt, 'updated-now');
    assert.equal(state.connectionCount, 2);
    assert.equal(state.reconcileQueries, 1);
    assert.equal(state.transactionCommits, 1);
    assert.ok(state.destroys >= 1);
});

test('reports confirmed non-commit when commit fails and rollback succeeds', async () => {
    reset({ commitMode: 'before' });
    const result = await service.retryFailedOutboxTask(9);
    assert.deepEqual(result, { outcome: 'commit_not_committed' });
    assert.equal(state.transactionCommits, 1);
    assert.equal(state.transactionRollbacks, 1);
    assert.equal(state.task.sync_status, 'failed');
    assert.equal(state.connectionCount, 2);
});

test('reports explicit uncertainty when commit and fresh-connection reconciliation cannot be confirmed', async () => {
    reset({ commitMode: 'uncertain', rollbackFails: true, reconcileFails: true });
    const result = await service.retryFailedOutboxTask(9);
    assert.deepEqual(result, { outcome: 'commit_uncertain' });
    assert.equal(state.connectionCount, 2);
    assert.equal(state.reconcileQueries, 1);
    assert.ok(state.destroys >= 1);
});

test('does not report a confirmed commit as failed when connection release fails', async () => {
    reset({ releaseFails: true });
    const result = await service.retryFailedOutboxTask(9);
    assert.equal(result.outcome, 'retried');
    assert.equal(result.sync.updatedAt, 'updated-now');
    assert.equal(state.task.sync_status, 'pending');
    assert.equal(state.destroys, 1);
});
