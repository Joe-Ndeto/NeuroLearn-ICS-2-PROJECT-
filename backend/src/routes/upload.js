const express = require('express');
const multer = require('multer');
const path = require('path');
const { execFile } = require('child_process');

const mysql = require('../config/mysql');

const router = express.Router();

const projectRoot = path.resolve(__dirname, '../../..');

const pythonExecutable = path.join(
    projectRoot,
    'ai-service',
    '.venv',
    'Scripts',
    'python.exe'
);

const processorScript = path.join(
    projectRoot,
    'ai-service',
    'document_processor.py'
);

const uploadFolder = path.join(
    projectRoot,
    'storage',
    'uploads'
);

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadFolder);
    },

    filename: (req, file, cb) => {
        const uniqueName =
            `${Date.now()}-${file.originalname}`;

        cb(null, uniqueName);
    }
});

function processDocument(filePath) {
    return new Promise((resolve, reject) => {

        execFile(
            pythonExecutable,
            [
                processorScript,
                filePath
            ],
            (error, stdout, stderr) => {

                if (error) {
                    console.error(
                        'Python document processing failed:',
                        stderr || error.message
                    );

                    reject(error);
                    return;
                }

                console.log(
                    'Python document processor:',
                    stdout
                );

                resolve(stdout);
            }
        );
    });
}

const upload = multer({
    storage: storage,

    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            '.pdf',
            '.docx',
            '.pptx'
        ];

        const extension =
            path.extname(file.originalname).toLowerCase();

        if (allowedTypes.includes(extension)) {
            cb(null, true);
        } else {
            cb(
                new Error(
                    'Only PDF, DOCX and PPTX files are supported.'
                )
            );
        }
    }
});

router.post(
    '/',
    upload.single('document'),
    async (req, res) => {

        if (!req.file) {
            return res.status(400).json({
                message: 'No document was uploaded.'
            });
        }

        try {
            const extension =
                path.extname(req.file.originalname)
                    .toLowerCase();

            const fileType =
                extension.substring(1);

            const learnerId = 1;

            const filePath =
                path.relative(
                    projectRoot,
                    req.file.path
                );

            const query = `
                INSERT INTO uploaded_document
                (
                    learner_id,
                    filename,
                    file_type,
                    file_size,
                    file_path,
                    processing_status
                )
                VALUES (?, ?, ?, ?, ?, ?)
            `;

            await mysql.query(
    query,
    [
        learnerId,
        req.file.originalname,
        fileType,
        req.file.size,
        filePath,
        'uploaded'
    ]
);

try {
    await processDocument(req.file.path);

    await mysql.query(
        `
        UPDATE uploaded_document
        SET processing_status = ?
        WHERE document_id = (
            SELECT document_id
            FROM (
                SELECT document_id
                FROM uploaded_document
                WHERE learner_id = ?
                  AND filename = ?
                  AND file_path = ?
                ORDER BY document_id DESC
                LIMIT 1
            ) AS latest_document
        )
        `,
        [
            'processed',
            learnerId,
            req.file.originalname,
            filePath
        ]
    );

    res.status(201).json({
        message: 'Document uploaded and processed successfully.',
        file: {
            originalName: req.file.originalname,
            storedName: req.file.filename,
            path: filePath,
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

    await mysql.query(
        `
        UPDATE uploaded_document
        SET processing_status = ?
        WHERE document_id = (
            SELECT document_id
            FROM (
                SELECT document_id
                FROM uploaded_document
                WHERE learner_id = ?
                  AND filename = ?
                  AND file_path = ?
                ORDER BY document_id DESC
                LIMIT 1
            ) AS failed_document
        )
        `,
        [
            'failed',
            learnerId,
            req.file.originalname,
            filePath
        ]
    );

    res.status(500).json({
        message: 'Document uploaded, but processing failed.',
        file: {
            originalName: req.file.originalname,
            storedName: req.file.filename,
            processingStatus: 'failed'
        }
    });
}

            res.status(201).json({
                message: 'Document uploaded and metadata saved.',
                file: {
                    originalName: req.file.originalname,
                    storedName: req.file.filename,
                    path: filePath,
                    type: fileType,
                    size: req.file.size,
                    processingStatus: 'uploaded'
                }
            });

        } catch (error) {

            console.error(
                'Failed to save document metadata:',
                error.message
            );

            res.status(500).json({
                message: 'Document uploaded, but metadata could not be saved.'
            });
        }
    }
);

module.exports = router;