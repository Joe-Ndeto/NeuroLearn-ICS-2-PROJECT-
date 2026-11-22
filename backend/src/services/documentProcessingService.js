'use strict';

const path = require('path');
const { execFile } = require('child_process');

const projectRoot = path.resolve(__dirname, '../../..');
const pythonExecutable = path.join(projectRoot, 'ai-service', '.venv', 'Scripts', 'python.exe');
const processorScript = path.join(projectRoot, 'ai-service', 'document_processor.py');
const processedFolder = path.join(projectRoot, 'storage', 'processed');

function processDocument(filePath) {
    return new Promise((resolve, reject) => {
        execFile(pythonExecutable, [processorScript, filePath], error => {
            if (error) reject(error);
            else resolve();
        });
    });
}

async function removeProcessedText(filePath) {
    const textPath = path.join(processedFolder, `${path.parse(path.basename(filePath)).name}.txt`);
    try {
        await require('fs/promises').unlink(textPath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

module.exports = { processDocument, removeProcessedText };
