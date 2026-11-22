'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

test('resource submission transaction links the original uploaded document without a duplicate file record', async () => {
    const servicePath = require.resolve('../src/services/knowledgeSubmissionService');
    const originalLoad = Module._load;
    const calls = [];
    let commits = 0;
    let releases = 0;
    const connection = {
        async beginTransaction() { calls.push(['BEGIN']); },
        async execute(sql, params) {
            calls.push([sql, params]);
            if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
            if (sql.includes('JSON_EXTRACT(')) return [[]];
            if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
            if (sql.includes('INSERT INTO uploaded_document')) return [{ insertId: 71 }];
            if (sql.includes('INSERT INTO knowledge_submissions')) return [{ insertId: 92 }];
            throw new Error('Unexpected SQL');
        },
        async commit() { commits += 1; },
        async rollback() { throw new Error('unexpected rollback'); },
        release() { releases += 1; },
        destroy() { throw new Error('unexpected destroy'); }
    };
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === servicePath && request === '../config/mysql') {
            return { execute: async () => [[]], getConnection: async () => connection };
        }
        if (parent?.filename === servicePath && request === './knowledgeGraphService') {
            return { CourseValidationError: Error, validateCourseIds: async () => [], getAllCourses: async () => [] };
        }
        if (parent?.filename === servicePath && request === './knowledgeCanonicalRecord') {
            return { CanonicalRecordValidationError: Error, loadCanonicalRecord: async () => ({}) };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[servicePath];
    try {
        const service = require(servicePath);
        const result = await service.createPendingResourceSubmission({
            learnerId: 7,
            title: 'SQL notes',
            courseId: 'COURSE-1',
            conceptId: 11,
            idempotencyKey: '11111111-1111-4111-8111-111111111111',
            fingerprint: 'a'.repeat(64),
            document: {
                filename: 'a-safe-uuid.pdf', originalName: 'notes.pdf', extension: '.pdf',
                documentType: 'PDF', size: 123, filePath: 'storage/resource-submissions/a-safe-uuid.pdf',
                processingStatus: 'processed'
            }
        });
        assert.equal(result.submission.submissionId, 92);
        assert.equal(result.processingStatus, 'processed');
        assert.equal(commits, 1);
        assert.equal(releases, 1);
        const documentInsert = calls.find(([sql]) => sql.includes('INSERT INTO uploaded_document'));
        assert.deepEqual(documentInsert[1], [7, 'notes.pdf', 'pdf', 123, 'storage/resource-submissions/a-safe-uuid.pdf', 'processed']);
        const submissionInsert = calls.find(([sql]) => sql.includes('INSERT INTO knowledge_submissions'));
        const stored = JSON.parse(submissionInsert[1][0]);
        assert.equal(stored.document.documentId, 71);
        assert.equal(stored.document.filename, 'a-safe-uuid.pdf');
        assert.equal(stored.title, 'SQL notes');
        assert.equal(stored.courseId, 'COURSE-1');
        assert.equal(stored.conceptId, 11);
        assert.equal(calls.filter(([sql]) => sql.includes('INSERT INTO uploaded_document')).length, 1);
        assert.match(calls.find(([sql]) => sql.includes('GET_LOCK'))[0], /GET_LOCK/);
        assert.ok(calls.some(([sql]) => sql.includes('RELEASE_LOCK')));
    } finally {
        Module._load = originalLoad;
        delete require.cache[servicePath];
    }
});

test('resource retry with the same key replays the existing submission and rejects changed payloads', async t => {
    const servicePath = require.resolve('../src/services/knowledgeSubmissionService');
    const originalLoad = Module._load;
    const key = '22222222-2222-4222-8222-222222222222';
    const fingerprint = 'b'.repeat(64);
    let inserts = 0;
    let releases = 0;
    const row = {
        submission_id: 93,
        submission_type: 'RESOURCE',
        submission_data: JSON.stringify({
            title: 'Existing notes', type: 'document',
            document: { documentId: 72, filename: 'safe.pdf', originalName: 'notes.pdf' },
            _idempotency: { key, fingerprint }
        }),
        status: 'pending', submitted_at: 'now', reviewed_by: null,
        review_notes: null, reviewed_at: null
    };
    const connection = {
        async beginTransaction() { throw new Error('retry should not start a transaction'); },
        async execute(sql) {
            if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
            if (sql.includes('JSON_EXTRACT(')) return [[row]];
            if (sql.includes('INSERT INTO')) inserts += 1;
            if (sql.includes('RELEASE_LOCK')) { releases += 1; return [[{ released: 1 }]]; }
            throw new Error('Unexpected SQL');
        },
        release() {}, destroy() {}
    };
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === servicePath && request === '../config/mysql') return { execute: async () => [[]], getConnection: async () => connection };
        if (parent?.filename === servicePath && request === './knowledgeGraphService') return { CourseValidationError: Error, validateCourseIds: async () => [], getAllCourses: async () => [] };
        if (parent?.filename === servicePath && request === './knowledgeCanonicalRecord') return { CanonicalRecordValidationError: Error, loadCanonicalRecord: async () => ({}) };
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[servicePath];
    try {
        const service = require(servicePath);
        const args = { learnerId: 7, title: 'Existing notes', courseId: 'COURSE-1', conceptId: 11, idempotencyKey: key, fingerprint,
            document: { filename: 'another-temp.pdf', originalName: 'notes.pdf', extension: '.pdf', documentType: 'PDF', size: 123, filePath: 'storage/temp.pdf', processingStatus: 'processed' } };
        const replay = await service.createPendingResourceSubmission(args);
        assert.equal(replay.replayed, true);
        assert.equal(replay.submission.submissionId, 93);
        assert.equal(replay.submission.submissionData.document.documentId, 72);
        assert.equal(Object.hasOwn(replay.submission.submissionData, '_idempotency'), false);
        assert.equal(inserts, 0);
        assert.equal(releases, 1);

        await t.test('the same key cannot be reused for different content', async () => {
            releases = 0;
            await assert.rejects(
                service.createPendingResourceSubmission({ ...args, fingerprint: 'c'.repeat(64) }),
                error => error.code === 'IDEMPOTENCY_KEY_REUSED' && error.status === 409
            );
            assert.equal(inserts, 0);
            assert.equal(releases, 1);
        });
    } finally {
        Module._load = originalLoad;
        delete require.cache[servicePath];
    }
});

