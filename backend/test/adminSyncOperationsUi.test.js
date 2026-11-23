'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createKnowledgeSyncOperations,
    initializeKnowledgeSyncOperations,
    renderFailedTasks
} = require('../../frontend/admin-sync-operations');

class FakeElement {
    constructor() {
        this.textContent = '';
        this.className = '';
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.dataset = {};
        this.children = [];
        this.listeners = {};
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
}

function createDocument() {
    return {
        createElement() { return new FakeElement(); }
    };
}

function createElements() {
    return {
        refresh: new FakeElement(),
        refreshing: new FakeElement(),
        statsError: new FakeElement(),
        statValues: {
            pending: new FakeElement(), processing: new FakeElement(), completed: new FakeElement(),
            failed: new FakeElement(), expired: new FakeElement(), outstanding: new FakeElement(),
            oldest: new FakeElement(), lastSync: new FakeElement()
        },
        healthChecked: new FakeElement(),
        workerState: new FakeElement(),
        workerMessage: new FakeElement(),
        workerLastPoll: new FakeElement(),
        failedLoading: new FakeElement(),
        failedError: new FakeElement(),
        failedEmpty: new FakeElement(),
        failedList: new FakeElement(),
        failedPagination: new FakeElement(),
        failedPrevious: new FakeElement(),
        failedNext: new FakeElement(),
        retryMessage: new FakeElement()
    };
}

function failedSubmission(overrides = {}) {
    return {
        submissionId: 31,
        submissionType: 'RESOURCE',
        submissionData: { title: '<Intro to Graphs>' },
        status: 'approved',
        sync: { outboxId: 81, status: 'failed', attemptCount: 8 },
        ...overrides
    };
}

function stats(overrides = {}) {
    return {
        pending: 2,
        processing: 1,
        completed: 12,
        failed: 3,
        expiredProcessing: 1,
        totalOutstanding: 3,
        oldestPendingAt: '2026-06-01T10:00:00Z',
        ...overrides
    };
}

function createOps({ api, elements = createElements(), confirmFn = () => true } = {}) {
    return {
        elements,
        controller: createKnowledgeSyncOperations({ api, document: createDocument(), elements, confirmFn })
    };
}

test('sync operations are hidden from students and shown only after admin role confirmation', async () => {
    const section = new FakeElement();
    section.hidden = true;
    const document = { getElementById: id => id === 'admin-sync-operations' ? section : null };
    let calls = 0;
    assert.equal(initializeKnowledgeSyncOperations({
        document, api: { isAdministrator: () => false, async get() { calls += 1; } }
    }), null);
    assert.equal(section.hidden, true);
    assert.equal(calls, 0);
});

test('server-confirmed administrator sees sync operations and initializes stats', async () => {
    const section = new FakeElement();
    section.hidden = true;
    const elements = createElements();
    const elementIds = {
        'admin-sync-refresh': elements.refresh,
        'admin-sync-refreshing': elements.refreshing,
        'admin-sync-stats-error': elements.statsError,
        'sync-stat-pending': elements.statValues.pending,
        'sync-stat-processing': elements.statValues.processing,
        'sync-stat-completed': elements.statValues.completed,
        'sync-stat-failed': elements.statValues.failed,
        'sync-stat-expired': elements.statValues.expired,
        'sync-stat-outstanding': elements.statValues.outstanding,
        'sync-stat-oldest': elements.statValues.oldest,
        'sync-stat-last-sync': elements.statValues.lastSync,
        'admin-worker-last-checked': elements.healthChecked,
        'admin-worker-state': elements.workerState,
        'admin-worker-message': elements.workerMessage,
        'admin-worker-last-poll': elements.workerLastPoll,
        'admin-failed-loading': elements.failedLoading,
        'admin-failed-error': elements.failedError,
        'admin-failed-empty': elements.failedEmpty,
        'admin-failed-task-list': elements.failedList,
        'admin-failed-pagination': elements.failedPagination,
        'admin-failed-previous': elements.failedPrevious,
        'admin-failed-next': elements.failedNext,
        'admin-retry-message': elements.retryMessage
    };
    let statsCalled = false;
    const controller = initializeKnowledgeSyncOperations({
        document: { getElementById: id => id === 'admin-sync-operations' ? section : elementIds[id] || null },
        api: {
            isAdministrator: () => true,
            async get(path) {
                if (path === '/admin/submissions/outbox/stats') {
                    statsCalled = true;
                    return { success: true, stats: stats() };
                }
                return { success: true, submissions: [], pagination: { page: 1, totalPages: 0, total: 0 } };
            }
        }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(controller);
    assert.equal(section.hidden, false);
    assert.equal(statsCalled, true);
});

test('stats render all returned aggregates and tolerate missing or null fields', async t => {
    await t.test('complete statistics', async () => {
        const { controller, elements } = createOps({
            api: { async get(path) {
                if (path === '/admin/submissions/outbox/stats') return { success: true, stats: stats() };
                if (path.includes('syncStatus=failed')) return { success: true, submissions: [], pagination: { page: 1, totalPages: 0, total: 0 } };
                throw new Error('unexpected');
            } }
        });
        await controller.loadStatistics();
        assert.deepEqual(Object.fromEntries(Object.entries(elements.statValues).map(([key, element]) => [key, element.textContent])), {
            pending: '2', processing: '1', completed: '12', failed: '3', expired: '1', outstanding: '3',
            oldest: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date('2026-06-01T10:00:00Z')),
            lastSync: ''
        });
    });

    await t.test('missing and null fields', async () => {
        const { controller, elements } = createOps({
            api: { async get() { return { success: true, stats: { pending: 0, oldestPendingAt: null } }; } }
        });
        await controller.loadStatistics();
        assert.equal(elements.statValues.pending.textContent, '0');
        assert.equal(elements.statValues.processing.textContent, '—');
        assert.equal(elements.statValues.oldest.textContent, 'No pending tasks');
    });
});

test('worker health uses the authenticated API proxy and distinguishes healthy from unavailable', async t => {
    await t.test('healthy worker', async () => {
        const calls = [];
        const { controller, elements } = createOps({
            api: { async get(path, options) {
                calls.push({ path, options });
                return { success: true, health: {
                    state: 'running', started: true, processAlive: true,
                    lastSuccessfulPollAt: '2026-06-02T11:00:00Z',
                    lastSuccessfulSyncAt: '2026-06-02T11:01:00Z'
                } };
            } }
        });
        await controller.checkWorkerHealth();
        assert.deepEqual(calls, [{
            path: '/admin/submissions/worker-health', options: { cache: 'no-store' }
        }]);
        assert.doesNotMatch(calls[0].path, /5001/);
        assert.equal(elements.workerState.textContent, 'Healthy');
        assert.match(elements.workerMessage.textContent, /State: running\. Process: alive/);
        assert.notEqual(elements.workerLastPoll.textContent, 'No successful poll recorded');
        assert.equal(elements.statValues.lastSync.textContent, new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium', timeStyle: 'short'
        }).format(new Date('2026-06-02T11:01:00Z')));
        assert.notEqual(elements.healthChecked.textContent, 'Not checked');
    });

    await t.test('endpoint reports not started', async () => {
        const { controller, elements } = createOps({
            api: { async get() {
                const error = new Error('Service unavailable');
                error.status = 503;
                error.payload = { success: false, health: { state: 'not_started', started: false, processAlive: false } };
                throw error;
            } }
        });
        await controller.checkWorkerHealth();
        assert.equal(elements.workerState.textContent, 'Unavailable');
        assert.match(elements.workerMessage.textContent, /not started/i);
    });

    await t.test('unreachable endpoint', async () => {
        const { controller, elements } = createOps({
            api: { async get() { throw new Error('private endpoint details'); } }
        });
        await controller.checkWorkerHealth();
        assert.equal(elements.workerState.textContent, 'Unavailable');
        assert.match(elements.workerMessage.textContent, /unavailable or returned an invalid health response/i);
        assert.doesNotMatch(elements.workerMessage.textContent, /private endpoint details/i);
    });

    await t.test('timeout response is shown as unavailable', async () => {
        const { controller, elements } = createOps({ api: { async get() {
            const error = new Error('Gateway timeout');
            error.status = 504;
            error.payload = { code: 'worker_health_timeout', message: 'The worker health check timed out.' };
            throw error;
        } } });
        await controller.checkWorkerHealth();
        assert.equal(elements.workerState.textContent, 'Unavailable');
        assert.match(elements.workerMessage.textContent, /timed out/i);
    });
});

