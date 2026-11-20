'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { DEFAULT_PORT, getWorkerHealth } = require('../src/services/workerHealthProxy');

const healthySnapshot = {
    state: 'running', started: true, processAlive: true,
    startedAt: '2026-06-02T10:00:00.000Z', stoppingAt: null, stoppedAt: null,
    lastSuccessfulPollAt: '2026-06-02T10:01:00.000Z',
    lastSuccessfulSyncAt: '2026-06-02T10:02:00.000Z',
    inFlightCount: 1, lastPollError: 'should-not-be-forwarded'
};

function requestMock({ statusCode = 200, body, timeout = false, requestError = null } = {}) {
    const calls = [];
    const requestImpl = (options, onResponse) => {
        calls.push(options);
        const request = new EventEmitter();
        request.destroy = error => queueMicrotask(() => request.emit('error', error));
        queueMicrotask(() => {
            if (timeout) return;
            if (requestError) return request.emit('error', requestError);
            const response = new EventEmitter();
            response.statusCode = statusCode;
            onResponse(response);
            queueMicrotask(() => {
                response.emit('data', Buffer.from(body));
                response.emit('end');
            });
        });
        return request;
    };
    const timerImpl = (callback, milliseconds) => {
        calls.timeoutMs = milliseconds;
        if (timeout) {
            queueMicrotask(callback);
            return null;
        }
        return setTimeout(callback, milliseconds);
    };
    return { requestImpl, timerImpl, clearTimer: handle => handle && clearTimeout(handle), calls };
}

test('worker proxy calls fixed loopback /health with default port and bounded timeout', async () => {
    const mock = requestMock({ body: JSON.stringify({ success: true, health: healthySnapshot }) });
    const result = await getWorkerHealth(mock);
    assert.equal(mock.calls[0].hostname, '127.0.0.1');
    assert.equal(mock.calls[0].port, DEFAULT_PORT);
    assert.equal(mock.calls[0].path, '/health');
    assert.ok(mock.calls.timeoutMs > 0 && mock.calls.timeoutMs <= 5000);
    assert.equal(result.status, 200);
    assert.equal(result.body.code, null);
    assert.equal(result.body.health.lastSuccessfulSyncAt, healthySnapshot.lastSuccessfulSyncAt);
    assert.equal(Object.hasOwn(result.body.health, 'lastPollError'), false);
});

test('worker proxy uses a configured health port and returns a sanitized healthy snapshot', async () => {
    const mock = requestMock({ body: JSON.stringify({ success: true, health: healthySnapshot }) });
    const result = await getWorkerHealth({ ...mock, port: 6002 });
    assert.equal(mock.calls[0].port, 6002);
    assert.equal(result.body.success, true);
    assert.equal(result.body.health.state, 'running');
});

test('stopped worker returns a consistent unavailable response with safe health details', async () => {
    const snapshot = { ...healthySnapshot, state: 'not_started', started: false, processAlive: false };
    const mock = requestMock({ statusCode: 503, body: JSON.stringify({ success: false, health: snapshot }) });
    const result = await getWorkerHealth(mock);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'worker_unavailable');
    assert.equal(result.body.health.state, 'not_started');
});

test('worker request timeout maps to gateway timeout', async () => {
    const mock = requestMock({ timeout: true });
    const result = await getWorkerHealth(mock);
    assert.equal(result.status, 504);
    assert.equal(result.body.code, 'worker_health_timeout');
});

test('invalid worker payload and worker HTTP errors are rejected safely', async t => {
    await t.test('invalid payload', async () => {
        const mock = requestMock({ body: '{broken' });
        const result = await getWorkerHealth(mock);
        assert.equal(result.status, 502);
        assert.equal(result.body.code, 'worker_health_invalid_response');
        assert.equal(result.body.health, null);
    });
    await t.test('unexpected worker status', async () => {
        const mock = requestMock({ statusCode: 500, body: 'private worker details' });
        const result = await getWorkerHealth(mock);
        assert.equal(result.status, 502);
        assert.equal(result.body.code, 'worker_health_http_error');
        assert.doesNotMatch(JSON.stringify(result.body), /private worker details/);
    });
});

test('unreachable worker returns an unavailable response without internal details', async () => {
    const mock = requestMock({ requestError: Object.assign(new Error('private socket details'), { code: 'ECONNREFUSED' }) });
    const result = await getWorkerHealth(mock);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'worker_unavailable');
    assert.doesNotMatch(JSON.stringify(result.body), /private socket details/);
});
