'use strict';

const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { inflateRawSync } = require('zlib');

const projectRoot = path.resolve(__dirname, '../../..');
const uploadFolder = path.join(projectRoot, 'storage', 'resource-submissions');
const maxFileSize = Number(process.env.RESOURCE_UPLOAD_MAX_BYTES || 10 * 1024 * 1024);
const supportedExtensions = Object.freeze(['.pdf', '.docx', '.pptx']);
const MAX_OPENXML_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_OPENXML_TOTAL_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_OPENXML_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_OPENXML_XML_BYTES = 8 * 1024 * 1024;
const MAX_OPENXML_ENTRIES = 2048;
const MAX_COMPRESSION_RATIO = 200;
fs.mkdirSync(uploadFolder, { recursive: true });

function isSupportedDocumentExtension(extension) {
    return supportedExtensions.includes(String(extension || '').toLowerCase());
}

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, callback) => callback(null, uploadFolder),
        filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
    }),
    limits: { fileSize: Number.isSafeInteger(maxFileSize) && maxFileSize > 0 ? maxFileSize : 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
        if (!isSupportedDocumentExtension(path.extname(file.originalname))) {
            return callback(new Error('Only PDF, DOCX and PPTX files can be processed.'));
        }
        callback(null, true);
    }
});

async function validateDocument(file) {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!isSupportedDocumentExtension(extension)) {
        throw new Error('Only PDF, DOCX and PPTX files can be processed.');
    }
    const handle = await fs.promises.open(file.path, 'r');
    try {
        const signature = Buffer.alloc(8);
        const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
        const bytes = signature.subarray(0, bytesRead);
        if (extension === '.pdf') {
            if (bytes.subarray(0, 5).toString() !== '%PDF-') {
                throw new Error('The selected file does not match a processable PDF, DOCX or PPTX document.');
            }
            return;
        }

        const stat = await handle.stat();
        const archiveLimit = Math.min(
            Number.isSafeInteger(maxFileSize) && maxFileSize > 0 ? maxFileSize : 10 * 1024 * 1024,
            MAX_OPENXML_ARCHIVE_BYTES
        );
        if (stat.size > archiveLimit) {
            throw new Error('The Office document archive exceeds the validation size limit.');
        }
        if (!isZipSignature(bytes)) {
            throw new Error('The selected file is not a valid DOCX or PPTX package.');
        }
        const archive = await fs.promises.readFile(file.path);
        validateOpenXmlPackage(archive, extension);
    } finally {
        await handle.close();
    }
}

function isZipSignature(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
        [0x03, 0x05, 0x07].includes(bytes[2]) && [0x04, 0x06, 0x08].includes(bytes[3]);
}

function validateOpenXmlPackage(archive, extension) {
    const parts = readZipDirectory(archive);
    for (const entry of parts.values()) {
        if (!entry.isDirectory) readZipEntry(archive, entry, MAX_OPENXML_ENTRY_BYTES);
    }
    const word = extension === '.docx';
    const mainPart = word ? 'word/document.xml' : 'ppt/presentation.xml';
    const mainContentType = word
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
        : 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
    const mainRoot = word ? /<w:document(?:\s|>)/ : /<p:presentation(?:\s|>)/;
    const contentTypes = stripXmlCommentsAndCdata(readZipEntry(archive, requireZipPart(parts, '[Content_Types].xml'), MAX_OPENXML_XML_BYTES).toString('utf8'));
    const rootRelationships = stripXmlCommentsAndCdata(readZipEntry(archive, requireZipPart(parts, '_rels/.rels'), MAX_OPENXML_XML_BYTES).toString('utf8'));
    const mainDocument = stripXmlCommentsAndCdata(readZipEntry(archive, requireZipPart(parts, mainPart), MAX_OPENXML_ENTRY_BYTES).toString('utf8'));
    const contentTypeRoot = assertWellFormedXml(contentTypes);
    const relationshipsRoot = assertWellFormedXml(rootRelationships);
    const mainDocumentRoot = assertWellFormedXml(mainDocument);

    const defaults = xmlElements(contentTypes, 'Default');
    const hasRelationshipsType = defaults.some(attributes =>
        attributes.Extension?.toLowerCase() === 'rels' &&
        attributes.ContentType === 'application/vnd.openxmlformats-package.relationships+xml'
    );
    const hasXmlType = defaults.some(attributes =>
        attributes.Extension?.toLowerCase() === 'xml' && attributes.ContentType === 'application/xml'
    );
    const hasMainType = xmlElements(contentTypes, 'Override').some(attributes =>
        attributes.PartName === `/${mainPart}` && attributes.ContentType === mainContentType
    );
    const contentTypesNamespace = xmlElements(contentTypes, 'Types')[0]?.xmlns === 'http://schemas.openxmlformats.org/package/2006/content-types';
    const relationshipsNamespace = xmlElements(rootRelationships, 'Relationships')[0]?.xmlns === 'http://schemas.openxmlformats.org/package/2006/relationships';
    const mainNamespace = xmlElements(mainDocument, word ? 'w:document' : 'p:presentation')[0]?.[word ? 'xmlns:w' : 'xmlns:p'] ===
        (word ? 'http://schemas.openxmlformats.org/wordprocessingml/2006/main' : 'http://schemas.openxmlformats.org/presentationml/2006/main');
    const hasOfficeDocumentRelationship = xmlElements(rootRelationships, 'Relationship').some(attributes =>
        attributes.Type === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' &&
        attributes.Target?.replace(/^\//, '') === mainPart
    );

    const hasMainStructure = word
        ? /<w:body(?:\s|\/?>)/.test(mainDocument)
        : /<p:sldIdLst(?:\s|\/?>)/.test(mainDocument);
    if (contentTypeRoot !== 'Types' || relationshipsRoot !== 'Relationships' || !contentTypesNamespace ||
        !relationshipsNamespace || !mainNamespace ||
        mainDocumentRoot !== (word ? 'w:document' : 'p:presentation') || !hasRelationshipsType ||
        !hasXmlType || !hasMainType || !hasOfficeDocumentRelationship || !mainRoot.test(mainDocument) || !hasMainStructure) {
        throw new Error(`The selected file is not a complete OOXML ${word ? 'Word' : 'PowerPoint'} package.`);
    }
}

function stripXmlCommentsAndCdata(xml) {
    return xml.replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\?[\s\S]*?\?>/g, ' ')
        .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
}

