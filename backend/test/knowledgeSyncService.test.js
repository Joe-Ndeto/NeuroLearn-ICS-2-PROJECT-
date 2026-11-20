'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createKnowledgeSyncService } = require('../src/services/knowledgeSyncService');

function harness(overrides = {}) {
    const state = {
        status: 'processing', token: 'claim', attempt: 0, lastError: null, completed: 0,
        claimRows: overrides.claimRows || [],
        concept: { concept_id: 7, concept_name: 'Algebra', description: 'Description', difficulty_level: 'Intermediate', graph_concept_id: Object.hasOwn(overrides, 'conceptGraphId') ? overrides.conceptGraphId : 'CONCEPT-abc' },
        courses: [{ course_graph_id: 'COURSE-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
        prerequisite: {
            prerequisite_id: 12, prerequisite_concept_id: 1, target_concept_id: 2,
            prerequisite_name: 'Before', prerequisite_description: null,
            prerequisite_difficulty_level: null, prerequisite_graph_id: 'CONCEPT-a',
            target_name: 'After', target_description: null,
            target_difficulty_level: null, target_graph_id: 'CONCEPT-b'
        },
        resource: {
            resource_id: 14, concept_id: 7, title: 'Notes', resource_type: 'document',
            file_url: 'https://example.test/notes', graph_resource_id: 'RESOURCE-a',
            concept_name: 'Algebra', description: 'Description', difficulty_level: null,
            concept_graph_id: 'CONCEPT-abc'
        },
        failCourse: Boolean(overrides.failCourse), failCompletionOnce: false, terminalFailures: 0, completionUpdates: 0,
        txCommits: 0, txRollbacks: 0, sessionCloses: 0, cypher: [],
        connectionCommits: 0, connectionRollbacks: 0, releases: 0, renewals: 0
    };
    const claimEligible = row => row.status === 'pending' ||
        (row.status === 'processing' &&
            (row.leaseExpired || row.lease_expires_at === null));

    const pool = {
        async getConnection() {
            return {
                async beginTransaction() {},
                async commit() { state.connectionCommits += 1; },
                async rollback() {
                    state.connectionRollbacks += 1;
                    if (overrides.claimRollbackFails) throw new Error('claim rollback cleanup failure');
                },
                release() {
                    state.releases += 1;
                    if (overrides.releaseFails) throw new Error('connection release cleanup failure');
                },
                destroy() { state.destroyed = true; },
                async execute(sql, params = []) {
                    const query = sql.replace(/\s+/g, ' ').trim();
                    if (query.startsWith('SELECT outbox_id')) {
                        if (overrides.claimSelectFails) throw new Error('claim select failed');
                        assert.match(query, /FOR UPDATE SKIP LOCKED/);
                        assert.match(query, /CURRENT_TIMESTAMP/);
                        if (query.includes('attempt_count >= ?')) {
                            return [state.claimRows.filter(row =>
                                Number(row.attempt_count) >= Number(params[0]) &&
                                row.manual_retry_requested !== true &&
                                claimEligible(row)
                            ).map(row => ({ ...row, sync_status: row.status, claim_token: row.token })), []];
                        }
                        return [state.claimRows
                            .filter(row => (Number(row.attempt_count) < Number(params[0]) || row.manual_retry_requested === true) &&
                                claimEligible(row))
                            .map(row => ({ ...row, sync_status: row.status, claim_token: row.token })), []];
                    }
                    if (query.startsWith('UPDATE knowledge_sync_outbox')) {
                        if (query.includes("SET sync_status = 'failed'")) {
                            const row = state.claimRows.find(item => Number(item.outbox_id) === Number(params[1]));
                            if (!row || row.status !== params[2] || row.token !== params[3] ||
                                row.lease_expires_at !== params[4] ||
                                Number(row.attempt_count) < Number(params[5]) || row.manual_retry_requested === true) return [{ affectedRows: 0 }, []];
                            row.status = 'failed'; row.token = null; row.leaseExpired = false; row.lease_expires_at = null;
                            row.lastError = params[0]; state.terminalFailures += 1;
                            return [{ affectedRows: 1 }, []];
                        }
                        const row = state.claimRows.find(item => Number(item.outbox_id) === Number(params[2]));
                        if (!row || row.status !== params[3] || row.token !== params[4] ||
                            row.lease_expires_at !== params[5] ||
                            (Number(row.attempt_count) >= Number(params[6]) && row.manual_retry_requested !== true) ||
                            !claimEligible(row)) return [{ affectedRows: 0 }, []];
                        row.status = 'processing'; row.leaseExpired = false; row.lease_expires_at = 'new-lease';
                        row.token = params[0]; row.attempt_count += 1; row.manual_retry_requested = false;
                        return [{ affectedRows: 1 }, []];
                    }
                    throw new Error(`Unexpected claim query: ${query}`);
                }
            };
        },
        async execute(sql, params = []) {
            const query = sql.replace(/\s+/g, ' ').trim();
            if (query.startsWith('SELECT concept_id, concept_name')) {
                if (overrides.loadDelayMs) await new Promise(resolve => setTimeout(resolve, overrides.loadDelayMs));
                return [overrides.missingCanonical ? [] : [state.concept], []];
            }
            if (query.startsWith('SELECT course_graph_id')) return [state.courses, []];
            if (query.startsWith('SELECT p.prerequisite_id')) return [overrides.missingCanonical ? [] : [state.prerequisite], []];
            if (query.startsWith('SELECT prerequisite_concept_id, target_concept_id FROM concept_prerequisite')) {
                return [overrides.cyclicPrerequisite
                    ? [{ prerequisite_concept_id: 2, target_concept_id: 1 }]
                    : [], []];
            }
            if (query.startsWith('SELECT r.resource_id')) return [overrides.missingCanonical ? [] : [state.resource], []];
            if (query.startsWith('UPDATE knowledge_sync_outbox')) {
                if (query.includes('SET lease_expires_at = DATE_ADD')) {
                    state.renewalAttempts = (state.renewalAttempts || 0) + 1;
                    if (params[1] !== 9 || state.status !== 'processing' || params[2] !== state.token) return [{ affectedRows: 0 }, []];
                    state.renewals += 1;
                    return [{ affectedRows: 1 }, []];
                }
                const id = params.find((value, index) => index > 0 && Number(value) === 9);
                const taskId = id === undefined ? 9 : id;
                const token = params[params.length - 1];
                if (overrides.failCompletion && query.includes("sync_status = 'completed'")) {
                    if (!state.failCompletionOnce) { state.failCompletionOnce = true; throw new Error('simulated completion write failure'); }
                }
                if (query.includes("sync_status = 'completed'")) state.completionUpdates += 1;
                if (taskId !== 9 || state.status !== 'processing' || token !== state.token) return [{ affectedRows: 0 }, []];
                if (query.includes("sync_status = 'completed'")) { state.status = 'completed'; state.completed += 1; }
                else if (query.includes("sync_status = 'pending'")) { state.status = 'pending'; state.lastError = params[1]; }
                else { state.status = 'failed'; state.lastError = params[0]; }
                state.token = null;
                return [{ affectedRows: 1 }, []];
            }
            throw new Error(`Unexpected pool query: ${query}`);
        }
    };

    const neo4j = {
        getSession() {
            return {
                async beginTransaction(options) {
                    if (overrides.beginTransactionFails) throw new Error('Neo4j transaction startup failed');
                    state.neo4jTimeout = options.timeout;
                    return {
                        async run(query, params) {
                            state.cypher.push({ query: query.replace(/\s+/g, ' ').trim(), params });
                            if (overrides.neo4jRunDelayMs) await new Promise(resolve => setTimeout(resolve, overrides.neo4jRunDelayMs));
                            if (state.failCourse && query.includes('MATCH (course:Course')) return { records: [] };
                            if (query.includes('MATCH (prerequisite:Concept') && overrides.missingConcept) return { records: [] };
                            if (query.includes('MATCH (concept:Concept') && query.includes('LearningResource') && overrides.missingConcept) return { records: [] };
                            return { records: [{ get: () => true }] };
                        },
                        async commit() {
                            state.txCommits += 1;
                            if (overrides.failNeo4jCommitOnce && !state.neo4jCommitFailed) {
                                state.neo4jCommitFailed = true;
                                throw new Error('simulated uncertain Neo4j commit');
                            }
                        },
                        async rollback() {
                            state.txRollbacks += 1;
                            if (overrides.rollbackFails) throw new Error('Neo4j rollback cleanup failure');
                        }
                    };
                },
                async close() {
                    state.sessionCloses += 1;
                    if (overrides.sessionCloseFails) throw new Error('Neo4j session cleanup failure');
                }
            };
        }
    };
    const service = createKnowledgeSyncService({
        mysql: pool,
        getNeo4jSession: neo4j.getSession,
        config: {
            maxAttempts: overrides.maxAttempts || 3,
            leaseSeconds: overrides.leaseSeconds || 120,
            leaseRenewIntervalMs: overrides.leaseRenewIntervalMs,
            neo4jTransactionTimeoutMs: 30000,
            retryBaseSeconds: 10,
            retryMaxSeconds: 20
        },
        makeToken: (() => { let n = 0; return () => `token-${++n}`; })(),
        random: () => 0.5
    });
    return { service, state, pool };
}

test('claims eligible pending and expired processing tasks with fresh tokens in a short transaction', async () => {
    const { service, state } = harness({ claimRows: [
        { outbox_id: 1, canonical_record_type: 'CONCEPT', canonical_record_id: 7, attempt_count: 0, status: 'pending' },
        { outbox_id: 2, canonical_record_type: 'RESOURCE', canonical_record_id: 4, attempt_count: 2, status: 'processing', leaseExpired: true }
    ] });
    const tasks = await service.claimTasks(2);
    assert.deepEqual(tasks.map(task => task.claim_token), ['token-1', 'token-2']);
    assert.deepEqual(tasks.map(task => task.attempt_count), [1, 3]);
    assert.equal(state.connectionCommits, 1);
    assert.equal(state.connectionRollbacks, 0);
    assert.equal(state.releases, 1);
});

test('reclaims an expired task below maximum and increments its attempt count once', async () => {
    const { service, state } = harness({ claimRows: [
        { outbox_id: 8, canonical_record_type: 'RESOURCE', canonical_record_id: 14, attempt_count: 2, status: 'processing', leaseExpired: true, token: 'expired-token' }
    ] });
    const [task] = await service.claimTasks(1);
    assert.equal(task.attempt_count, 3);
    assert.equal(task.claim_token, 'token-1');
    assert.equal(state.claimRows[0].attempt_count, 3);
    assert.equal(state.claimRows[0].token, 'token-1');
});

test('recovers a processing task with no lease while preserving and incrementing attempt history', async () => {
    const { service, state } = harness({ claimRows: [
        {
            outbox_id: 15, canonical_record_type: 'RESOURCE', canonical_record_id: 14,
            attempt_count: 4, status: 'processing', lease_expires_at: null, token: 'orphaned-token'
        }
    ], maxAttempts: 8 });
    const [task] = await service.claimTasks(1);
    assert.equal(task.attempt_count, 5);
    assert.equal(state.claimRows[0].attempt_count, 5);
    assert.equal(state.claimRows[0].status, 'processing');
    assert.equal(state.claimRows[0].token, 'token-1');
    assert.equal(state.claimRows[0].lease_expires_at, 'new-lease');
});

test('does not reclaim a processing task with a valid active lease', async () => {
    const { service, state } = harness({ claimRows: [
        {
            outbox_id: 16, canonical_record_type: 'RESOURCE', canonical_record_id: 14,
            attempt_count: 1, status: 'processing', lease_expires_at: 'future-lease',
            leaseExpired: false, token: 'active-token'
        }
    ] });
    assert.deepEqual(await service.claimTasks(1), []);
    assert.equal(state.claimRows[0].status, 'processing');
    assert.equal(state.claimRows[0].attempt_count, 1);
    assert.equal(state.claimRows[0].token, 'active-token');
    assert.equal(state.claimRows[0].lease_expires_at, 'future-lease');
});

test('terminalizes an expired task at the maximum without incrementing it or retaining its lease', async () => {
    const { service, state } = harness({ claimRows: [
        { outbox_id: 8, canonical_record_type: 'RESOURCE', canonical_record_id: 14, attempt_count: 3, status: 'processing', leaseExpired: true, token: 'expired-token' }
    ] });
    const claimed = await service.claimTasks(1);
    assert.deepEqual(claimed, []);
    assert.equal(state.claimRows[0].status, 'failed');
    assert.equal(state.claimRows[0].attempt_count, 3);
    assert.equal(state.claimRows[0].token, null);
    assert.equal(state.claimRows[0].leaseExpired, false);
    assert.match(state.claimRows[0].lastError, /Maximum synchronization attempts \(3\) exhausted/);
    assert.equal(state.terminalFailures, 1);
    assert.equal(state.connectionCommits, 1);
});

test('claims a manually retried exhausted task once without resetting attempt history', async () => {
    const { service, state } = harness({ claimRows: [
        { outbox_id: 13, canonical_record_type: 'RESOURCE', canonical_record_id: 55, attempt_count: 3, status: 'pending', manual_retry_requested: true }
    ] });
    const claimed = await service.claimTasks(1);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].attempt_count, 4);
    assert.equal(state.claimRows[0].attempt_count, 4);
    assert.equal(state.claimRows[0].manual_retry_requested, false);
    assert.equal(state.claimRows[0].status, 'processing');
});

