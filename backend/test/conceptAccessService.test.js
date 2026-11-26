
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ConceptAccessError,
    createConceptAccessService
} = require('../src/services/conceptAccessService');

const COURSE_ID = 'COURSE-11111111-1111-4111-8111-111111111111';

function createServiceResult(overrides = {}) {
    return {
        recommendationMode: 'adaptive',
        recommendations: [],
        concepts: [
            {
                conceptId: 1,
                conceptName: 'Introduction',
                sequence: 1,
                quizPassed: true,
                mastery: 90,
                evidenceStatus: 'EVIDENCE_QUALIFIED',
                assessmentCount: 2,
                prerequisites: []
            },
            {
                conceptId: 2,
                conceptName: 'Advanced Concepts',
                sequence: 2,
                quizPassed: false,
                mastery: null,
                evidenceStatus: 'UNKNOWN',
                assessmentCount: 0,
                prerequisites: [
                    {
                        conceptId: 1,
                        conceptName: 'Introduction',
                        mastery: 90,
                        evidenceStatus: 'EVIDENCE_QUALIFIED',
                        satisfied: true
                    }
                ]
            }
        ],
        coursePrerequisiteEligibility: {
            eligible: true,
            prerequisites: []
        },
        ...overrides
    };
}

function createAccessService(result = createServiceResult()) {
    const calls = [];

    const service = createConceptAccessService({
        recommendationService: {
            async getRecommendationResultForLearner(input) {
                calls.push(input);
                return structuredClone(result);
            }
        }
    });

    return { service, calls };
}

test('first concept without prerequisites is unlocked', async () => {
    const { service } = createAccessService();

    const result = await service.getConceptAccessForLearner({
        learnerId: 10,
        courseId: COURSE_ID,
        conceptId: 1
    });

    assert.equal(result.accessible, true);
    assert.equal(result.status, 'UNLOCKED');
    assert.equal(result.reason, null);
    assert.equal(result.revisionTarget, null);
});

test('second concept is locked until previous topic quiz is passed', async () => {
    const resultData = createServiceResult();

    resultData.concepts[0].quizPassed = false;

    const { service } = createAccessService(resultData);

    const result = await service.getConceptAccessForLearner({
        learnerId: 10,
        courseId: COURSE_ID,
        conceptId: 2
    });

    assert.equal(result.accessible, false);
    assert.equal(result.status, 'LOCKED');
    assert.equal(result.reason, 'PREVIOUS_TOPIC_NOT_PASSED');
    assert.deepEqual(result.revisionTarget, {
        conceptId: 1,
        conceptName: 'Introduction'
    });
});

test('second concept unlocks after previous topic quiz is passed', async () => {
    const resultData = createServiceResult();

    resultData.concepts[0].quizPassed = true;

    const { service } = createAccessService(resultData);

    const result = await service.getConceptAccessForLearner({
        learnerId: 10,
        courseId: COURSE_ID,
        conceptId: 2
    });

    assert.equal(result.accessible, true);
    assert.equal(result.status, 'UNLOCKED');
    assert.equal(result.reason, null);
});

test('a previous quiz pass remains valid after a later failed attempt', async () => {
    const resultData = createServiceResult();

    // Represents historical quiz evidence: at least one attempt passed.
    // A later failed attempt must not erase that pass.
    resultData.concepts[0].quizPassed = true;

    const { service } = createAccessService(resultData);

    const result = await service.getConceptAccessForLearner({
        learnerId: 10,
        courseId: COURSE_ID,
        conceptId: 2
    });

    assert.equal(result.accessible, true);
    assert.equal(result.status, 'UNLOCKED');
});

test('concept is locked when prerequisite mastery is below 80%', async () => {
    const resultData = createServiceResult();

    resultData.concepts[1].prerequisites[0].mastery = 65;

    const { service } = createAccessService(resultData);

    const result = await service.getConceptAccessForLearner({
        learnerId: 10,
        courseId: COURSE_ID,
        conceptId: 2
    });

    assert.equal(result.accessible, false);
    assert.equal(result.status, 'LOCKED');
    assert.equal(result.reason, 'REVISION_REQUIRED');
    assert.deepEqual(result.revisionTarget, {
        conceptId: 1,
        conceptName: 'Introduction'
    });
});

test('80% provisional mastery requires more assessment evidence', async () => {
    const resultData = createServiceResult();

    resultData.concepts[1].prerequisites[0].mastery = 82;
    resultData.concepts[1].prerequisites[0].evidenceStatus = 'PROVISIONAL';

    const { service } = createAccessService(resultData);

    const result = await service.getConceptAccessForLearner({
        learnerId: 10,
        courseId: COURSE_ID,
        conceptId: 2
    });

    assert.equal(result.accessible, false);
    assert.equal(result.reason, 'MORE_EVIDENCE_REQUIRED');
});

test('qualified prerequisite mastery of at least 80% unlocks the concept', async () => {
    const resultData = createServiceResult();

    resultData.concepts[1].prerequisites[0].mastery = 80;

    const { service } = createAccessService(resultData);

    const result = await service.getConceptAccessForLearner({
        learnerId: 10,
        courseId: COURSE_ID,
        conceptId: 2
    });

    assert.equal(result.accessible, true);
    assert.equal(result.status, 'UNLOCKED');
});

test('unknown prerequisite mastery requires an assessment', async () => {
    const resultData = createServiceResult();

    resultData.concepts[1].prerequisites[0].mastery = null;
    resultData.concepts[1].prerequisites[0].evidenceStatus = 'UNKNOWN';

    const { service } = createAccessService(resultData);

    const result = await service.getConceptAccessForLearner({
        learnerId: 10,
        courseId: COURSE_ID,
        conceptId: 2
    });

    assert.equal(result.accessible, false);
    assert.equal(result.reason, 'ASSESSMENT_REQUIRED');
});

test('course-level prerequisite blocks all concepts', async () => {
    const resultData = createServiceResult();

    resultData.coursePrerequisiteEligibility = {
        eligible: false,
        prerequisites: [
            {
                courseId: 5,
                title: 'Foundational Course',
                satisfied: false
            }
        ]
    };

    const { service } = createAccessService(resultData);

    const result = await service.getConceptAccessForLearner({
        learnerId: 10,
        courseId: COURSE_ID,
        conceptId: 1
    });

    assert.equal(result.accessible, false);
    assert.equal(result.reason, 'COURSE_PREREQUISITE_REQUIRED');
});

test('service passes learner and course identity to recommendation service', async () => {
    const { service, calls } = createAccessService();

    await service.getCourseConceptAccessForLearner({
        learnerId: '10',
        courseId: COURSE_ID
    });

    assert.deepEqual(calls, [{
        learnerId: 10,
        courseId: COURSE_ID
    }]);
});

test('invalid learner ID is rejected', async () => {
    const { service } = createAccessService();

    await assert.rejects(
        service.getCourseConceptAccessForLearner({
            learnerId: 0,
            courseId: COURSE_ID
        }),
        error => error instanceof ConceptAccessError &&
            error.code === 'INVALID_LEARNER_ID'
    );
});

test('concept outside the selected course is rejected', async () => {
    const { service } = createAccessService();

    await assert.rejects(
        service.getConceptAccessForLearner({
            learnerId: 10,
            courseId: COURSE_ID,
            conceptId: 999
        }),
        error => error instanceof ConceptAccessError &&
            error.code === 'CONCEPT_NOT_FOUND' &&
            error.status === 404
    );
});
