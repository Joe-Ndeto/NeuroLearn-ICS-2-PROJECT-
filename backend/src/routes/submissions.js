'use strict';

const express = require('express');
const authenticateToken = require('../middleware/authenticateToken');
const path = require('path');
const { upload: uploadResourceDocument, uploadFolder, validateDocument, removeUploadedFile, maxFileSize } = require('../middleware/resourceDocumentUpload');
const { createPendingSubmission, getLearnerSubmissions } = require('../services/knowledgeSubmissionService');

const router = express.Router();
const CONTROL_FIELDS = [
    'status',
    'submittedBy',
    'submitted_by',
    'reviewedBy',
    'reviewed_by',
    'reviewNotes',
    'review_notes',
    'reviewedAt',
    'reviewed_at'
];

router.use(authenticateToken);

function validateBody(req, res) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        res.status(400).json({
            success: false,
            message: 'A JSON object is required.'
        });
        return false;
    }

    const suppliedControlField = CONTROL_FIELDS.find(field =>
        Object.prototype.hasOwnProperty.call(req.body, field)
    );

    if (suppliedControlField) {
        res.status(400).json({
            success: false,
            message: 'Submission status and review fields are managed by NeuroLearn.'
        });
        return false;
    }

    return true;
}

function requireStudent(req, res) {
    if (req.user.role === 'student') {
        return true;
    }

    res.status(403).json({
        success: false,
        message: 'Only student accounts can create submissions.'
    });
    return false;
}

function optionalText(body, field, maxLength, res) {
    if (body[field] === undefined || body[field] === null) {
        return '';
    }

    if (
        typeof body[field] !== 'string' ||
        body[field].trim().length > maxLength
    ) {
        res.status(400).json({
            success: false,
            message: `${field} must be text no longer than ${maxLength} characters.`
        });
        return null;
    }

    return body[field].trim();
}

function requiredText(body, field, maxLength, res) {
    if (typeof body[field] !== 'string' || !body[field].trim()) {
        res.status(400).json({
            success: false,
            message: `${field} is required.`
        });
        return null;
    }

    if (body[field].trim().length > maxLength) {
        res.status(400).json({
            success: false,
            message: `${field} must not exceed ${maxLength} characters.`
        });
        return null;
    }

    return body[field].trim();
}

function validatePage(value, fallback, maximum) {
    if (value === undefined) {
        return fallback;
    }

    if (!/^[1-9]\d*$/.test(String(value))) {
        return null;
    }

    const number = Number(value);
    return Number.isSafeInteger(number) && number <= maximum
        ? number
        : null;
}

async function saveSubmission(req, res, submissionType, submissionData) {
    try {
        const submission = await createPendingSubmission(
            submissionType,
            submissionData,
            req.user.learner_id
        );

        return res.status(201).json({ success: true, submission });
    } catch (error) {
        console.error('[Submissions] Could not create submission:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Could not save the submission.'
        });
    }
}

router.post('/concepts', async (req, res) => {
    if (!requireStudent(req, res) || !validateBody(req, res)) {
        return;
    }

    const name = requiredText(req.body, 'name', 150, res);
    if (name === null) return;

    const description = optionalText(req.body, 'description', 5000, res);
    if (description === null) return;

    return saveSubmission(req, res, 'CONCEPT', {
        name,
        description
    });
});

router.post('/prerequisites', async (req, res) => {
    if (!requireStudent(req, res) || !validateBody(req, res)) {
        return;
    }

    return res.status(410).json({
        success: false,
        message: 'Prerequisite relationships are managed by administrators.'
    });

});

