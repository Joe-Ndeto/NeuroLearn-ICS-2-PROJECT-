'use strict';

const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const path = require('path');

const projectRoot = path.resolve(__dirname, '../../..');
const uploadFolder = path.join(projectRoot, 'storage', 'resource-submissions');
const maxFileSize = Number(process.env.RESOURCE_UPLOAD_MAX_BYTES || 10 * 1024 * 1024);
const extensions = new Set(['.pdf', '.ppt', '.pptx', '.doc', '.docx']);
fs.mkdirSync(uploadFolder, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, callback) => callback(null, uploadFolder),
        filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
    }),
    limits: { fileSize: Number.isSafeInteger(maxFileSize) && maxFileSize > 0 ? maxFileSize : 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
        if (!extensions.has(path.extname(file.originalname).toLowerCase())) return callback(new Error('Only PDF, PowerPoint and Word documents are supported.'));
        callback(null, true);
    }
});

async function validateDocument(file) {
    const extension = path.extname(file.originalname).toLowerCase();
    const handle = await fs.promises.open(file.path, 'r');
    try {
        const signature = Buffer.alloc(8);
        const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
        const bytes = signature.subarray(0, bytesRead);
        const isPdf = extension === '.pdf' && bytes.subarray(0, 5).toString() === '%PDF-';
        const isLegacyOffice = ['.doc', '.ppt'].includes(extension) && bytes.length >= 8 && bytes.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
        const isOpenXml = ['.docx', '.pptx'].includes(extension) && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]) && [0x04, 0x06, 0x08].includes(bytes[3]);
        if (!isPdf && !isLegacyOffice && !isOpenXml) throw new Error('The selected file does not match a supported PDF, PowerPoint or Word document.');
    } finally {
        await handle.close();
    }
}

function removeUploadedFile(file) {
    if (!file?.path) return Promise.resolve();
    return fs.promises.unlink(file.path).catch(error => {
        if (error.code !== 'ENOENT') throw error;
    });
}

module.exports = { upload, uploadFolder, validateDocument, removeUploadedFile, maxFileSize };
