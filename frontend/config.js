
'use strict';

// NeuroLearn API configuration
(function configureNeuroLearn(runtime) {
    const existing = runtime.NEUROLEARN_CONFIG || {};
    const location = runtime.location || {};

    const hostname = String(location.hostname || '').toLowerCase();

    const local =
        location.protocol === 'file:' ||
        ['localhost', '127.0.0.1', '::1'].includes(hostname);

    const defaultApiBaseUrl = local
        ? 'http://localhost:5000/api'
        : 'https://neurolearn-backend-xo55.onrender.com/api';

    runtime.NEUROLEARN_CONFIG = Object.freeze({
        ...existing,
        apiBaseUrl: String(
            existing.apiBaseUrl || defaultApiBaseUrl
        ).trim().replace(/\/+$/, '')
    });
})(window);
