'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createRecommendationService,
    RecommendationServiceError
} = require('../src/services/recommendationService');

const COURSE_ID = 'COURSE-11111111-1111-4111-8111-111111111111';
const AS_OF = new Date('2026-04-01T12:00:00.000Z');

const concepts = [
    { conceptId: 1, conceptName: 'Foundations', graphConceptId: 'CONCEPT-1' },
    { conceptId: 2, conceptName: 'Relations', graphConceptId: 'CONCEPT-2' },
    { conceptId: 3, conceptName: 'Indexes', graphConceptId: 'CONCEPT-3' },
    { conceptId: 4, conceptName: 'Transactions', graphConceptId: 'CONCEPT-4' }
];

const candidateRows = concepts.map(concept => ({
    ...concept,
    courseGraphId: COURSE_ID
}));

const canonicalEdges = [
    { prerequisiteRowId: 101, prerequisiteId: 1, targetId: 2 },
    { prerequisiteRowId: 102, prerequisiteId: 2, targetId: 3 }
];

const evidenceRows = [
    { conceptId: 1, assessmentId: 11, score: '90.00', assessmentDate: new Date('2026-03-01T12:00:00Z'), questionCount: '5', correctCount: '5', timestampProvenance: 'utc' },
    { conceptId: 1, assessmentId: 12, score: '90.00', assessmentDate: new Date('2026-03-15T12:00:00Z'), questionCount: '5', correctCount: '5', timestampProvenance: 'utc' },
    { conceptId: 2, assessmentId: 21, score: '82.00', assessmentDate: new Date('2026-03-01T12:00:00Z'), questionCount: '2', correctCount: '2', timestampProvenance: 'utc' },
    { conceptId: 2, assessmentId: 22, score: '82.00', assessmentDate: new Date('2026-03-15T12:00:00Z'), questionCount: '2', correctCount: '2', timestampProvenance: 'utc' },
    { conceptId: 3, assessmentId: 31, score: '60.00', assessmentDate: null, questionCount: null, correctCount: null, timestampProvenance: 'unknown' },
    { conceptId: 3, assessmentId: 32, score: '70.00', assessmentDate: null, questionCount: null, correctCount: null, timestampProvenance: 'unknown' }
];

function baseGraphSnapshot() {
    return {
        courseId: COURSE_ID,
        courseName: 'Database Concepts',
        courseConceptIds: concepts.map(concept => concept.graphConceptId),
        closures: [
            { candidateGraphId: 'CONCEPT-1', prerequisiteGraphIds: [] },
            { candidateGraphId: 'CONCEPT-2', prerequisiteGraphIds: ['CONCEPT-1'] },
            { candidateGraphId: 'CONCEPT-3', prerequisiteGraphIds: ['CONCEPT-1', 'CONCEPT-2'] },
            { candidateGraphId: 'CONCEPT-4', prerequisiteGraphIds: [] }
        ],
        edges: [
            { prerequisiteGraphId: 'CONCEPT-1', targetGraphId: 'CONCEPT-2' },
            { prerequisiteGraphId: 'CONCEPT-2', targetGraphId: 'CONCEPT-3' }
        ]
    };
}

