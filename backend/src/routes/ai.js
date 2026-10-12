const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { GoogleGenAI } = require('@google/genai');
const mysql = require('../config/mysql');

const router = express.Router();

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

// Use a model available to your Gemini API key.
const MODEL = 'gemini-flash-latest';
const projectRoot = path.resolve(__dirname, '../../..');
const processedFolder = path.join(
    projectRoot,
    'storage',
    'processed'
);

async function getProcessedText(documentId) {
    if (!Number.isInteger(documentId) || documentId < 1) {
        const error = new Error('A valid document ID is required.');
        error.status = 400;
        throw error;
    }

    const [documents] = await mysql.execute(
        `SELECT document_id, filename, processing_status
         FROM uploaded_document
         WHERE document_id = ?`,
        [documentId]
    );

    if (documents.length === 0) {
        const error = new Error('Document not found.');
        error.status = 404;
        throw error;
    }

    const document = documents[0];

    if (document.processing_status !== 'processed') {
        const error = new Error(
            'This document has not been processed successfully.'
        );
        error.status = 409;
        throw error;
    }

    // The current processor saves text using the original filename stem.
    const textFilename =
        `${path.parse(document.filename).name}.txt`;

    const textPath = path.join(processedFolder, textFilename);

    // Ensure the resolved path remains within the processed folder.
    if (path.dirname(textPath) !== processedFolder) {
        const error = new Error('Invalid processed document path.');
        error.status = 400;
        throw error;
    }

    const text = await fs.readFile(textPath, 'utf8');

    if (!text.trim()) {
        const error = new Error('The extracted document text is empty.');
        error.status = 422;
        throw error;
    }

    if (text.length > 30000) {
        const error = new Error(
            'This document is too long for this first version. ' +
            'Please use a shorter note.'
        );
        error.status = 413;
        throw error;
    }

    return text;
}

// Generate a summary
router.post('/summarize', async (req, res) => {
    try {
        const documentId = Number(req.body.documentId);
        const text = await getProcessedText(documentId);

        const response = await ai.models.generateContent({
            model: MODEL,
            contents: [
                'You are NeuroLearn, an educational study assistant.',
                'Summarize the following lecture notes using headings.',
                'Include the main topics, definitions, key points,',
                'and a brief revision recap. Do not invent facts.',
                '',
                'LECTURE NOTES:',
                text
            ].join('\n')
        });

        if (!response.text) {
            throw new Error('Gemini returned an empty summary.');
        }

        return res.json({
            documentId,
            summary: response.text
        });

    } catch (error) {
        console.error('Summary error:', error.message);

        return res.status(error.status || 502).json({
            error: error.status
                ? error.message
                : 'Could not generate a summary. Check the Gemini API key, model access and quota.'
        });
    }
});

// Generate a multiple-choice quiz
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
                error: 'Choose between 1 and 10 questions.'
            });
        }

        const text = await getProcessedText(documentId);

        const response = await ai.models.generateContent({
            model: MODEL,
            contents: [
                'Create a multiple-choice quiz using only these notes.',
                `Generate exactly ${questionCount} questions.`,
                'Return valid JSON only in this structure:',
                '{"questions":[{"question":"...","options":["A","B","C","D"],"correctAnswer":"exact option text","explanation":"..."}]}',
                'Each question must have four options and one correct answer.',
                'Do not invent information outside the notes.',
                '',
                'LECTURE NOTES:',
                text
            ].join('\n'),
            config: {
                responseMimeType: 'application/json'
            }
        });

        if (!response.text) {
            throw new Error('Gemini returned an empty quiz.');
        }

        const quiz = JSON.parse(response.text);

        if (
            !Array.isArray(quiz.questions) ||
            quiz.questions.length !== questionCount ||
            quiz.questions.some(question =>
                typeof question.question !== 'string' ||
                !Array.isArray(question.options) ||
                question.options.length !== 4 ||
                !question.options.includes(question.correctAnswer) ||
                typeof question.explanation !== 'string'
            )
        ) {
            throw new Error('Gemini returned an invalid quiz structure.');
        }

        return res.json({
            documentId,
            ...quiz
        });

    } catch (error) {
        console.error('Quiz error:', error.message);

        return res.status(error.status || 502).json({
            error: error.status
                ? error.message
                : 'Could not generate a quiz. Check the Gemini API key, model access and quota.'
        });
    }
});

module.exports = router;