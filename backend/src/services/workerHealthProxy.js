'use strict';

const http = require('node:http');

const DEFAULT_PORT = 5001;
const REQUEST_TIMEOUT_MS = 1500;
const MAX_RESPONSE_BYTES = 16 * 1024;
const HEALTH_STATES = new Set(['not_started', 'running', 'stopping', 'stopped']);

function configuredPort(value = process.env.KNOWLEDGE_SYNC_HEALTH_PORT) {
    if (value === undefined || value === '') return DEFAULT_PORT;
    const port = Number(value);
    return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function configuredHost(value = process.env.KNOWLEDGE_SYNC_HEALTH_HOST) {
    const host = value || '127.0.0.1';
    return ['127.0.0.1', 'localhost', '::1'].includes(host) ? host : null;
}

function proxyError(status, code, message) {
    return { status, body: { success: false, code, message, health: null } };
}

function safeHealthSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !HEALTH_STATES.has(value.state) || typeof value.started !== 'boolean' ||
        typeof value.processAlive !== 'boolean') return null;
    const safeTimestamp = field => value[field] === null ||
        (typeof value[field] === 'string' && value[field].length <= 64)
        ? value[field]
        : null;
    return {
        state: value.state,
        started: value.started,
        processAlive: value.processAlive,
        startedAt: safeTimestamp('startedAt'),
        stoppingAt: safeTimestamp('stoppingAt'),
        stoppedAt: safeTimestamp('stoppedAt'),
        lastSuccessfulPollAt: safeTimestamp('lastSuccessfulPollAt'),
        lastSuccessfulSyncAt: safeTimestamp('lastSuccessfulSyncAt'),
        inFlightCount: Number.isSafeInteger(value.inFlightCount) && value.inFlightCount >= 0
            ? value.inFlightCount
            : 0
    };
}

function requestWorker(host, port, { requestImpl = http.get, timeoutMs = REQUEST_TIMEOUT_MS, timerImpl = setTimeout, clearTimer = clearTimeout } = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let size = 0;
        const chunks = [];
        let timeoutHandle;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            if (timeoutHandle !== undefined) clearTimer(timeoutHandle);
            callback(value);
        };
        let request;
        try {
            request = requestImpl({
                hostname: host,
                port,
                path: '/health',
                method: 'GET',
                headers: { accept: 'application/json' }
            }, response => {
                response.on('data', chunk => {
                    size += Buffer.byteLength(chunk);
                    if (size > MAX_RESPONSE_BYTES) {
                        const error = new Error('Worker health response exceeded its size limit.');
                        error.code = 'WORKER_RESPONSE_TOO_LARGE';
                        finish(reject, error);
                        request?.destroy(error);
                        return;
                    }
                    chunks.push(Buffer.from(chunk));
                });
                response.on('end', () => finish(resolve, {
                    statusCode: response.statusCode,
                    body: Buffer.concat(chunks).toString('utf8')
                }));
                response.on('error', error => finish(reject, error));
            });
            request.on('error', error => finish(reject, error));
            timeoutHandle = timerImpl(() => {
                const error = new Error('Worker health request timed out.');
                error.code = 'WORKER_HEALTH_TIMEOUT';
                request.destroy(error);
            }, timeoutMs);
        } catch (error) {
            finish(reject, error);
        }
    });
}

async function getWorkerHealth({ port: requestedPort, requestImpl, timeoutMs, timerImpl, clearTimer } = {}) {
    const port = configuredPort(requestedPort);
    const host = configuredHost();
    if (!port || !host) return proxyError(503, 'worker_health_misconfigured', 'Worker health is unavailable.');

    let response;
    try {
        response = await requestWorker(host, port, { requestImpl, timeoutMs, timerImpl, clearTimer });
    } catch (error) {
        if (error.code === 'WORKER_HEALTH_TIMEOUT') {
            return proxyError(504, 'worker_health_timeout', 'The worker health check timed out.');
        }
        if (error.code === 'WORKER_RESPONSE_TOO_LARGE') {
            return proxyError(502, 'worker_health_invalid_response', 'The worker returned an invalid health response.');
        }
        return proxyError(503, 'worker_unavailable', 'The synchronization worker is unavailable.');
    }

    if (response.statusCode !== 200 && response.statusCode !== 503) {
        return proxyError(502, 'worker_health_http_error', 'The worker health endpoint returned an error.');
    }

    let parsed;
    try {
        parsed = JSON.parse(response.body);
    } catch {
        return proxyError(502, 'worker_health_invalid_response', 'The worker returned an invalid health response.');
    }
    const health = safeHealthSnapshot(parsed?.health);
    if (!health || typeof parsed.success !== 'boolean') {
        return proxyError(502, 'worker_health_invalid_response', 'The worker returned an invalid health response.');
    }

    const healthy = response.statusCode === 200 && parsed.success === true &&
        health.started && health.processAlive && health.state === 'running';
    if (healthy) return { status: 200, body: { success: true, code: null, message: 'The synchronization worker is running.', health } };
    return {
        status: 503,
        body: { success: false, code: 'worker_unavailable', message: 'The synchronization worker is not running.', health }
    };
}

module.exports = { DEFAULT_PORT, REQUEST_TIMEOUT_MS, configuredHost, configuredPort, getWorkerHealth, safeHealthSnapshot };
