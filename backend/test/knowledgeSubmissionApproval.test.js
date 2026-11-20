'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const servicePath = require.resolve('../src/services/knowledgeSubmissionService');
const originalLoad = Module._load;
let mockPool;
let mockValidateCourseIds;
let mockGetAllCourses = async () => [];
class MockCourseValidationError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const poolProxy = {
    execute: (...args) => mockPool.execute(...args),
    getConnection: (...args) => mockPool.getConnection(...args)
};

Module._load = function (request, parent, isMain) {
    if (parent.filename === servicePath && request === '../config/mysql') {
        return poolProxy;
    }
    if (parent.filename === servicePath && request === './knowledgeGraphService') {
        return {
            CourseValidationError: MockCourseValidationError,
            validateCourseIds: (...args) => mockValidateCourseIds(...args),
            getAllCourses: (...args) => mockGetAllCourses(...args)
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const service = require('../src/services/knowledgeSubmissionService');
Module._load = originalLoad;

const COURSE_1 = 'COURSE-11111111-1111-4111-8111-111111111111';
const COURSE_2 = 'COURSE-22222222-2222-4222-8222-222222222222';
const GRAPH_A = 'CONCEPT-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GRAPH_B = 'CONCEPT-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function createHarness({ type = 'CONCEPT', data, status = 'pending', edges = [], concepts = [], courses = [COURSE_1, COURSE_2], failAt, lockResult = 1, lockError, lockReleaseResult = 1, lockReleaseError, commitError, courseError, adminLookupFailure = false } = {}) {
    mockGetAllCourses = async () => courses.map(course_id => ({ course_id, name: 'Database Concepts' }));
    const state = {
        submission: {
            submission_id: 41,
            submission_type: type,
            submission_data: JSON.stringify(data || defaultData(type)),
            status,
            submitted_at: 'now',
            reviewed_by: null,
            review_notes: null,
            reviewed_at: null
        },
        concepts: concepts.map(row => ({ ...row })),
        edges: edges.map(row => ({ ...row })),
        resources: [],
        associations: concepts.map(concept => ({ concept_id: concept.concept_id, course_graph_id: courses[0] })),
        outbox: [],
        calls: [],
        releases: 0,
        rollbacks: 0,
        commits: 0,
        lockReleases: 0,
        nextId: 100,
        failAt,
        lockResult,
        lockError,
        lockReleaseResult,
        lockReleaseError,
        commitError,
        courseError,
        adminLookupFailure,
        courses
    };
    let rowTail = Promise.resolve();

    function maybeFail(sql) {
        if (state.failAt && (
            sql.includes(state.failAt) ||
            (state.failAt === 'OUTBOX_UNIQUE' && sql.includes('INSERT INTO knowledge_sync_outbox'))
        )) {
            const error = new Error('injected database failure');
            if (state.failAt === 'OUTBOX_UNIQUE') {
                error.code = 'ER_DUP_ENTRY';
                error.sqlMessage = "Duplicate entry for key 'uq_knowledge_sync_outbox_submission'";
            }
            throw error;
        }
    }

    function createConnection() {
        let transactionSnapshot;
        let transactionWrites = false;
        let transactionCommitted = false;
        let releaseRow;
        const connection = {
        async beginTransaction() {
            state.calls.push('BEGIN');
            transactionWrites = false;
            transactionCommitted = false;
            transactionSnapshot = structuredClone({
                submission: state.submission,
                concepts: state.concepts,
                edges: state.edges,
                resources: state.resources,
                associations: state.associations,
                outbox: state.outbox
            });
        },
        async commit() {
            state.calls.push('COMMIT');
            state.commits += 1;
            if (state.commitError) {
                transactionCommitted = true;
                releaseRow?.();
                releaseRow = null;
                throw state.commitError;
            }
            transactionCommitted = true;
            releaseRow?.();
            releaseRow = null;
        },
        async rollback() {
            state.calls.push('ROLLBACK');
            state.rollbacks += 1;
            if (transactionSnapshot && transactionWrites && !transactionCommitted) {
                Object.assign(state, structuredClone(transactionSnapshot));
            }
            releaseRow?.();
            releaseRow = null;
        },
        release() {
            state.calls.push('RELEASE_CONNECTION');
            state.releases += 1;
            releaseRow?.();
            releaseRow = null;
        },
        destroy() {
            state.calls.push('DESTROY_CONNECTION');
            state.destroyed = (state.destroyed || 0) + 1;
            releaseRow?.();
            releaseRow = null;
        },
        async execute(sql, params = []) {
            const normalized = sql.replace(/\s+/g, ' ').trim();
            state.calls.push(normalized);
            maybeFail(normalized);

            if (normalized.includes('GET_LOCK')) {
                if (state.lockError) throw state.lockError;
                return [[{ acquired: state.lockResult }], []];
            }
            if (normalized.includes('RELEASE_LOCK')) {
                state.lockReleases += 1;
                if (state.lockReleaseError) throw state.lockReleaseError;
                return [[{ released: state.lockReleaseResult }], []];
            }
            if (normalized.includes('FOR UPDATE') && normalized.includes('INNER JOIN concept_course')) {
                const multipleIds = normalized.includes('c.concept_id IN (?, ?)');
                const requestedIds = multipleIds ? params.slice(0, 2).map(Number) : [Number(params[0])];
                const allowedCourseIds = multipleIds ? params.slice(2) : params.slice(1);
                const rows = state.concepts.filter(concept => requestedIds.includes(Number(concept.concept_id)) && concept.graph_concept_id)
                    .filter(concept => state.associations.some(association => Number(association.concept_id) === Number(concept.concept_id) && allowedCourseIds.includes(association.course_graph_id)))
                    .map(concept => ({ concept_id: concept.concept_id, graph_concept_id: concept.graph_concept_id }));
                return [rows, []];
            }
            if (normalized.includes('FOR UPDATE') && normalized.includes('FROM knowledge_submissions')) {
                const previous = rowTail;
                let unlock;
                rowTail = new Promise(resolve => { unlock = resolve; });
                await previous;
                releaseRow = unlock;
                return [[state.submission ? { ...state.submission } : null].filter(Boolean), []];
            }
            if (normalized.startsWith('SELECT concept_id, graph_concept_id FROM concept')) {
                const [reference] = params;
                const found = /^\d+$/.test(String(reference))
                    ? state.concepts.find(row => Number(row.concept_id) === Number(reference))
                    : state.concepts.find(row => row.graph_concept_id === reference);
                return [[found ? { ...found } : null].filter(Boolean), []];
            }
            if (normalized.startsWith('SELECT concept_id FROM concept WHERE concept_name')) {
                const rows = state.concepts
                    .filter(row => row.concept_name === params[0])
                    .map(row => ({ concept_id: row.concept_id }));
                return [rows, []];
            }
            if (normalized.startsWith('SELECT prerequisite_id FROM concept_prerequisite')) {
                const found = state.edges.filter(row =>
                    Number(row.prerequisite_concept_id) === Number(params[0]) &&
                    Number(row.target_concept_id) === Number(params[1])
                );
                return [found, []];
            }
            if (normalized.startsWith('SELECT prerequisite_concept_id, target_concept_id FROM concept_prerequisite')) {
                return [[...state.edges], []];
            }
            if (normalized.startsWith('INSERT INTO concept (')) {
                const row = {
                    concept_id: ++state.nextId,
                    concept_name: params[0],
                    description: params[1],
                    difficulty_level: params[2],
                    graph_concept_id: params[3]
                };
                state.concepts.push(row);
                transactionWrites = true;
                return [{ insertId: row.concept_id, affectedRows: 1 }, []];
            }
            if (normalized.startsWith('INSERT INTO concept_course')) {
                state.associations.push({ concept_id: params[0], course_graph_id: params[1] });
                transactionWrites = true;
                return [{ insertId: 0, affectedRows: 1 }, []];
            }
            if (normalized.startsWith('INSERT INTO concept_prerequisite')) {
                const row = {
                    prerequisite_id: ++state.nextId,
                    prerequisite_concept_id: params[0],
                    target_concept_id: params[1]
                };
                state.edges.push(row);
                transactionWrites = true;
                return [{ insertId: row.prerequisite_id, affectedRows: 1 }, []];
            }
            if (normalized.startsWith('INSERT INTO learning_resource')) {
                const row = {
                    resource_id: ++state.nextId,
                    concept_id: params[0], title: params[1], resource_type: params[2],
                    file_url: params[3], graph_resource_id: params[4]
                };
                state.resources.push(row);
                transactionWrites = true;
                return [{ insertId: row.resource_id, affectedRows: 1 }, []];
            }
            if (normalized.startsWith('UPDATE knowledge_submissions')) {
                if (state.submission.status !== 'pending') return [{ affectedRows: 0 }, []];
                Object.assign(state.submission, {
                    status: params[0], review_notes: params[1], reviewed_by: params[2], reviewed_at: 'now'
                });
                transactionWrites = true;
                return [{ affectedRows: 1 }, []];
            }
            if (normalized.startsWith('INSERT INTO knowledge_sync_outbox')) {
                state.outbox.push({ submission_id: params[0], canonical_record_type: params[1], canonical_record_id: params[2] });
                transactionWrites = true;
                return [{ insertId: ++state.nextId, affectedRows: 1 }, []];
            }
            if (normalized.includes('LEFT JOIN knowledge_sync_outbox')) {
                return [[{
                    submission_id: state.submission.submission_id,
                    submission_type: state.submission.submission_type,
                    submission_data: state.submission.submission_data,
                    status: state.submission.status,
                    submitted_at: state.submission.submitted_at,
                    reviewed_by: state.submission.reviewed_by,
                    review_notes: state.submission.review_notes,
                    reviewed_at: state.submission.reviewed_at,
                    submitter_learner_id: 9,
                    submitter_username: 'student',
                    submitter_email: 'student@example.test',
                    reviewer_learner_id: state.submission.reviewed_by,
                    reviewer_username: 'admin',
                    reviewer_email: 'admin@example.test',
                    canonical_record_type: state.outbox[0]?.canonical_record_type,
                    canonical_record_id: state.outbox[0]?.canonical_record_id
                }], []];
            }
            if (normalized.startsWith('SELECT concept_id FROM concept WHERE concept_id')) {
                return [[state.concepts.some(row => Number(row.concept_id) === Number(params[0]))
                    ? { concept_id: params[0] } : null].filter(Boolean), []];
            }
            if (normalized.startsWith('SELECT prerequisite_id FROM concept_prerequisite WHERE prerequisite_id')) {
                return [[state.edges.some(row => Number(row.prerequisite_id) === Number(params[0]))
                    ? { prerequisite_id: params[0] } : null].filter(Boolean), []];
            }
            if (normalized.startsWith('SELECT resource_id FROM learning_resource')) {
                return [[state.resources.some(row => Number(row.resource_id) === Number(params[0]))
                    ? { resource_id: params[0] } : null].filter(Boolean), []];
            }
            throw new Error(`Unhandled test SQL: ${normalized}`);
        }
        };
        return connection;
    }

    mockPool = {
        async getConnection() { return createConnection(); },
        async execute(sql, params = []) {
            const normalized = sql.replace(/\s+/g, ' ').trim();
            state.calls.push(`POOL ${normalized}`);
            if (normalized.startsWith('SELECT submission_type, submission_data, status')) {
                return [[state.submission ? {
                    submission_type: state.submission.submission_type,
                    submission_data: state.submission.submission_data,
                    status: state.submission.status
                } : null].filter(Boolean), []];
            }
            if (normalized.startsWith('SELECT s.submission_id, s.submission_type')) {
                if (state.adminLookupFailure) throw new Error('response lookup failed');
                return [[{
                    ...state.submission,
                    submitter_learner_id: 9,
                    submitter_username: 'student',
                    submitter_email: 'student@example.test',
                    reviewer_learner_id: state.submission.reviewed_by,
                    reviewer_username: 'admin',
                    reviewer_email: 'admin@example.test'
                }], []];
            }
            throw new Error(`Unhandled pool SQL: ${normalized}`);
        }
    };
    mockPool.state = state;
    mockValidateCourseIds = async ids => {
        if (state.courseError) throw state.courseError;
        if (!Array.isArray(ids) || !ids.length) {
            throw new MockCourseValidationError('INVALID_COURSE_IDS', 'At least one course ID must be provided.');
        }
        const missing = ids.some(id => !state.courses.includes(id));
        if (missing) {
            throw new MockCourseValidationError('COURSES_NOT_FOUND', 'One or more selected courses do not exist.');
        }
        return ids;
    };
    return state;
}

function defaultData(type) {
    if (type === 'CONCEPT') return { name: 'Graph Theory', description: 'Graphs' };
    if (type === 'PREREQUISITE') return { prerequisiteId: 1, targetId: 2 };
    return { conceptId: 1, title: 'Resource', type: 'video', url: 'https://example.test/resource' };
}

const conceptRows = [
    { concept_id: 1, graph_concept_id: GRAPH_A },
    { concept_id: 2, graph_concept_id: GRAPH_B },
    { concept_id: 3, graph_concept_id: 'CONCEPT-cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
];

function review(overrides = {}) {
    return service.reviewPendingSubmission({
        submissionId: 41, status: 'approved', reviewNotes: 'Reviewed', reviewerId: 7,
        courseIds: [COURSE_1, COURSE_2], conceptId: 1, difficultyLevel: 'Intermediate', ...overrides
    });
}

test('approves concepts with course associations and one typed outbox task', async () => {
    const state = createHarness();
    const result = await review();
    assert.equal(result.outcome, 'reviewed');
    assert.equal(state.concepts.length, 1);
    assert.match(state.concepts[0].graph_concept_id, /^CONCEPT-[0-9a-f-]{36}$/);
    assert.equal(state.concepts[0].difficulty_level, 'Intermediate');
    assert.deepEqual(state.associations.map(row => row.course_graph_id), [COURSE_1, COURSE_2]);
    assert.equal(state.outbox.length, 1);
    assert.deepEqual(state.outbox[0], {
        submission_id: 41, canonical_record_type: 'CONCEPT', canonical_record_id: state.concepts[0].concept_id
    });
    assert.equal(state.commits, 1);
    assert.equal(state.releases, 1);
});

test('student concept submissions need no difficulty and admin choice overrides historical suggestion', async () => {
    const state = createHarness({ data: { name: 'Graph Theory', description: 'Graphs', difficultyLevel: 'Legacy text' } });
    await review({ difficultyLevel: 'Advanced' });
    assert.equal(state.concepts[0].difficulty_level, 'Advanced');
    assert.equal(state.outbox[0].canonical_record_id, state.concepts[0].concept_id);
});

test('rejects missing or invalid admin difficulty before canonical transaction', async t => {
    for (const [label, difficultyLevel] of [
        ['missing', undefined],
        ['invalid', 'Expert']
    ]) {
        await t.test(label, async () => {
            const state = createHarness();
            await assert.rejects(
                review({ difficultyLevel }),
                error => error.code === 'invalid_difficulty_level'
            );
            assert.equal(state.concepts.length, 0);
            assert.equal(state.outbox.length, 0);
            assert.equal(state.rollbacks, 0);
            assert.equal(state.releases, 0);
        });
    }
});

test('approves a prerequisite using canonical concept IDs and its relationship insert ID', async () => {
    createHarness({ type: 'PREREQUISITE', concepts: conceptRows });
    const state = mockPool.state;
    const result = await review({ courseIds: undefined });
    assert.equal(result.outcome, 'reviewed');
    assert.deepEqual(state.edges, [{ prerequisite_id: 101, prerequisite_concept_id: 1, target_concept_id: 2 }]);
    assert.equal(state.outbox[0].canonical_record_type, 'PREREQUISITE');
    assert.equal(state.outbox[0].canonical_record_id, 101);
    assert.equal(state.lockReleases, 1);
});

test('approves a resource with a stable graph ID and typed outbox task', async () => {
    const state = createHarness({ type: 'RESOURCE', concepts: conceptRows });
    await review({ courseIds: undefined });
    assert.equal(state.resources.length, 1);
    assert.match(state.resources[0].graph_resource_id, /^RESOURCE-[0-9a-f-]{36}$/);
    assert.equal(state.outbox[0].canonical_record_type, 'RESOURCE');
    assert.equal(state.outbox[0].canonical_record_id, state.resources[0].resource_id);
});

test('resource approval requires a selected Database Concept and writes that association canonically', async t => {
    await t.test('missing selection rejected before transaction', async () => {
        const state = createHarness({ type: 'RESOURCE', concepts: conceptRows });
        await assert.rejects(review({ conceptId: undefined }), error => error.name === 'ApprovalError' && error.code === 'invalid_concept_reference');
        assert.equal(state.resources.length, 0);
        assert.equal(state.outbox.length, 0);
    });
    await t.test('selected canonical concept attached', async () => {
        const state = createHarness({ type: 'RESOURCE', concepts: conceptRows });
        await review({ conceptId: 2 });
        assert.equal(state.resources[0].concept_id, 2);
        assert.equal(state.outbox[0].canonical_record_type, 'RESOURCE');
    });
});

test('resource association rejects a concept outside Database Concepts', async () => {
    const state = createHarness({ type: 'RESOURCE', concepts: conceptRows, courses: [COURSE_1, COURSE_2] });
    state.associations = state.associations.filter(association => Number(association.concept_id) !== 2);
    state.associations.push({ concept_id: 2, course_graph_id: COURSE_2 });
    mockGetAllCourses = async () => [
        { course_id: COURSE_1, name: 'Database Concepts' },
        { course_id: COURSE_2, name: 'Mathematics' }
    ];
    await assert.rejects(review({ conceptId: 2 }), error => error.name === 'ApprovalError' && error.code === 'invalid_concept_reference');
    assert.equal(state.resources.length, 0);
    assert.equal(state.outbox.length, 0);
});

test('rejection updates review metadata without canonical rows or outbox work', async () => {
    const state = createHarness({ type: 'CONCEPT' });
    const result = await service.reviewPendingSubmission({
        submissionId: 41, status: 'rejected', reviewNotes: 'No', reviewerId: 8
    });
    assert.equal(result.outcome, 'reviewed');
    assert.equal(state.concepts.length, 0);
    assert.equal(state.outbox.length, 0);
    assert.equal(state.submission.status, 'rejected');
});

test('rejecting a resource does not create a canonical record or outbox task', async () => {
    const state = createHarness({ type: 'RESOURCE', concepts: conceptRows });
    const result = await service.reviewPendingSubmission({
        submissionId: 41, status: 'rejected', reviewNotes: 'Not suitable', reviewerId: 8
    });
    assert.equal(result.outcome, 'reviewed');
    assert.equal(state.submission.status, 'rejected');
    assert.equal(state.resources.length, 0);
    assert.equal(state.outbox.length, 0);
});

test('returns not found and already reviewed without writes', async () => {
    const missing = createHarness();
    missing.submission = null;
    assert.equal((await review()).outcome, 'not_found');
    const reviewed = createHarness({ status: 'approved' });
    assert.equal((await review()).outcome, 'already_reviewed');
    assert.equal(reviewed.outbox.length, 0);
});

test('rejects duplicate concept names and rolls back', async () => {
    const state = createHarness({ concepts: [{ concept_id: 4, concept_name: 'Graph Theory' }] });
    await assert.rejects(review(), error => error.code === 'duplicate_concept');
    assert.equal(state.rollbacks, 1);
    assert.equal(state.outbox.length, 0);
});

test('rejects duplicate and invalid or self-referencing prerequisite relationships', async () => {
    const duplicate = createHarness({ type: 'PREREQUISITE', concepts: conceptRows, edges: [{ prerequisite_concept_id: 1, target_concept_id: 2 }] });
    await assert.rejects(review({ courseIds: undefined }), error => error.code === 'duplicate_prerequisite');
    assert.equal(duplicate.outbox.length, 0);

    const missing = createHarness({ type: 'PREREQUISITE', concepts: [conceptRows[0]] });
    await assert.rejects(review({ courseIds: undefined }), error => error.code === 'invalid_concept_reference');
    assert.equal(missing.outbox.length, 0);

    const self = createHarness({ type: 'PREREQUISITE', data: { prerequisiteId: 1, targetId: 1 }, concepts: conceptRows });
    await assert.rejects(review({ courseIds: undefined }), error => error.code === 'self_prerequisite');
    assert.equal(self.outbox.length, 0);
});

test('rejects direct and multi-edge prerequisite cycles', async () => {
    const direct = createHarness({ type: 'PREREQUISITE', concepts: conceptRows, edges: [{ prerequisite_concept_id: 2, target_concept_id: 1 }] });
    await assert.rejects(review({ courseIds: undefined }), error => error.code === 'prerequisite_cycle');
    assert.equal(direct.outbox.length, 0);

    const multi = createHarness({ type: 'PREREQUISITE', concepts: conceptRows, edges: [
        { prerequisite_concept_id: 2, target_concept_id: 3 },
        { prerequisite_concept_id: 3, target_concept_id: 1 }
    ] });
    await assert.rejects(review({ courseIds: undefined }), error => error.code === 'prerequisite_cycle');
    assert.equal(multi.outbox.length, 0);
});

test('handles advisory lock timeout and query errors without beginning a transaction', async () => {
    const timeout = createHarness({ type: 'PREREQUISITE', concepts: conceptRows, lockResult: 0 });
    await assert.rejects(review({ courseIds: undefined }), error => error.code === 'prerequisite_lock_timeout');
    assert.equal(timeout.calls.includes('BEGIN'), false);
    assert.equal(timeout.releases, 1);

    const failed = createHarness({ type: 'PREREQUISITE', concepts: conceptRows, lockError: new Error('db error') });
    await assert.rejects(review({ courseIds: undefined }), error => error.code === 'prerequisite_lock_failed');
    assert.equal(failed.releases, 1);
});

test('releases the advisory lock and connection after success and transaction failure', async () => {
    const success = createHarness({ type: 'PREREQUISITE', concepts: conceptRows });
    await review({ courseIds: undefined });
    assert.equal(success.lockReleases, 1);
    assert.equal(success.releases, 1);
    assert.equal(success.destroyed || 0, 0);

    const failure = createHarness({ type: 'PREREQUISITE', concepts: conceptRows, failAt: 'INSERT INTO concept_prerequisite' });
    await assert.rejects(review({ courseIds: undefined }));
    assert.equal(failure.rollbacks, 1);
    assert.equal(failure.lockReleases, 1);
    assert.equal(failure.releases, 1);
});

test('destroys a connection when advisory lock release errors or is not confirmed', async () => {
    for (const options of [
        { lockReleaseError: new Error('release failed') },
        { lockReleaseResult: 0 }
    ]) {
        const state = createHarness({ type: 'PREREQUISITE', concepts: conceptRows, ...options });
        const originalError = console.error;
        console.error = () => {};
        try {
            await review({ courseIds: undefined });
        } finally {
            console.error = originalError;
        }
        assert.equal(state.destroyed, 1);
        assert.equal(state.releases, 0);
    }
});

test('rolls back when canonical, association, review, or outbox writes fail', async () => {
    for (const failingSql of [
        'INSERT INTO concept (', 'INSERT INTO concept_course', 'UPDATE knowledge_submissions', 'INSERT INTO knowledge_sync_outbox'
    ]) {
        const state = createHarness({ failAt: failingSql });
        await assert.rejects(review());
        assert.equal(state.rollbacks, 1, failingSql);
        assert.equal(state.releases, 1, failingSql);
        assert.equal(state.outbox.length, 0, failingSql);
    }
});

test('maps an outbox uniqueness conflict to a consistency error and rolls back', async () => {
    const state = createHarness({ failAt: 'OUTBOX_UNIQUE' });
    await assert.rejects(review(), error => error.code === 'outbox_conflict');
    assert.equal(state.rollbacks, 1);
});

test('course validation failure prevents acquiring a transaction connection', async () => {
    const state = createHarness({ courseError: new Error('Neo4j unavailable') });
    await assert.rejects(review(), error => error.code === 'course_validation_unavailable');
    assert.equal(state.calls.includes('BEGIN'), false);
    assert.equal(state.releases, 0);
});

test('rejects invalid or missing course selections before acquiring a transaction connection', async () => {
    const invalid = createHarness({
        courseError: new MockCourseValidationError('INVALID_COURSE_IDS', 'Course IDs must not contain duplicates.')
    });
    await assert.rejects(review(), error => error.code === 'invalid_course_ids');
    assert.equal(invalid.calls.includes('BEGIN'), false);
    assert.equal(invalid.releases, 0);

    const missing = createHarness({
        courseError: new MockCourseValidationError('COURSES_NOT_FOUND', 'One or more selected courses do not exist.')
    });
    await assert.rejects(review(), error => error.code === 'courses_not_found');
    assert.equal(missing.calls.includes('BEGIN'), false);
});

test('reports success when post-commit response lookup fails and reconciliation succeeds', async () => {
    const state = createHarness({ adminLookupFailure: true });
    const originalError = console.error;
    console.error = () => {};
    let result;
    try {
        result = await review();
    } finally {
        console.error = originalError;
    }
    assert.equal(state.commits, 1);
    assert.equal(state.rollbacks, 0);
    assert.equal(result.outcome, 'reviewed');
    assert.equal(result.submission.status, 'approved');
    assert.equal(result.submission.reviewer.learnerId, 7);
    assert.equal(state.outbox.length, 1);
});

test('rolls back resource and prerequisite canonical insert failures', async () => {
    const resource = createHarness({ type: 'RESOURCE', concepts: conceptRows, failAt: 'INSERT INTO learning_resource' });
    await assert.rejects(review({ courseIds: undefined }));
    assert.equal(resource.rollbacks, 1);
    assert.equal(resource.outbox.length, 0);

    const prerequisite = createHarness({ type: 'PREREQUISITE', concepts: conceptRows, failAt: 'INSERT INTO concept_prerequisite' });
    await assert.rejects(review({ courseIds: undefined }));
    assert.equal(prerequisite.rollbacks, 1);
    assert.equal(prerequisite.lockReleases, 1);
    assert.equal(prerequisite.outbox.length, 0);
});

test('serializes concurrent approvals so only one creates canonical data', async () => {
    const state = createHarness();
    const outcomes = await Promise.all([
        review(),
        review()
    ]);
    assert.deepEqual(outcomes.map(item => item.outcome).sort(), ['already_reviewed', 'reviewed']);
    assert.equal(state.concepts.length, 1);
    assert.equal(state.outbox.length, 1);
    assert.equal(state.calls.filter(call => typeof call === 'string' && call.includes('FOR UPDATE')).length, 2);
});

test('reconciles an uncertain commit against status, type, ID, outbox, and canonical row', async () => {
    const state = createHarness({ commitError: new Error('connection lost during commit') });
    const result = await review();
    assert.equal(result.outcome, 'reviewed');
    assert.equal(state.outbox.length, 1);
    assert.equal(state.releases, 2);
});
