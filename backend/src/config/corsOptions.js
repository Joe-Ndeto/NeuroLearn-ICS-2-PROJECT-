'use strict';

const DEVELOPMENT_ORIGINS = Object.freeze([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:8080',
    'http://127.0.0.1:8080'
]);

function normalizeOrigin(value) {
    const origin = String(value || '').trim();
    if (!origin || origin === '*') throw new Error('CORS_ALLOWED_ORIGINS must contain explicit HTTP(S) origins.');
    let parsed;
    try {
        parsed = new URL(origin);
    } catch {
        throw new Error('CORS_ALLOWED_ORIGINS contains an invalid origin.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error('CORS_ALLOWED_ORIGINS entries must be origins without paths or credentials.');
    }
    return parsed.origin;
}

function parseAllowedOrigins(value) {
    const entries = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
    return new Set(entries.map(normalizeOrigin));
}

function createCorsOptions({
    nodeEnv = process.env.NODE_ENV,
    allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
} = {}) {
    let originSet;
    if (typeof allowedOrigins === 'string' && allowedOrigins.trim()) {
        originSet = parseAllowedOrigins(allowedOrigins);
    } else if (nodeEnv === 'production') {
        throw new Error('CORS_ALLOWED_ORIGINS must be configured in production.');
    } else {
        originSet = new Set(DEVELOPMENT_ORIGINS);
    }

    return {
        origin(origin, callback) {
            if (!origin) return callback(null, true);
            return callback(null, originSet.has(origin));
        },
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Accept', 'Authorization', 'Content-Type', 'Idempotency-Key'],
        optionsSuccessStatus: 204,
        maxAge: 600
    };
}

module.exports = { DEVELOPMENT_ORIGINS, createCorsOptions, normalizeOrigin, parseAllowedOrigins };
