'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLearnerProgressService } = require('../src/services/learnerProgressService');

const COURSE_ID = 'COURSE-11111111-1111-4111-8111-111111111111';
const PREREQUISITE_COURSE_ID = 'COURSE-22222222-2222-4222-8222-222222222222';
const AS_OF = new Date('2026-05-01T00:00:00.000Z');

function createMysql({ concepts = [], evidence = [], learnerExists = true, failEvidence = false,
    extraCourses = [], courseEdges = [], unresolved = [], memberships = null } = {}) {
    const courseRows = [{ course_id: 1, graph_course_id: COURSE_ID, title: 'Database Concepts' }, ...extraCourses];
    const state = { calls: [], commits: 0, rollbacks: 0, releases: 0, destroys: 0 };
    const connection = {
        async query(sql) { state.calls.push({ sql, params: [] }); return [[]]; },
        async beginTransaction() {},
        async execute(sql, params = []) {
            state.calls.push({ sql, params });
            if (sql.includes('SELECT learner_id FROM learner')) return [learnerExists ? [{ learner_id: params[0] }] : []];
            if (sql.includes('SELECT course_id, graph_course_id, title FROM course WHERE graph_course_id')) return [[...courseRows.filter(row => row.graph_course_id === params[0])]];
            if (sql.includes('FROM course_prerequisite WHERE is_active')) return [[...structuredClone(courseEdges)]];
            if (sql.includes('SELECT course_id, graph_course_id, title FROM course WHERE course_id IN')) return [[...courseRows.filter(row => params.includes(row.course_id))]];
            if (sql.includes('FROM knowledge_sync_outbox')) return [[...unresolved]];
            if (sql.includes('FROM concept AS c')) return [[...structuredClone(memberships || concepts.map(row => ({ graphCourseId: COURSE_ID, ...row })) )]];
            if (sql.includes('FROM quiz_result AS qr')) {
                if (failEvidence) throw new Error('mock evidence query failure');
                return [[...structuredClone(evidence)]];
            }
            throw new Error(`Unexpected progress query: ${sql}`);
        },
        async commit() { state.commits++; },
        async rollback() { state.rollbacks++; },
        release() { state.releases++; },
        destroy() { state.destroys++; }
    };
    return { state, pool: { async getConnection() { return connection; } } };
}

test('unknown mastery remains unknown and does not count toward course progress', async () => {
    const mysql = createMysql({ concepts: [
        { conceptId: 1, conceptName: 'Foundations' },
        { conceptId: 2, conceptName: 'SQL' }
    ] });
    const service = createLearnerProgressService({ mysql: mysql.pool, asOf: () => AS_OF, coursePrerequisiteReader: async ids => new Map(ids.map(id => [id, []])) });
    const result = await service.getProgressForLearner({ learnerId: 7, courseId: COURSE_ID });

    assert.deepEqual(result, {
        progress: { percentage: 0, masteredConcepts: 0, totalConcepts: 2 },
        mastery: { percentage: null, status: 'UNKNOWN', assessedConcepts: 0, totalConcepts: 2 },
        courseCompletion: { complete: false, masteredConcepts: 0, totalConcepts: 2 },
        prerequisiteEligibility: { eligible: true, prerequisites: [] }
    });
    assert.equal(mysql.state.calls.some(call => /learning_path/.test(call.sql)), false);
    assert.equal(mysql.state.commits, 1);
    assert.equal(mysql.state.releases, 1);
});

