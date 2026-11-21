'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const graphServicePath = require.resolve('../src/services/knowledgeGraphService');
const originalLoad = Module._load;
let mockGetSession;

Module._load = function (request, parent, isMain) {
    if (request === '../config/neo4j' && parent.filename === graphServicePath) {
        return { getSession: (...args) => mockGetSession(...args) };
    }

    return originalLoad.call(this, request, parent, isMain);
};

const { validateCourseIds, provisionCourse, getPrerequisiteClosure } = require('../src/services/knowledgeGraphService');
Module._load = originalLoad;

const COURSE_A = 'COURSE-11111111-1111-4111-8111-111111111111';
const COURSE_B = 'COURSE-22222222-2222-4222-8222-222222222222';

function createSession(records, runError) {
    const calls = { run: [], close: 0 };

    return {
        calls,
        session: {
            async run(query, parameters) {
                calls.run.push({ query, parameters });
                if (runError) throw runError;
                return { records };
            },
            async executeRead(work) {
                return work({ run: this.run.bind(this) });
            },
            async close() {
                calls.close += 1;
            }
        }
    };
}

function courseRecord(courseId) {
    return { get: key => key === 'courseId' ? courseId : undefined };
}

test('validates a selection containing multiple existing courses with a read-only parameterized query', async () => {
    const mock = createSession([courseRecord(COURSE_A), courseRecord(COURSE_B)]);
    mockGetSession = () => mock.session;

    assert.deepEqual(await validateCourseIds([COURSE_A, COURSE_B]), [COURSE_A, COURSE_B]);
    assert.equal(mock.calls.close, 1);
    assert.equal(mock.calls.run.length, 1);
    assert.deepEqual(mock.calls.run[0].parameters, { courseIds: [COURSE_A, COURSE_B] });
    assert.match(mock.calls.run[0].query, /MATCH \(c:Course\)/);
    assert.match(mock.calls.run[0].query, /RETURN c\.course_id AS courseId/);
    assert.doesNotMatch(mock.calls.run[0].query, /\b(CREATE|MERGE|SET|DELETE)\b/i);
});

test('rejects an empty selection without opening a session', async () => {
    mockGetSession = () => assert.fail('session should not be opened');
    await assert.rejects(validateCourseIds([]), error => error.code === 'INVALID_COURSE_IDS');
});

test('rejects non-array input without opening a session', async () => {
    mockGetSession = () => assert.fail('session should not be opened');
    await assert.rejects(validateCourseIds(COURSE_A), error => error.code === 'INVALID_COURSE_IDS');
});

test('rejects duplicate IDs without opening a session', async () => {
    mockGetSession = () => assert.fail('session should not be opened');
    await assert.rejects(
        validateCourseIds([COURSE_A, COURSE_A]),
        error => error.code === 'INVALID_COURSE_IDS'
    );
});

test('rejects blank and malformed IDs without opening a session', async () => {
    mockGetSession = () => assert.fail('session should not be opened');

    for (const invalidIds of [['   '], ['course-unknown'], ['COURSE-' + 'a'.repeat(101)]]) {
        await assert.rejects(
            validateCourseIds(invalidIds),
            error => error.code === 'INVALID_COURSE_IDS'
        );
    }
});

test('rejects uppercase UUID characters before opening a session', async () => {
    mockGetSession = () => assert.fail('session should not be opened');
    const uppercaseCourseId = 'COURSE-AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

    await assert.rejects(
        validateCourseIds([uppercaseCourseId]),
        error => error.code === 'INVALID_COURSE_IDS'
    );
});

test('rejects the whole selection when one or more courses are missing and closes the session', async () => {
    const mock = createSession([courseRecord(COURSE_A)]);
    mockGetSession = () => mock.session;

    await assert.rejects(
        validateCourseIds([COURSE_A, COURSE_B]),
        error => error.code === 'COURSES_NOT_FOUND'
    );
    assert.equal(mock.calls.close, 1);
});

test('fails closed on Neo4j query failure and closes the session', async () => {
    const mock = createSession([], new Error('Neo4j unavailable'));
    mockGetSession = () => mock.session;

    await assert.rejects(
        validateCourseIds([COURSE_A]),
        error => error.code === 'COURSE_VALIDATION_UNAVAILABLE'
    );
    assert.equal(mock.calls.close, 1);
});

test('fails closed when obtaining a Neo4j session throws without attempting a query', async () => {
    mockGetSession = () => {
        throw new Error('Neo4j unavailable');
    };

    await assert.rejects(
        validateCourseIds([COURSE_A]),
        error => error.code === 'COURSE_VALIDATION_UNAVAILABLE'
    );
});

test('classifies Neo4j session creation failures separately from invalid course IDs', async () => {
    mockGetSession = () => { throw new Error('driver unavailable'); };
    await assert.rejects(
        validateCourseIds([COURSE_A]),
        error => error.code === 'COURSE_VALIDATION_UNAVAILABLE'
    );
});