test('concurrent workers cannot claim or overwrite an exhausted expired task', async () => {
    const { service, state } = harness({ claimRows: [
        { outbox_id: 8, canonical_record_type: 'RESOURCE', canonical_record_id: 14, attempt_count: 3, status: 'processing', leaseExpired: true, token: 'expired-token' }
    ] });
    const results = await Promise.all([service.claimTasks(1), service.claimTasks(1)]);
    assert.deepEqual(results, [[], []]);
    assert.equal(state.claimRows[0].status, 'failed');
    assert.equal(state.claimRows[0].attempt_count, 3);
    assert.equal(state.claimRows[0].token, null);
    assert.equal(state.terminalFailures, 1);
});

test('destroys a claim connection if rollback fails and preserves the original claim error', async () => {
    const { service, state } = harness({ claimSelectFails: true, claimRollbackFails: true });
    await assert.rejects(service.claimTasks(1), /claim select failed/);
    assert.equal(state.connectionRollbacks, 1);
    assert.equal(state.releases, 0);
    assert.equal(state.destroyed, true);
});

test('claims from concurrent callers do not return the same successfully claimed row in the mock', async () => {
    const { service, state } = harness({ claimRows: [
        { outbox_id: 3, canonical_record_type: 'CONCEPT', canonical_record_id: 7, attempt_count: 0, status: 'pending' }
    ] });
    const claims = await Promise.all([service.claimTasks(1), service.claimTasks(1)]);
    const ids = claims.flat().map(task => task.outbox_id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length <= 1);
    // This mock checks query shape and token fencing; it does not prove MySQL locking semantics.
});

