'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    DocumentProcessingError,
    processDocument,
    resolvePythonExecutable
} = require('../src/services/documentProcessingService');

test('Python executable can be configured and has platform-specific virtualenv defaults', () => {
    assert.equal(resolvePythonExecutable({ env: { PYTHON_EXECUTABLE: 'custom-python' }, platform: 'linux', root: '/project' }), 'custom-python');
    assert.match(resolvePythonExecutable({ env: {}, platform: 'win32', root: '/project' }), /ai-service[\\/]\.venv[\\/]Scripts[\\/]python\.exe$/);
    assert.match(resolvePythonExecutable({ env: {}, platform: 'linux', root: '/project' }), /ai-service[\\/]\.venv[\\/]bin[\\/]python$/);
});

test('document processing reports missing Python with actionable safe guidance', async () => {
    await assert.rejects(
        processDocument('/private/document.pdf', {
            executable: 'missing-python',
            execFileImpl: (_executable, _args, callback) => {
                const error = new Error('no executable at /private/path');
                error.code = 'ENOENT';
                callback(error);
            }
        }),
        error => {
            assert.ok(error instanceof DocumentProcessingError);
            assert.equal(error.code, 'PYTHON_EXECUTABLE_UNAVAILABLE');
            assert.match(error.message, /PYTHON_EXECUTABLE/);
            assert.match(error.message, /ai-service\/requirements\.txt/);
            assert.doesNotMatch(error.message, /private\/path/);
            return true;
        }
    );
});

test('document processing invokes only the selected interpreter and processor arguments', async () => {
    let invocation;
    await processDocument('/storage/notes.pdf', {
        executable: 'configured-python',
        execFileImpl: (executable, args, callback) => {
            invocation = { executable, args };
            callback(null);
        }
    });
    assert.equal(invocation.executable, 'configured-python');
    assert.equal(invocation.args.at(-1), '/storage/notes.pdf');
    assert.match(invocation.args[0], /ai-service[\\/]document_processor\.py$/);
});
