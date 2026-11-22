'use strict';

const express = require('express');
const authenticateToken = require('../middleware/authenticateToken');
const path = require('path');
const crypto = require('crypto');
const fsPromises = require('fs/promises');
const { upload: uploadResourceDocument, uploadFolder, validateDocument, removeUploadedFile, maxFileSize } = require('../middleware/resourceDocumentUpload');
const { createPendingSubmission, createPendingCourseSubmission, createPendingResourceSubmission, getLearnerSubmissions, getApprovedCourseConceptOptions, validateResourceCourseConcept } = require('../services/knowledgeSubmissionService');
const { processDocument, removeProcessedText } = require('../services/documentProcessingService');

const router = express.Router();
const projectRoot = path.resolve(__dirname, '../../..');
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

router.post('/courses', async (req, res) => {
    if (!requireStudent(req, res) || !validateBody(req, res)) return;
    const title = requiredText(req.body, 'title', 200, res);
    if (title === null) return;
    const description = optionalText(req.body, 'description', 5000, res);
    if (description === null) return;
    try {
        const submission = await createPendingCourseSubmission({
            title,
            description,
            learnerId: req.user.learner_id
        });
        return res.status(201).json({ success: true, submission });
    } catch (error) {
        if (error.name === 'ApprovalError') return res.status(error.status).json({ success: false, code: error.code, message: error.message });
        console.error('[Submissions] Could not create course submission:', error.code || 'course_submission_failed');
        return res.status(500).json({ success: false, message: 'Could not save the course proposal.' });
    }
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

router.get('/resource-options', async (req, res) => {
    if (!requireStudent(req, res)) return;
    try {
        const courses = await getApprovedCourseConceptOptions();
        return res.json({ success: true, courses });
    } catch (error) {
        console.error('[Submissions] Could not load approved resource options:', error.code || 'resource_options_unavailable');
        return res.status(503).json({ success: false, message: 'Approved courses and concepts could not be loaded.' });
    }
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
    if (!req.file) return res.status(400).json({ success: false, message: 'Please select a PDF, PowerPoint or Word document.' });
    const courseId = typeof req.body.courseId === 'string' ? req.body.courseId.trim() : '';
    const conceptId = typeof req.body.conceptId === 'string' ? req.body.conceptId.trim() : '';
    if (!courseId || !conceptId) return fail(400, 'Select an approved course and concept for this document.');
    let validAssociation;
    try {
        validAssociation = await validateResourceCourseConcept(courseId, conceptId);
    } catch (error) {
        console.error('[Submissions] Resource course-concept validation failed:', error.code || 'association_lookup_failed');
        return fail(503, 'The selected course and concept could not be validated. Please retry.');
    }
    if (!validAssociation) {
        return fail(422, 'The selected concept is not associated with the selected approved course.');
    }
    const idempotencyKey = req.get('Idempotency-Key');
    if (typeof idempotencyKey !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
        return fail(400, 'A valid submission retry key is required. Refresh the form and try again.');
    }
    try {
        await validateDocument(req.file);
    } catch (error) {
        return fail(400, error.message);
    }

    const title = requiredText(req.body, 'title', 255, res);
    if (title === null) { await removeUploadedFile(req.file); return; }

    const extension = path.extname(req.file.originalname).toLowerCase();
    const documentType = ['.ppt', '.pptx'].includes(extension) ? 'PowerPoint' : ['.doc', '.docx'].includes(extension) ? 'Word' : 'PDF';

    let processingStatus = 'failed';
    if (['.pdf', '.docx', '.pptx'].includes(extension)) {
        try {
            await processDocument(req.file.path);
            processingStatus = 'processed';
        } catch (error) {
            // Preserve the review submission, but never present failed extraction as study-ready.
            console.error('[Submissions] Resource document processing failed:', error.message);
            await removeProcessedText(req.file.path).catch(() => {});
        }
    }

    try {
        const storedName = path.basename(req.file.filename);
        const fileDigest = crypto.createHash('sha256').update(await fsPromises.readFile(req.file.path)).digest('hex');
        const fingerprint = crypto.createHash('sha256')
            .update(JSON.stringify([title, courseId, conceptId, extension, fileDigest]))
            .digest('hex');
        const outcome = await createPendingResourceSubmission({
            learnerId: req.user.learner_id,
            title,
            courseId,
            conceptId,
            idempotencyKey,
            fingerprint,
            document: {
                filename: storedName,
                originalName: path.basename(req.file.originalname).slice(0, 255),
                extension,
                documentType,
                size: req.file.size,
                filePath: path.relative(projectRoot, req.file.path),
                processingStatus
            }
        });
        if (outcome.replayed) {
            await removeProcessedText(req.file.path).catch(() => {});
            await removeUploadedFile(req.file).catch(error => console.error('[Submissions] Retry upload cleanup failed:', error.message));
        }
        const processingFailed = outcome.processingStatus !== 'processed';
        const message = processingFailed
            ? 'Your resource was submitted for review, but its document could not be processed and will not be available in the Study Workspace.'
            : 'Your learning resource was submitted for administrator review.';
        return res.status(outcome.replayed ? 200 : 201).json({
            success: true,
            submission: outcome.submission,
            replayed: outcome.replayed,
            processingStatus: outcome.processingStatus,
            message
        });
    } catch (error) {
        if (error.outcomeUncertain) {
            console.error('[Submissions] Resource submission outcome could not be confirmed.');
            return res.status(503).json({ success: false, code: error.code, message: error.message });
        }
        console.error('[Submissions] Could not save resource submission:', error.message);
        await removeProcessedText(req.file.path).catch(() => {});
        return fail(error.status || 500, error.status && error.status < 500
            ? error.message
            : error.code === 'RESOURCE_SUBMISSION_BUSY'
                ? error.message
                : 'Could not save the resource submission.');
    }
});

router.get('/resources/:submissionId/document', async (req, res) => {
    const submissionId = Number(req.params.submissionId);
    if (!Number.isSafeInteger(submissionId) || submissionId < 1) return res.status(400).json({ success: false, message: 'Invalid submission ID.' });
    try {
        const [rows] = await require('../config/mysql').execute(
            `SELECT s.submitted_by, s.submission_data, s.status,
                    ud.processing_status,
                    EXISTS (
                        SELECT 1
                        FROM learning_resource AS lr
                        INNER JOIN concept_course AS association ON association.concept_id = lr.concept_id
                        INNER JOIN course AS approved_course ON approved_course.graph_course_id = association.course_graph_id
                        WHERE lr.file_url = CONCAT('/api/submissions/resources/', s.submission_id, '/document')
                    ) AS shared_resource
             FROM knowledge_submissions AS s
             LEFT JOIN uploaded_document AS ud
               ON JSON_UNQUOTE(JSON_EXTRACT(s.submission_data, '$.document.documentId')) = CAST(ud.document_id AS CHAR)
             WHERE s.submission_id = ? AND s.submission_type = 'RESOURCE'`, [submissionId]
        );
        if (!rows.length) return res.status(404).json({ success: false, message: 'Document not found.' });
        const row = rows[0];
        const isOwner = Number(row.submitted_by) === Number(req.user.learner_id);
        const isApprovedShared = row.status === 'approved' && row.processing_status === 'processed' && Number(row.shared_resource) === 1;
        if (req.user.role !== 'admin' && !isOwner && !isApprovedShared) return res.status(403).json({ success: false, message: 'You are not allowed to access this document.' });
        const data = typeof row.submission_data === 'string' ? JSON.parse(row.submission_data) : row.submission_data;
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