test('synchronizes all canonical record types with stable IDs and idempotent MERGE operations', async t => {
    for (const [type, id, expectedPattern] of [
        ['CONCEPT', 7, /MERGE \(c:Concept \{concept_id: \$graphId\}\).*ON CREATE SET/],
        ['PREREQUISITE', 12, /MERGE \(prerequisite\)-\[:PREREQUISITE_OF\]->\(target\)/],
        ['RESOURCE', 14, /MERGE \(resource:LearningResource \{resource_id: \$resourceId\}\).*ON CREATE SET/]
    ]) {
        await t.test(type, async () => {
            const { service, state } = harness();
            const result = await service.processTask({ outbox_id: 9, canonical_record_type: type, canonical_record_id: id, attempt_count: 1, claim_token: 'claim' });
            assert.equal(result.outcome, 'completed');
            assert.equal(state.txCommits, 1);
            assert.equal(state.txRollbacks, 0);
            assert.equal(state.sessionCloses, 1);
            assert.ok(state.cypher.some(item => expectedPattern.test(item.query)));
            assert.ok(state.cypher.every(item => !/^\s*CREATE\b/i.test(item.query)));
        });
    }
});

test('loads canonical concept difficulty and passes it to the create-only Neo4j property update', async () => {
    const { service, state } = harness();
    await service.processTask({ outbox_id: 9, canonical_record_type: 'CONCEPT', canonical_record_id: 7, attempt_count: 1, claim_token: 'claim' });
    const conceptWrite = state.cypher.find(item => item.query.includes('MERGE (c:Concept'));
    assert.ok(conceptWrite);
    assert.match(conceptWrite.query, /ON CREATE SET[\s\S]*c\.difficulty_level = \$difficultyLevel/);
    assert.equal(conceptWrite.params.difficultyLevel, 'Intermediate');
    assert.doesNotMatch(conceptWrite.query, /\n\s*SET c\.difficulty_level/);
});

