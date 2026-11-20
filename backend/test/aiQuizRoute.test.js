'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');
const express = require('express');

test('quiz routes persist generated attempts before responding and delegate replay-safe submission', async t => {
    const routePath = require.resolve('../src/routes/ai');
    const originalLoad = Module._load;
    const environmentDescriptor = Object.getOwnPropertyDescriptor(process, 'env');
    const captured = { attempt: null, submit: null };
    let failCreate = false;
    const questions = [
        { question: 'Q1', options: ['A', 'B', 'C', 'D'], correctAnswer: 'A', explanation: 'A is right', conceptId: 11 },
        { question: 'Q2', options: ['A', 'B', 'C', 'D'], correctAnswer: 'B', explanation: 'B is right', conceptId: 11 }
    ];
    const fakeMysql = {
        async execute(sql) {
            if (sql.includes('FROM uploaded_document')) return [[{
                document_id: 21, filename: 'notes.pdf', file_path: 'notes.pdf', processing_status: 'processed'
            }]];
            if (sql.includes('FROM concept')) return [[{ concept_id: 11, concept_name: 'Joins', description: '' }]];
            throw new Error(`Unexpected route test SQL: ${sql}`);
        }
    };
    class FakeGoogleGenAI {
        constructor() {
            this.models = { generateContent: async () => ({ text: JSON.stringify({ questions }) }) };
        }
    }

    Object.defineProperty(process, 'env', {
        ...environmentDescriptor,
        value: { GEMINI_API_KEY: 'test-only-key' }
    });
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === routePath && request === '@google/genai') return { GoogleGenAI: FakeGoogleGenAI };
        if (parent?.filename === routePath && request === '../config/mysql') return fakeMysql;
        if (parent?.filename === routePath && request === '../middleware/authenticateToken') {
            return (req, res, next) => { req.user = { learner_id: 7 }; next(); };
        }
        if (parent?.filename === routePath && request === '../services/quizAttemptService') {
            return {
                async createAttempt(data) {
                    if (failCreate) {
                        const error = new Error('database unavailable');
                        error.status = 503;
                        throw error;
                    }
                    captured.attempt = data;
                },
                async submitAttempt(data) {
                    captured.submit = data;
                    if (data.quizId === 'expired') return { status: 'expired' };
                    if (data.answers[0]?.selectedAnswer === 'bad') {
                        const error = new Error('not an option');
                        error.status = 400;
                        error.code = 'INVALID_ANSWER_OPTION';
                        throw error;
                    }
                    return {
                        status: 'replayed',
                        response: { assessmentId: 91, message: 'Quiz results saved successfully.' }
                    };
                }
            };
        }
        if (parent?.filename === routePath && request === 'fs/promises') {
            return { readFile: async () => 'Database notes', readdir: async () => [] };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[routePath];

    let server;
    try {
        const app = express();
        app.use(express.json());
        app.use('/api/ai', require(routePath));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}/api/ai`;

        const generated = await fetch(`${base}/quiz`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId: 21, questionCount: 2 })
        });
        assert.equal(generated.status, 200);
        const quiz = await generated.json();
        assert.ok(quiz.quizId);
        assert.equal(captured.attempt.learnerId, 7);
        assert.equal(captured.attempt.documentId, 21);
        assert.equal(captured.attempt.questions[0].correctAnswer, 'A');
        assert.equal(captured.attempt.questions.length, 2);
        assert.equal(quiz.questions.length, 2);
        assert.equal(Object.hasOwn(quiz.questions[0], 'correctAnswer'), false);
        assert.equal(Object.hasOwn(quiz.questions[0], 'explanation'), false);

        failCreate = true;
        const notPersisted = await fetch(`${base}/quiz`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId: 21, questionCount: 2 })
        });
        assert.equal(notPersisted.status, 503);
        assert.equal(Object.hasOwn(await notPersisted.json(), 'quizId'), false);
        failCreate = false;

        const body = {
            quizId: quiz.quizId,
            answers: [
                { questionIndex: 0, selectedAnswer: 'A' },
                { questionIndex: 1, selectedAnswer: 'B' }
            ]
        };
        const replay = await fetch(`${base}/quiz/submit`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        assert.equal(replay.status, 200);
        assert.equal((await replay.json()).assessmentId, 91);
        assert.equal(captured.submit.learnerId, 7);
        assert.equal(captured.submit.quizId, quiz.quizId);

        const expired = await fetch(`${base}/quiz/submit`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quizId: 'expired', answers: body.answers })
        });
        assert.equal(expired.status, 410);
        assert.equal((await expired.json()).code, 'QUIZ_ATTEMPT_EXPIRED');

        const failed = await fetch(`${base}/quiz/submit`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, answers: [{ questionIndex: 0, selectedAnswer: 'bad' }] })
        });
        assert.equal(failed.status, 400);
        assert.equal((await failed.json()).code, 'INVALID_ANSWER_OPTION');
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        Module._load = originalLoad;
        delete require.cache[routePath];
        Object.defineProperty(process, 'env', environmentDescriptor);
    }
});
