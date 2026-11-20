'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createQuizAttemptService, canonicalizeAnswers } = require('../src/services/quizAttemptService');

const QUIZ_ID = '9f7b2ab2-61f9-4f20-b8be-5d013caaf332';
const QUESTIONS = [
    { question: 'Q1', options: ['A', 'B'], correctAnswer: 'A', explanation: 'A', conceptId: 11, conceptName: 'C1' },
    { question: 'Q2', options: ['C', 'D'], correctAnswer: 'D', explanation: 'D', conceptId: 11, conceptName: 'C1' },
    { question: 'Q3', options: ['E', 'F'], correctAnswer: 'E', explanation: 'E', conceptId: 12, conceptName: 'C2' }
];
const ANSWERS = [
    { questionIndex: 0, selectedAnswer: 'A' },
    { questionIndex: 1, selectedAnswer: 'C' },
    { questionIndex: 2, selectedAnswer: 'E' }
];

function makeDb() {
    const data = {
        attempts: new Map(), assessments: [], results: [], learningPath: new Map(), recommendations: [],
        learners: new Set([7, 8]), concepts: new Set([11, 12]), nextAssessmentId: 1,
        failSql: null, failRollback: false, commitFailure: null, sqlSeen: [],
        executedByConnection: new Map(), connectionCount: 0, getConnectionCalls: 0,
        failConnectionCall: null, failReconcileQuery: false, destroyedConnections: 0,
        releasedConnections: 0, forcedAttemptUpdateRows: null
    };
    let tail = Promise.resolve();
    const clone = value => structuredClone(value);
    const copyState = source => ({
        attempts: clone(source.attempts), assessments: clone(source.assessments), results: clone(source.results),
        learningPath: clone(source.learningPath), recommendations: clone(source.recommendations),
        learners: clone(source.learners), concepts: clone(source.concepts), nextAssessmentId: source.nextAssessmentId
    });
    function connect() {
        const connectionId = ++data.connectionCount;
        let tx = null;
        let releaseLock = null;
        let released = false;
        const connection = {
            async beginTransaction() {
                let unlock;
                const previous = tail;
                tail = new Promise(resolve => { unlock = resolve; });
                await previous;
                releaseLock = unlock;
                tx = copyState(data);
            },
            async execute(sql, params = []) {
                const normalized = sql.replace(/\s+/g, ' ').trim();
                data.sqlSeen.push(normalized);
                if (!data.executedByConnection.has(connectionId)) data.executedByConnection.set(connectionId, []);
                data.executedByConnection.get(connectionId).push(normalized);
                if (data.failReconcileQuery && normalized.startsWith('SELECT learner_id, status, answers_hash')) {
                    data.failReconcileQuery = false;
                    throw new Error('simulated reconciliation query failure');
                }
                if (data.failSql && sql.includes(data.failSql)) {
                    data.failSql = null;
                    throw new Error('simulated statement failure');
                }
                const state = tx || data;
                if (normalized.startsWith('SELECT quiz_id, learner_id, document_id')) {
                    const attempt = state.attempts.get(params[0]);
                    return [attempt ? [clone(attempt)] : []];
                }
                if (normalized.startsWith('SELECT learner_id, status, answers_hash')) {
                    const attempt = state.attempts.get(params[0]);
                    return [attempt ? [clone(attempt)] : []];
                }
                if (normalized.startsWith('SELECT learner_id FROM learner')) {
                    return [[...(state.learners.has(Number(params[0])) ? [{ learner_id: Number(params[0]) }] : [])]];
                }
                if (normalized.startsWith('SELECT concept_id FROM concept')) {
                    return [[...new Set(params.map(Number))].filter(id => state.concepts.has(id)).map(concept_id => ({ concept_id }))];
                }
                if (normalized.startsWith('INSERT INTO assessment')) {
                    const [learner_id, overall_score, quiz_attempt_id] = params;
                    if (state.assessments.some(row => row.quiz_attempt_id === quiz_attempt_id)) {
                        const error = new Error('duplicate quiz attempt');
                        error.code = 'ER_DUP_ENTRY';
                        throw error;
                    }
                    const row = { assessment_id: state.nextAssessmentId++, learner_id, overall_score, quiz_attempt_id };
                    state.assessments.push(row);
                    return [{ insertId: row.assessment_id }];
                }
                if (normalized.startsWith('INSERT INTO quiz_result')) {
                    const [assessment_id, concept_id, score] = params;
                    state.results.push({ assessment_id, concept_id, score });
                    return [{ affectedRows: 1 }];
                }
                if (normalized.startsWith('INSERT INTO learning_path')) {
                    const [learner_id, concept_id, mastery_level] = params;
                    state.learningPath.set(`${learner_id}:${concept_id}`, { learner_id, concept_id, mastery_level });
                    return [{ affectedRows: 1 }];
                }
                if (normalized.startsWith('DELETE FROM recommendation')) {
                    const [, ...ids] = params;
                    state.recommendations = state.recommendations.filter(row => row.learner_id !== params[0] || !ids.includes(row.concept_id));
                    return [{ affectedRows: 1 }];
                }
                if (normalized.startsWith('INSERT INTO recommendation')) {
                    state.recommendations.push({ learner_id: params[0], concept_id: params[1] });
                    return [{ affectedRows: 1 }];
                }
                if (normalized.startsWith('UPDATE quiz_attempt')) {
                    if (normalized.includes("SET status = 'expired'")) {
                        const attempt = state.attempts.get(params[0]);
                        if (attempt?.status === 'open') attempt.status = 'expired';
                        return [{ affectedRows: attempt?.status === 'expired' ? 1 : 0 }];
                    }
                    const [answers_hash, response_json, quizId] = params;
                    const attempt = state.attempts.get(quizId);
                    if (data.forcedAttemptUpdateRows !== null) {
                        const affectedRows = data.forcedAttemptUpdateRows;
                        data.forcedAttemptUpdateRows = null;
                        return [{ affectedRows }];
                    }
                    if (attempt?.status === 'open') Object.assign(attempt, {
                        status: 'submitted', answers_hash, response_json, submitted_at: new Date()
                    });
                    return [{ affectedRows: attempt?.status === 'submitted' ? 1 : 0 }];
                }
                throw new Error(`Unexpected SQL in test fake: ${normalized}`);
            },
            async commit() {
                const failure = data.commitFailure;
                if (failure) {
                    data.commitFailure = null;
                    if (failure === 'before') tx = null;
                    else if (tx) Object.assign(data, tx);
                    tx = null;
                    releaseLock?.();
                    releaseLock = null;
                    if (failure === 'after') throw new Error('simulated lost commit acknowledgement');
                    throw new Error('simulated commit failure before commit');
                }
                if (tx) Object.assign(data, tx);
                tx = null;
                releaseLock?.();
                releaseLock = null;
            },
            async rollback() {
                if (data.failRollback) {
                    data.failRollback = false;
                    throw new Error('simulated rollback failure');
                }
                tx = null;
                releaseLock?.();
                releaseLock = null;
            },
            release() {
                if (released) return;
                released = true;
                data.releasedConnections++;
                releaseLock?.();
                releaseLock = null;
            },
            destroy() {
                tx = null;
                if (released) return;
                released = true;
                data.destroyedConnections++;
                releaseLock?.();
                releaseLock = null;
            }
        };
        return connection;
    }
    const db = {
        async execute(sql, params) {
            const [quizId, learnerId, documentId, questionsJson, expiresAt] = params;
            data.attempts.set(quizId, {
                quiz_id: quizId, learner_id: learnerId, document_id: documentId,
                questions_json: questionsJson, status: 'open', expires_at: expiresAt,
                answers_hash: null, response_json: null
            });
            return [{ affectedRows: 1 }];
        },
        async getConnection() {
            data.getConnectionCalls++;
            if (data.failConnectionCall === data.getConnectionCalls) {
                data.failConnectionCall = null;
                throw new Error('simulated connection acquisition failure');
            }
            return connect();
        }
    };
    return { db, data };
}