function createMysql({
    candidateRows: candidateOverrides = candidateRows,
    concepts: conceptOverrides = concepts,
    edges: edgeOverrides = canonicalEdges,
    evidence: evidenceOverrides = evidenceRows,
    unresolvedTasks = [],
    coursePrerequisites = [],
    relevantCourses = [{ courseId: 1, graphCourseId: COURSE_ID, title: 'Database Concepts' }],
    courseConcepts = candidateRows.map(row => ({ courseGraphId: COURSE_ID, conceptId: row.conceptId })),
    learnerExists = true,
    failAt = null,
    failRollback = false,
    failRelease = false
} = {}) {
    const state = {
        calls: [], beginCount: 0, commitCount: 0, rollbackCount: 0,
        releaseCount: 0, destroyCount: 0, getConnectionCount: 0
    };
    const connection = {
        async beginTransaction() { state.beginCount++; },
        async query(sql) {
            state.calls.push({ sql, params: [] });
            if (failAt && sql.includes(failAt)) throw new Error('mock MySQL failure');
            return [[]];
        },
        async execute(sql, params = []) {
            const normalized = sql.replace(/\s+/g, ' ').trim();
            state.calls.push({ sql: normalized, params: structuredClone(params) });
            if (failAt && normalized.includes(failAt)) throw new Error('mock MySQL failure');
            if (normalized.startsWith('SELECT learner_id FROM learner')) {
                return [learnerExists ? [{ learner_id: params[0] }] : []];
            }
            if (normalized.startsWith('SELECT c.concept_id AS conceptId')) {
                return [[...structuredClone(candidateOverrides)]];
            }
            if (normalized.startsWith('SELECT course_id AS courseId, graph_course_id AS graphCourseId, title FROM course WHERE graph_course_id')) {
                return [[{ courseId: 1, graphCourseId: COURSE_ID, title: 'Database Concepts' }]];
            }
            if (normalized.startsWith('SELECT course_prerequisite_id AS relationshipId')) return [[...structuredClone(coursePrerequisites)]];
            if (normalized.startsWith('SELECT course_id AS courseId, graph_course_id AS graphCourseId, title FROM course WHERE course_id IN')) {
                return [[...structuredClone(relevantCourses)]];
            }
            if (normalized.startsWith('SELECT cc.course_graph_id AS courseGraphId')) return [[...structuredClone(courseConcepts)]];
            if (normalized.startsWith('SELECT concept_id AS conceptId')) {
                return [[...structuredClone(conceptOverrides)]];
            }
            if (normalized.startsWith('SELECT prerequisite_id AS prerequisiteRowId')) {
                return [[...structuredClone(edgeOverrides)]];
            }
            if (normalized.startsWith('SELECT canonical_record_type AS recordType')) {
                return [[...structuredClone(unresolvedTasks)]];
            }
            if (normalized.startsWith('SELECT qr.concept_id AS conceptId')) {
                const [learnerId, ...ids] = params;
                state.evidenceParams = { learnerId, ids };
                return [[...structuredClone(evidenceOverrides).filter(row => ids.includes(Number(row.conceptId)))]];
            }
            throw new Error(`Unexpected SQL in recommendation service mock: ${normalized}`);
        },
        async commit() { state.commitCount++; },
        async rollback() {
            state.rollbackCount++;
            if (failRollback) throw new Error('mock rollback failure');
        },
        release() {
            state.releaseCount++;
            if (failRelease) throw new Error('mock release failure');
        },
        destroy() { state.destroyCount++; }
    };
    return {
        state,
        pool: {
            async getConnection() {
                state.getConnectionCount++;
                return connection;
            }
        }
    };
}

function serviceHarness(options = {}) {
    const mysql = createMysql(options.mysql);
    const graphCalls = [];
    const graphSnapshot = options.graphSnapshot === undefined ? baseGraphSnapshot() : options.graphSnapshot;
    const graphReader = async (candidateGraphIds, { courseId }) => {
        graphCalls.push({ candidateGraphIds: [...candidateGraphIds], courseId });
        if (options.graphError) {
            throw options.graphError instanceof Error ? options.graphError : new Error('Neo4j unavailable');
        }
        return typeof graphSnapshot === 'function' ? graphSnapshot(candidateGraphIds) : structuredClone(graphSnapshot);
    };
    const courseGraphReader = options.courseGraphReader || (async ids => new Map(ids.map(id => [id, []])));
    const service = createRecommendationService({
        mysql: mysql.pool,
        graphReader,
        courseGraphReader,
        asOf: () => new Date(AS_OF)
    });
    return { service, mysql: mysql.state, graphCalls };
}

