
'use strict';

require('dotenv').config();

const { spawn } = require('node:child_process');
const path = require('node:path');

const app = require('./app');
const mysql = require('./config/mysql');

const {
    initializeKnowledgeGraph
} = require('./services/knowledgeGraphService');

const {
    closeNeo4jConnection
} = require('./config/neo4j');

const PORT = process.env.PORT || 5000;

let server = null;
let workerProcess = null;
let shuttingDown = false;

function startKnowledgeSyncWorker() {
    console.log('[NeuroLearn] Starting knowledge synchronization worker...');

    workerProcess = spawn(
        process.execPath,
        [path.join(__dirname, 'workers', 'knowledgeSyncWorker.js')],
        {
            cwd: path.resolve(__dirname, '..'),
            env: {
                ...process.env,
                KNOWLEDGE_SYNC_CONCURRENCY:
                    process.env.KNOWLEDGE_SYNC_CONCURRENCY || '1',
                KNOWLEDGE_SYNC_BATCH_SIZE:
                    process.env.KNOWLEDGE_SYNC_BATCH_SIZE || '1',
                KNOWLEDGE_SYNC_POLL_INTERVAL_MS:
                    process.env.KNOWLEDGE_SYNC_POLL_INTERVAL_MS || '5000'
            },
            stdio: 'inherit'
        }
    );

    workerProcess.on('error', error => {
        console.error(
            '[NeuroLearn] Knowledge worker process error:',
            error.message
        );
    });

    workerProcess.on('exit', (code, signal) => {
        if (!shuttingDown) {
            console.error(
                `[NeuroLearn] Knowledge worker stopped unexpectedly. ` +
                `Code: ${code}, Signal: ${signal}`
            );
        }
    });
}

async function stopKnowledgeSyncWorker() {
    if (
        !workerProcess ||
        workerProcess.exitCode !== null ||
        workerProcess.signalCode !== null
    ) {
        return;
    }

    await new Promise(resolve => {
        const timeout = setTimeout(() => {
            console.error(
                '[NeuroLearn] Worker did not stop in time. Forcing shutdown.'
            );
            workerProcess.kill('SIGKILL');
        }, 10000);

        timeout.unref();

        workerProcess.once('exit', () => {
            clearTimeout(timeout);
            resolve();
        });

        workerProcess.kill('SIGTERM');
    });
}

async function shutdown(signal) {
    if (shuttingDown) return;

    shuttingDown = true;

    console.log(`[NeuroLearn] Received ${signal}. Shutting down...`);

    if (server && server.listening) {
        await new Promise(resolve => server.close(resolve));
    }

    await stopKnowledgeSyncWorker();

    try {
        if (typeof mysql.end === 'function') {
            await mysql.end();
        }

        await closeNeo4jConnection();

        console.log('[NeuroLearn] Shutdown completed.');
        process.exit(0);
    } catch (error) {
        console.error(
            '[NeuroLearn] Shutdown error:',
            error.message
        );
        process.exit(1);
    }
}

process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
    void shutdown('SIGINT');
});

async function startServer() {
    try {
        await initializeKnowledgeGraph();

        server = app.listen(PORT, () => {
            console.log(
                `NeuroLearn backend running on port ${PORT}`
            );

            startKnowledgeSyncWorker();
        });

    } catch (error) {
        console.error('Failed to start NeuroLearn:', error);

        try {
            if (typeof mysql.end === 'function') {
                await mysql.end();
            }

            await closeNeo4jConnection();
        } catch (cleanupError) {
            console.error(
                '[NeuroLearn] Startup cleanup failed:',
                cleanupError.message
            );
        }

        process.exit(1);
    }
}

startServer();