test('concurrent resource retries serialize on the same key and create one document and submission', async () => {
    const servicePath = require.resolve('../src/services/knowledgeSubmissionService');
    const originalLoad = Module._load;
    const key = '55555555-5555-4555-8555-555555555555';
    const fingerprint = 'd'.repeat(64);
    let lockHeld = false;
    let wakeWaiter;
    let documentId = 70;
    let submissionId = 90;
    let savedRow = null;
    let documentInserts = 0;
    let submissionInserts = 0;

    function makeConnection() {
        let ownsLock = false;
        let pendingDocumentId;
        return {
            async beginTransaction() {},
            async execute(sql, params) {
                if (sql.includes('GET_LOCK')) {
                    while (lockHeld) await new Promise(resolve => { wakeWaiter = resolve; });
                    lockHeld = true;
                    ownsLock = true;
                    return [[{ acquired: 1 }]];
                }
                if (sql.includes('JSON_EXTRACT(')) return [[...(savedRow ? [savedRow] : [])]];
                if (sql.includes('INSERT INTO uploaded_document')) {
                    documentInserts += 1;
                    pendingDocumentId = ++documentId;
                    return [{ insertId: pendingDocumentId }];
                }
                if (sql.includes('INSERT INTO knowledge_submissions')) {
                    submissionInserts += 1;
                    const data = JSON.parse(params[0]);
                    savedRow = {
                        submission_id: ++submissionId, submission_type: 'RESOURCE',
                        submission_data: params[0], status: 'pending', submitted_at: 'now',
                        reviewed_by: null, review_notes: null, reviewed_at: null,
                        document_processing_status: 'processed'
                    };
                    assert.equal(data.document.documentId, pendingDocumentId);
                    return [{ insertId: submissionId }];
                }
                if (sql.includes('RELEASE_LOCK')) {
                    assert.equal(ownsLock, true);
                    ownsLock = false;
                    lockHeld = false;
                    const wake = wakeWaiter;
                    wakeWaiter = null;
                    wake?.();
                    return [[{ released: 1 }]];
                }
                throw new Error('Unexpected SQL');
            },
            async commit() {},
            async rollback() {},
            release() {},
            destroy() {}
        };
    }

    Module._load = function(request, parent, isMain) {
        if (parent?.filename === servicePath && request === '../config/mysql') return { execute: async () => [[]], getConnection: async () => makeConnection() };
        if (parent?.filename === servicePath && request === './knowledgeGraphService') return { CourseValidationError: Error, validateCourseIds: async () => [], getAllCourses: async () => [] };
        if (parent?.filename === servicePath && request === './knowledgeCanonicalRecord') return { CanonicalRecordValidationError: Error, loadCanonicalRecord: async () => ({}) };
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[servicePath];
    try {
        const service = require(servicePath);
        const base = { learnerId: 7, title: 'Repeated notes', courseId: 'COURSE-1', conceptId: 11, idempotencyKey: key, fingerprint,
            document: { originalName: 'notes.pdf', extension: '.pdf', size: 100, processingStatus: 'processed', documentType: 'PDF' } };
        const [first, second] = await Promise.all([
            service.createPendingResourceSubmission({ ...base, document: { ...base.document, filename: 'first.pdf', filePath: 'storage/first.pdf' } }),
            service.createPendingResourceSubmission({ ...base, document: { ...base.document, filename: 'second.pdf', filePath: 'storage/second.pdf' } })
        ]);
        assert.equal(documentInserts, 1);
        assert.equal(submissionInserts, 1);
        assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);
        assert.equal(first.submission.submissionId, second.submission.submissionId);
    } finally {
        Module._load = originalLoad;
        delete require.cache[servicePath];
    }
});
