'use strict';

const express = require('express');
const authenticateToken = require('../middleware/authenticateToken');
const requireAdmin = require('../middleware/requireAdmin');
const { getWorkerHealth } = require('../services/workerHealthProxy');
const {
    getAdminSubmission,
    getAdminSubmissions,
    getOutboxStatistics,
    getDatabaseConceptOptions,
    createAdministratorPrerequisiteSubmission,
    retryFailedOutboxTask,
    reviewPendingSubmission
} = require('../services/knowledgeSubmissionService');

const router = express.Router();
const VALID_STATUSES = new Set(['pending', 'approved', 'rejected']);
const VALID_TYPES = new Set(['CONCEPT', 'PREREQUISITE', 'RESOURCE']);
const VALID_SYNC_STATUSES = new Set(['pending', 'processing', 'completed', 'failed']);
const REVIEW_NOTE_MAX_LENGTH = 5000;

router.use(authenticateToken, requireAdmin);

router.get('/worker-health', async (_req, res) => {
    const result = await getWorkerHealth();
    return res.status(result.status).json(result.body);
});

router.get('/database-concepts', async (_req, res) => {
    try {
        const result = await getDatabaseConceptOptions();
        return res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Admin submissions] Database concept lookup failed:', error.message);
        return res.status(error.status || 503).json({
            success: false,
            code: error.code || 'concept_lookup_failed',
            message: 'Database Concepts could not be loaded.'
        });
    }
});

router.post('/prerequisites', async (req, res) => {
    const prerequisiteId = req.body?.prerequisiteId;
    const targetId = req.body?.targetId;
    if (![prerequisiteId, targetId].every(value =>
        (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
        (typeof value === 'string' && /^[1-9]\d*$/.test(value)))) {
        return res.status(400).json({ success: false, message: 'Choose two existing Database Concepts.' });
    }
    try {
        const submission = await createAdministratorPrerequisiteSubmission({
            prerequisiteId,
            targetId,
            adminId: req.user.learner_id
        });
        return res.status(201).json({ success: true, submission });
    } catch (error) {
        if (error.name === 'ApprovalError') return res.status(error.status).json({ success: false, message: error.message, code: error.code });
        console.error('[Admin submissions] Prerequisite proposal failed:', error.message);
        return res.status(500).json({ success: false, message: 'Could not create the prerequisite proposal.' });
    }
});


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
    const { status, type, syncStatus } = req.query;

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

    if (syncStatus !== undefined &&
        (typeof syncStatus !== 'string' || !VALID_SYNC_STATUSES.has(syncStatus))) {
        return res.status(400).json({
            success: false,
            message: 'syncStatus must be pending, processing, completed, or failed.'
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
            syncStatus,
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

router.get('/outbox/stats', async (req, res) => {
    try {
        const stats = await getOutboxStatistics();
        return res.json({ success: true, stats });
    } catch (error) {
        console.error('[Admin submissions] Outbox statistics failed:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Could not retrieve synchronization statistics.'
        });
    }
});

router.post('/outbox/:id/retry', async (req, res) => {
    const outboxId = parseSubmissionId(req.params.id);
    if (outboxId === null) {
        return res.status(400).json({
            success: false,
            message: 'A valid outbox task ID is required.'
        });
    }

    try {
        const result = await retryFailedOutboxTask(outboxId);
        if (result.outcome === 'not_found') {
            return res.status(404).json({ success: false, message: 'Outbox task not found.' });
        }
        if (result.outcome === 'not_failed') {
            return res.status(409).json({
                success: false,
                message: 'Only failed synchronization tasks can be retried.'
            });
        }
        if (result.outcome === 'invalid_canonical_record') {
            return res.status(422).json({
                success: false,
                code: 'invalid_canonical_record',
                message: result.message || 'The canonical record is missing or invalid and cannot be retried.'
            });
        }
        if (result.outcome === 'commit_not_committed') {
            return res.status(503).json({
                success: false,
                code: 'retry_not_committed',
                message: 'The retry was not committed. Please retry the request.'
            });
        }
        if (result.outcome === 'commit_uncertain') {
            return res.status(503).json({
                success: false,
                code: 'retry_outcome_uncertain',
                message: 'The retry outcome could not be confirmed. Check synchronization status before retrying.'
            });
        }

        return res.json({
            success: true,
            message: 'Synchronization task queued for retry.',
            outboxId,
            sync: result.sync
        });
    } catch (error) {
        console.error('[Admin submissions] Outbox retry failed:', {
            outboxId,
            code: error.code || 'retry_failed'
        });
        return res.status(500).json({
            success: false,
            message: 'Could not retry the synchronization task.'
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
            reviewerId: req.user.learner_id,
            courseIds: status === 'approved' ? req.body?.courseIds : undefined,
            conceptId: status === 'approved' ? req.body?.conceptId : undefined,
            difficultyLevel: status === 'approved' ? req.body?.difficultyLevel : undefined
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
        if (error.name === 'ApprovalError') {
            return res.status(error.status).json({
                success: false,
                message: error.message,
                code: error.code
            });
        }

        console.error('[Admin submissions] Review failed:', {
            submissionId,
            code: error.code || 'review_failed'
        });
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