test('batches learner-scoped evidence across candidate and prerequisite concepts and integrates ranker output', async () => {
    const { service, mysql, graphCalls } = serviceHarness();
    const results = await service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID });

    assert.deepEqual(results.map(result => result.conceptId), [4, 3, 2]);
    assert.equal(results[0].mastery, null);
    assert.equal(results[0].evidenceStatus, 'UNKNOWN');
    assert.equal(results[1].mastery, 65);
    assert.equal(results[1].evidenceStatus, 'EVIDENCE_QUALIFIED');
    assert.deepEqual(results[1].prerequisiteReadiness.prerequisites.map(item => item.conceptId), [1, 2]);
    assert.equal(results.some(result => result.conceptId === 1), false, 'mastered concepts are excluded as candidates');

    const evidenceCalls = mysql.calls.filter(call => call.sql.startsWith('SELECT qr.concept_id AS conceptId'));
    assert.equal(evidenceCalls.length, 1, 'all evidence is retrieved in one query');
    assert.deepEqual(evidenceCalls[0].params, [7, 1, 2, 3, 4]);
    assert.match(evidenceCalls[0].sql, /WHERE a\.learner_id = \?/);
    assert.match(evidenceCalls[0].sql, /qr\.concept_id IN \(\?,\?,\?,\?\)/);
    assert.equal(mysql.evidenceParams.learnerId, 7);
    assert.deepEqual(mysql.evidenceParams.ids, [1, 2, 3, 4]);
    assert.equal(mysql.calls.some(call => /learning_path/.test(call.sql)), false, 'stale mastery cache is not queried');
    assert.deepEqual(graphCalls, [{ candidateGraphIds: ['CONCEPT-1', 'CONCEPT-2', 'CONCEPT-3', 'CONCEPT-4'], courseId: COURSE_ID }]);
    assert.equal(mysql.commitCount, 1);
    assert.equal(mysql.releaseCount, 1);
    assert.equal(mysql.destroyCount, 0);
    assert.ok(mysql.calls.findIndex(call => call.sql.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')) <
        mysql.calls.findIndex(call => call.sql.includes('learner_id = ?')),
    'the MySQL snapshot uses a fixed repeatable-read transaction before fetching evidence');
});

test('review gap data includes every validated course concept and its evidence-qualified prerequisite state', async () => {
    const { service } = serviceHarness();
    const result = await service.getRecommendationResultForLearner({ learnerId: 7, courseId: COURSE_ID });
    assert.deepEqual(result.concepts.map(item => item.conceptId), [1, 2, 3, 4]);
    const unknown = result.concepts.find(item => item.conceptId === 4);
    assert.equal(unknown.mastery, null);
    assert.equal(unknown.evidenceStatus, 'UNKNOWN');
    assert.equal(unknown.assessmentCount, 0);
    const dependent = result.concepts.find(item => item.conceptId === 3);
    assert.deepEqual(dependent.prerequisites.map(item => item.conceptId), [1, 2]);
    assert.ok(dependent.prerequisites.every(item => item.satisfied === true));
    assert.deepEqual(result.coursePrerequisiteEligibility, { eligible: true, prerequisites: [] });
});

test('cold-start results contain only prerequisite-ready concepts and preserve UNKNOWN mastery', async () => {
    const { service } = serviceHarness({ mysql: { evidence: [] } });
    const result = await service.getRecommendationResultForLearner({ learnerId: 7, courseId: COURSE_ID });

    assert.equal(result.recommendationMode, 'cold_start');
    assert.deepEqual(result.recommendations.map(item => item.conceptId), [1, 4]);
    assert.ok(result.recommendations.every(item => item.mastery === null && item.evidenceStatus === 'UNKNOWN'));
    assert.ok(result.recommendations.every(item => item.prerequisiteReadiness.totalCount === 0));
    assert.equal(result.recommendations.some(item => [2, 3].includes(item.conceptId)), false,
        'concepts with unmet prerequisites are excluded');
});

test('recommendations transition from cold-start to adaptive when course evidence appears', async () => {
    const evidence = [];
    const { service } = serviceHarness({ mysql: { evidence } });
    const input = { learnerId: 7, courseId: COURSE_ID };

    const coldStart = await service.getRecommendationResultForLearner(input);
    assert.equal(coldStart.recommendationMode, 'cold_start');
    evidence.push(...evidenceRows);

    const adaptive = await service.getRecommendationResultForLearner(input);
    assert.equal(adaptive.recommendationMode, 'adaptive');
    assert.deepEqual(adaptive.recommendations.map(item => item.conceptId), [4, 3, 2]);
    assert.ok(adaptive.recommendations.some(item => item.evidenceStatus === 'EVIDENCE_QUALIFIED'));
});