async function makeAttempt(service, { quizId = QUIZ_ID, learnerId = 7, expiresAt = new Date(Date.now() + 60_000), questions = QUESTIONS } = {}) {
    await service.createAttempt({ quizId, learnerId, documentId: 21, questions, expiresAt });
}

test('durably creates an attempt with private answer key and returns expiry metadata only to storage', async () => {
    const { db, data } = makeDb();
    const service = createQuizAttemptService({ db });
    const expiresAt = new Date(Date.now() + 60_000);
    await makeAttempt(service, { expiresAt });
    const row = data.attempts.get(QUIZ_ID);
    assert.equal(row.status, 'open');
    assert.equal(row.document_id, 21);
    assert.equal(JSON.parse(row.questions_json)[0].correctAnswer, 'A');
    assert.equal(row.expires_at, expiresAt);
});

test('successful submission stores one assessment and same-answer retry replays original response', async () => {
    const { db, data } = makeDb();
    const service = createQuizAttemptService({ db });
    await makeAttempt(service);
    const first = await service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS });
    const replay = await service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: [...ANSWERS].reverse() });
    assert.equal(first.status, 'created');
    assert.equal(replay.status, 'replayed');
    assert.deepEqual(replay.response, first.response);
    assert.equal(data.assessments.length, 1);
    assert.equal(data.results.length, 2);
    assert.equal(data.attempts.get(QUIZ_ID).status, 'submitted');
});