router.post('/resources', (req, res, next) => {
    if (!requireStudent(req, res)) return;
    uploadResourceDocument.single('document')(req, res, error => {
        if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
            success: false,
            message: error.code === 'LIMIT_FILE_SIZE'
                ? `Document size must not exceed ${Math.floor(maxFileSize / 1024 / 1024)} MB.`
                : error.message
        });
        next();
    });
}, async (req, res) => {
    const fail = async (status, message) => {
        await removeUploadedFile(req.file).catch(error => console.error('[Submissions] Temporary upload cleanup failed:', error.message));
        return res.status(status).json({ success: false, message });
    };
    if (!validateBody(req, res)) {
        await removeUploadedFile(req.file).catch(() => {});
        return;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'conceptId')) {
        return fail(400, 'The resource concept is assigned by an administrator during review.');
    }
    if (!req.file) return res.status(400).json({ success: false, message: 'Please select a PDF, PowerPoint or Word document.' });
    try {
        await validateDocument(req.file);
    } catch (error) {
        return fail(400, error.message);
    }

    const title = requiredText(req.body, 'title', 255, res);
    if (title === null) { await removeUploadedFile(req.file); return; }

    const extension = path.extname(req.file.originalname).toLowerCase();
    const documentType = ['.ppt', '.pptx'].includes(extension) ? 'PowerPoint' : ['.doc', '.docx'].includes(extension) ? 'Word' : 'PDF';

    try {
        const storedName = path.basename(req.file.filename);
        const submission = await createPendingSubmission('RESOURCE', {
            title,
            type: 'document',
            document: {
                filename: storedName,
                originalName: path.basename(req.file.originalname).slice(0, 255),
                extension,
                documentType,
                size: req.file.size
            }
        }, req.user.learner_id);
        return res.status(201).json({ success: true, submission });
    } catch (error) {
        console.error('[Submissions] Could not validate resource concept:', error.message);
        return fail(500, 'Could not save the resource submission.');
    }
});

router.get('/resources/:submissionId/document', async (req, res) => {
    const submissionId = Number(req.params.submissionId);
    if (!Number.isSafeInteger(submissionId) || submissionId < 1) return res.status(400).json({ success: false, message: 'Invalid submission ID.' });
    try {
        const [rows] = await require('../config/mysql').execute(
            `SELECT submitted_by, submission_data FROM knowledge_submissions
             WHERE submission_id = ? AND submission_type = 'RESOURCE'`, [submissionId]
        );
        if (!rows.length) return res.status(404).json({ success: false, message: 'Document not found.' });
        if (req.user.role !== 'admin' && Number(rows[0].submitted_by) !== Number(req.user.learner_id)) return res.status(403).json({ success: false, message: 'You are not allowed to access this document.' });
        const data = typeof rows[0].submission_data === 'string' ? JSON.parse(rows[0].submission_data) : rows[0].submission_data;
        const filename = data?.document?.filename;
        if (typeof filename !== 'string' || !/^[0-9a-f-]{36}\.(pdf|ppt|pptx|doc|docx)$/i.test(filename)) return res.status(404).json({ success: false, message: 'Document not found.' });
        const fullPath = path.join(uploadFolder, filename);
        return res.download(fullPath, data.document.originalName || 'learning-resource');
    } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).json({ success: false, message: 'Document not found.' });
        console.error('[Submissions] Could not retrieve resource document:', error.message);
        return res.status(500).json({ success: false, message: 'Could not retrieve the document.' });
    }
});

router.get('/', async (req, res) => {
    const page = validatePage(req.query.page, 1, Number.MAX_SAFE_INTEGER);
    const limit = validatePage(req.query.limit, 20, 100);

    if (page === null || limit === null) {
        return res.status(400).json({
            success: false,
            message: 'page must be a positive integer and limit must be between 1 and 100.'
        });
    }

    const offset = (page - 1) * limit;
    if (!Number.isSafeInteger(offset)) {
        return res.status(400).json({
            success: false,
            message: 'Requested page is out of range.'
        });
    }

    try {
        const result = await getLearnerSubmissions(
            req.user.learner_id,
            limit,
            offset
        );

        return res.json({
            success: true,
            submissions: result.submissions,
            pagination: {
                page,
                limit,
                total: result.total,
                totalPages: Math.ceil(result.total / limit)
            }
        });
    } catch (error) {
        console.error('[Submissions] Could not retrieve submissions:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Could not retrieve submissions.'
        });
    }
});

module.exports = router;
