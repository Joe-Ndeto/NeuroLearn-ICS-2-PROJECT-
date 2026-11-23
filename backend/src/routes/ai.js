
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');

const mysql = require('../config/mysql');
const authenticateToken = require('../middleware/authenticateToken');
const quizAttemptService = require('../services/quizAttemptService');
const { getAllCourses } = require('../services/knowledgeGraphService');
const { logSafeError } = require('../utils/safeErrorLogger');

const router = express.Router();

// All NeuroLearn AI features use the same Gemini model.
const MODEL = 'gemini-3.5-flash-lite';

console.log('[NeuroLearn] Gemini model:', MODEL);

const ai = process.env.GEMINI_API_KEY
    ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    : null;

if (!ai) {
    console.warn('Warning: GEMINI_API_KEY is not configured.');
}

const QUIZ_TTL_MS = 30 * 60 * 1000;

// Project paths.
const projectRoot = path.resolve(__dirname, '../../..');
const processedFolder = path.join(projectRoot, 'storage', 'processed');

// Check whether Gemini is configured.
function requireAI() {
    if (!ai) {
        const error = new Error('AI-powered features are not configured. Contact an administrator.');
        error.status = 503;
        error.code = 'AI_NOT_CONFIGURED';
        error.expose = true;
        throw error;
    }
}

function publicAIError(status, message, code) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    error.expose = true;
    return error;
}