test('progress counts evidence-based mastered concepts and reports partial evidence', async () => {
    const evidence = [
        { conceptId: 1, assessmentId: 10, score: '90.00', assessmentDate: AS_OF, questionCount: '5', correctCount: '4', timestampProvenance: 'utc' },
        { conceptId: 1, assessmentId: 11, score: '90.00', assessmentDate: AS_OF, questionCount: '5', correctCount: '4', timestampProvenance: 'utc' },
        { conceptId: 2, assessmentId: 12, score: '70.00', assessmentDate: AS_OF, questionCount: null, correctCount: null, timestampProvenance: 'unknown' }
    ];
    const mysql = createMysql({ concepts: [
        { conceptId: 1, conceptName: 'Foundations' },
        { conceptId: 2, conceptName: 'SQL' }
    ], evidence });
    const service = createLearnerProgressService({ mysql: mysql.pool, asOf: () => AS_OF, coursePrerequisiteReader: async ids => new Map(ids.map(id => [id, []])) });
    const result = await service.getProgressForLearner({ learnerId: 7, courseId: COURSE_ID });

    assert.deepEqual(result, {
        progress: { percentage: 80, masteredConcepts: 1, totalConcepts: 2 },
        mastery: { percentage: 80, status: 'PROVISIONAL', assessedConcepts: 2, totalConcepts: 2 },
        courseCompletion: { complete: false, masteredConcepts: 1, totalConcepts: 2 },
        prerequisiteEligibility: { eligible: true, prerequisites: [] }
    });
    const evidenceQuery = mysql.state.calls.find(call => call.sql.includes('FROM quiz_result AS qr'));
    assert.deepEqual(evidenceQuery.params, [7, 1, 2]);
});

test('one high provisional assessment does not count as a mastered concept', async () => {
    const mysql = createMysql({ concepts: [
        { conceptId: 1, conceptName: 'Foundations' }
    ], evidence: [
        { conceptId: 1, assessmentId: 20, score: 95, assessmentDate: AS_OF, questionCount: 5, correctCount: 5, timestampProvenance: 'utc' }
    ] });
    const service = createLearnerProgressService({ mysql: mysql.pool, asOf: () => AS_OF,
        coursePrerequisiteReader: async ids => new Map(ids.map(id => [id, []])) });
    const result = await service.getProgressForLearner({ learnerId: 7, courseId: COURSE_ID });
    assert.equal(result.mastery.status, 'PROVISIONAL');
    assert.equal(result.progress.masteredConcepts, 0);
    assert.equal(result.progress.percentage, 95);
});

test('only evidence-qualified mastery at or above 85 percent counts toward course progress', async () => {
    const mysql = createMysql({ concepts: [
        { conceptId: 1, conceptName: 'At threshold' },
        { conceptId: 2, conceptName: 'Below threshold' }
    ], evidence: [
        { conceptId: 1, assessmentId: 31, score: 85, assessmentDate: AS_OF, questionCount: 5, correctCount: 4, timestampProvenance: 'utc' },
        { conceptId: 1, assessmentId: 32, score: 85, assessmentDate: AS_OF, questionCount: 5, correctCount: 4, timestampProvenance: 'utc' },
        { conceptId: 2, assessmentId: 33, score: 84.99, assessmentDate: AS_OF, questionCount: 5, correctCount: 4, timestampProvenance: 'utc' },
        { conceptId: 2, assessmentId: 34, score: 84.99, assessmentDate: AS_OF, questionCount: 5, correctCount: 4, timestampProvenance: 'utc' }
    ] });
    const service = createLearnerProgressService({ mysql: mysql.pool, asOf: () => AS_OF,
        coursePrerequisiteReader: async ids => new Map(ids.map(id => [id, []])) });
    const result = await service.getProgressForLearner({ learnerId: 7, courseId: COURSE_ID });
    assert.equal(result.progress.masteredConcepts, 1);
    assert.equal(result.progress.totalConcepts, 2);
    assert.equal(result.progress.percentage, 84.995);
});

