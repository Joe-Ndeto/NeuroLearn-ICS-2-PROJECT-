'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');
const express = require('express');

test('PATCH /api/auth/profile updates authenticated student details safely', async t => {
    const routePath = require.resolve('../src/routes/auth');
    const originalLoad = Module._load;

    const state = {
        learner: {
            learner_id: 7,
            username: 'Old Name',
            email: 'old@example.com',
            role: 'student'
        },
        calls: [],
        error: null
    };

    Module._load = function(request, parent, isMain) {
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

                if (token === 'Bearer admin') {
                    req.user = {
                        learner_id: 2,
                        role: 'admin'
                    };
                } else if (token === 'Bearer student') {
                    req.user = {
                        learner_id: 7,
                        role: 'student'
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

                    if (sql.includes('SELECT learner_id') &&
                        sql.includes('learner_id <> ?')) {
                        return [state.duplicate ? [{ learner_id: 9 }] : []];
                    }

                    if (sql.includes('UPDATE learner')) {
                        state.learner.username = params[0];
                        state.learner.email = params[1];
                        return [{ affectedRows: 1 }];
                    }

                    if (sql.includes('SELECT learner_id, username, email, role')) {
                        return [[{ ...state.learner }]];
                    }

                    throw new Error('Unexpected database query.');
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
            '/api/auth/profile';

        const request = (token, body) => fetch(endpoint, {
            method: 'PATCH',
            headers: {
                ...(token ? { Authorization: token } : {}),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        await t.test('unauthenticated requests receive 401', async () => {
            const response = await request(null, {
                username: 'New Name',
                email: 'new@example.com'
            });

            assert.equal(response.status, 401);
        });

        await t.test('administrator accounts receive 403', async () => {
            const response = await request('Bearer admin', {
                username: 'New Name',
                email: 'new@example.com'
            });

            assert.equal(response.status, 403);
        });

        await t.test('invalid username and email are rejected', async () => {
            const before = state.calls.length;

            const response = await request('Bearer student', {
                username: '   ',
                email: 'invalid-email'
            });

            assert.equal(response.status, 400);
            assert.equal(state.calls.length, before);
        });

        await t.test('duplicate username or email receives 409', async () => {
            state.duplicate = true;

            const response = await request('Bearer student', {
                username: 'Existing Name',
                email: 'existing@example.com'
            });

            assert.equal(response.status, 409);

            state.duplicate = false;
        });

        await t.test('student profile is updated successfully', async () => {
            const response = await request('Bearer student', {
                username: '  New   Learner  ',
                email: 'NEW@example.com'
            });

            const body = await response.json();

            assert.equal(response.status, 200);
            assert.equal(body.success, true);

            assert.deepEqual(body.learner, {
                learner_id: 7,
                username: 'New Learner',
                email: 'new@example.com',
                role: 'student'
            });

            assert.equal(
                state.calls.some(call =>
                    call.params.includes(7)
                ),
                true
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