// Retry temporary Gemini service-unavailable errors only.
// Quota/rate-limit errors are not retried automatically.
async function generateContentWithRetry(request, maxRetries = 2) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await ai.models.generateContent(request);
        } catch (error) {
            const status = Number(error.status || error.code);

            const isTemporaryUnavailable =
                status === 503 ||
                error.status === 'UNAVAILABLE' ||
                error.code === 'UNAVAILABLE';

            if (!isTemporaryUnavailable || attempt >= maxRetries) {
                const providerError = new Error('The AI provider request failed.');
                providerError.name = 'AIProviderError';
                providerError.code = 'AI_PROVIDER_ERROR';
                providerError.status = Number.isInteger(status) ? status : undefined;
                providerError.providerError = true;
                providerError.cause = error;
                throw providerError;
            }

            const delayMs = 1500 * (attempt + 1);

            console.warn(
                `[NeuroLearn] Gemini temporarily unavailable. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries}).`
            );

            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

// Validate extracted text filenames.
function getSafeTextPath(filename) {
    const safeName = path.basename(filename);
    const candidate = path.resolve(processedFolder, safeName);

    if (path.dirname(candidate) !== processedFolder) {
        throw publicAIError(400, 'Invalid document path.', 'INVALID_DOCUMENT_PATH');
    }

    return candidate;
}

// Retrieve extracted text only for its owner or a confirmed approved
// resource associated with the selected canonical course.
async function getProcessedText(documentId, learnerId, courseId = null, conceptId = null) {
    if (!Number.isInteger(documentId) || documentId < 1) {
        throw publicAIError(400, 'A valid document ID is required.', 'INVALID_DOCUMENT_ID');
    }

    const sharedAccess = typeof courseId === 'string' && courseId.trim();
    const [rows] = await mysql.execute(
        `SELECT
            ud.document_id,
            ud.filename,
            ud.file_path,
            ud.processing_status
         FROM uploaded_document AS ud
         WHERE ud.document_id = ?
           AND (ud.learner_id = ? OR (? = 1 AND EXISTS (
                SELECT 1
                FROM knowledge_submissions AS s
                INNER JOIN learning_resource AS lr
                  ON lr.file_url = CONCAT('/api/submissions/resources/', s.submission_id, '/document')
                INNER JOIN concept AS c ON c.concept_id = lr.concept_id
                INNER JOIN concept_course AS cc ON cc.concept_id = c.concept_id
                INNER JOIN course AS approved_course ON approved_course.graph_course_id = cc.course_graph_id
                WHERE s.submission_type = 'RESOURCE'
                  AND s.status = 'approved'
                  AND JSON_UNQUOTE(JSON_EXTRACT(s.submission_data, '$.document.documentId')) = CAST(ud.document_id AS CHAR)
                  AND cc.course_graph_id = ?
                  AND (? = 0 OR lr.concept_id = ?)
           )))
           AND (? = 0 OR EXISTS (
                SELECT 1
                FROM knowledge_submissions AS scoped_submission
                INNER JOIN learning_resource AS scoped_resource
                  ON scoped_resource.file_url = CONCAT('/api/submissions/resources/', scoped_submission.submission_id, '/document')
                INNER JOIN concept_course AS scoped_association ON scoped_association.concept_id = scoped_resource.concept_id
                INNER JOIN course AS scoped_course ON scoped_course.graph_course_id = scoped_association.course_graph_id
                WHERE scoped_submission.submission_type = 'RESOURCE'
                  AND scoped_submission.status = 'approved'
                  AND JSON_UNQUOTE(JSON_EXTRACT(scoped_submission.submission_data, '$.document.documentId')) = CAST(ud.document_id AS CHAR)
                  AND scoped_association.course_graph_id = ?
                  AND scoped_resource.concept_id = ?
           ))`,
        [documentId, learnerId, sharedAccess ? 1 : 0, sharedAccess ? courseId : '', Number.isSafeInteger(Number(conceptId)) && Number(conceptId) > 0 ? 1 : 0, Number(conceptId) || 0,
            Number.isSafeInteger(Number(conceptId)) && Number(conceptId) > 0 ? 1 : 0, courseId || '', Number(conceptId) || 0]
    );

    if (!rows.length) {
        throw publicAIError(404, 'Document not found or you do not have permission to access it.', 'DOCUMENT_UNAVAILABLE');
    }

    const document = rows[0];

    console.log('[NeuroLearn] Loading study document:', {
        documentId: document.document_id,
        processingStatus: document.processing_status,
        sharedCourseRequest: Boolean(sharedAccess)
    });

    if (String(document.processing_status).toLowerCase() !== 'processed') {
        throw publicAIError(409, 'This document has not been processed yet. Please process it before using AI features.', 'DOCUMENT_NOT_PROCESSED');
    }

    if (!document.file_path && !document.filename) {
        throw publicAIError(422, 'This document has no available processed content.', 'DOCUMENT_CONTENT_UNAVAILABLE');
    }

    /*
     * The Python processor saves:
     * storage/processed/<uploaded-file-stem>.txt
     *
     * Example:
     * storage/uploads/12345-lecture.pdf
     * storage/processed/12345-lecture.txt
     */

    const candidateNames = [];

    if (document.file_path) {
        const storedName = path.win32.basename(
            String(document.file_path).replace(/\\/g, '/')
        );

        const storedStem = path.parse(storedName).name;

        if (storedStem) {
            candidateNames.push(`${storedStem}.txt`);
        }
    }

    // Fallback for older records.
    if (document.filename) {
        const originalStem = path.parse(
            path.basename(String(document.filename))
        ).name;

        if (originalStem) {
            candidateNames.push(`${originalStem}.txt`);
        }
    }

    const uniqueNames = [...new Set(candidateNames)];

    let text = '';
    let matchedPath = null;

    for (const filename of uniqueNames) {
        const textPath = getSafeTextPath(filename);

        try {
            text = (await fs.readFile(textPath, 'utf8')).trim();
            matchedPath = textPath;

            if (text) {
                break;
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                continue;
            }

            throw error;
        }
    }

    // Case-insensitive fallback.
    if (!text) {
        try {
            const files = await fs.readdir(processedFolder);

            const wantedNames = new Set(
                uniqueNames.map(name => name.toLowerCase())
            );

            const match = files.find(
                filename => wantedNames.has(filename.toLowerCase())
            );

            if (match) {
                matchedPath = getSafeTextPath(match);
                text = (await fs.readFile(matchedPath, 'utf8')).trim();
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    if (!matchedPath || !text) {
        console.error('[NeuroLearn] Extracted text lookup failed:', {
            documentId,
            candidateCount: uniqueNames.length
        });

        throw publicAIError(404, 'Processed text is unavailable for this document.', 'PROCESSED_TEXT_UNAVAILABLE');
    }

    if (text.length > 30000) {
        throw publicAIError(413, 'This document exceeds the current AI processing limit of 30,000 characters.', 'DOCUMENT_TEXT_TOO_LARGE');
    }

    console.log('[NeuroLearn] Extracted text loaded:', {
        documentId,
        characters: text.length
    });

    return { document, text };
}

// Handle AI errors.
function handleAIError(res, error, action) {
    logSafeError(console, `[NeuroLearn] ${action} failed`, error);
    if ((error?.expose === true || (error?.status && error.providerError !== true)) && Number.isInteger(error.status)) {
        return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(502).json({
        error: `The AI service could not ${action.toLowerCase()}. Please try again later.`,
        code: 'AI_PROVIDER_UNAVAILABLE'
    });
}

// =====================================================
// POST /api/ai/summarize
// Generate a summary of an authenticated learner's document.
// =====================================================

router.post('/summarize', authenticateToken, async (req, res) => {
    try {
        requireAI();

        const documentId = Number(req.body.documentId);

        const { text } = await getProcessedText(documentId, req.user.learner_id,
            typeof req.body.courseId === 'string' ? req.body.courseId.trim() : null,
            req.body.conceptId);

        const response = await generateContentWithRetry({
            model: MODEL,
            contents: [
                'You are NeuroLearn, an educational study assistant.',
                'Summarize the lecture notes in clear Markdown with headings, definitions, key points, examples where supported, and a short revision recap.',
                'Do not invent facts. Keep the explanation suitable for a university student.',
                '',
                'LECTURE NOTES:',
                text
            ].join('\n')
        });

        if (!response.text?.trim()) {
            throw new Error('The AI returned an empty summary.');
        }

        return res.json({
            documentId,
            summary: response.text.trim()
        });

    } catch (error) {
        return handleAIError(res, error, 'generate summary');
    }
});

// =====================================================
// POST /api/ai/chat
// Chat about an authenticated learner's document.
// =====================================================

router.post('/chat', authenticateToken, async (req, res) => {
    try {
        requireAI();

        const documentId = Number(req.body.documentId);
        const message = String(req.body.message || '').trim();

        if (!message) {
            return res.status(400).json({
                error: 'Please enter a question.'
            });
        }

        if (message.length > 2000) {
            return res.status(400).json({
                error: 'Your question must not exceed 2,000 characters.'
            });
        }

        const { document, text } = await getProcessedText(
            documentId,
            req.user.learner_id,
            typeof req.body.courseId === 'string' ? req.body.courseId.trim() : null,
            req.body.conceptId
        );

        const response = await generateContentWithRetry({
            model: MODEL,
            contents: [
                'You are NeuroLearn, an educational learning assistant.',
                'Answer using ONLY the supplied uploaded lecture notes. Do not use Google Search, the internet, or outside information.',
                'Do not add facts from your general knowledge.',
                'If the notes do not contain enough information to answer, clearly say that the uploaded document does not cover the question.',
                'Explain concepts clearly using only information supported by the notes.',
                'You may simplify or reorganize the notes without changing their meaning.',
                'Format answers in clear Markdown with headings, lists, and code blocks when useful.',
                `SELECTED DOCUMENT: ${document.filename}`,
                '',
                'LECTURE NOTES:',
                text,
                '',
                'LEARNER QUESTION:',
                message
            ].join('\n')
        });

        if (!response.text?.trim()) {
            throw new Error('The AI returned an empty answer.');
        }

        return res.json({
            documentId,
            answer: response.text.trim(),
            sources: [],
            searchPerformed: false
        });

    } catch (error) {
        return handleAIError(res, error, 'answer question');
    }
});


// =====================================================
// POST /api/ai/quiz
// Generate a quiz for an authenticated learner.
// =====================================================

router.post('/quiz', authenticateToken, async (req, res) => {
    try {
        const courseId = typeof req.body?.courseId === 'string' ? req.body.courseId.trim() : '';
        if (!courseId) {
            return res.status(400).json({
                success: false,
                code: 'COURSE_REQUIRED',
                message: 'Select a course before generating a quiz.'
            });
        }

        const conceptId = Number(req.body?.conceptId);
        if (!Number.isSafeInteger(conceptId) || conceptId < 1) {
            return res.status(400).json({
                success: false,
                code: 'CONCEPT_REQUIRED',
                message: 'Select an approved concept from the selected document before generating a quiz.'
            });
        }

        requireAI();
        const learnerId = req.user.learner_id;
        const documentId = Number(req.body.documentId);
        const questionCount = Number(req.body.questionCount ?? 5);

        if (
            !Number.isInteger(questionCount) ||
            questionCount < 1 ||
            questionCount > 10
        ) {
            return res.status(400).json({
                error: 'Question count must be between 1 and 10.'
            });
        }

        const availableCourses = await getAllCourses();
        const matchingCourses = Array.isArray(availableCourses)
            ? availableCourses.filter(course => course?.course_id === courseId)
            : [];
        if (matchingCourses.length !== 1) {
            return res.status(404).json({
                success: false,
                code: 'COURSE_NOT_FOUND',
                message: 'The selected course is not available.'
            });
        }

        const [documentAssociations] = await mysql.execute(
            `SELECT 1
             FROM uploaded_document AS ud
             INNER JOIN knowledge_submissions AS s
               ON s.submission_type = 'RESOURCE' AND s.status = 'approved'
              AND JSON_UNQUOTE(JSON_EXTRACT(s.submission_data, '$.document.documentId')) = CAST(ud.document_id AS CHAR)
             INNER JOIN learning_resource AS lr
               ON lr.file_url = CONCAT('/api/submissions/resources/', s.submission_id, '/document')
             INNER JOIN concept_course AS cc ON cc.concept_id = lr.concept_id
             INNER JOIN course AS approved_course ON approved_course.graph_course_id = cc.course_graph_id
             WHERE ud.document_id = ? AND ud.processing_status = 'processed'
               AND lr.concept_id = ? AND cc.course_graph_id = ?
             LIMIT 1`, [documentId, conceptId, courseId]
        );
        if (!documentAssociations.length) {
            return res.status(404).json({
                success: false,
                code: 'DOCUMENT_CONCEPT_UNAVAILABLE',
                message: 'The selected document is not an approved, processed resource for that concept and course.'
            });
        }

        const { text } = await getProcessedText(
            documentId,
            learnerId,
            courseId
        );

        const [concepts] = await mysql.execute(
            `SELECT c.concept_id, c.concept_name, c.description, c.graph_concept_id
             FROM concept AS c
             INNER JOIN concept_course AS cc ON cc.concept_id = c.concept_id
             WHERE cc.course_graph_id = ? AND c.concept_id = ?
             ORDER BY c.concept_id`,
            [courseId, conceptId]
        );

        if (!concepts.length) {
            return res.status(409).json({
                success: false,
                code: 'COURSE_HAS_NO_CONCEPTS',
                message: 'No concepts are currently associated with this course. Ask an administrator to review its concept associations.'
            });
        }
        if (concepts.some(concept => typeof concept.graph_concept_id !== 'string' || !concept.graph_concept_id.trim())) {
            return res.status(503).json({
                success: false,
                code: 'COURSE_CONCEPT_MAPPING_UNAVAILABLE',
                message: 'Course concepts could not be validated for quiz generation.'
            });
        }

        const conceptList = concepts.map(concept => ({
            conceptId: Number(concept.concept_id),
            name: concept.concept_name,
            description: concept.description || ''
        }));

        const validConceptIds = new Set(
            conceptList.map(concept => concept.conceptId)
        );

        const quizPrompt = [
            'You are NeuroLearn, an educational assessment assistant.',
            `Generate exactly ${questionCount} multiple-choice questions using only the supplied lecture notes.`,
            'Return valid JSON only. Do not include Markdown fences or text outside the JSON.',
            'The JSON must follow this exact structure:',
            '{"questions":[{"question":"Question text","options":["Option A","Option B","Option C","Option D"],"correctAnswer":"Exact option text","explanation":"Explanation","conceptId":1}]}',
            `IMPORTANT: The questions array must contain exactly ${questionCount} question objects. Not fewer and not more.`,
            'Every question must have exactly four distinct answer options.',
            'The correctAnswer must exactly match one of the four options.',
            'Every explanation must explain why the correct answer is correct.',
            'Assign each question to the single most relevant concept from the supplied list.',
            'Use only an existing conceptId from the supplied list. Never invent a concept ID.',
            'Do not invent facts that are not supported by the lecture notes.',
            '',
            'AVAILABLE CONCEPTS:',
            JSON.stringify(conceptList),
            '',
            'LECTURE NOTES:',
            text
        ].join('\n');

        let response = await generateContentWithRetry({
            model: MODEL,
            contents: quizPrompt,
            config: {
                responseMimeType: 'application/json'
            }
        });

        if (!response.text?.trim()) {
            throw new Error('The AI returned an empty quiz.');
        }

        let quiz;

        try {
            quiz = JSON.parse(response.text);
        } catch {
            throw new Error('The AI returned invalid quiz JSON.');
        }

        // Diagnose and retry once if Gemini returns the wrong number.
        if (
            !Array.isArray(quiz?.questions) ||
            quiz.questions.length !== questionCount
        ) {
            console.warn('[NeuroLearn] Quiz question count mismatch:', {
                requested: questionCount,
                received: Array.isArray(quiz?.questions)
                    ? quiz.questions.length
                    : 'Invalid questions array',
                retrying: true
            });

            response = await generateContentWithRetry({
                model: MODEL,
                contents: [
                    quizPrompt,
                    '',
                    'CORRECTION: Your previous response did not contain the required number of questions.',
                    `Regenerate the entire quiz. The questions array MUST contain exactly ${questionCount} complete question objects.`,
                    'Return JSON only, following the required schema.'
                ].join('\n'),
                config: {
                    responseMimeType: 'application/json'
                }
            });

            if (!response.text?.trim()) {
                throw new Error('The AI returned an empty quiz.');
            }

            try {
                quiz = JSON.parse(response.text);
            } catch {
                throw new Error('The AI returned invalid quiz JSON.');
            }
        }

        console.log('[NeuroLearn] Quiz generation count:', {
            requested: questionCount,
            received: Array.isArray(quiz?.questions)
                ? quiz.questions.length
                : 'Invalid questions array'
        });

        if (
            !Array.isArray(quiz?.questions) ||
            quiz.questions.length !== questionCount
        ) {
            throw new Error(
                `Expected ${questionCount} questions, but Gemini returned ${
                    Array.isArray(quiz?.questions)
                        ? quiz.questions.length
                        : 'an invalid questions array'
                }. Please try generating the quiz again.`
            );
        }

        const questions = quiz.questions.map(question => {
            const conceptId = Number(question?.conceptId);

            if (
                !question ||
                typeof question.question !== 'string' ||
                !question.question.trim() ||
                !Array.isArray(question.options) ||
                question.options.length !== 4 ||
                question.options.some(
                    option => typeof option !== 'string' || !option.trim()
                ) ||
                new Set(question.options).size !== 4 ||
                typeof question.correctAnswer !== 'string' ||
                !question.options.includes(question.correctAnswer) ||
                typeof question.explanation !== 'string' ||
                !Number.isInteger(conceptId) ||
                !validConceptIds.has(conceptId)
            ) {
                throw publicAIError(502, 'The generated quiz did not match the selected course. Please try again.', 'INVALID_GENERATED_QUIZ');
            }

            const concept = conceptList.find(
                item => item.conceptId === conceptId
            );

            return {
                question: question.question.trim(),
                options: question.options,
                correctAnswer: question.correctAnswer,
                explanation: question.explanation,
                conceptId,
                conceptName: concept.name
            };
        });

        const quizId = crypto.randomUUID();

        const expiresAt = new Date(Date.now() + QUIZ_TTL_MS);
        await quizAttemptService.createAttempt({
            quizId,
            learnerId,
            documentId,
            questions,
            expiresAt
        });

        // Never expose correct answers before submission.
        return res.json({
            quizId,
            documentId,
            questions: questions.map(
                ({ correctAnswer, explanation, ...question }) => question
            )
        });

    } catch (error) {
        return handleAIError(res, error, 'generate quiz');
    }
});


// =====================================================
// POST /api/ai/quiz/submit
// Submit answers for the authenticated learner's quiz.
// =====================================================

router.post(
    '/quiz/submit',
    authenticateToken,
    async (req, res) => {
        try {
            const result = await quizAttemptService.submitAttempt({
                quizId: req.body.quizId,
                learnerId: req.user.learner_id,
                answers: req.body.answers
            });
            if (result.status === 'expired') {
                return res.status(410).json({
                    error: 'This quiz attempt has expired. Generate a new quiz.',
                    code: 'QUIZ_ATTEMPT_EXPIRED'
                });
            }
            return res.status(result.status === 'created' ? 201 : 200).json(result.response);
        } catch (error) {
            if (error.status) {
                return res.status(error.status).json({ error: error.message, code: error.code });
            }
            logSafeError(console, '[NeuroLearn] Quiz submission failed', error);
            return res.status(500).json({ error: 'Could not save quiz results.' });
        }
    }
);


module.exports = router;
