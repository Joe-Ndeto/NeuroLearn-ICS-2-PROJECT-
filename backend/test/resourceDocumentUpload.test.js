'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { uploadFolder, validateDocument, removeUploadedFile, maxFileSize } = require('../src/middleware/resourceDocumentUpload');

async function withFile(extension, bytes, callback) {
    const filename = `${cryptoRandom()}${extension}`;
    const fullPath = path.join(uploadFolder, filename);
    await fs.writeFile(fullPath, bytes);
    try { await callback({ path: fullPath, originalname: `student supplied/../unsafe${extension}`, filename, size: bytes.length }); }
    finally { await fs.rm(fullPath, { force: true }); }
}

function cryptoRandom() { return require('node:crypto').randomUUID(); }

test('valid PDF, PowerPoint and Word signatures are accepted regardless of client MIME metadata', async t => {
    const office = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
    const legacyOffice = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    for (const [extension, bytes] of [
        ['.pdf', Buffer.from('%PDF-1.7')], ['.pptx', office], ['.ppt', legacyOffice],
        ['.docx', office], ['.doc', legacyOffice]
    ]) await t.test(extension, () => withFile(extension, bytes, validateDocument));
});

test('unsupported or mismatched content is rejected and can be cleaned up', async () => {
    await withFile('.pdf', Buffer.from('not a PDF'), async file => {
        await assert.rejects(validateDocument(file), /does not match/);
        await removeUploadedFile(file);
        await assert.rejects(fs.access(file.path));
    });
    assert.ok(maxFileSize > 0 && maxFileSize <= 50 * 1024 * 1024);
});