test('fails permanently when a canonical MySQL record is missing', async () => {
    const { service, state } = harness({ missingCanonical: true });
    const result = await service.processTask({ outbox_id: 9, canonical_record_type: 'CONCEPT', canonical_record_id: 7, attempt_count: 1, claim_token: 'claim' });
    assert.equal(result.outcome, 'failed');
    assert.equal(state.txCommits, 0);
    assert.equal(state.status, 'failed');
});

test('shared graph ID validation accepts legacy and UUID IDs and rejects whitespace or invalid values in worker processing', async t => {
    for (const [name, graphId, valid] of [
        ['legacy ID', 'C001', true],
        ['UUID-style ID', 'CONCEPT-123e4567-e89b-12d3-a456-426614174000', true],
        ['leading whitespace', ' C001', false],
        ['trailing whitespace', 'C001 ', false],
        ['whitespace only', '   ', false],
        ['blank', '', false],
        ['non-string', null, false],
        ['too long', 'x'.repeat(101), false]
    ]) {
        await t.test(name, async () => {
            const { service, state } = harness({ conceptGraphId: graphId });
            const result = await service.processTask({
                outbox_id: 9, canonical_record_type: 'CONCEPT', canonical_record_id: 7,
                attempt_count: 1, claim_token: 'claim'
            });
            assert.equal(result.outcome, valid ? 'completed' : 'failed');
            assert.equal(state.txCommits, valid ? 1 : 0);
            assert.equal(state.txRollbacks, 0);
        });
    }
});

