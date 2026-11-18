'use strict';

const express = require('express');
const authenticateToken = require('../middleware/authenticateToken');
const requireAdmin = require('../middleware/requireAdmin');
const {
    getAdminSubmission,
    getAdminSubmissions,
    reviewPendingSubmission
} = require('../services/knowledgeSubmissionService');

const router = express.Router();
const VALID_STATUSES = new Set(['pending', 'approved', 'rejected']);
const VALID_TYPES = new Set(['CONCEPT', 'PREREQUISITE', 'RESOURCE']);
const REVIEW_NOTE_MAX_LENGTH = 5000;

router.use(authenticateToken, requireAdmin);

function validatePositiveInteger(value, fallback, maximum) {
    if (value === undefined) {
        return fallback;
    }

    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
        return null;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed <= maximum
        ? parsed
        : null;
}

function parseSubmissionId(value) {
    if (!/^[1-9]\d*$/.test(value)) {
        return null;
    }

    const submissionId = Number(value);
    return Number.isSafeInteger(submissionId) ? submissionId : null;
}

function validateReviewBody(req, res) {
    const body = req.body === undefined ? {} : req.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({
            success: false,
            message: 'A JSON object is required.'
        });
        return undefined;
    }

    if (
        Object.prototype.hasOwnProperty.call(body, 'status') ||
        Object.prototype.hasOwnProperty.call(body, 'reviewed_by') ||
        Object.prototype.hasOwnProperty.call(body, 'reviewedBy') ||
        Object.prototype.hasOwnProperty.call(body, 'reviewed_at') ||
        Object.prototype.hasOwnProperty.call(body, 'reviewedAt')
    ) {
        res.status(400).json({
            success: false,
            message: 'Review status, reviewer, and review time are managed by NeuroLearn.'
        });
        return undefined;
    }

    if (body.reviewNotes === undefined || body.reviewNotes === null) {
        return null;
    }

    if (
        typeof body.reviewNotes !== 'string' ||
        body.reviewNotes.trim().length > REVIEW_NOTE_MAX_LENGTH
    ) {
        res.status(400).json({
            success: false,
            message: `reviewNotes must be text no longer than ${REVIEW_NOTE_MAX_LENGTH} characters.`
        });
        return undefined;
    }

    return body.reviewNotes.trim() || null;
}

router.get('/', async (req, res) => {
    const page = validatePositiveInteger(
        req.query.page,
        1,
        Number.MAX_SAFE_INTEGER
    );
    const limit = validatePositiveInteger(req.query.limit, 20, 100);
    const { status, type } = req.query;

    if (page === null || limit === null) {
        return res.status(400).json({
            success: false,
            message: 'page must be a positive integer and limit must be between 1 and 100.'
        });
    }

    if (status !== undefined &&
        (typeof status !== 'string' || !VALID_STATUSES.has(status))) {
        return res.status(400).json({
            success: false,
            message: 'status must be pending, approved, or rejected.'
        });
    }

    if (type !== undefined &&
        (typeof type !== 'string' || !VALID_TYPES.has(type))) {
        return res.status(400).json({
            success: false,
            message: 'type must be CONCEPT, PREREQUISITE, or RESOURCE.'
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
        const result = await getAdminSubmissions({
            status,
            type,
            limit,
            offset
        });

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
        console.error('[Admin submissions] List failed:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Could not retrieve submissions.'
        });
    }
});

router.get('/:id', async (req, res) => {
    const submissionId = parseSubmissionId(req.params.id);
    if (submissionId === null) {
        return res.status(400).json({
            success: false,
            message: 'A valid submission ID is required.'
        });
    }

    try {
        const submission = await getAdminSubmission(submissionId);
        if (!submission) {
            return res.status(404).json({
                success: false,
                message: 'Submission not found.'
            });
        }

        return res.json({ success: true, submission });
    } catch (error) {
        console.error('[Admin submissions] Detail failed:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Could not retrieve the submission.'
        });
    }
});

async function reviewSubmission(req, res, status) {
    const submissionId = parseSubmissionId(req.params.id);
    if (submissionId === null) {
        return res.status(400).json({
            success: false,
            message: 'A valid submission ID is required.'
        });
    }

    const reviewNotes = validateReviewBody(req, res);
    if (reviewNotes === undefined) {
        return;
    }

    try {
        const result = await reviewPendingSubmission({
            submissionId,
            status,
            reviewNotes,
            reviewerId: req.user.learner_id
        });

        if (result.outcome === 'not_found') {
            return res.status(404).json({
                success: false,
                message: 'Submission not found.'
            });
        }

        if (result.outcome === 'already_reviewed') {
            return res.status(409).json({
                success: false,
                message: 'This submission has already been reviewed.'
            });
        }

        return res.json({
            success: true,
            message: `Submission ${status}.`,
            submission: result.submission
        });
    } catch (error) {
        console.error('[Admin submissions] Review failed:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Could not review the submission.'
        });
    }
}

router.patch('/:id/approve', (req, res) =>
    reviewSubmission(req, res, 'approved')
);

router.patch('/:id/reject', (req, res) =>
    reviewSubmission(req, res, 'rejected')
);

module.exports = router;
