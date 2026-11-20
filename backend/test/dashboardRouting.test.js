'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { validateAndRoute } = require('../../frontend/role-routing');
const { createApiClient } = require('../../frontend/api');

function locationAt(page) {
    const location = {
        href: `http://frontend.test/${page}`,
        replacements: [],
        replace(url) {
            this.replacements.push(url);
            this.href = url;
        }
    };
    return location;
}

function readFrontend(file) {
    return fs.readFileSync(path.join(__dirname, '../../frontend', file), 'utf8');
}

test('student login routes to the student dashboard using the server-confirmed role', async () => {
    const location = locationAt('login_signup.html');
    let validations = 0;
    const result = await validateAndRoute({
        api: { async validateSession() { validations += 1; return { role: 'student' }; } },
        location
    });
    assert.equal(validations, 1);
    assert.equal(result.ok, false);
    assert.equal(result.redirected, true);
    assert.deepEqual(location.replacements, ['http://frontend.test/dashboard.html']);
});

test('administrator login routes to admin.html using /auth/me role data', async () => {
    const location = locationAt('login_signup.html');
    const result = await validateAndRoute({
        api: { async validateSession() { return { role: 'admin' }; } },
        location
    });
    assert.equal(result.redirected, true);
    assert.deepEqual(location.replacements, ['http://frontend.test/admin.html']);
});

test('unauthenticated dashboard access follows NeuroLearnApi 401 redirect to login', async () => {
    const location = locationAt('admin.html');
    const storage = { getItem() { return null; }, removeItem() {} };
    const api = createApiClient({
        runtime: { location, fetch() {} }, storage, fetchImpl: async () => { throw new Error('should not fetch'); },
        config: { apiBaseUrl: 'http://api.test/api' }, location
    });
    const result = await validateAndRoute({ api, location, expectedRole: 'admin' });
    assert.equal(result.reason, 'unauthenticated');
    assert.deepEqual(location.replacements, ['login_signup.html']);
});

test('student directly opening admin.html is routed to dashboard.html', async () => {
    const location = locationAt('admin.html');
    const result = await validateAndRoute({
        api: { async validateSession() { return { role: 'student' }; } },
        location,
        expectedRole: 'admin'
    });
    assert.equal(result.reason, 'role_mismatch');
    assert.deepEqual(location.replacements, ['http://frontend.test/dashboard.html']);
});

test('administrator opening dashboard.html is routed to admin.html', async () => {
    const location = locationAt('dashboard.html');
    const result = await validateAndRoute({
        api: { async validateSession() { return { role: 'admin' }; } },
        location,
        expectedRole: 'student'
    });
    assert.equal(result.reason, 'role_mismatch');
    assert.deepEqual(location.replacements, ['http://frontend.test/admin.html']);
});

