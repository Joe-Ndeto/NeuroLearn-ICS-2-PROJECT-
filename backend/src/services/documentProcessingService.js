'use strict';

const path = require('path');
const { execFile } = require('child_process');

const projectRoot = path.resolve(__dirname, '../../..');
const processorScript = path.join(projectRoot, 'ai-service', 'document_processor.py');
const processedFolder = path.join(projectRoot, 'storage', 'processed');

class DocumentProcessingError extends Error {
    constructor(code, message, cause) {
        super(message, { cause });
        this.name = 'DocumentProcessingError';
        this.code = code;
    }
}

function resolvePythonExecutable({ env = process.env, platform = process.platform, root = projectRoot } = {}) {
    const configured = typeof env.PYTHON_EXECUTABLE === 'string'
        ? env.PYTHON_EXECUTABLE.trim()
        : '';
    if (configured) return configured;

    const executable = platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
    return path.join(root, 'ai-service', '.venv', executable);
}

function processDocument(filePath, {
    executable = resolvePythonExecutable(),
    execFileImpl = execFile
} = {}) {
    return new Promise((resolve, reject) => {
        execFileImpl(executable, [processorScript, filePath], error => {
            if (error?.code === 'ENOENT') {
                reject(new DocumentProcessingError(
                    'PYTHON_EXECUTABLE_UNAVAILABLE',
                    'Document processing is unavailable. Configure PYTHON_EXECUTABLE and install ai-service/requirements.txt.',
                    error
                ));
            } else if (error) {
                reject(new DocumentProcessingError(
                    'DOCUMENT_PROCESSING_FAILED',
                    'The document could not be processed. Check the Python runtime and document dependencies.',
                    error
                ));
            }
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

module.exports = {
    DocumentProcessingError,
    processDocument,
    removeProcessedText,
    resolvePythonExecutable
};
