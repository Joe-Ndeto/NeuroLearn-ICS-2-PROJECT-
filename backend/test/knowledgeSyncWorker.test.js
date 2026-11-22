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
    readWorkerConfig,
    verifyWorkerDependencies,
    formatWorkerError
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

test('verifies MySQL and Neo4j before reporting either connection healthy', async () => {
    const events = [];
    const logger = {
        info(message) { events.push(message); },
        error(message) { events.push(message); }
    };
    const connection = {
        async ping() { events.push('mysql ping succeeded'); },
        release() { events.push('mysql connection released'); }
    };
    await verifyWorkerDependencies({
        mysql: { async getConnection() { events.push('mysql connection acquired'); return connection; } },
        neo4j: { async verifyNeo4jConnection() { events.push('neo4j verification succeeded'); } },
        logger
    });

    assert.ok(events.indexOf('[knowledge-sync] MySQL connectivity verified') > events.indexOf('mysql ping succeeded'));
    assert.ok(events.indexOf('[knowledge-sync] Neo4j connectivity verified') > events.indexOf('neo4j verification succeeded'));
    assert.ok(events.indexOf('[knowledge-sync] MySQL connectivity verified') < events.indexOf('[knowledge-sync] verifying Neo4j connectivity'));
});

test('startup verification failure does not report the failed dependency as healthy', async t => {
    await t.test('MySQL ping failure prevents Neo4j verification and discards the connection', async () => {
        const events = [];
        const connection = {
            async ping() { throw Object.assign(new Error('MySQL unavailable'), { code: 'ECONNREFUSED' }); },
            release() { events.push('released'); },
            destroy() { events.push('destroyed'); }
        };
        await assert.rejects(verifyWorkerDependencies({
            mysql: { async getConnection() { return connection; } },
            neo4j: { async verifyNeo4jConnection() { events.push('neo4j checked'); } },
            logger: { info(message) { events.push(message); }, error() {} }
        }), /MySQL unavailable/);
        assert.ok(events.includes('destroyed'));
        assert.ok(!events.includes('released'));
        assert.ok(!events.includes('neo4j checked'));
        assert.ok(!events.includes('[knowledge-sync] MySQL connectivity verified'));
    });

    await t.test('Neo4j failure is propagated after confirmed MySQL connectivity', async () => {
        const events = [];
        await assert.rejects(verifyWorkerDependencies({
            mysql: { async getConnection() { return { async ping() {}, release() { events.push('released'); } }; } },
            neo4j: { async verifyNeo4jConnection() { throw Object.assign(new Error('Neo4j unavailable'), { code: 'ServiceUnavailable' }); } },
            logger: { info(message) { events.push(message); }, error() {} }
        }), /Neo4j unavailable/);
        assert.ok(events.includes('[knowledge-sync] MySQL connectivity verified'));
        assert.ok(!events.includes('[knowledge-sync] Neo4j connectivity verified'));
    });
});

test('worker logs ready, idle waiting, successful processing, retry, and shutdown without fake activity', async () => {
    const messages = [];
    const logger = {
        info(message) { messages.push(message); },
        warn(message) { messages.push(message); },
        error(message) { messages.push(message); }
    };
    let claims = 0;
    let taskNumber = 0;
    const worker = createKnowledgeSyncWorker({
        service: {
            async claimTasks() {
                claims++;
                if (claims === 1) return [];
                if (claims === 2) return [{ outbox_id: 5, canonical_record_type: 'CONCEPT', attempt_count: 1 }];
                if (claims === 3) return [{ outbox_id: 6, canonical_record_type: 'RESOURCE', attempt_count: 2 }];
                return [];
            },
            async processTask() {
                taskNumber++;
                return { outcome: taskNumber === 1 ? 'retry' : 'completed' };
            }
        },
        config: { batchSize: 1, concurrency: 1, pollIntervalMs: 2 },
        logger
    });

    worker.start();
    try {
        for (let attempt = 0; attempt < 100 && !messages.some(message => message.includes('task=6 type=RESOURCE outcome=completed')); attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 2));
        }
        assert.ok(messages.some(message => message.includes('worker initialized and ready')));
        assert.ok(messages.some(message => message.includes('waiting for pending synchronization tasks')));
        assert.ok(messages.some(message => message.includes('task=5 type=CONCEPT retry scheduled')));
        assert.ok(messages.some(message => message.includes('task=6 type=RESOURCE outcome=completed')));
        assert.equal(worker.getHealthSnapshot().lastSuccessfulSyncAt !== null, true);
    } finally {
        await worker.stop();
    }
    assert.ok(messages.some(message => message.includes('shutdown complete')));
});

test('worker diagnostics redact connection strings, credentials, and tokens', () => {
    const diagnostic = formatWorkerError(Object.assign(
        new Error('connect bolt://worker-user:worker-pass@graph.internal:7687 password=secret Bearer token.value'),
        { code: 'ServiceUnavailable' }
    ));
    assert.match(diagnostic, /ServiceUnavailable/);
    assert.doesNotMatch(diagnostic, /worker-user|worker-pass|graph\.internal|secret|token\.value/);
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
