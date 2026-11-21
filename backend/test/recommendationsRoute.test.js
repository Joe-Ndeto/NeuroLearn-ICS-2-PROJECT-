'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');
const express = require('express');

test('GET /api/recommendations/me is authenticated, student-only, and returns safe ranked results', async t => {
    const routePath = require.resolve('../src/routes/recommendations');
    const originalLoad = Module._load;
    const state = {
        courseLookupError: null,
        courses: [{ course_id: 'COURSE-11111111-1111-4111-8111-111111111111', name: 'Database Concepts' }],
        serviceError: null,
        result: [{ conceptId: 3, conceptName: 'Normalization', priorityScore: 74.25 }],
        calls: []
    };

    class MockRecommendationServiceError extends Error {
        constructor(code, status) {
            super('internal service details must not appear in the HTTP response');
            this.code = code;
            this.status = status;
        }
    }

    Module._load = function (request, parent, isMain) {
        if (parent?.filename === routePath && request === '../middleware/authenticateToken') {
            return (req, res, next) => {
                const authorization = req.headers.authorization;
                if (!authorization) {
                    return res.status(401).json({ success: false, message: 'Authentication token is required.' });
                }
                if (authorization === 'Bearer admin') req.user = { learner_id: 4, role: 'admin' };
                else if (authorization === 'Bearer student') req.user = { learner_id: 17, role: 'student' };
                else return res.status(401).json({ success: false, message: 'Invalid or expired authentication token.' });
                return next();
            };
        }
        if (parent?.filename === routePath && request === '../services/knowledgeGraphService') {
            return { async getAllCourses() {
                if (state.courseLookupError) throw state.courseLookupError;
                return state.courses;
            } };
        }
        if (parent?.filename === routePath && request === '../services/recommendationService') {
            return {
                RecommendationServiceError: MockRecommendationServiceError,
                createRecommendationService() {
                    return {
                        async getRecommendationsForLearner(input) {
                            state.calls.push(input);
                            if (state.serviceError) throw state.serviceError;
                            return state.result;
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
        app.use('/api/recommendations', require(routePath));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}/api/recommendations/me`;

        async function request({ token, suffix = '', body } = {}) {
            const url = new URL(`${base}${suffix}`);
            return new Promise((resolve, reject) => {
                const req = http.request(url, {
                    method: 'GET',
                    headers: {
                        ...(token ? { Authorization: token } : {}),
                        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) } : {})
                    }
                }, res => {
                    let payload = '';
                    res.setEncoding('utf8');
                    res.on('data', chunk => { payload += chunk; });
                    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(payload) }));
                });
                req.on('error', reject);
                if (body) req.write(JSON.stringify(body));
                req.end();
            });
        }

        await t.test('unauthenticated requests receive 401', async () => {
            const response = await request();
            assert.equal(response.status, 401);
            assert.equal(response.body.success, false);
        });

        await t.test('non-student roles receive 403 without invoking the service', async () => {
            const callsBefore = state.calls.length;
            const response = await request({ token: 'Bearer admin' });
            assert.equal(response.status, 403);
            assert.equal(response.body.code, 'STUDENT_ROLE_REQUIRED');
            assert.equal(state.calls.length, callsBefore);
        });

        await t.test('student receives the ranked recommendations and stable response shape', async () => {
            const response = await request({ token: 'Bearer student' });
            assert.equal(response.status, 200);
            assert.deepEqual(response.body, {
                success: true,
                course: { courseId: state.courses[0].course_id, name: 'Database Concepts' },
                recommendations: state.result
            });
            assert.deepEqual(state.calls.at(-1), {
                learnerId: 17,
                courseId: state.courses[0].course_id
            });
        });

        await t.test('empty recommendation lists are successful responses', async () => {
            state.result = [];
            const response = await request({ token: 'Bearer student' });
            assert.equal(response.status, 200);
            assert.deepEqual(response.body.recommendations, []);
        });

        await t.test('query parameters and request body cannot override the principal learner ID', async () => {
            const response = await request({
                token: 'Bearer student',
                suffix: '?learnerId=99',
                body: { learnerId: 99 }
            });
            assert.equal(response.status, 200);
            assert.equal(state.calls.at(-1).learnerId, 17);
        });

        await t.test('unsupported course and graph failures return safe service errors', async () => {
            state.serviceError = new MockRecommendationServiceError('UNSUPPORTED_RECOMMENDATION_COURSE', 422);
            const unsupported = await request({ token: 'Bearer student' });
            assert.equal(unsupported.status, 422);
            assert.equal(unsupported.body.code, 'UNSUPPORTED_RECOMMENDATION_COURSE');
            assert.equal(JSON.stringify(unsupported.body).includes('internal service details'), false);

            state.serviceError = new MockRecommendationServiceError('PREREQUISITE_GRAPH_UNAVAILABLE', 503);
            const graphFailure = await request({ token: 'Bearer student' });
            assert.equal(graphFailure.status, 503);
            assert.equal(graphFailure.body.code, 'RECOMMENDATIONS_UNAVAILABLE');
            assert.equal(JSON.stringify(graphFailure.body).includes('internal service details'), false);
        });

        await t.test('course lookup failure does not expose internal details', async () => {
            state.serviceError = null;
            state.courseLookupError = new Error('database password=do-not-leak');
            const response = await request({ token: 'Bearer student' });
            assert.equal(response.status, 503);
            assert.equal(response.body.code, 'RECOMMENDATIONS_UNAVAILABLE');
            assert.equal(JSON.stringify(response.body).includes('do-not-leak'), false);
        });
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        Module._load = originalLoad;
        delete require.cache[routePath];
    }
});
