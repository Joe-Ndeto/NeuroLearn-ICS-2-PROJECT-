'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const routePath = require.resolve('../src/routes/knowledgeGraph');
const originalLoad = Module._load;
const writeCalls = { concept: 0, resource: 0, prerequisite: 0, course: 0 };
const readCalls = { courses: 0, concepts: 0 };
const authenticationMiddleware = (req, res, next) => next();
const adminMiddleware = require('../src/middleware/requireAdmin');

Module._load = function (request, parent, isMain) {
    if (parent.filename === routePath && request === '../middleware/authenticateToken') {
        return authenticationMiddleware;
    }
    if (parent.filename === routePath && request === '../middleware/requireAdmin') {
        return adminMiddleware;
    }
    if (parent.filename === routePath && request === '../services/knowledgeGraphService') {
        return {
            getAllCourses() { readCalls.courses += 1; return [{ course_id: 'COURSE-test' }]; },
            getAllConcepts() { readCalls.concepts += 1; return [{ concept_id: 'CONCEPT-test' }]; },
            async provisionCourse(data) {
                writeCalls.course += 1;
                return { course: { course_id: 'COURSE-test', name: data.name.trim() }, created: true };
            },
            createConcept() { writeCalls.concept += 1; },
            addPrerequisite() { writeCalls.prerequisite += 1; },
            addLearningResource() { writeCalls.resource += 1; }
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const router = require('../src/routes/knowledgeGraph');
Module._load = originalLoad;

function findRoute(path, method) {
    const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
    assert.ok(layer, `expected route ${path}`);
    return layer.route;
}

function responseStub() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

async function invoke(path, req = {}, method = 'post') {
    const route = findRoute(path, method);
    const response = responseStub();
    const handler = route.stack[route.stack.length - 1].handle;
    await handler(req, response);
    return { route, response };
}

for (const [path, counter, code, endpoint] of [
    ['/concepts', 'concept', 'CONCEPT_SUBMISSION_REQUIRED', '/api/submissions/concepts'],
    ['/resources', 'resource', 'RESOURCE_SUBMISSION_REQUIRED', '/api/submissions/resources'],
    ['/prerequisites', 'prerequisite', 'PREREQUISITE_SUBMISSION_REQUIRED', '/api/submissions/prerequisites']
]) {
    test(`${path} direct-write endpoint returns 410, keeps admin authorization, and does not call its Neo4j writer`, async () => {
        const { route, response } = await invoke(path, { body: {} });
        assert.equal(route.stack[0].handle, adminMiddleware);
        assert.equal(response.statusCode, 410);
        assert.equal(response.body.code, code);
        assert.ok(response.body.message.includes(endpoint));
        assert.ok(response.body.message.includes('/api/admin/submissions/:id/approve'));
        assert.equal(writeCalls[counter], 0);
    });
}

test('existing read-only graph endpoints still return courses and concepts', async () => {
    const courses = await invoke('/courses', {}, 'get');
    const concepts = await invoke('/concepts', {}, 'get');

    assert.equal(courses.response.statusCode, 200);
    assert.deepEqual(courses.response.body.courses, [{ course_id: 'COURSE-test' }]);
    assert.equal(concepts.response.statusCode, 200);
    assert.deepEqual(concepts.response.body.concepts, [{ concept_id: 'CONCEPT-test' }]);
    assert.equal(readCalls.courses, 1);
    assert.equal(readCalls.concepts, 1);
});

test('course provisioning remains administrator-only and reports newly created course', async () => {
    const route = findRoute('/courses', 'post');
    assert.equal(route.stack[0].handle, adminMiddleware);
    const { response } = await invoke('/courses', { body: { name: ' Database Concepts ' } });
    assert.equal(response.statusCode, 201);
    assert.equal(response.body.created, true);
    assert.equal(response.body.course.name, 'Database Concepts');
    assert.equal(writeCalls.course, 1);
});

test('course provisioning rejects non-administrators before calling the writer', async () => {
    const route = findRoute('/courses', 'post');
    const response = responseStub();
    let nextCalled = false;
    route.stack[0].handle({ user: { role: 'student' } }, response, () => { nextCalled = true; });
    assert.equal(response.statusCode, 403);
    assert.equal(nextCalled, false);
    assert.equal(writeCalls.course, 1);
});
