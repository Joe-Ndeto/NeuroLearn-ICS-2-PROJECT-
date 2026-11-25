'use strict';

const crypto = require('node:crypto');
const mysql = require('../config/mysql');
const { calculateMastery } = require('./masteryCalculator');

class QuizAttemptError extends Error {
    constructor(status, message, code) {
        super(message);
        this.name = 'QuizAttemptError';
        this.status = status;
        this.code = code;
    }
}

function parseJson(value) {
    if (typeof value === 'string') return JSON.parse(value);
    return value;
}

function canonicalizeAnswers(answers) {
    if (!Array.isArray(answers) || answers.length === 0) {
        throw new QuizAttemptError(400, 'Invalid quiz answers.', 'INVALID_ANSWERS');
    }
    const normalized = answers.map(answer => {
        if (!answer || !Number.isSafeInteger(answer.questionIndex) || answer.questionIndex < 0 ||
            typeof answer.selectedAnswer !== 'string') {
            throw new QuizAttemptError(400, 'One or more answers are invalid.', 'INVALID_ANSWERS');
        }
        return { questionIndex: answer.questionIndex, selectedAnswer: answer.selectedAnswer };
    }).sort((a, b) => a.questionIndex - b.questionIndex);
    if (normalized.some((answer, index) => index > 0 && answer.questionIndex === normalized[index - 1].questionIndex)) {
        throw new QuizAttemptError(400, 'Duplicate answers were submitted.', 'DUPLICATE_ANSWERS');
    }
    const hash = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    return { answers: normalized, hash };
}

function calculateConceptEvidence(group) {
    const mysqlUnsignedIntMax = 4294967295;
    if (!group || !Number.isSafeInteger(group.total) || group.total <= 0 ||
        group.total > mysqlUnsignedIntMax || !Number.isSafeInteger(group.correct) ||
        group.correct < 0 || group.correct > group.total || group.correct > mysqlUnsignedIntMax) {
        throw new Error('Quiz concept evidence counts are invalid.');
    }

    const score = Number(((group.correct / group.total) * 100).toFixed(2));
    return {
        questionCount: group.total,
        correctCount: group.correct,
        score
    };
}

function databaseInteger(value, fieldName) {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed)) return parsed;
    }
    throw new Error(`Database ${fieldName} is invalid.`);
}

function databaseScore(value) {
    const validNumericString = typeof value === 'string' && /^(?:\d+)(?:\.\d+)?$/.test(value);
    if (typeof value !== 'number' && !validNumericString) {
        throw new Error('Database assessment score is invalid.');
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        throw new Error('Database assessment score is invalid.');
    }
    return parsed;
}

function mapMasteryObservation(row) {
    if (!row || (row.timestampProvenance !== 'utc' && row.timestampProvenance !== 'unknown')) {
        throw new Error('Database assessment timestamp provenance is invalid.');
    }
    return {
        assessmentId: databaseInteger(row.assessmentId, 'assessment ID'),
        score: databaseScore(row.score),
        assessmentDate: row.assessmentDate,
        questionCount: row.questionCount === null ? null : databaseInteger(row.questionCount, 'question count'),
        correctCount: row.correctCount === null ? null : databaseInteger(row.correctCount, 'correct count'),
        timestampProvenance: row.timestampProvenance
    };
}

