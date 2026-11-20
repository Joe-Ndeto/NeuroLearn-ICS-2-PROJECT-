'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');
const express = require('express');
const { uploadFolder } = require('../src/middleware/resourceDocumentUpload');

test('resource multipart route validates, authorizes, stores and cleans submitted files', async t => {
    const originalLoad = Module._load;
    const routePath = require.resolve('../src/routes/submissions');
    let nextId = 0;
    let failSave = false;
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === routePath && request === '../middleware/authenticateToken') {
            return (req, res, next) => {
                if (!req.headers.authorization) return res.status(401).json({ success: false });
                req.user = { learner_id: 7, role: req.headers.authorization === 'Bearer admin' ? 'admin' : req.headers.authorization === 'Bearer student' ? 'student' : 'reader' };
                next();
            };
        }
        if (parent?.filename === routePath && request === '../services/knowledgeSubmissionService') {
            return {
                async createPendingSubmission(type, data, learnerId) {
                    if (failSave) throw new Error('simulated save failure');
                    return { submissionId: ++nextId, submissionType: type, submissionData: data, submittedBy: learnerId };
                },
                async getLearnerSubmissions() { return { submissions: [], total: 0 }; },
                async resolveConceptReference(id) { return id === 'C001' ? { concept_id: 1 } : null; }
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[routePath];
    let server;
    try {
        const app = express();
        app.use(express.json());
        app.use('/api/submissions', require(routePath));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}/api/submissions/resources`;
        const conceptBase = base.replace('/resources', '/concepts');
        const pdf = Buffer.from('%PDF-1.7 valid test body');
        const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
        const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        const before = new Set(await fs.readdir(uploadFolder));

        const conceptResponse = await fetch(conceptBase, {
            method: 'POST', headers: { Authorization: 'Bearer student', 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Graph Theory', description: 'Graphs' })
        });
        assert.equal(conceptResponse.status, 201, 'concept submission is accepted without student difficulty');
        const conceptPayload = await conceptResponse.json();
        assert.deepEqual(conceptPayload.submission.submissionData, { name: 'Graph Theory', description: 'Graphs' });

        async function send({ token = 'student', filename = 'resource.pdf', bytes = pdf, conceptId = null, includeFile = true, title = 'Learning notes' } = {}) {
            const body = new FormData();
            if (conceptId !== null) body.append('conceptId', conceptId);
            if (title !== undefined) body.append('title', title);
            if (includeFile) body.append('document', new Blob([bytes]), filename);
            return fetch(base, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body });
        }

        for (const [filename, bytes] of [['file.pdf', pdf], ['slides.pptx', zip], ['slides.ppt', ole], ['notes.docx', zip], ['notes.doc', ole]]) {
            const response = await send({ filename, bytes });
            assert.equal(response.status, 201, filename);
            const payload = await response.json();
            assert.equal(payload.submission.submissionData.document.originalName, filename);
            assert.equal(Object.hasOwn(payload.submission.submissionData, 'conceptId'), false);
            await fs.rm(path.join(uploadFolder, payload.submission.submissionData.document.filename), { force: true });
        }

        assert.equal((await send({ filename: 'script.exe' })).status, 400);
        assert.equal((await send({ filename: 'fake.pdf', bytes: Buffer.from('not PDF') })).status, 400);
        assert.equal((await send({ includeFile: false })).status, 400);
        const noConceptResponse = await send({ conceptId: null });
        assert.equal(noConceptResponse.status, 201);
        const noConceptPayload = await noConceptResponse.json();
        await fs.rm(path.join(uploadFolder, noConceptPayload.submission.submissionData.document.filename), { force: true });
        assert.equal((await send({ conceptId: 'NO_SUCH_CONCEPT' })).status, 400);
        assert.equal((await send({ token: 'admin' })).status, 403);
        assert.equal((await send({ token: null })).status, 401);
        const prerequisiteResponse = await fetch(`${base.replace('/resources', '/prerequisites')}`, {
            method: 'POST', headers: { Authorization: 'Bearer student', 'Content-Type': 'application/json' },
            body: JSON.stringify({ prerequisiteId: 1, targetId: 2 })
        });
        assert.equal(prerequisiteResponse.status, 410);

        failSave = true;
        assert.equal((await send()).status, 500);
        failSave = false;
        const after = new Set(await fs.readdir(uploadFolder));
        assert.deepEqual([...after].filter(filename => !before.has(filename)), []);

        const oversized = await send({ filename: 'large.pdf', bytes: Buffer.concat([pdf, Buffer.alloc(10 * 1024 * 1024)]) });
        assert.equal(oversized.status, 413);
    } finally {
        failSave = false;
        if (server) await new Promise(resolve => server.close(resolve));
        Module._load = originalLoad;
        delete require.cache[routePath];
    }
});