function assertWellFormedXml(xml) {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('OOXML parts cannot contain document type declarations.');
    const source = xml;
    if (/<!--|-->|<\?|<!\[CDATA\[|\]\]>/.test(source)) throw new Error('The OOXML package contains malformed XML.');

    const tags = source.match(/<[^>]*>/g) || [];
    const remainder = source.replace(/<[^>]*>/g, '');
    if (remainder.includes('<')) throw new Error('The OOXML package contains malformed XML.');

    const stack = [];
    let root = null;
    let roots = 0;
    for (const tag of tags) {
        const match = tag.match(/^<(\/)?([A-Za-z_:][\w:.-]*)([\s\S]*?)>$/);
        if (!match || match[3].startsWith('!') || match[3].startsWith('?')) {
            throw new Error('The OOXML package contains malformed XML.');
        }
        const closing = Boolean(match[1]);
        const name = match[2];
        const suffix = match[3];
        if (closing) {
            if (suffix.trim() || stack.pop() !== name) throw new Error('The OOXML package contains malformed XML.');
            continue;
        }
        const selfClosing = /\/\s*$/.test(suffix);
        const attributes = selfClosing ? suffix.replace(/\/\s*$/, '') : suffix;
        const validAttributes = /^(?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*$/.test(attributes);
        if (!validAttributes) throw new Error('The OOXML package contains malformed XML.');
        if (!stack.length) {
            roots++;
            if (roots > 1) throw new Error('The OOXML package contains malformed XML.');
            root = name;
        }
        if (!selfClosing) stack.push(name);
    }
    if (stack.length || roots !== 1) throw new Error('The OOXML package contains malformed XML.');
    return root;
}

function readZipDirectory(archive) {
    const minOffset = Math.max(0, archive.length - 0xffff - 22);
    let endOffset = -1;
    for (let offset = archive.length - 22; offset >= minOffset; offset--) {
        if (archive.readUInt32LE(offset) === 0x06054b50) {
            const commentLength = archive.readUInt16LE(offset + 20);
            if (offset + 22 + commentLength === archive.length) {
                endOffset = offset;
                break;
            }
        }
    }
    if (endOffset < 0) throw new Error('The selected file is not a valid OOXML ZIP archive.');

    const disk = archive.readUInt16LE(endOffset + 4);
    const directoryDisk = archive.readUInt16LE(endOffset + 6);
    const diskEntryCount = archive.readUInt16LE(endOffset + 8);
    const entryCount = archive.readUInt16LE(endOffset + 10);
    const directorySize = archive.readUInt32LE(endOffset + 12);
    const directoryOffset = archive.readUInt32LE(endOffset + 16);
    if (disk !== 0 || directoryDisk !== 0 || diskEntryCount !== entryCount ||
        entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff ||
        entryCount > MAX_OPENXML_ENTRIES || directoryOffset + directorySize !== endOffset) {
        throw new Error('The selected file uses an unsupported or unsafe OOXML ZIP structure.');
    }

    const entries = new Map();
    let offset = directoryOffset;
    let totalUncompressed = 0;
    for (let index = 0; index < entryCount; index++) {
        if (offset + 46 > endOffset || archive.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error('The selected file has a malformed OOXML ZIP directory.');
        }
        const flags = archive.readUInt16LE(offset + 8);
        const method = archive.readUInt16LE(offset + 10);
        const crc = archive.readUInt32LE(offset + 16);
        const compressedSize = archive.readUInt32LE(offset + 20);
        const uncompressedSize = archive.readUInt32LE(offset + 24);
        const nameLength = archive.readUInt16LE(offset + 28);
        const extraLength = archive.readUInt16LE(offset + 30);
        const commentLength = archive.readUInt16LE(offset + 32);
        const startDisk = archive.readUInt16LE(offset + 34);
        const localOffset = archive.readUInt32LE(offset + 42);
        const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
        if (recordEnd > endOffset || startDisk !== 0 || compressedSize === 0xffffffff ||
            uncompressedSize === 0xffffffff || localOffset === 0xffffffff || (flags & 0x2041) !== 0 ||
            ![0, 8].includes(method)) {
            throw new Error('The selected file contains an unsupported or unsafe OOXML ZIP entry.');
        }

        const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
        let name;
        try {
            name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
        } catch {
            throw new Error('The selected file contains an invalid OOXML ZIP entry name.');
        }
        if (!name || name.includes('\\') || name.startsWith('/') ||
            name.split('/').some(segment => segment === '..') || entries.has(name)) {
            throw new Error('The selected file contains an unsafe or duplicate OOXML ZIP entry.');
        }

        const extraStart = offset + 46 + nameLength;
        for (let extraOffset = extraStart; extraOffset < extraStart + extraLength;) {
            if (extraOffset + 4 > extraStart + extraLength) throw new Error('The selected file has malformed OOXML ZIP metadata.');
            const extraId = archive.readUInt16LE(extraOffset);
            const extraSize = archive.readUInt16LE(extraOffset + 2);
            extraOffset += 4 + extraSize;
            if (extraOffset > extraStart + extraLength || extraId === 0x0001) {
                throw new Error('The selected file uses unsupported OOXML ZIP metadata.');
            }
        }

        const isDirectory = name.endsWith('/');
        if (!isDirectory) {
            totalUncompressed += uncompressedSize;
            if (uncompressedSize > MAX_OPENXML_ENTRY_BYTES || totalUncompressed > MAX_OPENXML_TOTAL_UNCOMPRESSED_BYTES ||
                (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO))) {
                throw new Error('The selected Office document archive exceeds safe decompression limits.');
            }
        } else if (compressedSize !== 0 || uncompressedSize !== 0) {
            throw new Error('The selected file contains an invalid OOXML ZIP directory entry.');
        }

        const localNameLength = localOffset + 30 <= directoryOffset && archive.readUInt32LE(localOffset) === 0x04034b50
            ? archive.readUInt16LE(localOffset + 26)
            : -1;
        if (localNameLength < 0 || localOffset + 30 + localNameLength > directoryOffset) {
            throw new Error('The selected file has a malformed OOXML ZIP entry header.');
        }
        const localExtraLength = archive.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength);
        if (!localName.equals(nameBytes) || archive.readUInt16LE(localOffset + 6) !== flags ||
            archive.readUInt16LE(localOffset + 8) !== method || dataStart + compressedSize > directoryOffset) {
            throw new Error('The selected file has inconsistent OOXML ZIP entry metadata.');
        }

        entries.set(name, { name, flags, method, crc, compressedSize, uncompressedSize, dataStart, isDirectory });
        offset = recordEnd;
    }
    if (offset !== directoryOffset + directorySize) throw new Error('The selected file has an incomplete OOXML ZIP directory.');
    return entries;
}

