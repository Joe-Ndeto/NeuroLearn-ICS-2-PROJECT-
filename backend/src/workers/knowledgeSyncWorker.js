'use strict';

const http = require('node:http');
const net = require('node:net');

let activeWorker = null;
let lastWorker = null;

function sanitizeWorkerDiagnostic(value) {
    return String(value ?? 'unknown')
        .replace(/(?:bolt(?:\+s)?|neo4j(?:\+s)?|mysql|https?):\/\/[^\s'"<>]+/gi, '[redacted connection string]')
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(/\b(?:MYSQL|NEO4J|JWT|GEMINI)_[A-Z0-9_]+\s*[:=]\s*[^\s,;]+/gi, '[redacted environment setting]')
        .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)\b\s*[:=]\s*(['"]?)[^\s,;'" ]+/gi, '$1=[redacted]')
        .replace(/for user\s+['"][^'"]+['"]/gi, 'for user [redacted]')
        .replace(/[\r\n\t]+/g, ' ')
        .slice(0, 500);
}

function formatWorkerError(error) {
    const name = sanitizeWorkerDiagnostic(error?.name || 'Error');
    const code = error?.code === undefined ? null : sanitizeWorkerDiagnostic(error.code);
    const message = sanitizeWorkerDiagnostic(error?.message || 'unknown failure');
    return `error=${name}${code ? ` code=${code}` : ''} message=${message}`;
}

function log(logger, level, message) {
    const method = typeof logger[level] === 'function' ? logger[level] : logger.info;
    if (typeof method === 'function') method.call(logger, message);
}

async function verifyWorkerDependencies({ mysql, neo4j, logger = console }) {
    if (!mysql || typeof mysql.getConnection !== 'function') {
        throw new TypeError('A MySQL pool is required for worker startup.');
    }
    if (!neo4j || typeof neo4j.verifyNeo4jConnection !== 'function') {
        throw new TypeError('Neo4j connectivity verification is required for worker startup.');
    }

    log(logger, 'info', '[knowledge-sync] verifying MySQL connectivity');
    const connection = await mysql.getConnection();
    let mysqlVerified = false;
    let verificationError = null;
    try {
        if (typeof connection.ping !== 'function') {
            throw new TypeError('The MySQL connection does not support ping.');
        }
        await connection.ping();
        mysqlVerified = true;
    } catch (error) {
        verificationError = error;
        throw error;
    } finally {
        try {
            if (mysqlVerified) connection.release();
            else if (typeof connection.destroy === 'function') connection.destroy();
            else connection.release();
        } catch (cleanupError) {
            if (!verificationError) throw cleanupError;
        }
    }
    log(logger, 'info', '[knowledge-sync] MySQL connectivity verified');

    log(logger, 'info', '[knowledge-sync] verifying Neo4j connectivity');
    await neo4j.verifyNeo4jConnection();
    log(logger, 'info', '[knowledge-sync] Neo4j connectivity verified');
}

function readPositiveInteger(env, name, defaultValue, minimum = 1) {
    const raw = env[name];
    if (raw === undefined || raw === '') return defaultValue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${name} must be a whole number greater than or equal to ${minimum}.`);
    }
    return value;
}

function readWorkerConfig(env = process.env) {
    const healthHost = env.KNOWLEDGE_SYNC_HEALTH_HOST || '127.0.0.1';
    const allowExternalHealthBind = env.KNOWLEDGE_SYNC_HEALTH_ALLOW_EXTERNAL === 'true';
    if (env.KNOWLEDGE_SYNC_HEALTH_ALLOW_EXTERNAL !== undefined &&
        !['true', 'false'].includes(env.KNOWLEDGE_SYNC_HEALTH_ALLOW_EXTERNAL)) {
        throw new Error('KNOWLEDGE_SYNC_HEALTH_ALLOW_EXTERNAL must be true or false.');
    }
    const isLoopbackHost = healthHost === 'localhost' || healthHost === '127.0.0.1' || healthHost === '::1';
    if (net.isIP(healthHost) === 0 && healthHost !== 'localhost') {
        throw new Error('KNOWLEDGE_SYNC_HEALTH_HOST must be localhost or an IP address.');
    }
    if (!isLoopbackHost && !allowExternalHealthBind) {
        throw new Error('A non-loopback health bind requires KNOWLEDGE_SYNC_HEALTH_ALLOW_EXTERNAL=true.');
    }
    const config = {
        pollIntervalMs: readPositiveInteger(env, 'KNOWLEDGE_SYNC_POLL_INTERVAL_MS', 2000),
        batchSize: readPositiveInteger(env, 'KNOWLEDGE_SYNC_BATCH_SIZE', 5),
        concurrency: readPositiveInteger(env, 'KNOWLEDGE_SYNC_CONCURRENCY', 3),
        leaseSeconds: readPositiveInteger(env, 'KNOWLEDGE_SYNC_LEASE_SECONDS', 120),
        maxAttempts: readPositiveInteger(env, 'KNOWLEDGE_SYNC_MAX_ATTEMPTS', 8),
        neo4jTransactionTimeoutMs: readPositiveInteger(env, 'KNOWLEDGE_SYNC_NEO4J_TIMEOUT_MS', 30000),
        retryBaseSeconds: readPositiveInteger(env, 'KNOWLEDGE_SYNC_RETRY_BASE_SECONDS', 5),
        retryMaxSeconds: readPositiveInteger(env, 'KNOWLEDGE_SYNC_RETRY_MAX_SECONDS', 3600),
        healthPort: readPositiveInteger(env, 'KNOWLEDGE_SYNC_HEALTH_PORT', 5001),
        healthHost,
        allowExternalHealthBind
    };
    if (config.leaseSeconds * 1000 <= config.neo4jTransactionTimeoutMs + 10000) {
        throw new Error('KNOWLEDGE_SYNC_LEASE_SECONDS must exceed the Neo4j timeout by at least 10 seconds.');
    }
    if (config.healthPort > 65535) {
        throw new Error('KNOWLEDGE_SYNC_HEALTH_PORT must be between 1 and 65535.');
    }
    if (config.retryMaxSeconds < config.retryBaseSeconds) {
        throw new Error('KNOWLEDGE_SYNC_RETRY_MAX_SECONDS must be at least the retry base.');
    }
    return config;
}

function createKnowledgeSyncWorker({ service, config, logger = console, timers = globalThis }) {
    if (!service || typeof service.claimTasks !== 'function' || typeof service.processTask !== 'function') {
        throw new TypeError('A knowledge sync service is required.');
    }
    let running = false;
    let loopPromise = null;
    let sleepTimer = null;
    let wakeSleep = null;
    let waitingForTasksLogged = false;
    const inFlight = new Set();
    const health = {
        state: 'not_started',
        startedAt: null,
        stoppingAt: null,
        stoppedAt: null,
        lastSuccessfulPollAt: null,
        lastSuccessfulSyncAt: null,
        lastPollError: null
    };

    function getHealthSnapshot() {
        return {
            ...health,
            started: health.startedAt !== null,
            processAlive: health.state === 'running' || health.state === 'stopping',
            inFlightCount: inFlight.size
        };
    }
    lastWorker = { getHealthSnapshot };

    async function process(task) {
        try {
            const result = await service.processTask(task);
            if (result && result.outcome === 'completed') {
                health.lastSuccessfulSyncAt = new Date().toISOString();
            }
            const taskLabel = `task=${task.outbox_id} type=${task.canonical_record_type}`;
            const outcome = result?.outcome || 'unknown';
            if (outcome === 'retry') {
                log(logger, 'warn', `[knowledge-sync] ${taskLabel} retry scheduled`);
            } else if (outcome === 'failed' || outcome === 'completion_update_error') {
                const detail = result?.error ? ` detail=${sanitizeWorkerDiagnostic(result.error)}` : '';
                log(logger, 'error', `[knowledge-sync] ${taskLabel} outcome=${outcome}${detail}`);
            } else if (outcome === 'stale') {
                log(logger, 'warn', `[knowledge-sync] ${taskLabel} outcome=stale`);
            } else {
                log(logger, 'info', `[knowledge-sync] ${taskLabel} outcome=${sanitizeWorkerDiagnostic(outcome)}`);
            }
        } catch (error) {
            log(logger, 'error', `[knowledge-sync] task=${task.outbox_id} type=${task.canonical_record_type} failed ${formatWorkerError(error)}`);
        }
    }

    async function sleep() {
        await new Promise(resolve => {
            wakeSleep = resolve;
            sleepTimer = timers.setTimeout(() => {
                sleepTimer = null;
                wakeSleep = null;
                resolve();
            }, config.pollIntervalMs);
        });
    }

    async function loop() {
        while (running) {
            const capacity = config.concurrency - inFlight.size;
            if (capacity > 0) {
                try {
                    const tasks = await service.claimTasks(Math.min(config.batchSize, capacity));
                    health.lastSuccessfulPollAt = new Date().toISOString();
                    health.lastPollError = null;
                    if (tasks.length === 0 && !waitingForTasksLogged) {
                        log(logger, 'info', '[knowledge-sync] waiting for pending synchronization tasks');
                        waitingForTasksLogged = true;
                    } else if (tasks.length > 0) {
                        waitingForTasksLogged = false;
                    }
                    for (const task of tasks) {
                        const taskPromise = process(task).finally(() => inFlight.delete(taskPromise));
                        inFlight.add(taskPromise);
                    }
                } catch (error) {
                    health.lastPollError = error.name || 'Error';
                    log(logger, 'error', `[knowledge-sync] task polling failed; retrying ${formatWorkerError(error)}`);
                }
            }
            if (running) await sleep();
        }
    }

    return {
        start() {
            if (activeWorker) throw new Error('A knowledge sync polling loop is already active in this process.');
            activeWorker = this;
            health.state = 'running';
            health.startedAt = new Date().toISOString();
            health.stoppingAt = null;
            health.stoppedAt = null;
            running = true;
            loopPromise = loop();
            log(logger, 'info', '[knowledge-sync] worker initialized and ready');
            return this;
        },
        async stop() {
            if (activeWorker !== this) return;
            health.state = 'stopping';
            health.stoppingAt = new Date().toISOString();
            running = false;
            if (sleepTimer !== null) {
                timers.clearTimeout(sleepTimer);
                sleepTimer = null;
                const resume = wakeSleep;
                wakeSleep = null;
                if (resume) resume();
            }
            if (loopPromise) await loopPromise;
            await Promise.allSettled([...inFlight]);
            health.state = 'stopped';
            health.stoppedAt = new Date().toISOString();
            activeWorker = null;
            loopPromise = null;
            log(logger, 'info', '[knowledge-sync] shutdown complete');
        },
        getHealthSnapshot,
        get inFlightCount() { return inFlight.size; }
    };
}

function getWorkerHealthSnapshot() {
    const worker = activeWorker || lastWorker;
    if (!worker) {
        return {
            state: 'not_started',
            started: false,
            processAlive: false,
            startedAt: null,
            stoppingAt: null,
            stoppedAt: null,
            lastSuccessfulPollAt: null,
            lastSuccessfulSyncAt: null,
            lastPollError: null,
            inFlightCount: 0
        };
    }
    return worker.getHealthSnapshot();
}

function createWorkerHealthServer(worker) {
    if (!worker || typeof worker.getHealthSnapshot !== 'function') {
        throw new TypeError('A worker health snapshot provider is required.');
    }
    return http.createServer((request, response) => {
        if (request.method !== 'GET' || request.url !== '/health') {
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ success: false, message: 'Not found.' }));
            return;
        }
        const snapshot = worker.getHealthSnapshot();
        response.writeHead(snapshot.processAlive ? 200 : 503, {
            'content-type': 'application/json',
            'cache-control': 'no-store'
        });
        response.end(JSON.stringify({ success: snapshot.processAlive, health: snapshot }));
    });
}

function listenWorkerHealthServer(server, port, host) {
    return new Promise((resolve, reject) => {
        const onError = error => {
            server.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

function closeWorkerHealthServer(server) {
    if (!server || !server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

async function cleanupWorkerRuntime({ worker, healthServer, mysql, neo4j }) {
    const outcomes = [];
    if (worker) outcomes.push(...await Promise.allSettled([Promise.resolve().then(() => worker.stop())]));
    outcomes.push(...await Promise.allSettled([closeWorkerHealthServer(healthServer)]));
    const operations = [];
    if (mysql && typeof mysql.end === 'function') {
        operations.push(Promise.resolve().then(() => mysql.end()));
    }
    if (neo4j && typeof neo4j.closeNeo4jConnection === 'function') {
        operations.push(Promise.resolve().then(() => neo4j.closeNeo4jConnection()));
    }
    outcomes.push(...await Promise.allSettled(operations));
    return outcomes;
}

async function main() {
    let mysql;
    let neo4j;
    let worker;
    let healthServer;
    try {
        console.info('[knowledge-sync] startup initiated');
        require('dotenv').config();
        const config = readWorkerConfig(process.env);
        mysql = require('../config/mysql');
        neo4j = require('../config/neo4j');
        const { createKnowledgeSyncService } = require('../services/knowledgeSyncService');
        const service = createKnowledgeSyncService({ mysql, getNeo4jSession: neo4j.getSession, config });
        await verifyWorkerDependencies({ mysql, neo4j, logger: console });
        worker = createKnowledgeSyncWorker({ service, config });
        healthServer = createWorkerHealthServer(worker);
        await listenWorkerHealthServer(healthServer, config.healthPort, config.healthHost);
        worker.start();

        let shuttingDown = false;
        const shutdown = async signal => {
            if (shuttingDown) return;
            shuttingDown = true;
            console.info(`[knowledge-sync] received ${signal}; stopping after active tasks finish`);
            const outcomes = await cleanupWorkerRuntime({ worker, healthServer, mysql, neo4j });
            const failed = outcomes.find(outcome => outcome.status === 'rejected');
            if (failed) {
                console.error(`[knowledge-sync] shutdown failed error=${failed.reason?.name || 'Error'}`);
                process.exitCode = 1;
            }
        };
        process.once('SIGINT', () => { void shutdown('SIGINT'); });
        process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
    } catch (error) {
        await cleanupWorkerRuntime({ worker, healthServer, mysql, neo4j });
        throw error;
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(`[knowledge-sync] startup failed ${formatWorkerError(error)}`);
        process.exitCode = 1;
    });
}

module.exports = {
    createKnowledgeSyncWorker,
    createWorkerHealthServer,
    cleanupWorkerRuntime,
    getWorkerHealthSnapshot,
    listenWorkerHealthServer,
    readWorkerConfig,
    verifyWorkerDependencies,
    formatWorkerError
};