test('correct dashboard access and repeated validation do not create redirect loops', async () => {
    const location = locationAt('dashboard.html');
    const api = { async validateSession() { return { role: 'student' }; } };
    const first = await validateAndRoute({ api, location, expectedRole: 'student' });
    const second = await validateAndRoute({ api, location, expectedRole: 'student' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(location.replacements, []);
});

test('temporary session validation failures do not clear session or redirect', async () => {
    const location = locationAt('dashboard.html');
    let cleared = false;
    let message = '';
    const error = new Error('internal server text');
    error.status = 503;
    const result = await validateAndRoute({
        api: {
            async validateSession() { throw error; },
            clearSession() { cleared = true; }
        },
        location,
        expectedRole: 'student',
        onUnavailable(value) { message = value; }
    });
    assert.equal(result.reason, 'verification_unavailable');
    assert.equal(cleared, false);
    assert.equal(location.replacements.length, 0);
    assert.match(message, /could not be verified/i);
    assert.doesNotMatch(message, /internal server text/);
});

test('student and admin pages load only their own feature modules and markup', () => {
    const studentHtml = readFrontend('dashboard.html');
    const adminHtml = readFrontend('admin.html');
    const adminCss = readFrontend('dashboard.css');
    const studentJs = readFrontend('dashboard.js');
    const adminJs = readFrontend('admin.js');
    const studentModule = readFrontend('knowledge-contributions.js');
    const adminReviewModule = readFrontend('admin-submissions.js');
    const adminSyncModule = readFrontend('admin-sync-operations.js');

    assert.match(studentHtml, /id="overall-progress"/);
    assert.match(studentHtml, /id="concept-submission-form"/);
    assert.match(studentHtml, /id="submission-history"/);
    assert.doesNotMatch(studentHtml, /id="admin-submission-review"|id="admin-sync-operations"/);
    assert.doesNotMatch(studentHtml, /src="knowledge-contributions\.js"|src="admin-submissions\.js"|src="admin-sync-operations\.js"/);
    assert.match(studentJs, /knowledge-contributions\.js/);
    assert.match(studentJs, /initializeKnowledgeContributions/);
    assert.doesNotMatch(studentJs, /initializeAdminSubmissionReview|initializeKnowledgeSyncOperations/);
    for (const [, id] of studentModule.matchAll(/getElementById\('([^']+)'\)/g)) {
        assert.ok(studentHtml.includes(`id="${id}"`), `student page must contain ${id}`);
    }

    assert.match(adminHtml, /id="admin-submission-review"/);
    assert.match(adminHtml, /id="admin-sync-operations"/);
    assert.match(adminHtml, /id="admin-review-courses"/);
    assert.match(adminHtml, /id="admin-review-queue-view"/);
    assert.match(adminHtml, />Back to queue<\/button>/i);
    assert.match(adminHtml, /id="admin-review-approve"/);
    assert.match(adminHtml, /id="admin-review-reject"/);
    assert.doesNotMatch(adminHtml, /id="overall-progress"|id="concept-submission-form"|id="submission-history"/);
    assert.doesNotMatch(adminHtml, /src="admin-submissions\.js"|src="admin-sync-operations\.js"|src="knowledge-contributions\.js"/);
    assert.match(adminJs, /admin-submissions\.js/);
    assert.match(adminJs, /admin-sync-operations\.js/);
    assert.match(adminJs, /initializeAdminSubmissionReview/);
    assert.match(adminJs, /initializeKnowledgeSyncOperations/);
    assert.doesNotMatch(adminJs, /initializeKnowledgeContributions/);
    assert.match(adminCss, /\.admin-review-queue\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    assert.match(adminCss, /\.admin-review-card\s*\{[^}]*min-width:\s*0/s);
    assert.match(adminCss, /overflow-wrap:\s*anywhere/);
    for (const moduleText of [adminReviewModule, adminSyncModule]) {
        for (const [, id] of moduleText.matchAll(/get\('([^']+)'\)/g)) {
            if (/^(admin-|sync-stat-)/.test(id)) {
                assert.ok(adminHtml.includes(`id="${id}"`), `admin page must contain ${id}`);
            }
        }
    }
    assert.match(studentJs, /async function initializeDashboard\(\)[\s\S]*?roleRouting\.validateAndRoute[\s\S]*?loadStudentContributionModule\(\)/);
    assert.match(adminJs, /async function initializeAdminDashboard\(\)[\s\S]*?roleRouting\.validateAndRoute[\s\S]*?loadAdminModules\(\)/);
});

test('statistics route is registered at the same prefix and subpath used by the client', () => {
    const backendRoot = path.join(__dirname, '../src');
    const appSource = fs.readFileSync(path.join(backendRoot, 'app.js'), 'utf8');
    const routeSource = fs.readFileSync(path.join(backendRoot, 'routes/adminSubmissions.js'), 'utf8');
    assert.match(appSource, /app\.use\('\/api\/admin\/submissions',\s*adminSubmissionsRoute\)/);
    assert.match(routeSource, /router\.get\('\/outbox\/stats'/);
});

test('login script validates /auth/me after login and role router is loaded first', () => {
    const loginHtml = readFrontend('login_signup.html');
    const loginJs = readFrontend('login_signup.js');
    assert.ok(loginHtml.indexOf('src="role-routing.js"') < loginHtml.indexOf('src="login_signup.js"'));
    assert.match(loginJs, /api\.setSession\(\{ learner, token \}\)/);
    assert.match(loginJs, /NeuroLearnRoleRouting\.validateAndRoute/);
});

test('statistics request resolves through the configured API base and 404 remains visible without fake values', async () => {
    const { createKnowledgeSyncOperations } = require('../../frontend/admin-sync-operations');
    const requested = [];
    const storage = { getItem(key) { return key === 'neurolearnToken' ? 'test-bearer' : null; } };
    const runtime = { location: { href: 'http://frontend.test/admin.html' } };
    const api = createApiClient({
        runtime,
        storage,
        location: runtime.location,
        config: { apiBaseUrl: 'http://localhost:5000/api' },
        fetchImpl: async (url, options) => {
            requested.push({ url, options });
            return {
                ok: false,
                status: 404,
                async text() { return '<html>Not Found</html>'; }
            };
        }
    });
    const fakeElement = () => ({
        textContent: '', hidden: false, disabled: false, dataset: {},
        addEventListener() {}, replaceChildren() {}
    });
    const statValues = Object.fromEntries([
        'pending', 'processing', 'completed', 'failed', 'expired', 'outstanding', 'oldest', 'lastSync'
    ].map(key => [key, fakeElement()]));
    const statsError = fakeElement();
    const controller = createKnowledgeSyncOperations({
        api,
        document: { createElement: fakeElement },
        elements: {
            refresh: fakeElement(), refreshing: fakeElement(), statsError, statValues,
            healthChecked: fakeElement(), workerState: fakeElement(), workerMessage: fakeElement(), workerLastPoll: fakeElement(),
            failedLoading: fakeElement(), failedError: fakeElement(), failedEmpty: fakeElement(), failedList: fakeElement(),
            failedPagination: fakeElement(), failedPrevious: fakeElement(), failedNext: fakeElement(), retryMessage: fakeElement()
        }
    });
    await controller.loadStatistics();
    assert.equal(requested[0].url, 'http://localhost:5000/api/admin/submissions/outbox/stats');
    assert.equal(requested[0].options.headers.get('Authorization'), 'Bearer test-bearer');
    assert.equal(statValues.pending.textContent, '—');
    assert.equal(statsError.hidden, false);
    assert.match(statsError.textContent, /404/);
});