test('failed task rendering offers retry only for failed tasks with an actual outbox ID', () => {
    const container = new FakeElement();
    let retryArgs;
    const count = renderFailedTasks(container, [
        failedSubmission(),
        failedSubmission({ submissionId: 32, sync: { outboxId: null, status: 'failed', attemptCount: 1 } }),
        failedSubmission({ submissionId: 33, sync: { outboxId: 83, status: 'pending', attemptCount: 1 } })
    ], createDocument(), (...args) => { retryArgs = args; });
    assert.equal(count, 2);
    assert.equal(container.children.length, 2);
    assert.match(container.children[0].children[0].textContent, /<Intro to Graphs>/);
    assert.equal(container.children[0].children[2].textContent, 'Review status: approved');
    assert.equal(container.children[0].children.at(-1).textContent, 'Retry synchronization');
    assert.match(container.children[1].children.at(-1).textContent, /identifier was not provided/i);
    container.children[0].children.at(-1).listeners.click();
    assert.deepEqual(retryArgs, ['81', container.children[0].children.at(-1)]);
});

test('manual refresh loads statistics, failed tasks, and separate worker health', async () => {
    const calls = [];
    const { controller, elements } = createOps({
        api: { async get(path, options) {
            calls.push({ path, options });
            if (path === '/admin/submissions/outbox/stats') return { success: true, stats: stats() };
            if (path.includes('syncStatus=failed')) return { success: true, submissions: [], pagination: { page: 1, totalPages: 0, total: 0 } };
            return { success: true, health: { state: 'running', started: true, processAlive: true, lastSuccessfulPollAt: null, lastSuccessfulSyncAt: null } };
        } }
    });
    await controller.refreshAll();
    assert.ok(calls.some(call => call.path === '/admin/submissions/outbox/stats'));
    assert.ok(calls.some(call => call.path === '/admin/submissions?syncStatus=failed&page=1&limit=20'));
    assert.ok(calls.some(call => call.path === '/admin/submissions/worker-health' && call.options.cache === 'no-store'));
    assert.ok(calls.every(call => !String(call.path).includes('5001')));
    assert.equal(elements.refreshing.hidden, true);
    assert.equal(elements.refresh.disabled, false);
});

