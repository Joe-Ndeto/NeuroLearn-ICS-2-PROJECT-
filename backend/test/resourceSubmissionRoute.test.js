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
    let requestKey = 0;
    let documentAccessFixture = null;
    const resourceCalls = [];
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === routePath && request === '../middleware/authenticateToken') {
            return (req, res, next) => {
                if (!req.headers.authorization) return res.status(401).json({ success: false });
                req.user = { learner_id: 7, role: req.headers.authorization === 'Bearer admin' ? 'admin' : req.headers.authorization === 'Bearer student' ? 'student' : 'reader' };
                next();
            };
        }
        if (parent?.filename === routePath && request === '../config/mysql') {
            return { async execute() { return [documentAccessFixture ? [documentAccessFixture] : [], []]; } };
        }
        if (parent?.filename === routePath && request === '../services/knowledgeSubmissionService') {
            return {
                async createPendingSubmission(type, data, learnerId) {
                    if (failSave) throw new Error('simulated save failure');
                    return { submissionId: ++nextId, submissionType: type, submissionData: data, submittedBy: learnerId };
                },
                async createPendingCourseSubmission({ title, description, learnerId }) {
                    if (failSave) throw new Error('simulated save failure');
                    return { submissionId: ++nextId, submissionType: 'COURSE', submissionData: { title, description }, submittedBy: learnerId };
                },
                async createPendingResourceSubmission({ learnerId, title, courseId, conceptId, document }) {
                    if (failSave) throw new Error('simulated save failure');
                    resourceCalls.push({ learnerId, title, courseId, conceptId, document });
                    const submissionId = ++nextId;
                    return { replayed: false, submission: {
                        submissionId,
                        submissionType: 'RESOURCE',
                        submissionData: { title, courseId, conceptId: Number(conceptId), type: 'document', document: {
                            filename: document.filename, originalName: document.originalName,
                            documentId: submissionId + 100
                        } },
                        submittedBy: learnerId
                    }, processingStatus: document.processingStatus };
                },
                async getLearnerSubmissions() { return { submissions: [], total: 0 }; },
                async getApprovedCourseConceptOptions() { return [{ courseId: 'COURSE-1', name: 'Database Concepts', concepts: [{ conceptId: 11, name: 'Joins' }] }]; },
                async validateResourceCourseConcept(courseId, conceptId) { return courseId === 'COURSE-1' && Number(conceptId) === 11; },
                async resolveConceptReference(id) { return id === 'C001' ? { concept_id: 1 } : null; }
            };
        }
        if (parent?.filename === routePath && request === '../services/documentProcessingService') {
            return { async processDocument() {}, async removeProcessedText() {} };
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
        const courseBase = base.replace('/resources', '/courses');
        const pdf = Buffer.from('%PDF-1.7 valid test body');
        const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
        const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        const before = new Set(await fs.readdir(uploadFolder));

        const optionsResponse = await fetch(base.replace('/resources', '/resource-options'), {
            headers: { Authorization: 'Bearer student' }
        });
        assert.equal(optionsResponse.status, 200);
        assert.deepEqual((await optionsResponse.json()).courses[0].concepts, [{ conceptId: 11, name: 'Joins' }]);
        const deniedOptions = await fetch(base.replace('/resources', '/resource-options'), {
            headers: { Authorization: 'Bearer admin' }
        });
        assert.equal(deniedOptions.status, 403);

        const conceptResponse = await fetch(conceptBase, {
            method: 'POST', headers: { Authorization: 'Bearer student', 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Graph Theory', description: 'Graphs' })
        });
        assert.equal(conceptResponse.status, 201, 'concept submission is accepted without student difficulty');
        const conceptPayload = await conceptResponse.json();
        assert.deepEqual(conceptPayload.submission.submissionData, { name: 'Graph Theory', description: 'Graphs' });

        const unauthorizedCourse = await fetch(courseBase, {
            method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Data Systems' })
        });
        assert.equal(unauthorizedCourse.status, 403, 'course proposals are student-only');
        const courseResponse = await fetch(courseBase, {
            method: 'POST', headers: { Authorization: 'Bearer student', 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: '  Data Systems  ', description: 'A course' })
        });
        assert.equal(courseResponse.status, 201);
        assert.deepEqual((await courseResponse.json()).submission.submissionData, { title: 'Data Systems', description: 'A course' });
        const invalidCourse = await fetch(courseBase, {
            method: 'POST', headers: { Authorization: 'Bearer student', 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: ' ' })
        });
        assert.equal(invalidCourse.status, 400);

        async function send({ token = 'student', filename = 'resource.pdf', bytes = pdf, courseId = 'COURSE-1', conceptId = '11', includeFile = true, title = 'Learning notes', includeKey = true } = {}) {
            const body = new FormData();
            if (courseId !== null) body.append('courseId', courseId);
            if (conceptId !== null) body.append('conceptId', conceptId);
            if (title !== undefined) body.append('title', title);
            if (includeFile) body.append('document', new Blob([bytes]), filename);
            const headers = token ? { Authorization: `Bearer ${token}` } : {};
            if (includeKey) headers['Idempotency-Key'] = `44444444-4444-4444-8444-${String(++requestKey).padStart(12, '0')}`;
            return fetch(base, { method: 'POST', headers, body });
        }

        for (const [filename, bytes] of [['file.pdf', pdf], ['slides.pptx', zip], ['slides.ppt', ole], ['notes.docx', zip], ['notes.doc', ole]]) {
            const response = await send({ filename, bytes });
            assert.equal(response.status, 201, filename);
            const payload = await response.json();
            assert.equal(payload.submission.submissionData.document.originalName, filename);
            assert.ok(payload.submission.submissionData.document.documentId > 0);
            if (['.doc', '.ppt'].includes(path.extname(filename))) {
                assert.equal(payload.processingStatus, 'failed');
                assert.match(payload.message, /will not be available in the Study Workspace/);
            } else {
                assert.equal(payload.processingStatus, 'processed');
                assert.match(payload.message, /submitted for administrator review/i);
            }
            assert.equal(payload.submission.submissionData.conceptId, 11);
            assert.equal(payload.submission.submissionData.courseId, 'COURSE-1');
            await fs.rm(path.join(uploadFolder, payload.submission.submissionData.document.filename), { force: true });
        }

        assert.equal((await send({ filename: 'script.exe' })).status, 400);
        assert.equal((await send({ includeKey: false })).status, 400);
        assert.equal((await send({ filename: 'fake.pdf', bytes: Buffer.from('not PDF') })).status, 400);
        assert.equal((await send({ includeFile: false })).status, 400);
        assert.equal((await send({ conceptId: null })).status, 400);
        assert.equal((await send({ conceptId: '999' })).status, 422);
        assert.equal((await send({ courseId: 'COURSE-OTHER', conceptId: '11' })).status, 422);
        assert.equal((await send({ token: 'admin' })).status, 403);
        assert.equal((await send({ token: null })).status, 401);
        assert.ok(resourceCalls.every(call => call.learnerId === 7));
        assert.ok(resourceCalls.every(call => call.courseId === 'COURSE-1' && Number(call.conceptId) === 11));
        assert.ok(resourceCalls.every(call => call.document.filePath.replace(/\\/g, '/').startsWith('storage/resource-submissions/')));
        const prerequisiteResponse = await fetch(`${base.replace('/resources', '/prerequisites')}`, {
            method: 'POST', headers: { Authorization: 'Bearer student', 'Content-Type': 'application/json' },
            body: JSON.stringify({ prerequisiteId: 1, targetId: 2 })
        });
        assert.equal(prerequisiteResponse.status, 410);

        const sharedFilename = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf';
        const sharedPath = path.join(uploadFolder, sharedFilename);
        await fs.writeFile(sharedPath, pdf);
        documentAccessFixture = {
            submitted_by: 9,
            submission_data: JSON.stringify({ document: { filename: sharedFilename, originalName: 'shared notes.pdf' } }),
            status: 'approved', processing_status: 'processed', shared_resource: 1
        };
        const sharedDownload = await fetch(`${base}/55/document`, { headers: { Authorization: 'Bearer student' } });
        assert.equal(sharedDownload.status, 200, 'another authenticated learner may access an approved processed shared document');
        assert.deepEqual(Buffer.from(await sharedDownload.arrayBuffer()), pdf);
        documentAccessFixture = { ...documentAccessFixture, status: 'pending' };
        const pendingDownload = await fetch(`${base}/55/document`, { headers: { Authorization: 'Bearer student' } });
        assert.equal(pendingDownload.status, 403, 'pending resources remain private to their uploader and administrators');
        await fs.rm(sharedPath, { force: true });

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
