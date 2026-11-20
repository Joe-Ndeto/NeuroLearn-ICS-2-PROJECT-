
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');

const mysql = require('../config/mysql');
const authenticateToken = require('../middleware/authenticateToken');
const quizAttemptService = require('../services/quizAttemptService');

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
        const error = new Error(
            'Gemini is not configured. Check GEMINI_API_KEY in backend/.env.'
        );
        error.status = 503;
        throw error;
    }
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
                throw error;
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
        const error = new Error('Invalid processed document path.');
        error.status = 400;
        throw error;
    }

    return candidate;
}

// Retrieve extracted text only when the document belongs
// to the authenticated learner.
async function getProcessedText(documentId, learnerId) {
    if (!Number.isInteger(documentId) || documentId < 1) {
        const error = new Error('A valid document ID is required.');
        error.status = 400;
        throw error;
    }

    const [rows] = await mysql.execute(
        `SELECT
            document_id,
            filename,
            file_path,
            processing_status
         FROM uploaded_document
         WHERE document_id = ?
         AND learner_id = ?`,
        [documentId, learnerId]
    );

    if (!rows.length) {
        const error = new Error(
            'Document not found or you do not have permission to access it.'
        );
        error.status = 404;
        throw error;
    }

    const document = rows[0];

    console.log('[NeuroLearn] Loading document:', {
        documentId: document.document_id,
        filename: document.filename,
        filePath: document.file_path,
        processingStatus: document.processing_status,
        projectRoot,
        processedFolder
    });

    if (String(document.processing_status).toLowerCase() !== 'processed') {
        const error = new Error(
            `Document processing status is "${document.processing_status}", not "processed". Please upload or process the document again.`
        );
        error.status = 409;
        throw error;
    }

    if (!document.file_path && !document.filename) {
        const error = new Error(
            'The document has no stored file path or filename.'
        );
        error.status = 422;
        throw error;
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
    const missingPaths = [];

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
                missingPaths.push(textPath);
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
            originalFilename: document.filename,
            storedFilePath: document.file_path,
            expectedTextFiles: uniqueNames,
            checkedPaths: missingPaths,
            processedFolder
        });

        const error = new Error(
            `Extracted text was not found for "${document.filename}". Expected file: ${uniqueNames.join(' or ') || 'unknown'}. Checked folder: ${processedFolder}. Check the backend terminal for details.`
        );
        error.status = 404;
        throw error;
    }

    if (text.length > 30000) {
        const error = new Error(
            'This document exceeds the current AI processing limit of 30,000 characters.'
        );
        error.status = 413;
        throw error;
    }

    console.log('[NeuroLearn] Extracted text loaded:', {
        documentId,
        textPath: matchedPath,
        characters: text.length
    });

    return { document, text };
}

// Handle AI errors.
function handleAIError(res, error, action) {
    console.error(`[NeuroLearn] ${action} failed:`, error);

    return res.status(error.status || 502).json({
        error: error.status
            ? error.message
            : `Gemini could not ${action.toLowerCase()}. Check the backend terminal for details.`
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

        const { text } = await getProcessedText(
            documentId,
            req.user.learner_id
        );

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
            req.user.learner_id
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

        const { text } = await getProcessedText(
            documentId,
            learnerId
        );

        const [concepts] = await mysql.execute(
            `SELECT concept_id, concept_name, description
             FROM concept
             ORDER BY concept_id`
        );

        if (!concepts.length) {
            return res.status(409).json({
                error: 'No concepts exist yet. Add concepts to the concept table before generating quizzes.'
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
                throw new Error(
                    'The generated quiz contains an invalid question or concept mapping. Please generate it again.'
                );
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
            console.error('[NeuroLearn] Quiz submission failed:', error);
            return res.status(500).json({ error: 'Could not save quiz results.' });
        }
    }
);


module.exports = router;