function createQuizAttemptService({ db = mysql, now = () => new Date() } = {}) {
    async function createAttempt({ quizId, learnerId, documentId, questions, expiresAt }) {
        await db.execute(
            `INSERT INTO quiz_attempt
                (quiz_id, learner_id, document_id, questions_json, status, expires_at)
             VALUES (?, ?, ?, ?, 'open', ?)`,
            [quizId, learnerId, documentId, JSON.stringify(questions), expiresAt]
        );
    }


async function getHistory({ learnerId }) {
    if (!Number.isSafeInteger(Number(learnerId)) || Number(learnerId) <= 0) {
        throw new QuizAttemptError(
            400,
            'A valid learner ID is required.',
            'INVALID_LEARNER_ID'
        );
    }

    const [rows] = await db.execute(
        `SELECT
            qa.quiz_id AS quizId,
            qa.document_id AS documentId,
            qa.submitted_at AS submittedAt,
            a.assessment_id AS assessmentId,
            a.overall_score AS overallScore,
            qa.response_json AS responseJson
         FROM quiz_attempt AS qa
         INNER JOIN assessment AS a
            ON a.quiz_attempt_id = qa.quiz_id
            AND a.learner_id = qa.learner_id
         WHERE qa.learner_id = ?
            AND qa.status = 'submitted'
         ORDER BY qa.submitted_at DESC, a.assessment_id DESC`,
        [Number(learnerId)]
    );

    return rows.map(row => {
        const response = parseJson(row.responseJson);

        return {
            quizId: row.quizId,
            documentId: row.documentId,
            submittedAt: row.submittedAt,
            assessmentId: row.assessmentId,
            overallScore: Number(row.overallScore),
            correctCount: response.correctCount,
            totalQuestions: response.totalQuestions,
            conceptResults: response.conceptResults || [],
            review: response.review || []
        };
    });
}


    async function reconcile(quizId, learnerId, answerHash) {
        let connection;
        try {
            connection = await db.getConnection();
            const [rows] = await connection.execute(
                `SELECT learner_id, status, answers_hash, response_json
                 FROM quiz_attempt WHERE quiz_id = ?`,
                [quizId]
            );
            const attempt = rows[0];
            if (!attempt || Number(attempt.learner_id) !== Number(learnerId)) return null;
            if (attempt.status === 'submitted' && attempt.answers_hash === answerHash) {
                return { status: 'replayed', response: parseJson(attempt.response_json) };
            }
            if (attempt.status === 'expired') return { status: 'expired' };
            return { status: 'open' };
        } catch {
            return { status: 'unavailable' };
        } finally {
            connection?.release();
        }
    }

    async function submitAttempt({ quizId, learnerId, answers }) {
        if (typeof quizId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(quizId)) {
            throw new QuizAttemptError(400, 'A valid quiz ID is required.', 'INVALID_QUIZ_ID');
        }
        const canonical = canonicalizeAnswers(answers);
        const connection = await db.getConnection();
        let transactionStarted = false;
        let commitAttempted = false;
        let connectionDisposed = false;

        const destroyConnection = () => {
            if (connectionDisposed) return;
            connectionDisposed = true;
            try {
                if (typeof connection.destroy === 'function') connection.destroy();
                else connection.release();
            } catch {
                // Do not replace the original transaction/application error.
            }
        };

        const rollbackTransaction = async () => {
            if (!transactionStarted) return true;
            try {
                await connection.rollback();
                transactionStarted = false;
                return true;
            } catch {
                transactionStarted = false;
                destroyConnection();
                return false;
            }
        };

        try {
            await connection.beginTransaction();
            transactionStarted = true;
            const [attemptRows] = await connection.execute(
                `SELECT quiz_id, learner_id, document_id, questions_json,
                        status, expires_at, answers_hash, response_json
                 FROM quiz_attempt WHERE quiz_id = ? FOR UPDATE`,
                [quizId]
            );
            const attempt = attemptRows[0];
            if (!attempt) throw new QuizAttemptError(410, 'This quiz attempt is unavailable or has expired.', 'QUIZ_ATTEMPT_UNAVAILABLE');
            if (Number(attempt.learner_id) !== Number(learnerId)) {
                throw new QuizAttemptError(403, 'You are not authorized to submit this quiz.', 'QUIZ_OWNERSHIP_REQUIRED');
            }

            if (attempt.status === 'submitted') {
                if (attempt.answers_hash !== canonical.hash) {
                    throw new QuizAttemptError(409, 'This quiz attempt was already submitted with different answers.', 'QUIZ_ALREADY_SUBMITTED');
                }
                const response = parseJson(attempt.response_json);
                if (!await rollbackTransaction()) {
                    throw new QuizAttemptError(503, 'The saved quiz response could not be safely retrieved. Retry the same quiz attempt and answers.', 'QUIZ_REPLAY_CLEANUP_FAILED');
                }
                return { status: 'replayed', response };
            }
            if (attempt.status === 'expired' || new Date(attempt.expires_at).getTime() <= now().getTime()) {
                if (attempt.status === 'open') {
                    const [expiryUpdate] = await connection.execute(
                        `UPDATE quiz_attempt SET status = 'expired'
                         WHERE quiz_id = ? AND status = 'open'`,
                        [quizId]
                    );
                    if (expiryUpdate.affectedRows !== 1) {
                        throw new QuizAttemptError(409, 'This quiz attempt could not be marked as expired.', 'QUIZ_ATTEMPT_EXPIRY_FAILED');
                    }
                }
                commitAttempted = true;
                await connection.commit();
                transactionStarted = false;
                commitAttempted = false;
                return { status: 'expired' };
            }
            if (attempt.status !== 'open') {
                throw new QuizAttemptError(409, 'This quiz attempt cannot be submitted in its current state.', 'QUIZ_ATTEMPT_STATE_INVALID');
            }

            const questions = parseJson(attempt.questions_json);
            if (!Array.isArray(questions) || canonical.answers.length !== questions.length ||
                canonical.answers.some((answer, index) => answer.questionIndex !== index)) {
                throw new QuizAttemptError(400, 'Please answer every question exactly once.', 'INVALID_ANSWERS');
            }
            if (canonical.answers.some((answer, index) => !questions[index].options.includes(answer.selectedAnswer))) {
                throw new QuizAttemptError(400, 'One or more answers are not valid options for this quiz.', 'INVALID_ANSWER_OPTION');
            }

            // Serializes cache writes for different attempts from the same learner.
            const [learners] = await connection.execute(
                'SELECT learner_id FROM learner WHERE learner_id = ? FOR UPDATE',
                [learnerId]
            );
            if (!learners.length) throw new QuizAttemptError(404, 'Learner not found.', 'LEARNER_NOT_FOUND');

            const conceptIds = [...new Set(questions.map(question => question.conceptId))];
            const placeholders = conceptIds.map(() => '?').join(',');
            const [validConcepts] = await connection.execute(
                `SELECT concept_id FROM concept WHERE concept_id IN (${placeholders})`,
                conceptIds
            );
            if (validConcepts.length !== conceptIds.length) {
                throw new QuizAttemptError(409, 'A concept in this quiz no longer exists.', 'QUIZ_CONCEPT_MISSING');
            }

            const answerByIndex = new Map(canonical.answers.map(answer => [answer.questionIndex, answer.selectedAnswer]));
            let correctCount = 0;
            const grouped = new Map();
            questions.forEach((question, index) => {
                const correct = answerByIndex.get(index) === question.correctAnswer;
                if (correct) correctCount++;
                if (!grouped.has(question.conceptId)) grouped.set(question.conceptId, { total: 0, correct: 0 });
                const group = grouped.get(question.conceptId);
                group.total++;
                if (correct) group.correct++;
            });
            const overallScore = Number(((correctCount / questions.length) * 100).toFixed(2));

            // Validate and calculate all per-concept evidence before the first
            // persistent write, keeping score rounding consistent with counts.
            const scoredConcepts = [...grouped.entries()].map(([conceptId, group]) => ({
                conceptId,
                group,
                ...calculateConceptEvidence(group)
            }));

            const [assessment] = await connection.execute(
                `INSERT INTO assessment
                    (learner_id, overall_score, quiz_attempt_id, timestamp_provenance)
                 VALUES (?, ?, ?, ?)`,
                [learnerId, overallScore, quizId, 'utc']
            );
            for (const { conceptId, questionCount, correctCount: conceptCorrectCount, score } of scoredConcepts) {
                await connection.execute(
                    `INSERT INTO quiz_result
                        (assessment_id, concept_id, score, question_count, correct_count)
                     VALUES (?, ?, ?, ?, ?)`,
                    [assessment.insertId, conceptId, score, questionCount, conceptCorrectCount]
                );
            }

            const conceptResults = [];
            const asOf = now();
            for (const { conceptId, score } of scoredConcepts) {
                const [evidenceRows] = await connection.execute(
                    `SELECT a.assessment_id AS assessmentId,
                            qr.score AS score,
                            a.assessment_date AS assessmentDate,
                            qr.question_count AS questionCount,
                            qr.correct_count AS correctCount,
                            a.timestamp_provenance AS timestampProvenance
                     FROM quiz_result AS qr
                     JOIN assessment AS a ON a.assessment_id = qr.assessment_id
                     WHERE a.learner_id = ? AND qr.concept_id = ?
                     ORDER BY a.assessment_date, a.assessment_id, qr.result_id`,
                    [learnerId, conceptId]
                );
                if (evidenceRows.length === 0) {
                    throw new Error('Assessment evidence is missing after quiz result insertion.');
                }
                const mastery = calculateMastery(evidenceRows.map(mapMasteryObservation), { asOf });
                if (mastery.mastery === null) {
                    throw new Error('Assessment evidence did not produce a mastery score.');
                }
                await connection.execute(
                    `INSERT INTO learning_path (learner_id, concept_id, mastery_level)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE mastery_level = VALUES(mastery_level)`,
                    [learnerId, conceptId, mastery.mastery]
                );
                const conceptName = questions.find(question => question.conceptId === conceptId)?.conceptName || `Concept ${conceptId}`;
                conceptResults.push({ conceptId, conceptName, score, masteryLevel: mastery.mastery, needsRevision: score < 60 });
            }

            const assessedIds = [...grouped.keys()];
            const assessedPlaceholders = assessedIds.map(() => '?').join(',');
            await connection.execute(
                `DELETE FROM recommendation WHERE learner_id = ? AND concept_id IN (${assessedPlaceholders})`,
                [learnerId, ...assessedIds]
            );
            for (const result of conceptResults) {
                if (result.needsRevision) {
                    await connection.execute(
                        'INSERT INTO recommendation (learner_id, concept_id) VALUES (?, ?)',
                        [learnerId, result.conceptId]
                    );
                }
            }

            const response = {
                message: 'Quiz results saved successfully.',
                assessmentId: assessment.insertId,
                overallScore,
                correctCount,
                totalQuestions: questions.length,
                conceptResults,
                review: questions.map((question, index) => ({
                    question: question.question,
                    options: question.options,
                    selectedAnswer: answerByIndex.get(index),
                    correctAnswer: question.correctAnswer,
                    explanation: question.explanation,
                    isCorrect: answerByIndex.get(index) === question.correctAnswer,
                    conceptId: question.conceptId,
                    conceptName: question.conceptName
                }))
            };
            const [attemptUpdate] = await connection.execute(
                `UPDATE quiz_attempt
                 SET status = 'submitted', answers_hash = ?, response_json = ?, submitted_at = CURRENT_TIMESTAMP
                 WHERE quiz_id = ? AND status = 'open'`,
                [canonical.hash, JSON.stringify(response), quizId]
            );
            if (attemptUpdate.affectedRows !== 1) {
                throw new QuizAttemptError(409, 'This quiz attempt could not be marked as submitted.', 'QUIZ_ATTEMPT_COMPLETION_FAILED');
            }
            commitAttempted = true;
            await connection.commit();
            transactionStarted = false;
            commitAttempted = false;
            return { status: 'created', response };
        } catch (error) {
            if (transactionStarted && !commitAttempted) {
                await rollbackTransaction();
            }
            if (commitAttempted) {
                // A failed COMMIT has an unknown outcome. Destroy this
                // connection so an open transaction cannot return to the pool.
                destroyConnection();
                const outcome = await reconcile(quizId, learnerId, canonical.hash);
                if (outcome?.status === 'replayed') return outcome;
                if (outcome?.status === 'expired') return { status: 'expired' };
                if (outcome?.status === 'unavailable') {
                    throw new QuizAttemptError(503, 'Submission status could not be confirmed. Retry the same quiz attempt and answers.', 'SUBMISSION_STATUS_UNAVAILABLE');
                }
                throw new QuizAttemptError(503, 'Submission status could not be confirmed. Retry the same quiz attempt and answers.', 'SUBMISSION_STATUS_UNCONFIRMED');
            }
            throw error;
        } finally {
            if (!connectionDisposed) connection.release();
        }
    }

    return { createAttempt, submitAttempt, getHistory };
}

const service = createQuizAttemptService();
module.exports = { ...service, createQuizAttemptService, canonicalizeAnswers, calculateConceptEvidence, QuizAttemptError };
