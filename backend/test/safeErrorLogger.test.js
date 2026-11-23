'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { logSafeError, safeErrorDetails } = require('../src/utils/safeErrorLogger');

test('safe error diagnostics retain identifiers but never include messages, causes or stacks', () => {
    const error = new Error('token=PRIVATE_TOKEN document body PRIVATE_CONTENT');
    error.code = 'AI_PROVIDER_ERROR';
    error.status = 503;
    error.cause = new Error('nested password PRIVATE_PASSWORD');
    const details = safeErrorDetails(error);
    assert.deepEqual(details, { name: 'Error', code: 'AI_PROVIDER_ERROR', status: 503 });
    assert.doesNotMatch(JSON.stringify(details), /PRIVATE_TOKEN|PRIVATE_CONTENT|PRIVATE_PASSWORD/);

    const calls = [];
    logSafeError({ error: (...args) => calls.push(args) }, '[AI] failed', error);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '[AI] failed');
    assert.deepEqual(calls[0][1], details);
});

test('unsafe diagnostic identifiers are omitted', () => {
    assert.deepEqual(safeErrorDetails({ name: 'Error', code: 'PRIVATE TOKEN' }), { name: 'Error', code: null });
});