test('course-level prerequisites block recommendations until prerequisite course mastery is evidence-qualified', async t => {
    const prerequisiteGraphId = 'COURSE-22222222-2222-4222-8222-222222222222';
    const courseRows = [
        { courseId: 1, graphCourseId: COURSE_ID, title: 'Database Concepts' },
        { courseId: 2, graphCourseId: prerequisiteGraphId, title: 'Database Foundations' }
    ];
    const coursePrerequisites = [{ relationshipId: 91, prerequisiteCourseId: 2, targetCourseId: 1 }];
    const courseConcepts = [
        ...candidateRows.map(row => ({ courseGraphId: COURSE_ID, conceptId: row.conceptId })),
        { courseGraphId: prerequisiteGraphId, conceptId: 5 }
    ];
    const allConcepts = [...concepts, { conceptId: 5, conceptName: 'Foundational Concept', graphConceptId: 'CONCEPT-5' }];
    const courseReader = async ids => new Map([
        [COURSE_ID, [prerequisiteGraphId]],
        [prerequisiteGraphId, []]
    ].filter(([id]) => ids.includes(id)));
    const options = {
        mysql: { concepts: allConcepts, coursePrerequisites, relevantCourses: courseRows, courseConcepts },
        courseGraphReader: courseReader
    };
    await t.test('unknown prerequisite mastery returns no recommendations', async () => {
        const { service } = serviceHarness(options);
        const result = await service.getRecommendationResultForLearner({ learnerId: 7, courseId: COURSE_ID });
        assert.equal(result.recommendationMode, 'course_prerequisite_blocked');
        assert.deepEqual(result.recommendations, []);
        assert.ok(Array.isArray(result.concepts), 'verified concept evidence remains available to Review Gaps');
        assert.deepEqual(result.coursePrerequisiteEligibility.prerequisites, [
            { courseId: 2, title: 'Database Foundations', satisfied: false }
        ]);
    });
    await t.test('qualified mastery at 80 unlocks the target course recommendations', async () => {
        const evidence = [
            { conceptId: 5, assessmentId: 50, score: 80, assessmentDate: AS_OF, questionCount: 5, correctCount: 4, timestampProvenance: 'utc' },
            { conceptId: 5, assessmentId: 51, score: 80, assessmentDate: AS_OF, questionCount: 5, correctCount: 4, timestampProvenance: 'utc' }
        ];
        const { service } = serviceHarness({ ...options, mysql: { ...options.mysql, evidence } });
        const result = await service.getRecommendationResultForLearner({ learnerId: 7, courseId: COURSE_ID });
        assert.equal(result.recommendationMode, 'cold_start');
        assert.ok(result.recommendations.length > 0);
        assert.equal(result.coursePrerequisiteEligibility.eligible, true);
    });
});

test('normalizes numeric strings and preserves NULL historical date, NULL counts, and provenance for the ranker', async () => {
    let rankerInput;
    const mysql = createMysql();
    const service = createRecommendationService({
        mysql: mysql.pool,
        graphReader: async () => baseGraphSnapshot(),
        courseGraphReader: async ids => new Map(ids.map(id => [id, []])),
        asOf: () => AS_OF,
        ranker(candidates, options) {
            rankerInput = { candidates, options };
            return [];
        }
    });
    await service.getRecommendationsForLearner({ learnerId: '7', courseId: COURSE_ID });

    const target = rankerInput.candidates.find(item => item.conceptId === 3);
    assert.equal(target.mastery, 65);
    assert.equal(target.evidenceStatus, 'EVIDENCE_QUALIFIED');
    assert.deepEqual(target.assessmentHistory, [
        { assessmentId: 31, assessmentDate: null, timestampProvenance: 'unknown' },
        { assessmentId: 32, assessmentDate: null, timestampProvenance: 'unknown' }
    ]);
    assert.deepEqual(target.prerequisites.map(item => ({
        conceptId: item.conceptId, mastery: item.mastery, evidenceStatus: item.evidenceStatus
    })), [
        { conceptId: 1, mastery: 90, evidenceStatus: 'EVIDENCE_QUALIFIED' },
        { conceptId: 2, mastery: 82, evidenceStatus: 'EVIDENCE_QUALIFIED' }
    ]);
    assert.equal(rankerInput.options.asOf.getTime(), AS_OF.getTime());
});