function provisionSession(courses = []) {
    const calls = [];
    let transactionQueue = Promise.resolve();
    const session = {
        async executeWrite(work) {
            const previous = transactionQueue;
            let release;
            transactionQueue = new Promise(resolve => { release = resolve; });
            await previous;
            try {
                return await work({
                    async run(query, parameters) {
                        calls.push({ query, parameters });
                        if (/MATCH \(c:Course\)/.test(query)) {
                            const matches = courses.filter(course => course.name.trim().toLowerCase() === parameters.normalizedName)
                                .sort((a, b) => a.course_id.localeCompare(b.course_id));
                            return { records: matches.slice(0, 1).map(course => ({ get: () => ({ properties: course }) })) };
                        }
                        const existing = courses.find(course => course.course_id === parameters.courseId);
                        let nodesCreated = 0;
                        let course = existing;
                        if (!course) {
                            course = {
                                course_id: parameters.courseId,
                                name: parameters.name,
                                description: parameters.description
                            };
                            courses.push(course);
                            nodesCreated = 1;
                        }
                        return {
                            records: [{ get: () => ({ properties: course }) }],
                            summary: { counters: { updates: () => ({ nodesCreated }) } }
                        };
                    }
                });
            } finally {
                release();
            }
        },
        async close() {}
    };
    return { session, calls, courses };
}

test('course provisioning reuses normalized existing course without changing its ID or data', async () => {
    const existing = { course_id: COURSE_A, name: '  DATABASE Concepts ', description: 'Preserve me' };
    const mock = provisionSession([existing]);
    mockGetSession = () => mock.session;

    const result = await provisionCourse({ name: 'Database Concepts', description: 'New description' });
    assert.equal(result.created, false);
    assert.equal(result.course, existing);
    assert.deepEqual(existing, { course_id: COURSE_A, name: '  DATABASE Concepts ', description: 'Preserve me' });
    assert.equal(mock.calls.length, 1);
    assert.match(mock.calls[0].query, /toLower\(trim\(c\.name\)\)/);
});

