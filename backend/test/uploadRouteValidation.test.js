'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const test = require('node:test');

test('generic student upload rejects a mismatched signature before writing metadata and removes the temporary file', async t => {
    const routePath = require.resolve('../src/routes/upload');
    const originalLoad = Module._load;
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'neurolearn-upload-validation-'));
    const filePath = path.join(temporaryDirectory, 'bad.pdf');
    await fs.writeFile(filePath, 'not a PDF');
    let dbWrites = 0;
    let activeFile = null;

    function fakeMulter() {
        return { single: () => (req, _res, next) => { req.file = activeFile; next(); } };
    }
    fakeMulter.diskStorage = () => ({});

    Module._load = function(request, parent, isMain) {
        if (parent?.filename === routePath && request === 'multer') return fakeMulter;
        if (parent?.filename === routePath && request === '../config/mysql') {
            return { async execute() { dbWrites++; throw new Error('unexpected metadata write'); } };
        }
        if (parent?.filename === routePath && request === '../middleware/authenticateToken') {
            return (req, _res, next) => { req.user = { learner_id: 17 }; next(); };
        }
        if (parent?.filename === routePath && request === '../services/documentProcessingService') {
            return { async processDocument() { throw new Error('must not process invalid content'); } };
        }
        if (parent?.filename === routePath && request === '../services/knowledgeGraphService') return { async getAllCourses() { return []; } };
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[routePath];

    let server;
    try {
        const app = express();
        app.use('/api/upload', require(routePath));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        activeFile = { path: filePath, originalname: 'bad.pdf', filename: 'bad.pdf', size: 9 };
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/upload`, {
            method: 'POST',
            headers: { Authorization: 'Bearer test', 'Content-Type': 'multipart/form-data; boundary=test' },
            body: '--test--\r\n'
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).message, /does not match/);
        assert.equal(dbWrites, 0);
        await assert.rejects(fs.access(filePath));
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        Module._load = originalLoad;
        delete require.cache[routePath];
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
});