test('retry confirmation, duplicate prevention, success refresh, and review status separation', async t => {
    await t.test('success', async () => {
        const elements = createElements();
        const requests = [];
        let finishRetry;
        let confirmMessage = '';
        let listCount = 0;
        const { controller } = createOps({
            elements,
            confirmFn(message) { confirmMessage = message; return true; },
            api: {
                get(path) {
                    requests.push(path);
                    if (path === '/admin/submissions/outbox/stats') return Promise.resolve({ success: true, stats: stats() });
                    if (path.includes('syncStatus=failed')) {
                        listCount += 1;
                        return Promise.resolve({
                            success: true,
                            submissions: listCount === 1 ? [failedSubmission()] : [],
                            pagination: { page: 1, totalPages: listCount === 1 ? 1 : 0, total: listCount === 1 ? 1 : 0 }
                        });
                    }
                    throw new Error('health disabled');
                },
                post(path) {
                    requests.push(path);
                    return new Promise(resolve => { finishRetry = resolve; });
                }
            }
        });
        await controller.loadFailedTasks(1);
        const card = elements.failedList.children[0];
        const retryButton = card.children.at(-1);
        const first = retryButton.listeners.click();
        const second = retryButton.listeners.click();
        assert.equal(retryButton.disabled, true);
        assert.match(confirmMessage, /does not change the submission's review decision/i);
        assert.equal(requests.filter(path => path.includes('/retry')).length, 1);
        finishRetry({ success: true, outboxId: 81, sync: { status: 'pending', attemptCount: 9 } });
        await Promise.all([first, second]);
        assert.ok(requests.includes('/admin/submissions/outbox/81/retry'));
        assert.ok(requests.filter(path => path === '/admin/submissions/outbox/stats').length >= 1);
        assert.ok(requests.some(path => path.includes('syncStatus=failed')));
        assert.equal(elements.retryMessage.textContent, 'Synchronization retry queued. The submission review decision is unchanged.');
        assert.equal(elements.failedEmpty.hidden, false);
    });

    await t.test('cancel does not call retry', async () => {
        const elements = createElements();
        let posts = 0;
        const { controller } = createOps({
            elements, confirmFn: () => false,
            api: { async post() { posts += 1; } }
        });
        const button = new FakeElement();
        await controller.retryTask('81', button);
        assert.equal(posts, 0);
        assert.equal(button.disabled, false);
    });

    await t.test('failure preserves failed row and reports safe server error', async () => {
        const elements = createElements();
        const { controller } = createOps({
            elements,
            api: { async post() { const error = new Error('Only failed synchronization tasks can be retried.'); error.status = 409; throw error; } }
        });
        const button = new FakeElement();
        await controller.retryTask('81', button);
        assert.match(elements.retryMessage.textContent, /Only failed synchronization tasks/);
        assert.equal(button.disabled, false);
    });
});

test('401, 403, and network failures do not expose internal details', async t => {
    for (const [status, expected] of [[401, /session expired/i], [403, /not allowed/i], [0, /could not be loaded/i]]) {
        await t.test(String(status), async () => {
            const { controller, elements } = createOps({
                api: { async get(path) {
                    if (path === '/admin/submissions/outbox/stats') {
                        const error = new Error('secret internal details');
                        error.status = status;
                        throw error;
                    }
                    return { success: true, submissions: [], pagination: { page: 1, totalPages: 0, total: 0 } };
                } }
            });
            await controller.loadStatistics();
            assert.match(elements.statsError.textContent, expected);
            assert.doesNotMatch(elements.statsError.textContent, /secret internal details/i);
        });
    }
});
