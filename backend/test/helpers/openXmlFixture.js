'use strict';

const { deflateRawSync } = require('node:zlib');

function makeOpenXmlParts(kind = 'docx', overrides = {}) {
    const isWord = kind === 'docx';
    const mainPart = isWord ? 'word/document.xml' : 'ppt/presentation.xml';
    const contentType = isWord
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
        : 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
    const root = isWord
        ? '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'
        : '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>';
    return {
        '[Content_Types].xml': Buffer.from(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${mainPart}" ContentType="${contentType}"/></Types>`),
        '_rels/.rels': Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainPart}"/></Relationships>`),
        [mainPart]: Buffer.from(root),
        ...overrides
    };
}

function crc32(buffer) {
    let value = 0xffffffff;
    for (const byte of buffer) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    return (value ^ 0xffffffff) >>> 0;
}

function makeZip(entries, compressedNames = new Set()) {
    const localRecords = [];
    const centralRecords = [];
    let localOffset = 0;
    for (const [name, content] of Object.entries(entries)) {
        const nameBytes = Buffer.from(name);
        const method = compressedNames.has(name) ? 8 : 0;
        const compressed = method === 8 ? deflateRawSync(content) : content;
        const checksum = crc32(content);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(content.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        localRecords.push(local, nameBytes, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(content.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(localOffset, 42);
        centralRecords.push(central, nameBytes);
        localOffset += local.length + nameBytes.length + compressed.length;
    }
    const directory = Buffer.concat(centralRecords);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(entries).length, 8);
    end.writeUInt16LE(Object.keys(entries).length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(localOffset, 16);
    return Buffer.concat([...localRecords, directory, end]);
}

module.exports = { makeOpenXmlParts, makeZip };