test('changed answers after successful submission conflict without replacing history', async () => {
    const { db, data } = makeDb();
    const service = createQuizAttemptService({ db });
    await makeAttempt(service);
    await service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS });
    await assert.rejects(
        service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS.map((answer, i) => i ? answer : { ...answer, selectedAnswer: 'B' }) }),
        error => error.status === 409
    );
    assert.equal(data.assessments.length, 1);
});

test('concurrent duplicate submissions create exactly one assessment and replay once', async () => {
    const { db, data } = makeDb();
    const service = createQuizAttemptService({ db });
    await makeAttempt(service);
    const results = await Promise.all([
        service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS }),
        service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS })
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), ['created', 'replayed']);
    assert.equal(data.assessments.length, 1);
    assert.equal(data.results.length, 2);
});

test('attempt ownership is enforced and invalid answer options are rejected', async t => {
    await t.test('different learner', async () => {
        const { db, data } = makeDb();
        const service = createQuizAttemptService({ db });
        await makeAttempt(service);
        await assert.rejects(service.submitAttempt({ quizId: QUIZ_ID, learnerId: 8, answers: ANSWERS }), error => error.status === 403);
        assert.equal(data.assessments.length, 0);
    });
    await t.test('not a declared option', async () => {
        const { db, data } = makeDb();
        const service = createQuizAttemptService({ db });
        await makeAttempt(service);
        const invalid = ANSWERS.map((answer, index) => index === 1 ? { ...answer, selectedAnswer: 'not an option' } : answer);
        await assert.rejects(service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: invalid }), error => error.status === 400 && error.code === 'INVALID_ANSWER_OPTION');
        assert.equal(data.assessments.length, 0);
    });
});

test('expired open attempts are marked expired; submitted attempts replay after expiry', async () => {
    const { db, data } = makeDb();
    let now = new Date('2026-01-01T00:00:00Z');
    const service = createQuizAttemptService({ db, now: () => now });
    await makeAttempt(service, { expiresAt: new Date('2026-01-01T00:01:00Z') });
    const first = await service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS });
    now = new Date('2026-01-01T00:02:00Z');
    const replay = await service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS });
    assert.equal(replay.status, 'replayed');
    assert.deepEqual(replay.response, first.response);
    assert.equal(data.assessments.length, 1);

    const secondId = 'a71a9d4b-7257-45a9-91d6-997a44ed7f62';
    await makeAttempt(service, { quizId: secondId, expiresAt: new Date('2026-01-01T00:01:00Z') });
    const expired = await service.submitAttempt({ quizId: secondId, learnerId: 7, answers: ANSWERS });
    assert.equal(expired.status, 'expired');
    assert.equal(data.attempts.get(secondId).status, 'expired');
});

