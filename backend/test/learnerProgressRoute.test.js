'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');
const express = require('express');

test('GET /api/learners/me/progress uses authenticated student identity and returns safe progress', async t => {
    const routePath = require.resolve('../src/routes/learnerProgress');
    const originalLoad = Module._load;
    const state = {
        courses: [{ course_id: 'COURSE-11111111-1111-4111-8111-111111111111', name: 'Database Concepts' }],
        result: { progress: { percentage: 50, masteredConcepts: 1, totalConcepts: 2 }, mastery: { percentage: 85, status: 'PROVISIONAL', assessedConcepts: 1, totalConcepts: 2 } },
        error: null,
        calls: []
    };
    class MockProgressError extends Error {
        constructor(code) { super('database internals must not be returned'); this.code = code; this.status = 503; }
    }
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === routePath && request === '../middleware/authenticateToken') {
            return (req, res, next) => {
                const token = req.headers.authorization;
                if (!token) return res.status(401).json({ success: false, message: 'Authentication token is required.' });
                if (token === 'Bearer admin') req.user = { learner_id: 2, role: 'admin' };
                else if (token === 'Bearer student') req.user = { learner_id: 7, role: 'student' };
                else return res.status(401).json({ success: false, message: 'Invalid token.' });
                return next();
            };
        }
        if (parent?.filename === routePath && request === '../services/knowledgeGraphService') {
            return { async getAllCourses() { return state.courses; } };
        }
        if (parent?.filename === routePath && request === '../services/learnerProgressService') {
            return {
                LearnerProgressError: MockProgressError,
                createLearnerProgressService() {
                    return { async getProgressForLearner(input) {
                        state.calls.push(input);
                        if (state.error) throw state.error;
                        return state.result;
                    } };
                }
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[routePath];

    let server;
    try {
        const app = express();
        app.use('/api/learners', require(routePath));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const endpoint = `http://127.0.0.1:${server.address().port}/api/learners/me/progress?learnerId=99`;
        const request = token => fetch(endpoint, { headers: token ? { Authorization: token } : {} });

        await t.test('unauthenticated access receives 401', async () => {
            const response = await request();
            assert.equal(response.status, 401);
        });
        await t.test('non-student role receives 403 without service call', async () => {
            const before = state.calls.length;
            const response = await request('Bearer admin');
            assert.equal(response.status, 403);
            assert.equal(state.calls.length, before);
        });
        await t.test('student receives progress and cannot override learner identity', async () => {
            const response = await request('Bearer student');
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), {
                success: true,
                course: { courseId: state.courses[0].course_id, name: 'Database Concepts' },
                ...state.result
            });
            assert.deepEqual(state.calls.at(-1), { learnerId: 7, courseId: state.courses[0].course_id });
        });
        await t.test('service and course lookup failures are safe', async () => {
            state.error = new MockProgressError('DB_ERROR');
            const failed = await request('Bearer student');
            assert.equal(failed.status, 503);
            assert.equal(JSON.stringify(await failed.json()).includes('database internals'), false);
            state.error = null;
            state.courses = [];
            const noCourse = await request('Bearer student');
            assert.equal(noCourse.status, 404);
            assert.equal((await noCourse.json()).code, 'COURSE_NOT_FOUND');
        });
        await t.test('missing canonical course gives an actionable but sanitized response', async () => {
            state.courses = [{ course_id: 'COURSE-11111111-1111-4111-8111-111111111111', name: 'Database Concepts' }];
            state.error = new MockProgressError('COURSE_NOT_CANONICAL');
            const response = await request('Bearer student');
            const body = await response.json();
            assert.equal(response.status, 503);
            assert.equal(body.code, 'COURSE_NOT_CANONICAL');
            assert.match(body.message, /administrator to reconcile/);
            assert.equal(JSON.stringify(body).includes('database internals'), false);
            state.error = null;
        });
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        Module._load = originalLoad;
        delete require.cache[routePath];
    }
});
