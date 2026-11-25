'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');
const express = require('express');

test('PATCH /api/auth/password validates password changes securely', async t => {
    const routePath = require.resolve('../src/routes/auth');
    const originalLoad = Module._load;

    const state = {
        passwordHash: 'existing-hash',
        googleId: 'google-sub-123',
        googlePayload: null,
        calls: [],
        compareResult: true,
        hashResult: 'new-hash',
        error: null
    };

    Module._load = function (request, parent, isMain) {
        if (
            parent?.filename === routePath &&
            request === '../middleware/authenticateToken'
        ) {
            return (req, res, next) => {
                const token = req.headers.authorization;

                if (!token) {
                    return res.status(401).json({
                        success: false,
                        message: 'Authentication token is required.'
                    });
                }

                if (token === 'Bearer student') {
                    req.user = {
                        learner_id: 7,
                        role: 'student'
                    };
                } else if (token === 'Bearer admin') {
                    req.user = {
                        learner_id: 2,
                        role: 'admin'
                    };
                } else {
                    return res.status(401).json({
                        success: false,
                        message: 'Invalid token.'
                    });
                }

                return next();
            };
        }

        if (
            parent?.filename === routePath &&
            request === '../config/mysql'
        ) {
            return {
                async execute(sql, params) {
                    state.calls.push({ sql, params });

                    if (state.error) {
                        throw state.error;
                    }

                    if (sql.includes('SELECT password_hash')) {
                        return [[{
                            password_hash: state.passwordHash,
                            google_id: state.googleId
                        }]];
                    }
                    if (sql.includes('UPDATE learner')) {
                        state.passwordHash = params[0];
                        return [{ affectedRows: 1 }];
                    }

                    throw new Error('Unexpected database query.');
                }
            };
        }

        if (
            parent?.filename === routePath &&
            request === 'bcryptjs'
        ) {
            return {
                async compare(password, hash) {
                    state.compared = { password, hash };
                    return state.compareResult;
                },

                async hash(password, rounds) {
                    state.hashed = { password, rounds };
                    return state.hashResult;
                }
            };
        }

        if (
            parent?.filename === routePath &&
            request === 'google-auth-library'
        ) {
            return {
                OAuth2Client: class {
                    async verifyIdToken() {
                        return {
                            getPayload() {
                                return state.googlePayload;
                            }
                        };
                    }
                }
            };
        }

        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[routePath];

    let server;

    try {
        const app = express();
        app.use(express.json());
        app.use('/api/auth', require(routePath));

        server = http.createServer(app);

        await new Promise(resolve => {
            server.listen(0, '127.0.0.1', resolve);
        });

        const endpoint =
            `http://127.0.0.1:${server.address().port}` +
            '/api/auth/password';

        const request = (token, body) => fetch(endpoint, {
            method: 'PATCH',
            headers: {
                ...(token ? { Authorization: token } : {}),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const statusEndpoint =
            `http://127.0.0.1:${server.address().port}` +
            '/api/auth/password-status';

        const statusRequest = token => fetch(statusEndpoint, {
            method: 'GET',
            headers: token ? { Authorization: token } : {}
        });

        await t.test('password status requires authentication', async () => {
            const response = await statusRequest(null);

            assert.equal(response.status, 401);
        });

        await t.test('password status identifies an account with a password', async () => {
            state.passwordHash = 'existing-hash';
            state.googleId = 'google-sub-123';

            const response = await statusRequest('Bearer student');
            const body = await response.json();

            assert.equal(response.status, 200);
            assert.deepEqual(body, {
                success: true,
                hasPassword: true,
                googleLinked: true
            });
        });

        await t.test('password status identifies a Google-only account', async () => {
            state.passwordHash = null;
            state.googleId = 'google-sub-123';

            const response = await statusRequest('Bearer student');
            const body = await response.json();

            assert.equal(response.status, 200);
            assert.deepEqual(body, {
                success: true,
                hasPassword: false,
                googleLinked: true
            });

            state.passwordHash = 'existing-hash';
        });

        await t.test('administrator password status requests receive 403', async () => {
            const response = await statusRequest('Bearer admin');

            assert.equal(response.status, 403);
        });

        await t.test('unauthenticated users receive 401', async () => {
            const response = await request(null, {
                currentPassword: 'old-password',
                newPassword: 'new-password'
            });

            assert.equal(response.status, 401);
        });

        await t.test('administrator accounts receive 403', async () => {
            const response = await request('Bearer admin', {
                currentPassword: 'old-password',
                newPassword: 'new-password'
            });

            assert.equal(response.status, 403);
        });

        await t.test('short new passwords receive 400', async () => {
            const before = state.calls.length;

            const response = await request('Bearer student', {
                currentPassword: 'old-password',
                newPassword: 'short'
            });

            assert.equal(response.status, 400);
            assert.equal(state.calls.length, before);
        });

        await t.test('Google account can set a password after successful verification', async () => {
            state.passwordHash = null;
            state.googlePayload = {
                sub: 'google-sub-123',
                email: 'learner@example.com',
                email_verified: true
            };

            const response = await request('Bearer student', {
                googleCredential: 'valid-google-credential',
                newPassword: 'new-google-password-123'
            });

            const body = await response.json();

            assert.equal(response.status, 200);
            assert.equal(body.success, true);
            assert.equal(state.passwordHash, 'new-hash');

            state.passwordHash = 'existing-hash';
            state.googlePayload = null;
        });

        await t.test('Google account cannot set a password using another Google identity', async () => {
            state.passwordHash = null;
            state.googlePayload = {
                sub: 'different-google-account',
                email: 'another@example.com',
                email_verified: true
            };

            const before = state.calls.length;

            const response = await request('Bearer student', {
                googleCredential: 'another-google-credential',
                newPassword: 'new-google-password-123'
            });

            assert.equal(response.status, 401);

            assert.equal(
                state.calls.slice(before).some(call =>
                    call.sql.includes('UPDATE learner')
                ),
                false
            );

            state.passwordHash = 'existing-hash';
            state.googlePayload = null;
        });

        await t.test('Google-only accounts require Google reauthentication', async () => {
            state.passwordHash = null;
            const before = state.calls.length;

            const response = await request('Bearer student', {
                currentPassword: 'anything',
                newPassword: 'new-password-123'
            });

            const body = await response.json();

            assert.equal(response.status, 401);
            assert.equal(
                body.code,
                'GOOGLE_REAUTHENTICATION_REQUIRED'
            );

            assert.equal(
                state.calls.slice(before).some(call =>
                    call.sql.includes('UPDATE learner')
                ),
                false
            );

            state.passwordHash = 'existing-hash';
        });

        await t.test('incorrect current passwords receive 401', async () => {
            state.compareResult = false;

            const before = state.calls.length;

            const response = await request('Bearer student', {
                currentPassword: 'wrong-password',
                newPassword: 'new-password-123'
            });

            assert.equal(response.status, 401);

            assert.equal(
                state.calls.slice(before).some(call =>
                    call.sql.includes('UPDATE learner')
                ),
                false
            );

            state.compareResult = true;
        });

        await t.test('valid password changes save a bcrypt hash', async () => {
            const response = await request('Bearer student', {
                currentPassword: 'old-password',
                newPassword: 'new-password-123'
            });

            const body = await response.json();

            assert.equal(response.status, 200);
            assert.equal(body.success, true);
            assert.equal(state.passwordHash, 'new-hash');

            assert.deepEqual(state.compared, {
                password: 'old-password',
                hash: 'existing-hash'
            });

            assert.deepEqual(state.hashed, {
                password: 'new-password-123',
                rounds: 10
            });

            assert.equal(
                JSON.stringify(body).includes('new-hash'),
                false
            );
        });

    } finally {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }

        Module._load = originalLoad;
        delete require.cache[routePath];
    }
});