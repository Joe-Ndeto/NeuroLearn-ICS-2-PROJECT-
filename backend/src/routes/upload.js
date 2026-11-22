'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const mysql = require('../config/mysql');
const authenticateToken = require('../middleware/authenticateToken');
const { processDocument } = require('../services/documentProcessingService');
const { getAllCourses } = require('../services/knowledgeGraphService');

const router = express.Router();

const projectRoot = path.resolve(__dirname, '../../..');

const uploadFolder = path.join(projectRoot, 'storage', 'uploads');

fs.mkdirSync(uploadFolder, { recursive: true });

// Configure uploaded file storage.
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadFolder);
    },

    filename: (req, file, cb) => {
        const uniqueName =
            `${Date.now()}-${path.basename(file.originalname)}`;

        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,

    limits: {
        fileSize: 10 * 1024 * 1024
    },

    fileFilter: (req, file, cb) => {
        const allowedTypes = ['.pdf', '.docx', '.pptx'];
        const extension = path.extname(file.originalname).toLowerCase();

        if (allowedTypes.includes(extension)) {
            cb(null, true);
        } else {
            cb(new Error(
                'Only PDF, DOCX and PPTX files are supported.'
            ));
        }
    }
});

// GET /api/upload
// Retrieve only documents belonging to the authenticated learner.
router.get('/', authenticateToken, async (req, res) => {
    const learnerId = req.user.learner_id;

    try {
        const [documents] = await mysql.execute(
            `SELECT
                document_id,
                filename,
                file_type,
                file_size,
                upload_date,
                processing_status
             FROM uploaded_document
             WHERE learner_id = ?
             ORDER BY upload_date DESC`,
            [learnerId]
        );

        return res.json({ documents });

    } catch (error) {
        console.error(
            'Could not retrieve documents:',
            error.message
        );

        return res.status(500).json({
            message: 'Unable to retrieve uploaded documents.'
        });
    }
});

// GET /api/upload/library?courseId=...
// Own uploads remain visible to their owner. Shared resources are returned
// only after approval, canonical course/concept association, and processing.
router.get('/library', authenticateToken, async (req, res) => {
    const learnerId = req.user.learner_id;
    const courseId = typeof req.query.courseId === 'string' ? req.query.courseId.trim() : '';
    try {
        let course = null;
        if (courseId) {
            const courses = await getAllCourses();
            const matches = Array.isArray(courses)
                ? courses.filter(item => item?.course_id === courseId)
                : [];
            if (matches.length !== 1) {
                return res.status(404).json({ success: false, message: 'The selected course is unavailable.' });
            }
            course = { courseId, name: matches[0].name };
        }

        const [ownRows] = await mysql.execute(
            `SELECT ud.document_id, ud.filename, ud.file_type, ud.file_size,
                    ud.upload_date, ud.processing_status,
                    (SELECT s.status FROM knowledge_submissions AS s
                     WHERE s.submission_type = 'RESOURCE'
                       AND s.submitted_by = ud.learner_id
                       AND JSON_UNQUOTE(JSON_EXTRACT(s.submission_data, '$.document.documentId')) = CAST(ud.document_id AS CHAR)
                     ORDER BY s.submission_id DESC LIMIT 1) AS resource_review_status
             FROM uploaded_document AS ud
             WHERE ud.learner_id = ?
             ORDER BY ud.upload_date DESC, ud.document_id DESC`,
            [learnerId]
        );

        let sharedRows = [];
        if (course) {
            const [rows] = await mysql.execute(
                `SELECT ud.document_id, ud.filename, ud.file_type, ud.file_size,
                        ud.upload_date, ud.processing_status, lr.resource_id,
                        lr.title, c.concept_id, c.concept_name, cc.course_graph_id
                 FROM learning_resource AS lr
                 INNER JOIN concept AS c ON c.concept_id = lr.concept_id
                 INNER JOIN concept_course AS cc ON cc.concept_id = c.concept_id
                 INNER JOIN course AS approved_course ON approved_course.graph_course_id = cc.course_graph_id
                 INNER JOIN knowledge_submissions AS s
                   ON s.submission_type = 'RESOURCE' AND s.status = 'approved'
                  AND lr.file_url = CONCAT('/api/submissions/resources/', s.submission_id, '/document')
                 INNER JOIN uploaded_document AS ud
                   ON JSON_UNQUOTE(JSON_EXTRACT(s.submission_data, '$.document.documentId')) = CAST(ud.document_id AS CHAR)
                 WHERE cc.course_graph_id = ? AND ud.processing_status = 'processed'
                 ORDER BY c.concept_name, lr.title, ud.document_id`,
                [course.courseId]
            );
            sharedRows = rows;
        }

        const sharedIds = new Set(sharedRows.map(row => Number(row.document_id)));
        const personalDocuments = ownRows
            .filter(row => !sharedIds.has(Number(row.document_id)) &&
                !(row.resource_review_status === 'approved' && row.processing_status === 'processed'))
            .map(row => ({
                documentId: Number(row.document_id),
                title: row.filename,
                filename: row.filename,
                fileType: row.file_type,
                fileSize: Number(row.file_size),
                processingStatus: row.processing_status,
                reviewStatus: row.resource_review_status || null,
                scope: 'personal',
                courseId: null,
                courseName: null,
                conceptId: null,
                conceptName: null
            }));
        const sharedDocuments = sharedRows.map(row => ({
            documentId: Number(row.document_id),
            resourceId: Number(row.resource_id),
            title: row.title,
            filename: row.filename,
            fileType: row.file_type,
            fileSize: Number(row.file_size),
            processingStatus: row.processing_status,
            reviewStatus: 'approved',
            scope: 'shared',
            courseId: row.course_graph_id,
            courseName: course.name,
            conceptId: Number(row.concept_id),
            conceptName: row.concept_name
        }));

        return res.json({ success: true, course, documents: [...sharedDocuments, ...personalDocuments] });
    } catch (error) {
        console.error('[Study Library] Could not load materials:', error.message);
        return res.status(503).json({ success: false, message: 'Study materials are temporarily unavailable.' });
    }
});