test('fails permanently when the canonical prerequisite relationship introduces a cycle', async () => {
    const { service, state } = harness({ cyclicPrerequisite: true });
    const result = await service.processTask({
        outbox_id: 9, canonical_record_type: 'PREREQUISITE', canonical_record_id: 12,
        attempt_count: 1, claim_token: 'claim'
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(state.txCommits, 0);
    assert.equal(state.status, 'failed');
});

test('rolls back the complete concept transaction when a mapped course is missing', async () => {
    const { service, state } = harness();
    state.failCourse = true;
    const result = await service.processTask({ outbox_id: 9, canonical_record_type: 'CONCEPT', canonical_record_id: 7, attempt_count: 1, claim_token: 'claim' });
    assert.equal(result.outcome, 'retry');
    assert.equal(state.txCommits, 0);
    assert.equal(state.txRollbacks, 1);
    assert.equal(state.sessionCloses, 1);
    assert.equal(state.status, 'pending');
});

test('retries prerequisite synchronization when a Neo4j concept is missing', async () => {
    const { service, state } = harness({ missingConcept: true });
    const result = await service.processTask({ outbox_id: 9, canonical_record_type: 'PREREQUISITE', canonical_record_id: 12, attempt_count: 1, claim_token: 'claim' });
    assert.equal(result.outcome, 'retry');
    assert.equal(state.txRollbacks, 1);
    assert.equal(state.status, 'pending');
});

test('rolls back resource creation when its Neo4j concept is missing', async () => {
    const { service, state } = harness({ missingConcept: true });
    const result = await service.processTask({ outbox_id: 9, canonical_record_type: 'RESOURCE', canonical_record_id: 14, attempt_count: 1, claim_token: 'claim' });
    assert.equal(result.outcome, 'retry');
    assert.equal(state.txRollbacks, 1);
    assert.equal(state.txCommits, 0);
});

test('applies bounded exponential retry delay with jitter and clears the claim', async () => {
    const { service, state } = harness();
    assert.equal(service.retryDelaySeconds(2), 20);
    const result = await service.processTask({ outbox_id: 9, canonical_record_type: 'INVALID', canonical_record_id: 99, attempt_count: 1, claim_token: 'claim' });
    assert.equal(result.outcome, 'failed'); // Invalid type is permanent.
    assert.equal(state.status, 'failed');
});

test('marks retryable errors terminal at the configured maximum attempt count', async () => {
    const { service, state } = harness();
    state.failCourse = true;
    const result = await service.processTask({ outbox_id: 9, canonical_record_type: 'CONCEPT', canonical_record_id: 7, attempt_count: 3, claim_token: 'claim' });
    assert.equal(result.outcome, 'failed');
    assert.equal(state.status, 'failed');
    assert.equal(state.txRollbacks, 1);
});

test('rejects completion by a stale token', async () => {
    const { service, state } = harness();
    state.token = 'new-owner';
    const result = await service.processTask({ outbox_id: 9, canonical_record_type: 'CONCEPT', canonical_record_id: 7, attempt_count: 1, claim_token: 'old-owner' });
    assert.equal(result.outcome, 'stale');
    assert.equal(state.status, 'processing');
});

test('renews an active claim conditionally before its lease expires', async () => {
    const { service, state } = harness({ leaseSeconds: 3, loadDelayMs: 1100 });
    const result = await service.processTask({ outbox_id: 9, canonical_record_type: 'CONCEPT', canonical_record_id: 7, attempt_count: 1, claim_token: 'claim' });
    assert.equal(result.outcome, 'completed');
    assert.ok(state.renewals >= 1);
});

test('rolls back and skips MySQL completion when lease ownership is lost during Neo4j work', async () => {
    const { service, state } = harness({ leaseRenewIntervalMs: 10, neo4jRunDelayMs: 30 });
    const loseOwnership = setTimeout(() => { state.token = 'new-owner'; }, 5);
    const result = await service.processTask({ outbox_id: 9, canonical_record_type: 'CONCEPT', canonical_record_id: 7, attempt_count: 1, claim_token: 'claim' });
    clearTimeout(loseOwnership);
    assert.equal(result.outcome, 'stale');
    assert.equal(state.txCommits, 0);
    assert.equal(state.txRollbacks, 1);
    assert.equal(state.sessionCloses, 1);
    assert.equal(state.completionUpdates, 0);
    assert.equal(state.status, 'processing');
    assert.equal(state.token, 'new-owner');
});

test('keeps the synchronization error primary when Neo4j rollback and close also fail', async () => {
    const { service, state } = harness({
        failCourse: true,
        rollbackFails: true,
        sessionCloseFails: true
    });
    const result = await service.processTask({ outbox_id: 9, canonical_record_type: 'CONCEPT', canonical_record_id: 7, attempt_count: 1, claim_token: 'claim' });
    assert.equal(result.outcome, 'retry');
    assert.equal(state.txRollbacks, 1);
    assert.match(state.lastError, /^MissingGraphDependencyError:/);
    assert.doesNotMatch(state.lastError, /cleanup failure/);
    assert.equal(state.sessionCloses, 1);
});

test('replays idempotently if Neo4j committed but completion update failed', async () => {
    const { service, state } = harness({ failCompletion: true });
    const task = { outbox_id: 9, canonical_record_type: 'CONCEPT', canonical_record_id: 7, attempt_count: 1, claim_token: 'claim' };
    const first = await service.processTask(task);
    assert.equal(first.outcome, 'completion_update_error');
    assert.equal(state.txCommits, 1);
    state.status = 'processing'; state.token = 'claim';
    const second = await service.processTask(task);
    assert.equal(second.outcome, 'completed');
    assert.equal(state.txCommits, 2);
    assert.equal(state.cypher.filter(item => item.query.includes('MERGE (c:Concept')).length, 2);
});

test('retries an uncertain Neo4j commit using the same stable graph identifiers', async () => {
    const { service, state } = harness({ failNeo4jCommitOnce: true });
    const task = { outbox_id: 9, canonical_record_type: 'CONCEPT', canonical_record_id: 7, attempt_count: 1, claim_token: 'claim' };
    const first = await service.processTask(task);
    assert.equal(first.outcome, 'retry');
    assert.equal(state.txRollbacks, 1);
    assert.equal(state.sessionCloses, 1);
    const firstGraphId = state.cypher.find(item => item.query.includes('MERGE (c:Concept')).params.graphId;

    state.status = 'processing';
    state.token = 'claim-again';
    const second = await service.processTask({ ...task, attempt_count: 2, claim_token: 'claim-again' });
    assert.equal(second.outcome, 'completed');
    assert.equal(state.txCommits, 2);
    assert.equal(state.sessionCloses, 2);
    const graphIds = state.cypher.filter(item => item.query.includes('MERGE (c:Concept')).map(item => item.params.graphId);
    assert.deepEqual(graphIds, [firstGraphId, firstGraphId]);
});
