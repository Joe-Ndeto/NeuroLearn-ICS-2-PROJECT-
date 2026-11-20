'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
    createKnowledgeSyncWorker,
    createWorkerHealthServer,
    cleanupWorkerRuntime,
    getWorkerHealthSnapshot,
    listenWorkerHealthServer,
    readWorkerConfig
} = require('../src/workers/knowledgeSyncWorker');

const quietLogger = { info() {}, error() {} };

test('reads safe worker defaults and validates lease versus transaction timeout', () => {
    const defaults = readWorkerConfig({});
    assert.equal(defaults.batchSize, 5);
    assert.equal(defaults.concurrency, 3);
    assert.equal(defaults.leaseSeconds, 120);
    assert.throws(() => readWorkerConfig({ KNOWLEDGE_SYNC_LEASE_SECONDS: '20', KNOWLEDGE_SYNC_NEO4J_TIMEOUT_MS: '30000' }), /must exceed/);
    assert.throws(() => readWorkerConfig({ KNOWLEDGE_SYNC_BATCH_SIZE: '0' }), /whole number/);
    assert.throws(() => readWorkerConfig({ KNOWLEDGE_SYNC_HEALTH_PORT: '65536' }), /between 1 and 65535/);
    assert.throws(() => readWorkerConfig({ KNOWLEDGE_SYNC_HEALTH_PORT: '0' }), /whole number/);
    assert.throws(() => readWorkerConfig({ KNOWLEDGE_SYNC_HEALTH_HOST: '0.0.0.0' }), /requires KNOWLEDGE_SYNC_HEALTH_ALLOW_EXTERNAL/);
    assert.throws(() => readWorkerConfig({ KNOWLEDGE_SYNC_HEALTH_HOST: 'not-an-address' }), /must be localhost or an IP address/);
    assert.equal(readWorkerConfig({
        KNOWLEDGE_SYNC_HEALTH_HOST: '0.0.0.0',
        KNOWLEDGE_SYNC_HEALTH_ALLOW_EXTERNAL: 'true'
    }).healthHost, '0.0.0.0');
});

test('prevents a second polling loop and waits for active work during graceful shutdown', async () => {
    let resolveTask;
    let taskStarted;
    const started = new Promise(resolve => { taskStarted = resolve; });
    let returnedTask = false;
    const service = {
        async claimTasks() {
            if (returnedTask) return [];
            returnedTask = true;
            return [{ outbox_id: 1, canonical_record_type: 'CONCEPT' }];
        },
        processTask() {
            taskStarted();
            return new Promise(resolve => { resolveTask = resolve; });
        }
    };
    const config = { batchSize: 1, concurrency: 1, pollIntervalMs: 5 };
    const worker = createKnowledgeSyncWorker({ service, config, logger: quietLogger });
    const anotherWorker = createKnowledgeSyncWorker({ service, config, logger: quietLogger });
    assert.equal(worker.getHealthSnapshot().state, 'not_started');
    assert.equal(worker.getHealthSnapshot().started, false);
    worker.start();
    assert.equal(worker.getHealthSnapshot().state, 'running');
    await started;
    assert.ok(worker.getHealthSnapshot().lastSuccessfulPollAt);
    assert.throws(() => anotherWorker.start(), /already active/);

    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    assert.equal(worker.getHealthSnapshot().state, 'stopping');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    resolveTask({ outcome: 'completed' });
    await stopping;
    assert.equal(stopped, true);
    assert.equal(worker.inFlightCount, 0);
    assert.equal(worker.getHealthSnapshot().state, 'stopped');
    assert.equal(worker.getHealthSnapshot().processAlive, false);
    assert.ok(worker.getHealthSnapshot().lastSuccessfulSyncAt);
    anotherWorker.start();
    await anotherWorker.stop();
});

test('health port conflict rejects startup and runtime cleanup closes acquired resources', async () => {
    const occupied = createWorkerHealthServer({ getHealthSnapshot: () => ({ processAlive: true }) });
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const conflicted = createWorkerHealthServer({ getHealthSnapshot: () => ({ processAlive: false }) });
    let workerStopped = 0;
    let mysqlClosed = 0;
    let neo4jClosed = 0;
    const cleanupOrder = [];
    try {
        await assert.rejects(
            listenWorkerHealthServer(conflicted, occupied.address().port, '127.0.0.1'),
            error => error.code === 'EADDRINUSE'
        );
        assert.equal(conflicted.listening, false);
        const cleanupResults = await cleanupWorkerRuntime({
            worker: { async stop() { workerStopped += 1; cleanupOrder.push('worker'); } },
            healthServer: conflicted,
            mysql: { async end() { mysqlClosed += 1; cleanupOrder.push('mysql'); } },
            neo4j: { async closeNeo4jConnection() { neo4jClosed += 1; cleanupOrder.push('neo4j'); } }
        });
        assert.ok(cleanupResults.every(result => result.status === 'fulfilled'));
        assert.equal(workerStopped, 1);
        assert.equal(mysqlClosed, 1);
        assert.equal(neo4jClosed, 1);
        assert.equal(cleanupOrder[0], 'worker');
        assert.ok(cleanupOrder.indexOf('mysql') > cleanupOrder.indexOf('worker'));
    } finally {
        await new Promise(resolve => occupied.close(resolve));
        if (conflicted.listening) await new Promise(resolve => conflicted.close(resolve));
    }
});

test('idle worker health reports liveness and successful polls separately from synchronization', async () => {
    const worker = createKnowledgeSyncWorker({
        service: { async claimTasks() { return []; }, async processTask() {} },
        config: { batchSize: 1, concurrency: 1, pollIntervalMs: 1000 },
        logger: quietLogger
    });
    assert.deepEqual(getWorkerHealthSnapshot(), worker.getHealthSnapshot());
    assert.equal(worker.getHealthSnapshot().state, 'not_started');
    assert.equal(worker.getHealthSnapshot().lastSuccessfulPollAt, null);

    worker.start();
    for (let attempt = 0; attempt < 20 && !worker.getHealthSnapshot().lastSuccessfulPollAt; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
    const snapshot = worker.getHealthSnapshot();
    assert.equal(snapshot.state, 'running');
    assert.equal(snapshot.processAlive, true);
    assert.ok(snapshot.lastSuccessfulPollAt);
    assert.equal(snapshot.lastSuccessfulSyncAt, null);
    await worker.stop();
});

test('worker health endpoint returns a safe snapshot and does not call idle workers unhealthy', async () => {
    const worker = createKnowledgeSyncWorker({
        service: { async claimTasks() { return []; }, async processTask() {} },
        config: { batchSize: 1, concurrency: 1, pollIntervalMs: 1000 },
        logger: quietLogger
    });
    const server = createWorkerHealthServer(worker);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        worker.start();
        for (let attempt = 0; attempt < 20 && !worker.getHealthSnapshot().lastSuccessfulPollAt; attempt += 1) {
            await new Promise(resolve => setImmediate(resolve));
        }
        const response = await new Promise((resolve, reject) => {
            http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/health' }, result => {
                let body = '';
                result.setEncoding('utf8');
                result.on('data', chunk => { body += chunk; });
                result.on('end', () => resolve({ statusCode: result.statusCode, body: JSON.parse(body) }));
            }).on('error', reject);
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.health.state, 'running');
        assert.ok(response.body.health.lastSuccessfulPollAt);
        assert.equal(Object.hasOwn(response.body.health, 'claimToken'), false);
        await worker.stop();
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