function requireZipPart(entries, name) {
    const entry = entries.get(name);
    if (!entry || entry.isDirectory) throw new Error(`The OOXML package is missing required part ${name}.`);
    return entry;
}

function readZipEntry(archive, entry, maxOutputBytes) {
    if (entry.uncompressedSize > maxOutputBytes) throw new Error('The OOXML package metadata exceeds the validation limit.');
    const compressed = archive.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    let content;
    try {
        content = entry.method === 0
            ? Buffer.from(compressed)
            : inflateRawSync(compressed, { maxOutputLength: maxOutputBytes });
    } catch {
        throw new Error('The OOXML package contains a malformed compressed part.');
    }
    if (content.length !== entry.uncompressedSize || crc32(content) !== entry.crc) {
        throw new Error('The OOXML package contains a corrupt part.');
    }
    return content;
}

function xmlElements(xml, name) {
    const elements = [];
    const expression = new RegExp(`<${name}\\b([^>]*)\\/?\\s*>`, 'g');
    let match;
    while ((match = expression.exec(xml))) {
        const attributes = {};
        const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let attribute;
        while ((attribute = attributePattern.exec(match[1]))) {
            attributes[attribute[1]] = attribute[2] ?? attribute[3];
        }
        elements.push(attributes);
    }
    return elements;
}

const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function removeUploadedFile(file) {
    if (!file?.path) return Promise.resolve();
    return fs.promises.unlink(file.path).catch(error => {
        if (error.code !== 'ENOENT') throw error;
    });
}

module.exports = {
    upload,
    uploadFolder,
    validateDocument,
    removeUploadedFile,
    isSupportedDocumentExtension,
    supportedExtensions,
    maxFileSize,
    validateOpenXmlPackage
};
