'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ApiError, createApiClient } = require('../../frontend/api');

function createStorage(seed = {}) {
    const values = new Map(Object.entries(seed));
    return {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); },
        has(key) { return values.has(key); }
    };
}

function createRuntime({ fetchImpl, token = 'test-token', learner = { learner_id: 7 }, apiBaseUrl, location } = {}) {
    const storage = createStorage({
        neurolearnToken: token,
        neurolearnLearner: JSON.stringify(learner)
    });
    const redirects = [];
    const runtimeLocation = location || { replace(path) { redirects.push(path); } };
    const api = createApiClient({
        fetchImpl,
        storage,
        config: apiBaseUrl === undefined ? {} : { apiBaseUrl },
        location: runtimeLocation
    });
    return { api, storage, redirects };
}

function response(status, body, contentType = 'application/json') {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => contentType },
        async text() {
            return typeof body === 'string' ? body : JSON.stringify(body);
        }
    };
}

test('attaches the bearer token and sends JSON with successful JSON responses', async () => {
    let request;
    const { api } = createRuntime({
        fetchImpl: async (url, options) => {
            request = { url, options };
            return response(200, { success: true, value: 4 });
        }
    });

    const result = await api.post('/sample', { answer: 42 });

    assert.deepEqual(result, { success: true, value: 4 });
    assert.equal(request.url, 'http://localhost:5000/api/sample');
    assert.equal(request.options.headers.get('Authorization'), 'Bearer test-token');
    assert.equal(request.options.headers.get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(request.options.body), { answer: 42 });
});

test('supports PATCH requests and preserves multipart upload bodies', async t => {
    await t.test('PATCH JSON', async () => {
        let request;
        const { api } = createRuntime({
            fetchImpl: async (url, options) => {
                request = { url, options };
                return response(200, { success: true });
            }
        });
        await api.patch('/sample/2', { active: true });
        assert.equal(request.options.method, 'PATCH');
        assert.deepEqual(JSON.parse(request.options.body), { active: true });
    });

    await t.test('multipart upload', async () => {
        const formData = new FormData();
        formData.append('document', 'mock file');
        let request;
        const { api } = createRuntime({
            fetchImpl: async (url, options) => {
                request = { url, options };
                return response(200, { success: true });
            }
        });
        await api.post('/upload', formData);
        assert.equal(request.options.body, formData);
        assert.equal(request.options.headers.has('Content-Type'), false);
    });
});

test('uses a deployment-configured API base without changing request logic', async () => {
    let requestedUrl;
    const { api } = createRuntime({
        apiBaseUrl: 'https://api.neurolearn.invalid/v2/',
        fetchImpl: async url => {
            requestedUrl = url;
            return response(200, { ok: true });
        }
    });

    assert.equal(api.apiBaseUrl, 'https://api.neurolearn.invalid/v2');
    await api.get('health');
    assert.equal(requestedUrl, 'https://api.neurolearn.invalid/v2/health');
});

test('uses the local API base default', () => {
    const { api } = createRuntime({ fetchImpl: async () => response(200, {}) });
    assert.equal(api.apiBaseUrl, 'http://localhost:5000/api');
});

test('defaults deployed frontends to their same-origin API', async () => {
    let requestedUrl;
    const { api } = createRuntime({
        location: {
            origin: 'https://learn.example',
            hostname: 'learn.example',
            protocol: 'https:',
            replace() {}
        },
        fetchImpl: async url => {
            requestedUrl = url;
            return response(200, { ok: true });
        }
    });
    assert.equal(api.apiBaseUrl, 'https://learn.example/api');
    await api.get('/health');
    assert.equal(requestedUrl, 'https://learn.example/api/health');
});

test('uses a safe fallback for non-JSON HTTP error responses', async () => {
    const { api } = createRuntime({
        fetchImpl: async () => response(502, '<html>temporary gateway failure</html>', 'text/html')
    });

    await assert.rejects(api.get('/unavailable'), error => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 502);
        assert.equal(error.message, 'Request failed with status 502.');
        return true;
    });
});

test('clears the session and redirects on authenticated 401 responses', async () => {
    const { api, storage, redirects } = createRuntime({
        fetchImpl: async () => response(401, { message: 'Invalid or expired authentication token.' })
    });

    await assert.rejects(api.get('/private'), error => error.status === 401 && error.unauthorized);
    assert.equal(storage.has('neurolearnToken'), false);
    assert.equal(storage.has('neurolearnLearner'), false);
    assert.deepEqual(redirects, ['login_signup.html']);
});

test('preserves the session on 403 and surfaces a forbidden authorization error', async () => {
    const { api, storage, redirects } = createRuntime({
        fetchImpl: async () => response(403, { message: 'Administrator privileges required.' })
    });

    await assert.rejects(api.get('/admin'), error => {
        assert.equal(error.status, 403);
        assert.equal(error.forbidden, true);
        assert.equal(error.message, 'Administrator privileges required.');
        return true;
    });
    assert.equal(storage.has('neurolearnToken'), true);
    assert.equal(storage.has('neurolearnLearner'), true);
    assert.deepEqual(redirects, []);
});

test('preserves the session after temporary server errors and network failures', async t => {
    await t.test('server error', async () => {
        const { api, storage, redirects } = createRuntime({
            fetchImpl: async () => response(503, { message: 'Temporarily unavailable.' })
        });
        await assert.rejects(api.get('/private'), error => error.status === 503);
        assert.equal(storage.has('neurolearnToken'), true);
        assert.deepEqual(redirects, []);
    });

    await t.test('network error', async () => {
        const { api, storage, redirects } = createRuntime({
            fetchImpl: async () => { throw new TypeError('network failure'); }
        });
        await assert.rejects(api.get('/private'), /Could not reach the server/);
        assert.equal(storage.has('neurolearnToken'), true);
        assert.deepEqual(redirects, []);
    });
});

test('validates /auth/me and exposes only the server-confirmed role', async () => {
    const { api, storage } = createRuntime({
        fetchImpl: async () => response(200, {
            success: true,
            learner: { learner_id: 7, username: 'Admin', role: 'admin' }
        })
    });

    assert.equal(api.isAdministrator(), false);
    assert.equal(api.isStudent(), false);
    const learner = await api.validateSession();
    assert.equal(learner.role, 'admin');
    assert.equal(api.isAdministrator(), true);
    assert.equal(api.isStudent(), false);
    assert.deepEqual(JSON.parse(storage.getItem('neurolearnLearner')), learner);
});
