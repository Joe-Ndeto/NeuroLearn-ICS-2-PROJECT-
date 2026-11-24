
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');
const express = require('express');

test('GET /api/recommendations/me is authenticated, student-only, and returns recommendations with concept progression', async t => {
    const routePath = require.resolve('../src/routes/recommendations');
    const originalLoad = Module._load;
    const originalConsoleError = console.error;

    const courseId =
        'COURSE-11111111-1111-4111-8111-111111111111';

    const state = {
        serviceError: null,
        mode: 'adaptive',

        result: [
            {
                conceptId: 3,
                conceptName: 'Normalization',
                priorityScore: 74.25
            }
        ],

        concepts: [
            {
                conceptId: 3,
                conceptName: 'Normalization',
                mastery: 74.25,
                evidenceStatus: 'EVIDENCE_QUALIFIED',
                assessmentCount: 2,
                prerequisites: []
            }
        ],

        coursePrerequisiteEligibility: {
            eligible: true,
            prerequisites: []
        },

        progressionOverrides: {},

        calls: [],
        progressionCalls: [],
        logs: []
    };

    function buildProgression() {
        return {
            learnerId: 17,
            courseId,
            progressionThreshold: 80,

            concepts: state.concepts.map(concept => {
                const override =
                    state.progressionOverrides[concept.conceptId] || {};

                const accessible = override.accessible !== undefined
                    ? override.accessible
                    : true;

                return {
                    conceptId: concept.conceptId,
                    conceptName: concept.conceptName,
                    mastery: concept.mastery,
                    evidenceStatus: concept.evidenceStatus,
                    assessmentCount: concept.assessmentCount,
                    prerequisites: concept.prerequisites,

                    accessible,
                    status: accessible ? 'UNLOCKED' : 'LOCKED',

                    reason: accessible
                        ? null
                        : (override.reason || 'REVISION_REQUIRED'),

                    message: accessible
                        ? 'This concept is available for learning.'
                        : (
                            override.message ||
                            'Revise the prerequisite before continuing.'
                        ),

                    revisionTarget: accessible
                        ? null
                        : (
                            override.revisionTarget !== undefined
                                ? override.revisionTarget
                                : {
                                    conceptId: 2,
                                    conceptName: 'Database Fundamentals'
                                }
                        )
                };
            }),

            coursePrerequisiteEligibility:
                state.coursePrerequisiteEligibility
        };
    }

    console.error = (...values) => {
        state.logs.push(values.join(' '));
    };

    class MockRecommendationServiceError extends Error {
        constructor(code, status) {
            super(
                'internal service details must not appear in the HTTP response'
            );

            this.name = 'RecommendationServiceError';
            this.code = code;
            this.status = status;
        }
    }

    class MockConceptAccessError extends Error {
        constructor(code, message, status = 503) {
            super(message);

            this.name = 'ConceptAccessError';
            this.code = code;
            this.status = status;
        }
    }

    Module._load = function (request, parent, isMain) {
        if (
            parent?.filename === routePath &&
            request === '../middleware/authenticateToken'
        ) {
            return (req, res, next) => {
                const authorization = req.headers.authorization;

                if (!authorization) {
                    return res.status(401).json({
                        success: false,
                        message: 'Authentication token is required.'
                    });
                }

                if (authorization === 'Bearer admin') {
                    req.user = {
                        learner_id: 4,
                        role: 'admin'
                    };
                } else if (authorization === 'Bearer student') {
                    req.user = {
                        learner_id: 17,
                        role: 'student'
                    };
                } else {
                    return res.status(401).json({
                        success: false,
                        message: 'Invalid or expired authentication token.'
                    });
                }

                return next();
            };
        }

        if (
            parent?.filename === routePath &&
            request === '../services/recommendationService'
        ) {
            return {
                RecommendationServiceError:
                    MockRecommendationServiceError,

                createRecommendationService() {
                    return {
                        async getRecommendationResultForLearner(input) {
                            state.calls.push(input);

                            if (state.serviceError) {
                                throw state.serviceError;
                            }

                            return {
                                recommendationMode: state.mode,
                                recommendations: state.result,
                                concepts: state.concepts,
                                coursePrerequisiteEligibility:
                                    state.coursePrerequisiteEligibility
                            };
                        }
                    };
                }
            };
        }

        if (
            parent?.filename === routePath &&
            request === '../services/conceptAccessService'
        ) {
            return {
                ConceptAccessError: MockConceptAccessError,

                createConceptAccessService({
                    recommendationService
                }) {
                    assert.ok(
                        recommendationService,
                        'The existing recommendation service should be injected.'
                    );

                    return {
                        async getCourseConceptAccessForLearner(input) {
                            state.progressionCalls.push(input);

                            if (state.serviceError) {
                                throw state.serviceError;
                            }

                            assert.ok(
                                input.recommendationResult,
                                'The route should reuse the existing recommendation result.'
                            );

                            return buildProgression();
                        }
                    };
                }
            };
        }

        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[routePath];

    let server;

    try {
        const app = express();

        app.use(express.json());
        app.use(
            '/api/recommendations',
            require(routePath)
        );

        server = http.createServer(app);

        await new Promise(resolve =>
            server.listen(0, '127.0.0.1', resolve)
        );

        const base =
            `http://127.0.0.1:${server.address().port}/api/recommendations/me`;

        async function request({
            token,
            suffix = '',
            body,
            includeCourse = true
        } = {}) {
            const url = new URL(`${base}${suffix}`);

            // Supply the valid course ID by default.
            // Individual tests can disable this to test missing IDs.
            if (
                includeCourse &&
                !url.searchParams.has('courseId')
            ) {
                url.searchParams.set('courseId', courseId);
            }

            return new Promise((resolve, reject) => {
                const req = http.request(url, {
                    method: 'GET',

                    headers: {
                        ...(token
                            ? { Authorization: token }
                            : {}),

                        ...(body
                            ? {
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(
                                    JSON.stringify(body)
                                )
                            }
                            : {})
                    }
                }, res => {
                    let payload = '';

                    res.setEncoding('utf8');

                    res.on('data', chunk => {
                        payload += chunk;
                    });

                    res.on('end', () => {
                        resolve({
                            status: res.statusCode,
                            body: JSON.parse(payload)
                        });
                    });
                });

                req.on('error', reject);

                if (body) {
                    req.write(JSON.stringify(body));
                }

                req.end();
            });
        }

        await t.test(
            'unauthenticated requests receive 401',
            async () => {
                const response = await request();

                assert.equal(response.status, 401);
                assert.equal(response.body.success, false);
            }
        );

        await t.test(
            'non-student roles receive 403 without invoking services',
            async () => {
                const callsBefore = state.calls.length;
                const progressionCallsBefore =
                    state.progressionCalls.length;

                const response = await request({
                    token: 'Bearer admin'
                });

                assert.equal(response.status, 403);

                assert.equal(
                    response.body.code,
                    'STUDENT_ROLE_REQUIRED'
                );

                assert.equal(state.calls.length, callsBefore);

                assert.equal(
                    state.progressionCalls.length,
                    progressionCallsBefore
                );
            }
        );

        await t.test(
            'student receives recommendations and concept progression',
            async () => {
                const response = await request({
                    token: 'Bearer student'
                });

                assert.equal(response.status, 200);

                assert.deepEqual(response.body, {
                    success: true,

                    course: {
                        courseId
                    },

                    recommendationMode: state.mode,
                    recommendations: state.result,
                    concepts: state.concepts,

                    coursePrerequisiteEligibility:
                        state.coursePrerequisiteEligibility,

                    conceptProgression: {
                        progressionThreshold: 80,
                        concepts: buildProgression().concepts
                    }
                });

                assert.deepEqual(state.calls.at(-1), {
                    learnerId: 17,
                    courseId
                });

                assert.deepEqual(
                    state.progressionCalls.at(-1),
                    {
                        learnerId: 17,
                        courseId,

                        recommendationResult: {
                            recommendationMode: state.mode,
                            recommendations: state.result,
                            concepts: state.concepts,
                            coursePrerequisiteEligibility:
                                state.coursePrerequisiteEligibility
                        }
                    }
                );
            }
        );

        await t.test(
            'progression reuses the recommendation result instead of fetching it again',
            async () => {
                const recommendationCallsBefore =
                    state.calls.length;

                const response = await request({
                    token: 'Bearer student'
                });

                assert.equal(response.status, 200);

                assert.equal(
                    state.calls.length,
                    recommendationCallsBefore + 1
                );

                const latestProgressionCall =
                    state.progressionCalls.at(-1);

                assert.ok(
                    latestProgressionCall.recommendationResult
                );

                assert.equal(
                    latestProgressionCall.recommendationResult
                        .coursePrerequisiteEligibility.eligible,
                    true
                );
            }
        );

        await t.test(
            'invalid or missing course IDs receive 400',
            async () => {
                const callsBefore = state.calls.length;

                const missing = await request({
                    token: 'Bearer student',
                    includeCourse: false
                });

                assert.equal(missing.status, 400);

                assert.equal(
                    missing.body.code,
                    'INVALID_COURSE_ID'
                );

                const malformed = await request({
                    token: 'Bearer student',
                    suffix: '?courseId=not-a-course-id'
                });

                assert.equal(malformed.status, 400);

                assert.equal(
                    malformed.body.code,
                    'INVALID_COURSE_ID'
                );

                assert.equal(
                    state.calls.length,
                    callsBefore,
                    'Invalid course IDs must be rejected before service calls.'
                );
            }
        );

        await t.test(
            'empty recommendation lists remain successful',
            async () => {
                state.result = [];

                const response = await request({
                    token: 'Bearer student'
                });

                assert.equal(response.status, 200);
                assert.deepEqual(
                    response.body.recommendations,
                    []
                );
            }
        );

        await t.test(
            'cold-start mode is explicit and preserves the response contract',
            async () => {
                state.mode = 'cold_start';
                state.result = [];

                const response = await request({
                    token: 'Bearer student'
                });

                assert.equal(response.status, 200);

                assert.equal(
                    response.body.recommendationMode,
                    'cold_start'
                );

                assert.deepEqual(
                    response.body.recommendations,
                    []
                );

                state.mode = 'adaptive';
            }
        );

        await t.test(
            'locked concepts include a reason and revision target',
            async () => {
                state.concepts = [
                    {
                        conceptId: 3,
                        conceptName: 'Normalization',
                        mastery: 74,
                        evidenceStatus: 'EVIDENCE_QUALIFIED',
                        assessmentCount: 2,

                        prerequisites: [
                            {
                                conceptId: 2,
                                conceptName: 'Database Fundamentals',
                                mastery: 74,
                                evidenceStatus: 'EVIDENCE_QUALIFIED',
                                satisfied: false
                            }
                        ]
                    }
                ];

                state.progressionOverrides = {
                    3: {
                        accessible: false,
                        reason: 'REVISION_REQUIRED',

                        message:
                            'Revise Database Fundamentals and reach at least 80% mastery.',

                        revisionTarget: {
                            conceptId: 2,
                            conceptName: 'Database Fundamentals'
                        }
                    }
                };

                const response = await request({
                    token: 'Bearer student'
                });

                assert.equal(response.status, 200);

                const lockedConcept =
                    response.body.conceptProgression.concepts[0];

                assert.equal(
                    lockedConcept.status,
                    'LOCKED'
                );

                assert.equal(
                    lockedConcept.accessible,
                    false
                );

                assert.equal(
                    lockedConcept.reason,
                    'REVISION_REQUIRED'
                );

                assert.deepEqual(
                    lockedConcept.revisionTarget,
                    {
                        conceptId: 2,
                        conceptName: 'Database Fundamentals'
                    }
                );

                assert.equal(
                    lockedConcept.mastery,
                    74
                );

                state.progressionOverrides = {};
            }
        );

        await t.test(
            'course prerequisite blocks concepts with an actionable reason',
            async () => {
                state.coursePrerequisiteEligibility = {
                    eligible: false,

                    prerequisites: [
                        {
                            courseId: 2,
                            title: 'Programming Fundamentals',
                            satisfied: false
                        }
                    ]
                };

                state.concepts = [
                    {
                        conceptId: 3,
                        conceptName: 'Normalization',
                        mastery: null,
                        evidenceStatus: 'UNKNOWN',
                        assessmentCount: 0,
                        prerequisites: []
                    }
                ];

                state.progressionOverrides = {
                    3: {
                        accessible: false,
                        reason: 'COURSE_PREREQUISITE_REQUIRED',

                        message:
                            'Complete the required prerequisite course before accessing this concept.',

                        revisionTarget: null
                    }
                };

                const response = await request({
                    token: 'Bearer student'
                });

                assert.equal(response.status, 200);

                const progression =
                    response.body.conceptProgression;

                assert.equal(
                    progression.concepts[0].status,
                    'LOCKED'
                );

                assert.equal(
                    progression.concepts[0].reason,
                    'COURSE_PREREQUISITE_REQUIRED'
                );

                assert.equal(
                    progression.concepts[0].revisionTarget,
                    null
                );

                assert.equal(
                    response.body.coursePrerequisiteEligibility.eligible,
                    false
                );

                state.coursePrerequisiteEligibility = {
                    eligible: true,
                    prerequisites: []
                };

                state.progressionOverrides = {};
            }
        );

        await t.test(
            'query parameters and request body cannot override the principal learner ID',
            async () => {
                const response = await request({
                    token: 'Bearer student',

                    suffix:
                        `?courseId=${courseId}&learnerId=99`,

                    body: {
                        learnerId: 99
                    }
                });

                assert.equal(response.status, 200);

                assert.equal(
                    state.calls.at(-1).learnerId,
                    17
                );

                assert.equal(
                    state.progressionCalls.at(-1).learnerId,
                    17
                );
            }
        );

        await t.test(
            'unsupported course errors return a safe response',
            async () => {
                state.serviceError =
                    new MockRecommendationServiceError(
                        'UNSUPPORTED_RECOMMENDATION_COURSE',
                        422
                    );

                const response = await request({
                    token: 'Bearer student'
                });

                assert.equal(response.status, 422);

                assert.equal(
                    response.body.code,
                    'UNSUPPORTED_RECOMMENDATION_COURSE'
                );

                assert.equal(
                    JSON.stringify(response.body).includes(
                        'internal service details'
                    ),
                    false
                );

                state.serviceError = null;
            }
        );

        await t.test(
            'recommendation and graph failures do not expose internal details',
            async () => {
                state.serviceError =
                    new MockRecommendationServiceError(
                        'PREREQUISITE_GRAPH_UNAVAILABLE',
                        503
                    );

                state.serviceError.cause = Object.assign(
                    new Error(
                        'Neo4j connect bolt://neo-user:neo-pass@graph.internal:7687 password=hunter2 Bearer abc.def'
                    ),
                    {
                        code: 'ServiceUnavailable'
                    }
                );

                const response = await request({
                    token: 'Bearer student'
                });

                assert.equal(response.status, 503);

                assert.equal(
                    response.body.code,
                    'RECOMMENDATIONS_UNAVAILABLE'
                );

                assert.equal(
                    JSON.stringify(response.body).includes(
                        'internal service details'
                    ),
                    false
                );

                const diagnostic = state.logs.at(-1);

                assert.match(
                    diagnostic,
                    /RecommendationServiceError/
                );

                assert.match(
                    diagnostic,
                    /PREREQUISITE_GRAPH_UNAVAILABLE/
                );

                assert.doesNotMatch(
                    diagnostic,
                    /neo-user|neo-pass|hunter2|abc\.def|graph\.internal/
                );

                state.serviceError = null;
            }
        );

        await t.test(
            'course-not-found errors return a safe response',
            async () => {
                state.serviceError =
                    new MockRecommendationServiceError(
                        'COURSE_NOT_FOUND',
                        404
                    );

                const response = await request({
                    token: 'Bearer student'
                });

                assert.equal(response.status, 404);

                assert.equal(
                    response.body.code,
                    'COURSE_NOT_FOUND'
                );

                assert.equal(
                    JSON.stringify(response.body).includes(
                        'internal service details'
                    ),
                    false
                );

                state.serviceError = null;
            }
        );

    } finally {
        if (server) {
            await new Promise(resolve =>
                server.close(resolve)
            );
        }

        Module._load = originalLoad;
        delete require.cache[routePath];
        console.error = originalConsoleError;
    }
});
