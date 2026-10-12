
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

// Retrieve extracted text using the unique stored upload filename.
async function getProcessedText(documentId) {
    if (!Number.isInteger(documentId) || documentId < 1) {
        const error = new Error('A valid document ID is required.');
        error.status = 400;
        throw error;
    }

    const [documents] = await mysql.execute(
        `SELECT
            document_id,
            filename,
            file_path,
            processing_status
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

    if (!document.file_path) {
        const error = new Error(
            'The stored upload path is missing for this document.'
        );
        error.status = 422;
        throw error;
    }

    // Example stored path:
    // storage/uploads/1791803589374-Lecture 8 Cloud Auditing.pdf
    const storedUploadName = path.basename(document.file_path);
    const storedStem = path.parse(storedUploadName).name;
    const textFilename = `${storedStem}.txt`;

    const textPath = path.resolve(processedFolder, textFilename);

    // Prevent reading files outside the processed folder.
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
                `Extracted text file not found: ${textFilename}. ` +
                'The document may need to be processed again.'
            );
            error.status = 404;
            throw error;
        }

        throw readError;
    }

    if (!text.trim()) {
        const error = new Error('The extracted document text is empty.');
        error.status = 422;
        throw error;
    }

    if (text.length > 30000) {
        const error = new Error(
            'This document exceeds the current 30,000-character limit. ' +
            'Please use shorter notes for now.'
        );
        error.status = 413;
        throw error;
    }

    return text;
}

// Generate a summary.
router.post('/summarize', async (req, res) => {
    try {
        const documentId = Number(req.body.documentId);
        const text = await getProcessedText(documentId);

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

        if (!response.text) {
            throw new Error('Gemini returned an empty summary.');
        }

        return res.json({
            documentId,
            summary: response.text
        });
    } catch (error) {
        console.error('Summary error:', error.message);

        const status = error.status || 502;

        return res.status(status).json({
            error: error.status
                ? error.message
                : 'Gemini could not generate the summary. Check the backend terminal for the API error.'
        });
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

        const status = error.status || 502;

        return res.status(status).json({
            error: error.status
                ? error.message
                : 'Gemini could not generate the quiz. Check the backend terminal for the API error.'
        });
    }
});

module.exports = router;