test('unknown mastery is supplied when a concept has no assessment rows', async () => {
    const mysql = createMysql({ evidence: evidenceRows.filter(row => Number(row.conceptId) !== 4) });
    let candidates;
    const service = createRecommendationService({
        mysql: mysql.pool,
        graphReader: async () => baseGraphSnapshot(),
        courseGraphReader: async ids => new Map(ids.map(id => [id, []])),
        asOf: () => AS_OF,
        ranker(input) { candidates = input; return []; }
    });
    await service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID });
    const noHistory = candidates.find(candidate => candidate.conceptId === 4);
    assert.equal(noHistory.mastery, null);
    assert.equal(noHistory.evidenceStatus, 'UNKNOWN');
    assert.deepEqual(noHistory.assessmentHistory, []);
});

test('fails closed for missing and ambiguous canonical graph mappings', async t => {
    await t.test('candidate has no graph ID', async () => {
        const rows = candidateRows.map(row => ({ ...row }));
        rows[3].graphConceptId = null;
        const { service } = serviceHarness({ mysql: { candidateRows: rows } });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
            error instanceof RecommendationServiceError && error.code === 'INVALID_RECOMMENDATION_DATA');
    });
    await t.test('prerequisite graph ID has no canonical row', async () => {
        const graphSnapshot = baseGraphSnapshot();
        graphSnapshot.closures[2].prerequisiteGraphIds = ['CONCEPT-1', 'CONCEPT-MISSING'];
        const { service } = serviceHarness({ graphSnapshot });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
            error.code === 'MISSING_CANONICAL_MAPPING');
    });
    await t.test('graph ID maps to multiple canonical concepts', async () => {
        const conceptRows = [...concepts, { conceptId: 99, conceptName: 'Ambiguous', graphConceptId: 'CONCEPT-1' }];
        const { service } = serviceHarness({ mysql: { concepts: conceptRows } });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
            error.code === 'MISSING_CANONICAL_MAPPING');
    });
});

test('fails closed when MySQL and Neo4j prerequisite closures differ', async t => {
    await t.test('Neo4j is missing a canonical prerequisite', async () => {
        const graphSnapshot = baseGraphSnapshot();
        graphSnapshot.closures[2].prerequisiteGraphIds = ['CONCEPT-2'];
        const { service } = serviceHarness({ graphSnapshot });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
            error.code === 'PREREQUISITE_CLOSURE_MISMATCH');
    });
    await t.test('Neo4j has an extra prerequisite', async () => {
        const graphSnapshot = baseGraphSnapshot();
        graphSnapshot.closures[1].prerequisiteGraphIds = ['CONCEPT-1', 'CONCEPT-4'];
        const { service } = serviceHarness({ graphSnapshot });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
            error.code === 'PREREQUISITE_CLOSURE_MISMATCH');
    });
});

test('fails closed for course association mismatch, missing graph nodes, and unsupported course', async t => {
    await t.test('graph course association differs', async () => {
        const graphSnapshot = baseGraphSnapshot();
        graphSnapshot.courseConceptIds.pop();
        const { service } = serviceHarness({ graphSnapshot });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
            error.code === 'COURSE_ASSOCIATION_MISMATCH');
    });
    await t.test('candidate node is missing', async () => {
        const graphSnapshot = baseGraphSnapshot();
        graphSnapshot.closures.pop();
        const { service } = serviceHarness({ graphSnapshot });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
            error.code === 'MISSING_CANDIDATE_NODE');
    });
    await t.test('course name is not the supported Database Concepts course', async () => {
        const graphSnapshot = baseGraphSnapshot();
        graphSnapshot.courseName = 'Unrelated Course';
        const { service } = serviceHarness({ graphSnapshot });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
            error.code === 'UNSUPPORTED_RECOMMENDATION_COURSE');
    });
});

test('fails closed for unresolved synchronization tasks', async () => {
    const { service } = serviceHarness({
        mysql: { unresolvedTasks: [{ recordType: 'PREREQUISITE', recordId: 101, syncStatus: 'processing' }] }
    });
    await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
        error.code === 'KNOWLEDGE_SYNC_PENDING');
});