test('concurrent expiry requests return expired without reconciliation or connection destruction', async () => {
    const { db, data } = makeDb();
    const now = new Date('2026-01-01T00:02:00Z');
    const service = createQuizAttemptService({ db, now: () => now });
    await makeAttempt(service, { expiresAt: new Date('2026-01-01T00:01:00Z') });
    const outcomes = await Promise.all([
        service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS }),
        service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS })
    ]);
    assert.deepEqual(outcomes.map(item => item.status), ['expired', 'expired']);
    assert.equal(data.attempts.get(QUIZ_ID).status, 'expired');
    assert.equal(data.getConnectionCalls, 2, 'no extra connection is acquired for reconciliation');
    assert.equal(data.sqlSeen.some(sql => sql.startsWith('SELECT learner_id, status, answers_hash')), false);
    assert.equal(data.destroyedConnections, 0);
    assert.equal(data.releasedConnections, 2);
});

test('transaction failure rolls back assessment, results, mastery, recommendations and attempt state', async () => {
    const { db, data } = makeDb();
    const service = createQuizAttemptService({ db });
    await makeAttempt(service);
    data.failSql = 'INSERT INTO quiz_result';
    await assert.rejects(service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS }));
    assert.equal(data.assessments.length, 0);
    assert.equal(data.results.length, 0);
    assert.equal(data.learningPath.size, 0);
    assert.equal(data.attempts.get(QUIZ_ID).status, 'open');
});

test('attempt completion update must affect exactly one row or all writes roll back', async () => {
    for (const affectedRows of [0, 2]) {
        const { db, data } = makeDb();
        const service = createQuizAttemptService({ db });
        await makeAttempt(service);
        data.forcedAttemptUpdateRows = affectedRows;
        await assert.rejects(
            service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS }),
            error => error.status === 409 && error.code === 'QUIZ_ATTEMPT_COMPLETION_FAILED'
        );
        assert.equal(data.assessments.length, 0);
        assert.equal(data.results.length, 0);
        assert.equal(data.learningPath.size, 0);
        assert.equal(data.attempts.get(QUIZ_ID).status, 'open');
        assert.equal(data.destroyedConnections, 0);
        assert.equal(data.releasedConnections, 1);
    }
});

test('rollback failure destroys the uncertain connection and preserves the original operation error', async t => {
    await t.test('ordinary operation failure', async () => {
        const { db, data } = makeDb();
        const service = createQuizAttemptService({ db });
        await makeAttempt(service);
        data.failSql = 'SELECT learner_id FROM learner';
        data.failRollback = true;
        await assert.rejects(
            service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS }),
            error => error.message === 'simulated statement failure'
        );
        assert.equal(data.destroyedConnections, 1);
        assert.equal(data.releasedConnections, 0);
        assert.deepEqual(data.executedByConnection.get(1).slice(-1), ['SELECT learner_id FROM learner WHERE learner_id = ? FOR UPDATE']);
        assert.equal(data.getConnectionCalls, 1, 'no reconciliation or further query uses the uncertain connection');
    });
    await t.test('replay rollback failure', async () => {
        const { db, data } = makeDb();
        const service = createQuizAttemptService({ db });
        await makeAttempt(service);
        await service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS });
        data.failRollback = true;
        await assert.rejects(
            service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS }),
            error => error.status === 503 && error.code === 'QUIZ_REPLAY_CLEANUP_FAILED'
        );
        assert.equal(data.destroyedConnections, 1);
        assert.equal(data.releasedConnections, 1, 'only the successful original transaction connection was released');
        assert.equal(data.getConnectionCalls, 2);
    });
});

