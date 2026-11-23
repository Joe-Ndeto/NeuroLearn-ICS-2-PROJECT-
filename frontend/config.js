'use strict';

// A deployment may define NEUROLEARN_CONFIG before this script or replace this
// asset. Production defaults to the same-origin API; loopback remains convenient
// for local static-server development.
(function configureNeuroLearn(runtime) {
    const existing = runtime.NEUROLEARN_CONFIG || {};
    const location = runtime.location || {};
    const hostname = String(location.hostname || '').toLowerCase();
    const local = location.protocol === 'file:' ||
        ['localhost', '127.0.0.1', '::1'].includes(hostname);
    const defaultApiBaseUrl = local || !location.origin || location.origin === 'null'
        ? 'http://localhost:5000/api'
        : `${location.origin.replace(/\/+$/, '')}/api`;

    runtime.NEUROLEARN_CONFIG = Object.freeze({
        ...existing,
        apiBaseUrl: String(existing.apiBaseUrl || defaultApiBaseUrl).trim().replace(/\/+$/, '')
    });
})(window);
