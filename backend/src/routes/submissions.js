'use strict';

const express = require('express');
const authenticateToken = require('../middleware/authenticateToken');
const {
    createPendingSubmission,
    getLearnerSubmissions,
    resolveConceptReference
} = require('../services/knowledgeSubmissionService');

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

function conceptReference(body, field, res) {
    const value = body[field];
    const numericValue = typeof value === 'string' && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : value;

    if (
        (typeof numericValue === 'number' &&
            (!Number.isSafeInteger(numericValue) || numericValue < 1)) ||
        (typeof numericValue === 'string' &&
            (!numericValue.trim() || numericValue.trim().length > 100)) ||
        (typeof numericValue !== 'number' && typeof numericValue !== 'string')
    ) {
        res.status(400).json({
            success: false,
            message: `${field} must be a positive concept ID or graph concept ID.`
        });
        return null;
    }

    return typeof numericValue === 'string'
        ? numericValue.trim()
        : numericValue;
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

    const difficultyLevel = optionalText(
        req.body,
        'difficultyLevel',
        50,
        res
    );
    if (difficultyLevel === null) return;

    return saveSubmission(req, res, 'CONCEPT', {
        name,
        description,
        difficultyLevel
    });
});

router.post('/prerequisites', async (req, res) => {
    if (!requireStudent(req, res) || !validateBody(req, res)) {
        return;
    }

    const prerequisiteId = conceptReference(req.body, 'prerequisiteId', res);
    if (prerequisiteId === null) return;

    const targetId = conceptReference(req.body, 'targetId', res);
    if (targetId === null) return;

    try {
        const prerequisite = await resolveConceptReference(prerequisiteId);
        const target = await resolveConceptReference(targetId);

        if (!prerequisite || !target) {
            return res.status(400).json({
                success: false,
                message: 'Both concepts must exist before proposing a prerequisite.'
            });
        }

        if (prerequisite.concept_id === target.concept_id) {
            return res.status(400).json({
                success: false,
                message: 'A concept cannot be its own prerequisite.'
            });
        }

        return saveSubmission(req, res, 'PREREQUISITE', {
            prerequisiteId,
            targetId
        });
    } catch (error) {
        console.error('[Submissions] Could not validate concepts:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Could not validate the concepts.'
        });
    }
});

router.post('/resources', async (req, res) => {
    if (!requireStudent(req, res) || !validateBody(req, res)) {
        return;
    }

    const conceptId = conceptReference(req.body, 'conceptId', res);
    if (conceptId === null) return;

    const title = requiredText(req.body, 'title', 255, res);
    if (title === null) return;

    const type = requiredText(req.body, 'type', 50, res);
    if (type === null) return;

    const url = requiredText(req.body, 'url', 500, res);
    if (url === null) return;

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        return res.status(400).json({
            success: false,
            message: 'url must be a valid HTTP or HTTPS URL.'
        });
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return res.status(400).json({
            success: false,
            message: 'url must be a valid HTTP or HTTPS URL.'
        });
    }

    try {
        const concept = await resolveConceptReference(conceptId);
        if (!concept) {
            return res.status(400).json({
                success: false,
                message: 'The resource concept must already exist.'
            });
        }

        return saveSubmission(req, res, 'RESOURCE', {
            conceptId,
            title,
            type,
            url: parsedUrl.toString()
        });
    } catch (error) {
        console.error('[Submissions] Could not validate resource concept:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Could not validate the resource concept.'
        });
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
