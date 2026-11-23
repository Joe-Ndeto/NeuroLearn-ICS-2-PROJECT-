'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { makeOpenXmlParts, makeZip } = require('./helpers/openXmlFixture');
const {
    uploadFolder,
    validateDocument,
    removeUploadedFile,
    isSupportedDocumentExtension,
    supportedExtensions,
    maxFileSize,
    validateOpenXmlPackage
} = require('../src/middleware/resourceDocumentUpload');

test('shared upload extension allowlist exactly matches the supported processor formats', () => {
    assert.deepEqual([...supportedExtensions], ['.pdf', '.docx', '.pptx']);
    for (const extension of supportedExtensions) assert.equal(isSupportedDocumentExtension(extension), true);
    for (const extension of ['.doc', '.ppt', '.exe']) assert.equal(isSupportedDocumentExtension(extension), false);
});

async function withFile(extension, bytes, callback) {
    const filename = `${cryptoRandom()}${extension}`;
    const fullPath = path.join(uploadFolder, filename);
    await fs.writeFile(fullPath, bytes);
    try { await callback({ path: fullPath, originalname: `student supplied/../unsafe${extension}`, filename, size: bytes.length }); }
    finally { await fs.rm(fullPath, { force: true }); }
}

function cryptoRandom() { return require('node:crypto').randomUUID(); }

test('valid OOXML Word and PowerPoint packages are accepted', async t => {
    for (const extension of ['.docx', '.pptx']) {
        await t.test(extension, () => withFile(extension, makeZip(makeOpenXmlParts(extension.slice(1))), validateDocument));
    }
    await t.test('deflated OOXML parts', () => {
        const parts = makeOpenXmlParts('docx');
        return withFile('.docx', makeZip(parts, new Set(Object.keys(parts))), validateDocument);
    });
});

test('generic ZIP files renamed to Office extensions are rejected', async () => {
    const genericZip = makeZip({ 'readme.txt': Buffer.from('not an Office package') });
    for (const extension of ['.docx', '.pptx']) {
        await withFile(extension, genericZip, async file => {
            await assert.rejects(validateDocument(file), /missing required part/);
        });
    }
});

test('missing package parts, incorrect declarations, and malformed archives are rejected', async t => {
    const word = makeOpenXmlParts('docx');
    const missingMain = { ...word };
    delete missingMain['word/document.xml'];
    const wrongType = makeOpenXmlParts('docx');
    wrongType['[Content_Types].xml'] = Buffer.from(wrongType['[Content_Types].xml'].toString().replace(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
        'application/xml'
    ));
    const malformedXml = makeOpenXmlParts('docx');
    malformedXml['word/document.xml'] = Buffer.from('<w:document><w:body></w:document>');
    for (const [name, content] of [
        ['missing main XML', makeZip(missingMain)],
        ['missing relationship', makeZip({ '[Content_Types].xml': word['[Content_Types].xml'], 'word/document.xml': word['word/document.xml'] })],
        ['wrong content type', makeZip(wrongType)],
        ['malformed XML part', makeZip(malformedXml)],
        ['malformed ZIP', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])]
    ]) {
        await t.test(name, async () => {
            await withFile('.docx', content, file => assert.rejects(validateDocument(file)));
        });
    }
});

test('suspicious compression ratios are rejected before decompression', async () => {
    const entries = makeOpenXmlParts('docx', { 'custom/data.bin': Buffer.alloc(1024 * 1024, 65) });
    const archive = makeZip(entries, new Set(['custom/data.bin']));
    await withFile('.docx', archive, file => assert.rejects(validateDocument(file), /decompression limits/));
});

test('oversized Office archives and invalid PDFs are rejected', async t => {
    await t.test('oversized package', async () => {
        const filename = `${cryptoRandom()}.docx`;
        const fullPath = path.join(uploadFolder, filename);
        const handle = await fs.open(fullPath, 'w');
        try {
            await handle.truncate(Math.min(maxFileSize, 50 * 1024 * 1024) + 1);
        } finally {
            await handle.close();
        }
        try {
            await assert.rejects(validateDocument({ path: fullPath, originalname: filename }), /size limit/);
        } finally {
            await fs.rm(fullPath, { force: true });
        }
    });
    await t.test('invalid PDF signature', async () => {
        await withFile('.pdf', Buffer.from('not a PDF'), file => assert.rejects(validateDocument(file), /does not match/));
    });
});

test('a rejected Office upload can be cleaned up from temporary storage', async () => {
    const genericZip = makeZip({ 'readme.txt': Buffer.from('not a DOCX') });
    await withFile('.docx', genericZip, async file => {
        await assert.rejects(validateDocument(file));
        await removeUploadedFile(file);
        await assert.rejects(fs.access(file.path));
    });
});

test('legacy Office formats and unsupported extensions are rejected before processing', async () => {
    for (const extension of ['.doc', '.ppt', '.exe']) {
        await withFile(extension, Buffer.from('content'), async file => {
            await assert.rejects(validateDocument(file), /Only PDF, DOCX and PPTX/);
        });
    }
});

test('unsupported or mismatched content is rejected and can be cleaned up', async () => {
    await withFile('.pdf', Buffer.from('not a PDF'), async file => {
        await assert.rejects(validateDocument(file), /does not match/);
        await removeUploadedFile(file);
        await assert.rejects(fs.access(file.path));
    });
    assert.ok(maxFileSize > 0 && maxFileSize <= 50 * 1024 * 1024);
});
