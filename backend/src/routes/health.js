'use strict';

const express = require('express');
const defaultMysql = require('../config/mysql');
const { getSession: defaultGetSession } = require('../config/neo4j');

const DEFAULT_TIMEOUT_MS = 2000;

function configuredTimeout(value = process.env.HEALTH_CHECK_TIMEOUT_MS) {
    if (value === undefined || value === '') return DEFAULT_TIMEOUT_MS;
    const timeout = Number(value);
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30000) {
        throw new Error('HEALTH_CHECK_TIMEOUT_MS must be an integer between 100 and 30000.');
    }
    return timeout;
}

function withTimeout(operation, timeoutMs, dependency) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`${dependency} readiness check timed out.`);
            error.code = 'HEALTH_CHECK_TIMEOUT';
            reject(error);
        }, timeoutMs);
    });
    return Promise.race([Promise.resolve(operation), timeout])
        .finally(() => clearTimeout(timer));
}

function statusFromError(error) {
    return error?.code === 'HEALTH_CHECK_TIMEOUT' || error?.code === 'ETIMEDOUT'
        ? 'timeout'
        : 'unavailable';
}

function createHealthRouter({
    mysql = defaultMysql,
    getSession = defaultGetSession,
    timeoutMs = configuredTimeout()
} = {}) {
    const router = express.Router();

    router.get('/live', (_req, res) => res.status(200).json({ status: 'alive' }));

    async function readiness(_req, res, legacy = false) {
        const mysqlCheck = Promise.resolve()
            .then(() => withTimeout(
                mysql.query({ sql: 'SELECT 1 AS ready', timeout: timeoutMs }),
                timeoutMs,
                'MySQL'
            ))
            .then(() => 'connected', statusFromError);

        const neo4jCheck = (async () => {
            let session;
            try {
                session = getSession();
                await withTimeout(
                    session.run('RETURN 1 AS ready', {}, { timeout: timeoutMs }),
                    timeoutMs,
                    'Neo4j'
                );
                return 'connected';
            } catch (error) {
                return statusFromError(error);
            } finally {
                if (session) {
                    try {
                        await withTimeout(session.close(), timeoutMs, 'Neo4j session close');
                    } catch {
                        // Readiness is already degraded when session cleanup fails.
                    }
                }
            }
        })();

        const [mysqlStatus, neo4jStatus] = await Promise.all([mysqlCheck, neo4jCheck]);
        const ready = mysqlStatus === 'connected' && neo4jStatus === 'connected';
        return res.status(ready ? 200 : 503).json({
            status: ready ? legacy ? 'healthy' : 'ready' : 'degraded',
            mysql: mysqlStatus,
            neo4j: neo4jStatus
        });
    }

    // Keep the existing path as a dependency readiness check.
    router.get('/', (req, res) => readiness(req, res, true));
    router.get('/ready', (req, res) => readiness(req, res));
    router.get('/readiness', (req, res) => readiness(req, res));
    return router;
}

module.exports = createHealthRouter();
module.exports.createHealthRouter = createHealthRouter;
module.exports.configuredTimeout = configuredTimeout;