test('partial mastery contributes to progress while matseresd concept count retains its evidence threshold', async t => {
    const concepts = [
        { conceptId: 1, conceptName: 'Course target concept', graphCourseId: COURSE_ID },
        { conceptId: 2, conceptName: 'Prerequisite concept', graphCourseId: PREREQUISITE_COURSE_ID }
    ];
    const edges = [{ relationshipId: 8, prerequisiteCourseId: 2, targetCourseId: 1 }];
    const graphReader = async ids => new Map([
        [COURSE_ID, [PREREQUISITE_COURSE_ID]],
        [PREREQUISITE_COURSE_ID, []]
    ].filter(([id]) => ids.includes(id)));
    await t.test('two assessments and mastery >= 80 satisfy prerequisite', async () => {
        const mysql = createMysql({ extraCourses: [{ course_id: 2, graph_course_id: PREREQUISITE_COURSE_ID, title: 'Foundations' }],
            courseEdges: edges, memberships: concepts, evidence: [
                { conceptId: 2, assessmentId: 10, score: 80, assessmentDate: AS_OF, questionCount: 5, correctCount: 4, timestampProvenance: 'utc' },
                { conceptId: 2, assessmentId: 11, score: 80, assessmentDate: AS_OF, questionCount: 5, correctCount: 4, timestampProvenance: 'utc' }
            ] });
        const service = createLearnerProgressService({ mysql: mysql.pool, asOf: () => AS_OF, coursePrerequisiteReader: graphReader });
        const result = await service.getProgressForLearner({ learnerId: 7, courseId: COURSE_ID });
        assert.deepEqual(result.prerequisiteEligibility, { eligible: true, prerequisites: [{ courseId: 2, title: 'Foundations', satisfied: true }] });
        assert.equal(result.courseCompletion.complete, false);
    });
    await t.test('unknown evidence and graph mismatch fail closed', async () => {
        const mysql = createMysql({ extraCourses: [{ course_id: 2, graph_course_id: PREREQUISITE_COURSE_ID, title: 'Foundations' }], courseEdges: edges, memberships: concepts });
        const service = createLearnerProgressService({ mysql: mysql.pool, asOf: () => AS_OF, coursePrerequisiteReader: async ids => new Map(ids.map(id => [id, []])) });
        await assert.rejects(service.getProgressForLearner({ learnerId: 7, courseId: COURSE_ID }), error => error.code === 'COURSE_PREREQUISITE_MISMATCH');
    });
});

test('a course with no concepts returns zero progress and unknown mastery without evidence query', async () => {
    const mysql = createMysql();
    const service = createLearnerProgressService({ mysql: mysql.pool, asOf: () => AS_OF, coursePrerequisiteReader: async ids => new Map(ids.map(id => [id, []])) });
    const result = await service.getProgressForLearner({ learnerId: 7, courseId: COURSE_ID });

    assert.deepEqual(result, {
        progress: { percentage: 0, masteredConcepts: 0, totalConcepts: 0 },
        mastery: { percentage: null, status: 'UNKNOWN', assessedConcepts: 0, totalConcepts: 0 },
        courseCompletion: { complete: false, masteredConcepts: 0, totalConcepts: 0 },
        prerequisiteEligibility: { eligible: true, prerequisites: [] }
    });
    assert.equal(mysql.state.calls.some(call => call.sql.includes('FROM quiz_result AS qr')), false);
});

test('learner identity and invalid database evidence fail safely', async t => {
    await t.test('missing learner', async () => {
        const mysql = createMysql({ learnerExists: false });
        const service = createLearnerProgressService({ mysql: mysql.pool, asOf: () => AS_OF, coursePrerequisiteReader: async ids => new Map(ids.map(id => [id, []])) });
        await assert.rejects(service.getProgressForLearner({ learnerId: 7, courseId: COURSE_ID }), error => error.code === 'LEARNER_NOT_FOUND');
    });
    await t.test('evidence query failure', async () => {
        const mysql = createMysql({ concepts: [{ conceptId: 1, conceptName: 'Foundations' }], failEvidence: true });
        const service = createLearnerProgressService({ mysql: mysql.pool, asOf: () => AS_OF, coursePrerequisiteReader: async ids => new Map(ids.map(id => [id, []])) });
        await assert.rejects(service.getProgressForLearner({ learnerId: 7, courseId: COURSE_ID }), error => error.code === 'PROGRESS_UNAVAILABLE');
        assert.equal(mysql.state.rollbacks, 1);
        assert.equal(mysql.state.releases, 1);
    });
});
