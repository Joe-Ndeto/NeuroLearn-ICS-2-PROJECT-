
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

    const captured = {
        attempt: null,
        submit: null,
        history: null,
        prompt: ''
    };

    let failCreate = false;
    let documentMatchesConcept = true;
    let processedTextMatchesConcept = true;
    let failGeneration = false;

    const processedTextCalls = [];

    let generatedQuestions = [
        {
            question: 'Q1',
            options: ['A', 'B', 'C', 'D'],
            correctAnswer: 'A',
            explanation: 'A is right',
            conceptId: 11
        },
        {
            question: 'Q2',
            options: ['A', 'B', 'C', 'D'],
            correctAnswer: 'B',
            explanation: 'B is right',
            conceptId: 11
        }
    ];

    const courseId = 'COURSE-11111111-1111-4111-8111-111111111111';
    const otherCourseId = 'COURSE-22222222-2222-4222-8222-222222222222';

    let courseConcepts = [
        {
            concept_id: 11,
            concept_name: 'Joins',
            description: '',
            graph_concept_id: 'CONCEPT-11'
        }
    ];

    let availableCourses = [
        {
            course_id: courseId,
            name: 'Database Concepts'
        },
        {
            course_id: otherCourseId,
            name: 'Other Course'
        }
    ];

    const fakeMysql = {
        async execute(sql, params) {
            if (
                sql.startsWith('SELECT 1') &&
                sql.includes('FROM uploaded_document AS ud') &&
                sql.includes('INNER JOIN knowledge_submissions AS s')
            ) {
                return documentMatchesConcept
                    ? [[{ 1: 1 }]]
                    : [[]];
            }

            if (
                sql.includes('ud.file_path') &&
                sql.includes('FROM uploaded_document AS ud')
            ) {
                processedTextCalls.push({
                    sql,
                    params
                });

                return processedTextMatchesConcept
                    ? [[{
                        document_id: 21,
                        filename: 'notes.pdf',
                        file_path: 'notes.pdf',
                        processing_status: 'processed'
                    }]]
                    : [[]];
            }

            if (
                sql.includes('FROM concept AS c') &&
                sql.includes('concept_course')
            ) {
                assert.deepEqual(params, [courseId, 11]);

                return [structuredClone(courseConcepts)];
            }

            throw new Error(`Unexpected route test SQL: ${sql}`);
        }
    };

    class FakeGoogleGenAI {
        constructor() {
            this.models = {
                generateContent: async request => {
                    if (failGeneration) {
                        const error = new Error(
                            'GEMINI_SECRET_SENTINEL PRIVATE_LECTURE_SENTINEL'
                        );

                        error.status = 429;
                        error.code = 'RESOURCE_EXHAUSTED';

                        throw error;
                    }

                    captured.prompt = request.contents;

                    return {
                        text: JSON.stringify({
                            questions: generatedQuestions
                        })
                    };
                }
            };
        }
    }

    Object.defineProperty(process, 'env', {
        ...environmentDescriptor,
        value: {
            GEMINI_API_KEY: 'test-only-key'
        }
    });

    Module._load = function (request, parent, isMain) {
        if (
            parent?.filename === routePath &&
            request === '@google/genai'
        ) {
            return {
                GoogleGenAI: FakeGoogleGenAI
            };
        }

        if (
            parent?.filename === routePath &&
            request === '../config/mysql'
        ) {
            return fakeMysql;
        }

        if (
            parent?.filename === routePath &&
            request === '../middleware/authenticateToken'
        ) {
            return (req, res, next) => {
                req.user = {
                    learner_id: 7
                };

                next();
            };
        }

        if (
            parent?.filename === routePath &&
            request === '../services/knowledgeGraphService'
        ) {
            return {
                async getAllCourses() {
                    return availableCourses;
                }
            };
        }

        if (
            parent?.filename === routePath &&
            request === '../services/quizAttemptService'
        ) {
            return {
                async createAttempt(data) {
                    if (failCreate) {
                        const error = new Error(
                            'database unavailable'
                        );

                        error.status = 503;

                        throw error;
                    }

                    captured.attempt = data;
                },

                async getHistory(data) {
                    captured.history = data;

                    return [{
                        quizId: '9f7b2ab2-61f9-4f20-b8be-5d013caaf332',
                        documentId: 21,
                        assessmentId: 91,
                        overallScore: 100,
                        correctCount: 2,
                        totalQuestions: 2,
                        submittedAt: new Date('2026-11-24T10:00:00Z'),
                        conceptResults: [],
                        review: []
                    }];
                },
                async submitAttempt(data) {
                    captured.submit = data;

                    if (data.quizId === 'expired') {
                        return {
                            status: 'expired'
                        };
                    }

                    if (
                        data.answers[0]?.selectedAnswer === 'bad'
                    ) {
                        const error = new Error('not an option');

                        error.status = 400;
                        error.code = 'INVALID_ANSWER_OPTION';

                        throw error;
                    }

                    return {
                        status: 'replayed',
                        response: {
                            assessmentId: 91,
                            message: 'Quiz results saved successfully.'
                        }
                    };
                }
            };
        }

        // Mock concept access so this route test remains isolated
        // from the real recommendation service and database.
        if (
            parent?.filename === routePath &&
            request === '../services/conceptAccessService'
        ) {
            class FakeConceptAccessError extends Error { }

            return {
                ConceptAccessError: FakeConceptAccessError,

                createConceptAccessService() {
                    return {
                        async getConceptAccessForLearner({
                            learnerId,
                            courseId,
                            conceptId
                        }) {
                            assert.equal(learnerId, 7);
                            assert.equal(typeof courseId, 'string');

                            assert.ok(
                                Number.isSafeInteger(Number(conceptId))
                            );

                            return {
                                accessible: true,
                                status: 'UNLOCKED',
                                message: 'This concept is available for learning.',
                                conceptId: Number(conceptId),
                                courseId
                            };
                        }
                    };
                }
            };
        }

        if (
            parent?.filename === routePath &&
            request === 'fs/promises'
        ) {
            return {
                readFile: async () => 'Database notes',
                readdir: async () => []
            };
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

        await new Promise(resolve =>
            server.listen(0, '127.0.0.1', resolve)
        );

        const base =
            `http://127.0.0.1:${server.address().port}/api/ai`;

        // 1. Generate quiz

        const generated = await fetch(`${base}/quiz`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: 21,
                questionCount: 2,
                courseId,
                conceptId: 11
            })
        });

        assert.equal(generated.status, 200);

        const quiz = await generated.json();

        assert.ok(quiz.quizId);
        assert.equal(captured.attempt.learnerId, 7);
        assert.equal(captured.attempt.documentId, 21);
        assert.equal(captured.attempt.questions[0].correctAnswer, 'A');
        assert.equal(captured.attempt.questions.length, 2);

        assert.match(captured.prompt, /Joins/);
        assert.doesNotMatch(captured.prompt, /unrelated concept/i);

        assert.equal(quiz.questions.length, 2);

        assert.equal(
            Object.hasOwn(quiz.questions[0], 'correctAnswer'),
            false
        );

        assert.equal(
            Object.hasOwn(quiz.questions[0], 'explanation'),
            false
        );

        // 2. Summarize document

        const summary = await fetch(`${base}/summarize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: 21,
                courseId,
                conceptId: 11
            })
        });

        assert.equal(summary.status, 200);

        assert.deepEqual(
            processedTextCalls.at(-1).params,
            [21, 7, 1, courseId, 1, 11, 1, courseId, 11]
        );

        // 3. Chat with document

        const chat = await fetch(`${base}/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: 21,
                courseId,
                conceptId: 11,
                message: 'Explain joins.'
            })
        });

        assert.equal(chat.status, 200);

        assert.deepEqual(
            processedTextCalls.at(-1).params,
            [21, 7, 1, courseId, 1, 11, 1, courseId, 11]
        );

        // 4. Reject document belonging to another concept

        processedTextMatchesConcept = false;

        const wrongConceptSummary = await fetch(
            `${base}/summarize`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    documentId: 21,
                    courseId,
                    conceptId: 12
                })
            }
        );

        assert.equal(wrongConceptSummary.status, 404);

        processedTextMatchesConcept = true;

        // 5. Gemini provider failure

        failGeneration = true;

        const loggedErrors = [];
        const originalConsoleError = console.error;

        console.error = (...args) => loggedErrors.push(args);

        let providerFailure;

        try {
            providerFailure = await fetch(`${base}/summarize`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    documentId: 21,
                    courseId,
                    conceptId: 11
                })
            });
        } finally {
            console.error = originalConsoleError;
            failGeneration = false;
        }

        assert.equal(providerFailure.status, 502);

        const providerFailureBody = await providerFailure.text();

        assert.doesNotMatch(
            providerFailureBody,
            /GEMINI_SECRET_SENTINEL|PRIVATE_LECTURE_SENTINEL/
        );

        assert.doesNotMatch(
            JSON.stringify(loggedErrors),
            /GEMINI_SECRET_SENTINEL|PRIVATE_LECTURE_SENTINEL/
        );

        // 6. Attempt persistence failure

        failCreate = true;

        const notPersisted = await fetch(`${base}/quiz`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: 21,
                questionCount: 2,
                courseId,
                conceptId: 11
            })
        });

        assert.equal(notPersisted.status, 503);

        assert.equal(
            Object.hasOwn(await notPersisted.json(), 'quizId'),
            false
        );

        failCreate = false;

        // 7. Missing course

        const beforeMissingCourse = captured.attempt;

        const missingCourse = await fetch(`${base}/quiz`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: 21,
                questionCount: 2
            })
        });

        assert.equal(missingCourse.status, 400);
        assert.equal(captured.attempt, beforeMissingCourse);

        // 8. Missing concept

        const missingConcept = await fetch(`${base}/quiz`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: 21,
                questionCount: 2,
                courseId
            })
        });

        assert.equal(missingConcept.status, 400);

        assert.equal(
            (await missingConcept.json()).code,
            'CONCEPT_REQUIRED'
        );

        // 9. Wrong document concept

        documentMatchesConcept = false;

        const wrongDocumentConcept = await fetch(`${base}/quiz`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: 21,
                questionCount: 2,
                courseId,
                conceptId: 12
            })
        });

        assert.equal(wrongDocumentConcept.status, 404);

        assert.equal(
            (await wrongDocumentConcept.json()).code,
            'DOCUMENT_CONCEPT_UNAVAILABLE'
        );

        assert.equal(captured.attempt, beforeMissingCourse);

        documentMatchesConcept = true;

        // 10. Unknown course

        const unknownCourse = await fetch(`${base}/quiz`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: 21,
                questionCount: 2,
                courseId: 'COURSE-33333333-3333-4333-8333-333333333333',
                conceptId: 11
            })
        });

        assert.equal(unknownCourse.status, 404);
        assert.equal(captured.attempt, beforeMissingCourse);

        // 11. Course without canonical concepts

        courseConcepts = [];

        const noCanonicalConcepts = await fetch(`${base}/quiz`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: 21,
                questionCount: 2,
                courseId,
                conceptId: 11
            })
        });

        assert.equal(noCanonicalConcepts.status, 409);

        assert.equal(
            (await noCanonicalConcepts.json()).code,
            'COURSE_HAS_NO_CONCEPTS'
        );

        assert.equal(captured.attempt, beforeMissingCourse);

        courseConcepts = [
            {
                concept_id: 11,
                concept_name: 'Joins',
                description: '',
                graph_concept_id: 'CONCEPT-11'
            }
        ];

        // 12. Reject unrelated generated concept mapping

        generatedQuestions = generatedQuestions.map(question => ({
            ...question,
            conceptId: 99
        }));

        const unrelatedMapping = await fetch(`${base}/quiz`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: 21,
                questionCount: 2,
                courseId,
                conceptId: 11
            })
        });

        assert.equal(unrelatedMapping.status, 502);

        assert.equal(
            (await unrelatedMapping.json()).error,
            'The generated quiz did not match the selected course. Please try again.'
        );

        assert.equal(
            captured.attempt,
            beforeMissingCourse,
            'invalid generated concept mapping is never persisted'
        );

        generatedQuestions = [
            {
                question: 'Q1',
                options: ['A', 'B', 'C', 'D'],
                correctAnswer: 'A',
                explanation: 'A is right',
                conceptId: 11
            },
            {
                question: 'Q2',
                options: ['A', 'B', 'C', 'D'],
                correctAnswer: 'B',
                explanation: 'B is right',
                conceptId: 11
            }
        ];

        // Quiz history is scoped to the authenticated learner.
        const historyResponse = await fetch(`${base}/quiz/history`);

        assert.equal(historyResponse.status, 200);

        const historyBody = await historyResponse.json();

        assert.equal(historyBody.success, true);
        assert.equal(historyBody.history.length, 1);
        assert.equal(historyBody.history[0].overallScore, 100);
        assert.equal(captured.history.learnerId, 7);

        // 13. Replay-safe quiz submission

        const body = {
            quizId: quiz.quizId,
            answers: [
                {
                    questionIndex: 0,
                    selectedAnswer: 'A'
                },
                {
                    questionIndex: 1,
                    selectedAnswer: 'B'
                }
            ]
        };

        const replay = await fetch(`${base}/quiz/submit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        assert.equal(replay.status, 200);

        assert.equal(
            (await replay.json()).assessmentId,
            91
        );

        assert.equal(captured.submit.learnerId, 7);
        assert.equal(captured.submit.quizId, quiz.quizId);

        // 14. Expired attempt

        const expired = await fetch(`${base}/quiz/submit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                quizId: 'expired',
                answers: body.answers
            })
        });

        assert.equal(expired.status, 410);

        assert.equal(
            (await expired.json()).code,
            'QUIZ_ATTEMPT_EXPIRED'
        );

        // 15. Invalid answer option

        const failed = await fetch(`${base}/quiz/submit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ...body,
                answers: [
                    {
                        questionIndex: 0,
                        selectedAnswer: 'bad'
                    }
                ]
            })
        });

        assert.equal(failed.status, 400);

        assert.equal(
            (await failed.json()).code,
            'INVALID_ANSWER_OPTION'
        );

    } finally {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }

        Module._load = originalLoad;

        delete require.cache[routePath];

        Object.defineProperty(
            process,
            'env',
            environmentDescriptor
        );
    }
});
