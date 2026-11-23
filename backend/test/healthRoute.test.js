'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');
const express = require('express');

async function startHealthServer(t, { mysql, getSession, timeoutMs = 100 } = {}) {
    const routePath = require.resolve('../src/routes/health');
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === routePath && request === '../config/mysql') return mysql;
        if (parent?.filename === routePath && request === '../config/neo4j') return { getSession };
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[routePath];
    let router;
    try {
        router = require(routePath).createHealthRouter({ mysql, getSession, timeoutMs });
    } finally {
        Module._load = originalLoad;
        delete require.cache[routePath];
    }
    const app = express();
    app.use('/health', router);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}/health`;
}

function healthySession() {
    return { async run() {}, async close() {} };
}

test('liveness is independent of dependencies and readiness reports healthy dependencies', async t => {
    let queryCount = 0;
    const mysql = { async query() { queryCount++; } };
    const base = await startHealthServer(t, { mysql, getSession: healthySession });
    const liveness = await fetch(`${base}/live`);
    assert.equal(liveness.status, 200);
    assert.deepEqual(await liveness.json(), { status: 'alive' });
    assert.equal(queryCount, 0);

    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'ready', mysql: 'connected', neo4j: 'connected' });
    assert.equal(queryCount, 1);

    const legacy = await fetch(`${base}/`);
    assert.equal(legacy.status, 200);
    assert.deepEqual(await legacy.json(), { status: 'healthy', mysql: 'connected', neo4j: 'connected' });
    assert.equal(queryCount, 2);
});

test('readiness returns 503 with safe dependency states when a dependency fails', async t => {
    const mysql = { async query() { const error = new Error('contains private connection detail'); error.code = 'ECONNREFUSED'; throw error; } };
    const base = await startHealthServer(t, { mysql, getSession: healthySession });
    const ready = await fetch(`${base}/`);
    assert.equal(ready.status, 503);
    const body = await ready.json();
    assert.deepEqual(body, { status: 'degraded', mysql: 'unavailable', neo4j: 'connected' });
    assert.doesNotMatch(JSON.stringify(body), /private connection detail/);
});

test('readiness bounds database checks and marks timeouts without exposing details', async t => {
    const mysql = { query() { return new Promise(() => {}); } };
    const base = await startHealthServer(t, { mysql, getSession: healthySession, timeoutMs: 30 });
    const ready = await fetch(`${base}/readiness`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: 'degraded', mysql: 'timeout', neo4j: 'connected' });
});

test('readiness applies a Neo4j timeout and still closes its session', async t => {
    let closed = false;
    const mysql = { async query() {} };
    const getSession = () => ({
        run() { return new Promise(() => {}); },
        async close() { closed = true; }
    });
    const base = await startHealthServer(t, { mysql, getSession, timeoutMs: 30 });
    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: 'degraded', mysql: 'connected', neo4j: 'timeout' });
    assert.equal(closed, true);
});
