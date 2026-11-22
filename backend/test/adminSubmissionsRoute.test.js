'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const routePath = require.resolve('../src/routes/adminSubmissions');
const originalLoad = Module._load;
const authenticateMiddleware = (req, res, next) => req.user
    ? next()
    : res.status(401).json({ success: false, message: 'Authentication required.' });
const adminMiddleware = require('../src/middleware/requireAdmin');
const listResult = {
    total: 1,
    submissions: [{ submissionId: 12, status: 'approved', sync: {
        status: 'processing', attemptCount: 2, lastError: null, completedAt: null, updatedAt: 'now'
    } }]
};
const detailResult = listResult.submissions[0];
let listOptions;
let prerequisitePayload;
let reviewPayload;
let conceptAssignmentPayload;
let workerHealthResult = { status: 200, body: { success: true, health: { state: 'running', started: true, processAlive: true } } };
class MockCourseManagementError extends Error {
    constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

Module._load = function (request, parent, isMain) {
    if (parent.filename === routePath && request === '../middleware/authenticateToken') return authenticateMiddleware;
    if (parent.filename === routePath && request === '../middleware/requireAdmin') return adminMiddleware;
    if (parent.filename === routePath && request === '../services/workerHealthProxy') {
        return { async getWorkerHealth() { return workerHealthResult; } };
    }
    if (parent.filename === routePath && request === '../services/knowledgeSubmissionService') {
        return {
            async getAdminSubmissions(options) { listOptions = options; return listResult; },
            async getAdminSubmission() { return detailResult; },
            async getDatabaseConceptOptions() { return {
                concepts: [{ concept_id: 1, name: 'Normalization' }],
                domainAvailable: true,
                emptyReason: null,
                diagnostics: { totalConcepts: 1, domainAssociatedConcepts: 1, graphMappedConcepts: 1, missingGraphConceptId: 0 }
            }; },
            async getCourseConceptOptions(courseId) {
                return courseId === 'COURSE-1' ? [{ concept_id: 11, name: 'Joins' }] : [];
            },
            async createAdministratorPrerequisiteSubmission(payload) {
                prerequisitePayload = payload;
                return { submissionId: 44, submissionType: 'PREREQUISITE' };
            },
            async getOutboxStatistics() {
                return { pending: 2, processing: 1, completed: 8, failed: 1, expiredProcessing: 1, oldestPendingAt: 'oldest', totalOutstanding: 3 };
            },
            async retryFailedOutboxTask(outboxId) {
                if (outboxId === 10) return { outcome: 'not_found' };
                if (outboxId === 11) return { outcome: 'not_failed' };
                if (outboxId === 12) return { outcome: 'invalid_canonical_record' };
                if (outboxId === 13) return { outcome: 'commit_not_committed' };
                if (outboxId === 14) return { outcome: 'commit_uncertain' };
                return { outcome: 'retried', sync: { status: 'pending', attemptCount: 4, lastError: 'previous error', completedAt: null, updatedAt: 'updated-now' } };
            },
            async reviewPendingSubmission(payload) { reviewPayload = payload; return { outcome: 'reviewed', submission: { submissionId: 12 } }; }
        };
    }
    if (parent.filename === routePath && request === '../services/courseManagementService') {
        return {
            CourseManagementError: MockCourseManagementError,
            createCourseManagementService() {
                return {
                    async listApprovedCourses() { return []; },
                    async updateCourse() { return {}; },
                    async changePrerequisite() { return {}; },
                    async getConceptAssignmentOptions(courseId) {
                        if (courseId !== '7') throw new MockCourseManagementError('COURSE_NOT_FOUND', 'Approved course not found.', 404);
                        return { assigned: [{ conceptId: 1, name: 'Relational Algebra' }], available: [{ conceptId: 2, name: 'Transactions' }] };
                    },
                    async assignConceptToCourse(payload) {
                        conceptAssignmentPayload = payload;
                        return { courseId: 7, conceptId: Number(payload.conceptId), syncStatus: 'pending' };
                    }
                };
            }
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const router = require('../src/routes/adminSubmissions');
Module._load = originalLoad;

function findRoute(path, method) {
    const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
    assert.ok(layer, `expected ${method.toUpperCase()} ${path}`);
    return layer.route;
}

function responseStub() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

test('administrator list response includes separate sync object and preserves pagination', async () => {
    const route = findRoute('/', 'get');
    const response = responseStub();
    await route.stack.at(-1).handle({ query: {} }, response);
    assert.equal(response.body.submissions[0].sync.status, 'processing');
    assert.deepEqual(response.body.pagination, { page: 1, limit: 20, total: 1, totalPages: 1 });
    assert.equal(route.stack.length, 1);
});

test('administrator list accepts the actual failed synchronization status filter', async () => {
    const route = findRoute('/', 'get');
    const response = responseStub();
    await route.stack.at(-1).handle({ query: { syncStatus: 'failed' } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(listOptions.syncStatus, 'failed');
});

test('administrator list rejects unsupported synchronization status filters', async () => {
    const route = findRoute('/', 'get');
    const response = responseStub();
    await route.stack.at(-1).handle({ query: { syncStatus: 'retrying' } }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /syncStatus/);
});

test('administrator detail response includes separate sync object', async () => {
    const route = findRoute('/:id', 'get');
    const response = responseStub();
    await route.stack.at(-1).handle({ params: { id: '12' } }, response);
    assert.equal(response.body.submission.status, 'approved');
    assert.deepEqual(response.body.submission.sync, detailResult.sync);
});

test('concept approval forwards administrator difficulty to the canonical review service', async () => {
    const route = findRoute('/:id/approve', 'patch');
    const response = responseStub();
    await route.stack.at(-1).handle({
        params: { id: '12' },
        body: { reviewNotes: 'Approved', courseIds: ['COURSE-1'], difficultyLevel: 'Advanced' },
        user: { learner_id: 9 }
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(reviewPayload.difficultyLevel, 'Advanced');
    assert.deepEqual(reviewPayload.courseIds, ['COURSE-1']);
    assert.equal(reviewPayload.reviewerId, 9);
});

test('admin database concept options and prerequisite proposals are served through administrator routes', async () => {
    const optionsRoute = findRoute('/database-concepts', 'get');
    const optionsResponse = responseStub();
    await optionsRoute.stack.at(-1).handle({}, optionsResponse);
    assert.deepEqual(optionsResponse.body.concepts, [{ concept_id: 1, name: 'Normalization' }]);
    assert.equal(optionsResponse.body.domainAvailable, true);
    assert.equal(optionsResponse.body.diagnostics.graphMappedConcepts, 1);

    const proposalRoute = findRoute('/prerequisites', 'post');
    const deniedProposalResponse = responseStub();
    let deniedProposalHandlerCalled = false;
    adminMiddleware({ user: { role: 'student' } }, deniedProposalResponse, () => {
        deniedProposalHandlerCalled = true;
        proposalRoute.stack.at(-1).handle({ body: { prerequisiteId: '2', targetId: '3' }, user: { learner_id: 7 } }, responseStub());
    });
    assert.equal(deniedProposalResponse.statusCode, 403);
    assert.equal(deniedProposalHandlerCalled, false);

    const proposalResponse = responseStub();
    await proposalRoute.stack.at(-1).handle({
        body: { prerequisiteId: '2', targetId: '3' },
        user: { learner_id: 8 }
    }, proposalResponse);
    assert.equal(proposalResponse.statusCode, 201);
    assert.deepEqual(prerequisitePayload, { prerequisiteId: '2', targetId: '3', adminId: 8 });

    const invalidResponse = responseStub();
    await proposalRoute.stack.at(-1).handle({ body: { prerequisiteId: '2', targetId: 'bad-id' }, user: { learner_id: 8 } }, invalidResponse);
    assert.equal(invalidResponse.statusCode, 400);
});

test('administrator course-concept options are scoped to the canonical course', async () => {
    const route = findRoute('/courses/:courseId/concepts', 'get');
    const response = responseStub();
    await route.stack.at(-1).handle({ params: { courseId: 'COURSE-1' } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.concepts, [{ concept_id: 11, name: 'Joins' }]);
});

test('administrator concept management lists assignments and uses authenticated admin identity for assignment', async () => {
    const optionsRoute = findRoute('/courses/:courseId/concept-management', 'get');
    const optionsResponse = responseStub();
    await optionsRoute.stack.at(-1).handle({ params: { courseId: '7' } }, optionsResponse);
    assert.equal(optionsResponse.body.success, true);
    assert.deepEqual(optionsResponse.body.assigned, [{ conceptId: 1, name: 'Relational Algebra' }]);
    assert.deepEqual(optionsResponse.body.available, [{ conceptId: 2, name: 'Transactions' }]);

    const assignRoute = findRoute('/courses/:courseId/concepts', 'post');
    const assignResponse = responseStub();
    await assignRoute.stack.at(-1).handle({
        params: { courseId: '7' }, body: { conceptId: '2' }, user: { learner_id: 55, role: 'admin' }
    }, assignResponse);
    assert.equal(assignResponse.statusCode, 201);
    assert.deepEqual(conceptAssignmentPayload, { courseId: '7', conceptId: '2', adminId: 55 });
});


test('administrator authorization middleware remains mounted for the router', () => {
    assert.equal(router.stack[0].handle, authenticateMiddleware);
    assert.equal(router.stack[1].handle, adminMiddleware);
    const unauthorized = responseStub();
    let nextCalled = false;
    router.stack[0].handle({}, unauthorized, () => { nextCalled = true; });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(nextCalled, false);
    const studentDenied = responseStub();
    adminMiddleware({ user: { role: 'student' } }, studentDenied, () => assert.fail('student must not receive admin routes'));
    assert.equal(studentDenied.statusCode, 403);
});

test('worker health proxy is behind authentication and administrator authorization', async () => {
    const route = findRoute('/worker-health', 'get');
    const response = responseStub();
    let nextCalled = false;
    router.stack[0].handle({}, response, () => { nextCalled = true; });
    assert.equal(response.statusCode, 401);
    assert.equal(nextCalled, false);

    const forbidden = responseStub();
    adminMiddleware({ user: { role: 'student' } }, forbidden, () => assert.fail('student must be denied'));
    assert.equal(forbidden.statusCode, 403);

    const adminResponse = responseStub();
    const handler = route.stack.at(-1).handle;
    await handler({ user: { role: 'admin' } }, adminResponse);
    assert.equal(adminResponse.statusCode, 200);
    assert.equal(adminResponse.body.health.state, 'running');
});

test('outbox statistics endpoint returns aggregate status under administrator authorization', async () => {
    const route = findRoute('/outbox/stats', 'get');
    const response = responseStub();
    await route.stack.at(-1).handle({}, response);
    assert.deepEqual(response.body.stats, {
        pending: 2, processing: 1, completed: 8, failed: 1,
        expiredProcessing: 1, oldestPendingAt: 'oldest', totalOutstanding: 3
    });
    assert.equal(router.stack[1].handle, adminMiddleware);
});

test('failed outbox retry endpoint returns pending status and preserved attempt history', async () => {
    const route = findRoute('/outbox/:id/retry', 'post');
    const response = responseStub();
    await route.stack.at(-1).handle({ params: { id: '9' } }, response);
    assert.equal(response.body.outboxId, 9);
    assert.equal(response.body.sync.status, 'pending');
    assert.equal(response.body.sync.attemptCount, 4);
    assert.equal(response.body.sync.lastError, 'previous error');
    assert.equal(response.body.sync.updatedAt, 'updated-now');
});

test('retry endpoint maps missing, non-failed, and invalid canonical outcomes to safe responses', async () => {
    const route = findRoute('/outbox/:id/retry', 'post');
    for (const [id, expectedStatus] of [['10', 404], ['11', 409], ['12', 422], ['13', 503], ['14', 503]]) {
        const response = responseStub();
        await route.stack.at(-1).handle({ params: { id } }, response);
        assert.equal(response.statusCode, expectedStatus);
    }
});
