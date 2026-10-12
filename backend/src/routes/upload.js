const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
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

fs.mkdirSync(uploadFolder, { recursive: true });

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

function processDocument(filePath) {
    return new Promise((resolve, reject) => {
        execFile(
            pythonExecutable,
            [processorScript, filePath],
            (error, stdout, stderr) => {
                if (error) {
                    console.error(
                        'Python processing failed:',
                        stderr || error.message
                    );
                    reject(error);
                    return;
                }

                console.log('Document processing:', stdout);
                resolve(stdout);
            }
        );
    });
}

router.post('/', (req, res, next) => {
    upload.single('document')(req, res, error => {
        if (error) {
            const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;

            return res.status(status).json({
                message: error.code === 'LIMIT_FILE_SIZE'
                    ? 'File size must not exceed 10 MB.'
                    : error.message
            });
        }

        next();
    });
}, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            message: 'Please select a document to upload.'
        });
    }

    // TEMPORARY: Replace with the authenticated learner ID
    // once server-side authentication is implemented.
    const learnerId = 1;

    const extension = path.extname(req.file.originalname).toLowerCase();
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
                 WHERE document_id = ?`,
                ['processed', documentId]
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
            await mysql.execute(
                `UPDATE uploaded_document
                 SET processing_status = ?
                 WHERE document_id = ?`,
                ['failed', documentId]
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
});

module.exports = router;