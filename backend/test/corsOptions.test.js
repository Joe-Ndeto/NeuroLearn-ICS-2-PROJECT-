'use strict';

const assert = require('node:assert/strict');
const cors = require('cors');
const express = require('express');
const http = require('node:http');
const test = require('node:test');
const { createCorsOptions, parseAllowedOrigins } = require('../src/config/corsOptions');

function decideOrigin(options, origin) {
    return new Promise((resolve, reject) => {
        options.origin(origin, (error, allowed) => error ? reject(error) : resolve(allowed));
    });
}

test('CORS defaults are limited to local development origins and production requires configuration', async () => {
    const development = createCorsOptions({ nodeEnv: 'development', allowedOrigins: '' });
    assert.equal(await decideOrigin(development, 'http://localhost:5500'), true);
    assert.equal(await decideOrigin(development, 'https://other.example'), false);
    assert.equal(await decideOrigin(development, undefined), true);
    assert.throws(() => createCorsOptions({ nodeEnv: 'production', allowedOrigins: '' }), /configured in production/);
});

test('CORS origin configuration rejects wildcards, credentials and paths', () => {
    assert.deepEqual([...parseAllowedOrigins('https://learn.example, https://admin.example/')], [
        'https://learn.example', 'https://admin.example'
    ]);
    for (const value of ['*', 'https://user:pass@example.test', 'https://example.test/path']) {
        assert.throws(() => parseAllowedOrigins(value));
    }
});

test('allowed preflight requests receive explicit CORS headers while denied origins do not', async t => {
    const app = express();
    app.use(cors(createCorsOptions({ nodeEnv: 'production', allowedOrigins: 'https://learn.example' })));
    app.get('/api/check', (_req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;

    const preflight = await fetch(`${base}/api/check`, {
        method: 'OPTIONS',
        headers: {
            Origin: 'https://learn.example',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization,content-type'
        }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://learn.example');
    assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/i);

    const denied = await fetch(`${base}/api/check`, { headers: { Origin: 'https://other.example' } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
});
