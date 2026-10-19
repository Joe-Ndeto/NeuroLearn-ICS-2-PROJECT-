
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { GoogleGenAI } = require('@google/genai');
const mysql = require('../config/mysql');

const router = express.Router();

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

const MODEL = 'gemini-3.8-flash';

const projectRoot = path.resolve(__dirname, '../../..');
const processedFolder = path.resolve(
    projectRoot,
    'storage',
    'processed'
);

// Read the extracted text for a document.
async function getProcessedText(documentId) {
    if (!Number.isInteger(documentId) || documentId < 1) {
        const error = new Error('A valid document ID is required.');
        error.status = 400;
        throw error;
    }

    const [rows] = await mysql.execute(
        `SELECT document_id, filename, file_path, processing_status
         FROM uploaded_document
         WHERE document_id = ?`,
        [documentId]
    );

    if (!rows.length) {
        const error = new Error('Document not found.');
        error.status = 404;
        throw error;
    }

    const document = rows[0];

    if (document.processing_status !== 'processed') {
        const error = new Error(
            'This document has not finished processing.'
        );
        error.status = 409;
        throw error;
    }

    if (!document.file_path) {
        const error = new Error(
            'The document does not have a stored file path.'
        );
        error.status = 422;
        throw error;
    }

    const storedUploadName = path.basename(document.file_path);
    const storedStem = path.parse(storedUploadName).name;
    const textFilename = `${storedStem}.txt`;
    const textPath = path.resolve(processedFolder, textFilename);

    // Prevent paths outside the processed folder.
    if (path.dirname(textPath) !== processedFolder) {
        const error = new Error('Invalid processed document path.');
        error.status = 400;
        throw error;
    }

    let text;

    try {
        text = await fs.readFile(textPath, 'utf8');
    } catch (readError) {
        if (readError.code === 'ENOENT') {
            const error = new Error(
                'The extracted text file could not be found. Please upload the document again.'
            );
            error.status = 404;
            throw error;
        }

        throw readError;
    }

    text = text.trim();

    if (!text) {
        const error = new Error(
            'The document contains no extracted text to study.'
        );
        error.status = 422;
        throw error;
    }

    if (text.length > 30000) {
        const error = new Error(
            'This document is too long for the current AI processing limit.'
        );
        error.status = 413;
        throw error;
    }

    return {
        document,
        text
    };
}

// Shared error response.
function handleAIError(res, error, action) {
    console.error(`${action} failed:`, error);

    const status = error.status || 502;

    return res.status(status).json({
        error: error.status
            ? error.message
            : `Gemini could not ${action.toLowerCase()}. Check the backend terminal for details.`
    });
}

// Generate a summary.
router.post('/summarize', async (req, res) => {
    try {
        const documentId = Number(req.body.documentId);
        const { text } = await getProcessedText(documentId);

        const response = await ai.models.generateContent({
            model: MODEL,
            contents: [
                'You are NeuroLearn, an educational study assistant.',
                'Summarize the following lecture notes using clear headings.',
                'Include the main topics, definitions, key points,',
                'and a brief revision recap. Do not invent facts.',
                '',
                'LECTURE NOTES:',
                text
            ].join('\n')
        });

        if (!response.text || !response.text.trim()) {
            throw new Error('The AI returned an empty summary.');
        }

        return res.json({
            documentId,
            summary: response.text.trim()
        });
    } catch (error) {
        return handleAIError(res, error, 'Generate summary');
    }
});

// Answer questions using the selected document.
router.post('/chat', async (req, res) => {
    try {
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

        const { text } = await getProcessedText(documentId);

        const response = await ai.models.generateContent({
            model: MODEL,
            contents: [
                'You are NeuroLearn, a helpful educational study assistant.',
                'Answer the learner using the supplied lecture notes as your primary source.',
                'Explain concepts clearly and at an appropriate student level.',
                'If the notes do not contain the answer, say so instead of inventing information.',
                'You may explain a concept in simpler words, but distinguish explanations from facts explicitly stated in the notes.',
                '',
                'LECTURE NOTES:',
                text,
                '',
                'LEARNER QUESTION:',
                message
            ].join('\n')
        });

        if (!response.text || !response.text.trim()) {
            throw new Error('The AI returned an empty answer.');
        }

        return res.json({
            documentId,
            answer: response.text.trim()
        });
    } catch (error) {
        return handleAIError(res, error, 'Answer question');
    }
});

// Generate a multiple-choice quiz.
router.post('/quiz', async (req, res) => {
    try {
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

        const { text } = await getProcessedText(documentId);

        const response = await ai.models.generateContent({
            model: MODEL,
            contents: [
                'Create a multiple-choice revision quiz using only the lecture notes below.',
                `Generate exactly ${questionCount} questions.`,
                'Return valid JSON only, without Markdown code fences.',
                'Use this exact structure:',
                '{"questions":[{"question":"Question text","options":["Option A","Option B","Option C","Option D"],"correctAnswer":"Exact option text","explanation":"Brief explanation based on the notes"}]}',
                'Each question must have exactly four distinct options.',
                'Each question must have exactly one correct answer.',
                'The correctAnswer must exactly match one of the four options.',
                'Make questions clear and relevant to the notes.',
                'Do not invent facts that are not supported by the notes.',
                '',
                'LECTURE NOTES:',
                text
            ].join('\n'),
            config: {
                responseMimeType: 'application/json'
            }
        });

        if (!response.text || !response.text.trim()) {
            throw new Error('The AI returned an empty quiz.');
        }

        let quiz;

        try {
            quiz = JSON.parse(response.text);
        } catch {
            throw new Error('The AI returned invalid quiz JSON.');
        }

        if (
            !quiz ||
            !Array.isArray(quiz.questions) ||
            quiz.questions.length !== questionCount
        ) {
            throw new Error(
                'The generated quiz did not contain the requested number of questions.'
            );
        }

        for (const question of quiz.questions) {
            if (
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
                typeof question.explanation !== 'string'
            ) {
                throw new Error(
                    'The generated quiz contains an invalid question.'
                );
            }
        }

        return res.json({
            documentId,
            questions: quiz.questions
        });
    } catch (error) {
        return handleAIError(res, error, 'Generate quiz');
    }
});

module.exports = router;