test('uncertain commit reconciles committed work and does not duplicate it', async t => {
    await t.test('commit succeeded but acknowledgement was lost', async () => {
        const { db, data } = makeDb();
        const service = createQuizAttemptService({ db });
        await makeAttempt(service);
        data.commitFailure = 'after';
        const result = await service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS });
        assert.equal(result.status, 'replayed');
        assert.equal(data.assessments.length, 1);
    });
    await t.test('commit did not persist; caller can safely retry', async () => {
        const { db, data } = makeDb();
        const service = createQuizAttemptService({ db });
        await makeAttempt(service);
        data.commitFailure = 'before';
        await assert.rejects(service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS }), error => error.status === 503);
        assert.equal(data.assessments.length, 0);
        const retry = await service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS });
        assert.equal(retry.status, 'created');
        assert.equal(data.assessments.length, 1);
    });
    await t.test('reconciliation connection acquisition failure returns retryable 503', async () => {
        const { db, data } = makeDb();
        const service = createQuizAttemptService({ db });
        await makeAttempt(service);
        data.commitFailure = 'after';
        data.failConnectionCall = 2;
        await assert.rejects(
            service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS }),
            error => error.status === 503 && error.code === 'SUBMISSION_STATUS_UNAVAILABLE'
        );
        assert.equal(data.assessments.length, 1, 'the commit may have succeeded and is not blindly repeated');
    });
    await t.test('reconciliation query failure returns retryable 503', async () => {
        const { db, data } = makeDb();
        const service = createQuizAttemptService({ db });
        await makeAttempt(service);
        data.commitFailure = 'after';
        data.failReconcileQuery = true;
        await assert.rejects(
            service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS }),
            error => error.status === 503 && error.code === 'SUBMISSION_STATUS_UNAVAILABLE'
        );
        assert.equal(data.assessments.length, 1);
    });
});

test('malformed, missing, duplicate, and out-of-range question indexes are rejected', async t => {
    for (const [name, answers] of [
        ['malformed index', [{ questionIndex: '0', selectedAnswer: 'A' }, ...ANSWERS.slice(1)]],
        ['missing answer', ANSWERS.slice(0, 2)],
        ['duplicate index', [ANSWERS[0], ANSWERS[0], ANSWERS[2]]],
        ['out-of-range index', [ANSWERS[0], ANSWERS[1], { questionIndex: 3, selectedAnswer: 'E' }]]
    ]) {
        await t.test(name, async () => {
            const { db, data } = makeDb();
            const service = createQuizAttemptService({ db });
            await makeAttempt(service);
            await assert.rejects(service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers }), error => error.status === 400);
            assert.equal(data.assessments.length, 0);
        });
    }
});

test('answer hash ignores input answer ordering and object property order', () => {
    const first = canonicalizeAnswers([
        { questionIndex: 1, selectedAnswer: 'C' },
        { questionIndex: 0, selectedAnswer: 'A' }
    ]);
    const reordered = canonicalizeAnswers([
        { selectedAnswer: 'A', questionIndex: 0 },
        { selectedAnswer: 'C', questionIndex: 1 }
    ]);
    assert.equal(first.hash, reordered.hash);
});

test('different attempts by one learner serialize through a learner row lock', async () => {
    const { db, data } = makeDb();
    const service = createQuizAttemptService({ db });
    const secondId = 'a71a9d4b-7257-45a9-91d6-997a44ed7f62';
    await makeAttempt(service);
    await makeAttempt(service, { quizId: secondId });
    await Promise.all([
        service.submitAttempt({ quizId: QUIZ_ID, learnerId: 7, answers: ANSWERS }),
        service.submitAttempt({ quizId: secondId, learnerId: 7, answers: ANSWERS })
    ]);
    assert.equal(data.assessments.length, 2);
    assert.ok(data.sqlSeen.filter(sql => sql.includes('FROM learner WHERE learner_id = ? FOR UPDATE')).length >= 2);
});
