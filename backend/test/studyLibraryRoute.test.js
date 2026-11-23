'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');
const express = require('express');

test('study library returns learner documents and only approved processed course resources', async t => {
    const routePath = require.resolve('../src/routes/upload');
    const originalLoad = Module._load;
    const requests = [];
    const courseId = 'COURSE-11111111-1111-4111-8111-111111111111';
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === routePath && request === '../config/mysql') {
            return { async execute(sql, params) {
                requests.push({ sql, params });
                if (sql.includes('FROM uploaded_document AS ud')) return [[
                    { document_id: 10, filename: 'own.pdf', file_type: 'pdf', file_size: 12, processing_status: 'processed', resource_review_status: null },
                    { document_id: 11, filename: 'pending.pdf', file_type: 'pdf', file_size: 14, processing_status: 'processed', resource_review_status: 'pending' },
                    { document_id: 12, filename: 'broken.pdf', file_type: 'pdf', file_size: 16, processing_status: 'failed', resource_review_status: 'approved' }
                ]];
                if (sql.includes('FROM learning_resource AS lr')) return [[
                    { document_id: 13, filename: 'shared.pdf', file_type: 'pdf', file_size: 18, processing_status: 'processed', resource_id: 3, title: 'Approved notes', concept_id: 5, concept_name: 'SQL Fundamentals', course_graph_id: courseId }
                ]];
                throw new Error('Unexpected test query');
            } };
        }
        if (parent?.filename === routePath && request === '../middleware/authenticateToken') {
            return (req, res, next) => { req.user = { learner_id: 44, role: 'student' }; next(); };
        }
        if (parent?.filename === routePath && request === '../services/knowledgeGraphService') {
            return { async getAllCourses() { return [{ course_id: courseId, name: 'Database Concepts' }]; } };
        }
        if (parent?.filename === routePath && request === '../services/documentProcessingService') return { processDocument: async () => {} };
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[routePath];
    let server;
    try {
        const app = express();
        app.use('/api/upload', require(routePath));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/upload/library?courseId=${courseId}`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.course.courseId, courseId);
        assert.deepEqual(body.documents.map(item => item.documentId), [13, 10, 11, 12]);
        assert.equal(body.documents[0].scope, 'shared');
        assert.equal(body.documents[0].conceptName, 'SQL Fundamentals');
        assert.equal(body.documents[0].reviewStatus, 'approved');
        assert.equal(body.documents.find(item => item.documentId === 11).reviewStatus, 'pending');
        assert.equal(body.documents.find(item => item.documentId === 12).processingStatus, 'failed');
        assert.deepEqual(requests[0].params, [44]);
        assert.match(requests[1].sql, /s\.status = 'approved'/);
        assert.match(requests[1].sql, /ud\.processing_status = 'processed'/);
        assert.match(requests[1].sql, /INNER JOIN concept_course AS cc/);
        assert.match(requests[1].sql, /cc\.course_graph_id = \?/);
        assert.deepEqual(requests[1].params, [courseId]);
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        Module._load = originalLoad;
        delete require.cache[routePath];
    }
});

test('study library rejects a course that is not in the graph course list', async t => {
    const routePath = require.resolve('../src/routes/upload');
    const originalLoad = Module._load;
    let queries = 0;
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === routePath && request === '../config/mysql') return { async execute() { queries += 1; return [[]]; } };
        if (parent?.filename === routePath && request === '../middleware/authenticateToken') return (req, res, next) => { req.user = { learner_id: 44 }; next(); };
        if (parent?.filename === routePath && request === '../services/knowledgeGraphService') return { async getAllCourses() { return []; } };
        if (parent?.filename === routePath && request === '../services/documentProcessingService') return { processDocument: async () => {} };
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[routePath];
    let server;
    try {
        const app = express();
        app.use('/api/upload', require(routePath));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/upload/library?courseId=UNKNOWN`);
        assert.equal(response.status, 404);
        assert.equal(queries, 0);
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        Module._load = originalLoad;
        delete require.cache[routePath];
    }
});