test('first-time course provisioning creates one safe course with a valid stable ID', async () => {
    const mock = provisionSession();
    mockGetSession = () => mock.session;

    const result = await provisionCourse({ name: ' Database Concepts ' });
    assert.equal(result.created, true);
    assert.equal(result.course.name, 'Database Concepts');
    assert.match(result.course.course_id, /^COURSE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(mock.courses.length, 1);
    assert.match(mock.calls[1].query, /MERGE \(c:Course \{course_id: \$courseId\}\)/);
});

test('concurrent provisioning requests converge on one course using the unique course ID constraint', async () => {
    const mock = provisionSession();
    mockGetSession = () => mock.session;

    const results = await Promise.all([
        provisionCourse({ name: 'Database Concepts' }),
        provisionCourse({ name: ' database concepts ' })
    ]);
    assert.equal(mock.courses.length, 1);
    assert.equal(new Set(results.map(result => result.course.course_id)).size, 1);
    assert.equal(results.filter(result => result.created).length, 1);
});

const graphValueRecord = values => ({ get: key => values[key] });

function prerequisiteReadSession({ missingCandidate = false, failQuery = null, courseIds = ['CONCEPT-1'],
    closures = [{ candidateGraphId: 'CONCEPT-1', prerequisiteGraphIds: ['CONCEPT-0'] }],
    prerequisiteNodes = null,
    edges = [{ prerequisiteGraphId: 'CONCEPT-0', targetGraphId: 'CONCEPT-1' }], failClose = false } = {}) {
    const calls = { run: [], close: 0, executeRead: 0 };
    const session = {
        async executeRead(work) {
            calls.executeRead++;
            return work({
                async run(query, parameters) {
                    calls.run.push({ query, parameters });
                    if (failQuery && query.includes(failQuery)) throw new Error('graph read failed');
                    if (/RETURN course\.name AS courseName/.test(query)) {
                        return { records: [graphValueRecord({ courseName: 'Database Concepts' })] };
                    }
                    if (/RETURN DISTINCT concept\.concept_id AS conceptId/.test(query)) {
                        return { records: courseIds.map(conceptId => graphValueRecord({ conceptId })) };
                    }
                    if (/AS prerequisiteNodes/.test(query)) {
                        const records = missingCandidate ? [] : closures.map((row, index) => graphValueRecord({
                            candidateGraphId: row.candidateGraphId,
                            prerequisiteNodes: prerequisiteNodes
                                ? prerequisiteNodes[index]
                                : row.prerequisiteGraphIds.map(conceptId => ({ conceptId }))
                        }));
                        return { records };
                    }
                    if (/RETURN prerequisite\.concept_id AS prerequisiteGraphId/.test(query)) {
                        return { records: edges.map(row => graphValueRecord(row)) };
                    }
                    throw new Error(`Unexpected graph query: ${query}`);
                }
            });
        },
        async close() {
            calls.close++;
            if (failClose) throw new Error('session close failed');
        }
    };
    return { session, calls };
}

test('reads the complete prerequisite closure with the established edge direction and course associations', async () => {
    const mock = prerequisiteReadSession({
        courseIds: ['CONCEPT-1'],
        closures: [{ candidateGraphId: 'CONCEPT-1', prerequisiteGraphIds: ['CONCEPT-0', 'CONCEPT-ROOT'] }],
        edges: [
            { prerequisiteGraphId: 'CONCEPT-ROOT', targetGraphId: 'CONCEPT-0' },
            { prerequisiteGraphId: 'CONCEPT-0', targetGraphId: 'CONCEPT-1' }
        ]
    });
    mockGetSession = () => mock.session;

    const result = await getPrerequisiteClosure(['CONCEPT-1'], { courseId: COURSE_A });

    assert.deepEqual(result, {
        courseId: COURSE_A,
        courseName: 'Database Concepts',
        courseConceptIds: ['CONCEPT-1'],
        closures: [{ candidateGraphId: 'CONCEPT-1', prerequisiteGraphIds: ['CONCEPT-0', 'CONCEPT-ROOT'] }],
        edges: [
            { prerequisiteGraphId: 'CONCEPT-ROOT', targetGraphId: 'CONCEPT-0' },
            { prerequisiteGraphId: 'CONCEPT-0', targetGraphId: 'CONCEPT-1' }
        ]
    });
    const closureQuery = mock.calls.run.find(call => /AS prerequisiteNodes/.test(call.query));
    assert.match(closureQuery.query, /\(prerequisite:Concept\)-\[:PREREQUISITE_OF\*1\.\.\]->\(candidate\)/);
    assert.match(closureQuery.query, /CASE WHEN prerequisite IS NULL THEN null[\s\S]*prerequisite\.concept_id/);
    assert.deepEqual(closureQuery.parameters, { candidateGraphIds: ['CONCEPT-1'] });
    assert.equal(mock.calls.executeRead, 1);
    assert.equal(mock.calls.close, 1);
});

test('confirmed graph candidate with no edges returns an explicit empty prerequisite closure', async () => {
    const mock = prerequisiteReadSession({
        closures: [{ candidateGraphId: 'CONCEPT-1', prerequisiteGraphIds: [] }],
        edges: []
    });
    mockGetSession = () => mock.session;

    const result = await getPrerequisiteClosure(['CONCEPT-1'], { courseId: COURSE_A });
    assert.deepEqual(result.closures, [{ candidateGraphId: 'CONCEPT-1', prerequisiteGraphIds: [] }]);
    assert.equal(mock.calls.close, 1);
});

test('rejects prerequisite nodes whose concept ID is null or missing', async t => {
    for (const [label, node] of [['null concept ID', { conceptId: null }], ['missing concept ID', {}]]) {
        await t.test(label, async () => {
            const mock = prerequisiteReadSession({
                closures: [{ candidateGraphId: 'CONCEPT-1', prerequisiteGraphIds: [] }],
                prerequisiteNodes: [[node]],
                edges: []
            });
            mockGetSession = () => mock.session;

            await assert.rejects(
                getPrerequisiteClosure(['CONCEPT-1'], { courseId: COURSE_A }),
                error => error.code === 'INVALID_PREREQUISITE_NODE'
            );
            assert.equal(mock.calls.close, 1);
        });
    }
});

test('fails closed when a requested candidate node is missing and closes the session', async () => {
    const mock = prerequisiteReadSession({ missingCandidate: true });
    mockGetSession = () => mock.session;

    await assert.rejects(
        getPrerequisiteClosure(['CONCEPT-1'], { courseId: COURSE_A }),
        error => error.code === 'MISSING_CANDIDATE_NODE'
    );
    assert.equal(mock.calls.close, 1);
});

test('fails closed on graph query errors and closes the session', async () => {
    const mock = prerequisiteReadSession({ failQuery: 'PREREQUISITE_OF' });
    mockGetSession = () => mock.session;

    await assert.rejects(
        getPrerequisiteClosure(['CONCEPT-1'], { courseId: COURSE_A }),
        error => error.code === 'GRAPH_UNAVAILABLE'
    );
    assert.equal(mock.calls.close, 1);
});

test('fails closed when closing a successful graph read fails', async () => {
    const mock = prerequisiteReadSession({ failClose: true });
    mockGetSession = () => mock.session;

    await assert.rejects(
        getPrerequisiteClosure(['CONCEPT-1'], { courseId: COURSE_A }),
        error => error.code === 'GRAPH_UNAVAILABLE'
    );
    assert.equal(mock.calls.close, 1);
});

test('rejects malformed candidate IDs before opening a graph session', async () => {
    mockGetSession = () => assert.fail('session should not be opened');
    await assert.rejects(
        getPrerequisiteClosure(['CONCEPT-1', '  '], { courseId: COURSE_A }),
        error => error.code === 'INVALID_CANDIDATE_IDS'
    );
});