test('fails closed for canonical cycles and graph self-ancestors', async t => {
    await t.test('canonical cycle', async () => {
        const edges = [
            { prerequisiteRowId: 101, prerequisiteId: 1, targetId: 2 },
            { prerequisiteRowId: 102, prerequisiteId: 2, targetId: 1 }
        ];
        const { service } = serviceHarness({ mysql: { edges } });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
            error.code === 'PREREQUISITE_CYCLE_OR_DUPLICATE');
    });
    await t.test('graph self-ancestor', async () => {
        const graphSnapshot = baseGraphSnapshot();
        graphSnapshot.closures[1].prerequisiteGraphIds = ['CONCEPT-1', 'CONCEPT-2'];
        const { service } = serviceHarness({ graphSnapshot });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
            error.code === 'PREREQUISITE_CYCLE_OR_DUPLICATE');
    });
});

test('MySQL and Neo4j failures fail closed and MySQL connections are cleaned up', async t => {
    await t.test('evidence query fails and transaction rolls back before release', async () => {
        const { service, mysql } = serviceHarness({ mysql: { failAt: 'FROM quiz_result AS qr' } });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
            error.code === 'RECOMMENDATION_DATA_UNAVAILABLE');
        assert.equal(mysql.rollbackCount, 1);
        assert.equal(mysql.releaseCount, 1);
        assert.equal(mysql.destroyCount, 0);
    });
    await t.test('rollback failure destroys and does not release the connection', async () => {
        const { service, mysql } = serviceHarness({
            mysql: { failAt: 'FROM quiz_result AS qr', failRollback: true }
        });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }));
        assert.equal(mysql.destroyCount, 1);
        assert.equal(mysql.releaseCount, 0);
    });
    await t.test('graph failure occurs after MySQL transaction commits and connection releases', async () => {
        const original = Object.assign(new Error('Neo4j unavailable'), { code: 'ServiceUnavailable' });
        const { service, mysql } = serviceHarness({ graphError: original });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
            error.code === 'PREREQUISITE_GRAPH_UNAVAILABLE' && error.cause === original);
        assert.equal(mysql.commitCount, 1);
        assert.equal(mysql.releaseCount, 1);
        assert.equal(mysql.destroyCount, 0);
    });
    await t.test('service rejects invalid learner and course IDs before acquiring a connection', async () => {
        const { service, mysql } = serviceHarness();
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 0, courseId: COURSE_ID }), error =>
            error.code === 'INVALID_LEARNER_ID');
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: 'COURSE-invalid' }), error =>
            error.code === 'INVALID_COURSE_ID');
        assert.equal(mysql.getConnectionCount, 0);
    });
    await t.test('unknown learner ID does not produce cold-start recommendations', async () => {
        const mysql = createMysql({ learnerExists: false });
        const service = createRecommendationService({
            mysql: mysql.pool,
            graphReader: async () => baseGraphSnapshot(),
            courseGraphReader: async ids => new Map(ids.map(id => [id, []])),
            asOf: () => AS_OF
        });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 701, courseId: COURSE_ID }), error =>
            error.code === 'LEARNER_NOT_FOUND' && error.status === 404);
        assert.equal(mysql.state.commitCount, 0);
        assert.equal(mysql.state.rollbackCount, 1);
        assert.equal(mysql.state.releaseCount, 1);
    });
    await t.test('release failure destroys the connection and fails the request', async () => {
        const mysql = createMysql({ failRelease: true });
        const service = createRecommendationService({
            mysql: mysql.pool,
            graphReader: async () => baseGraphSnapshot(),
            courseGraphReader: async ids => new Map(ids.map(id => [id, []])),
            asOf: () => AS_OF
        });
        await assert.rejects(service.getRecommendationsForLearner({ learnerId: 7, courseId: COURSE_ID }), error =>
            error.code === 'RECOMMENDATION_DATA_UNAVAILABLE');
        assert.equal(mysql.state.destroyCount, 1);
        assert.equal(mysql.state.releaseCount, 1);
    });
});