// POST /api/upload
// Authenticate before accepting or processing the uploaded file.
router.post(
    '/',
    authenticateToken,
    (req, res, next) => {
        // Must match formData.append('document', file) in study.js.
        upload.single('document')(req, res, error => {
            if (error) {
                const status =
                    error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;

                return res.status(status).json({
                    message: error.code === 'LIMIT_FILE_SIZE'
                        ? 'File size must not exceed 10 MB.'
                        : error.message
                });
            }

            next();
        });
    },
    async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                message: 'Please select a document to upload.'
            });
        }

        // Get the learner identity from the verified JWT session.
        const learnerId = req.user.learner_id;

        const extension = path.extname(
            req.file.originalname
        ).toLowerCase();

        const fileType = extension.substring(1);
        const filePath = path.relative(projectRoot, req.file.path);

        let documentId;

        try {
            const [result] = await mysql.execute(
                `INSERT INTO uploaded_document
                    (learner_id, filename, file_type, file_size,
                     file_path, processing_status)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    learnerId,
                    req.file.originalname,
                    fileType,
                    req.file.size,
                    filePath,
                    'uploaded'
                ]
            );

            documentId = result.insertId;

            try {
                await processDocument(req.file.path);

                await mysql.execute(
                    `UPDATE uploaded_document
                     SET processing_status = ?
                     WHERE document_id = ?
                     AND learner_id = ?`,
                    ['processed', documentId, learnerId]
                );

                return res.status(201).json({
                    message: 'Document uploaded and processed successfully.',
                    file: {
                        documentId,
                        originalName: req.file.originalname,
                        type: fileType,
                        size: req.file.size,
                        processingStatus: 'processed'
                    }
                });

            } catch (processingError) {
                console.error(
                    'Document processing failed:',
                    processingError.message
                );

                await mysql.execute(
                    `UPDATE uploaded_document
                     SET processing_status = ?
                     WHERE document_id = ?
                     AND learner_id = ?`,
                    ['failed', documentId, learnerId]
                );

                return res.status(500).json({
                    message: 'The document was uploaded, but processing failed.',
                    file: {
                        documentId,
                        originalName: req.file.originalname,
                        processingStatus: 'failed'
                    }
                });
            }

        } catch (error) {
            console.error('Upload error:', error.message);

            return res.status(500).json({
                message: 'Unable to save the uploaded document.'
            });
        }
    }
);

module.exports = router;
