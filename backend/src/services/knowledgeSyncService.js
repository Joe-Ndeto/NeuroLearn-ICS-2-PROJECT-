'use strict';

const { randomUUID } = require('crypto');
const {
    CanonicalRecordValidationError,
    loadCanonicalRecord: loadAndValidateCanonicalRecord
} = require('./knowledgeCanonicalRecord');

const RECORD_TYPES = new Set(['CONCEPT', 'PREREQUISITE', 'RESOURCE']);
const ERROR_TEXT_LIMIT = 1000;

class PermanentSyncError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PermanentSyncError';
        this.retryable = false;
    }
}

class MissingGraphDependencyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MissingGraphDependencyError';
        this.retryable = true;
    }
}

function createKnowledgeSyncService({
    mysql,
    getNeo4jSession,
    config,
    makeToken = randomUUID,
    random = Math.random
}) {
    if (!mysql || typeof mysql.getConnection !== 'function' || typeof mysql.execute !== 'function') {
        throw new TypeError('A mysql2/promise pool is required.');
    }
    if (typeof getNeo4jSession !== 'function') {
        throw new TypeError('A Neo4j session factory is required.');
    }

    const settings = {
        batchSize: 5,
        maxAttempts: 8,
        leaseSeconds: 120,
        neo4jTransactionTimeoutMs: 30000,
        retryBaseSeconds: 5,
        retryMaxSeconds: 3600,
        ...config
    };

    async function claimTasks(limit = settings.batchSize) {
        const connection = await mysql.getConnection();
        let transactionStarted = false;
        let connectionReusable = true;
        let primaryError = null;
        try {
            await connection.beginTransaction();
            transactionStarted = true;

            const [exhaustedRows] = await connection.execute(
                `SELECT outbox_id, sync_status, claim_token, lease_expires_at,
                        manual_retry_requested
                 FROM knowledge_sync_outbox
                 WHERE attempt_count >= ?
                   AND manual_retry_requested = FALSE
                   AND ((sync_status = 'pending' AND available_at <= CURRENT_TIMESTAMP)
                     OR (sync_status = 'processing'
                         AND lease_expires_at IS NULL)
                     OR (sync_status = 'processing'
                         AND lease_expires_at IS NOT NULL
                         AND lease_expires_at <= CURRENT_TIMESTAMP))
                 ORDER BY outbox_id
                 LIMIT ?
                 FOR UPDATE SKIP LOCKED`,
                [settings.maxAttempts, limit]
            );

            for (const row of exhaustedRows) {
                await connection.execute(
                    `UPDATE knowledge_sync_outbox
                     SET sync_status = 'failed',
                         lease_expires_at = NULL,
                         claim_token = NULL,
                         last_error = ?
                     WHERE outbox_id = ?
                       AND sync_status = ?
                       AND claim_token <=> ?
                       AND lease_expires_at <=> ?
                       AND attempt_count >= ?
                       AND manual_retry_requested = FALSE
                       AND ((sync_status = 'pending' AND available_at <= CURRENT_TIMESTAMP)
                         OR (sync_status = 'processing'
                           AND lease_expires_at IS NULL)
                       OR (sync_status = 'processing'
                             AND lease_expires_at IS NOT NULL
                             AND lease_expires_at <= CURRENT_TIMESTAMP))`,
                    [
                        `Maximum synchronization attempts (${settings.maxAttempts}) exhausted.`,
                        row.outbox_id,
                        row.sync_status,
                        row.claim_token,
                        row.lease_expires_at,
                        settings.maxAttempts
                    ]
                );
            }

            const [rows] = await connection.execute(
                `SELECT outbox_id, canonical_record_type, canonical_record_id,
                        attempt_count, manual_retry_requested, sync_status,
                        claim_token, lease_expires_at
                 FROM knowledge_sync_outbox
                 WHERE (attempt_count < ? OR manual_retry_requested = TRUE)
                   AND ((sync_status = 'pending' AND available_at <= CURRENT_TIMESTAMP)
                     OR (sync_status = 'processing'
                         AND lease_expires_at IS NULL)
                     OR (sync_status = 'processing'
                         AND lease_expires_at IS NOT NULL
                         AND lease_expires_at <= CURRENT_TIMESTAMP))
                 ORDER BY outbox_id
                 LIMIT ?
                 FOR UPDATE SKIP LOCKED`,
                [settings.maxAttempts, limit]
            );

            const claimed = [];
            for (const row of rows) {
                const claimToken = makeToken();
                const [result] = await connection.execute(
                    `UPDATE knowledge_sync_outbox
                     SET sync_status = 'processing', claim_token = ?,
                         lease_expires_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND),
                         attempt_count = attempt_count + 1,
                         manual_retry_requested = FALSE
                     WHERE outbox_id = ?
                       AND sync_status = ?
                       AND claim_token <=> ?
                       AND lease_expires_at <=> ?
                       AND (attempt_count < ? OR manual_retry_requested = TRUE)
                       AND ((sync_status = 'pending' AND available_at <= CURRENT_TIMESTAMP)
                         OR (sync_status = 'processing' AND lease_expires_at IS NULL)
                         OR (sync_status = 'processing'
                             AND lease_expires_at IS NOT NULL
                             AND lease_expires_at <= CURRENT_TIMESTAMP))`,
                    [
                        claimToken,
                        settings.leaseSeconds,
                        row.outbox_id,
                        row.sync_status,
                        row.claim_token,
                        row.lease_expires_at,
                        settings.maxAttempts
                    ]
                );
                if (result.affectedRows === 1) {
                    claimed.push({
                        outbox_id: row.outbox_id,
                        canonical_record_type: row.canonical_record_type,
                        canonical_record_id: row.canonical_record_id,
                        attempt_count: Number(row.attempt_count) + 1,
                        claim_token: claimToken
                    });
                }
            }
            await connection.commit();
            transactionStarted = false;
            return claimed;
        } catch (error) {
            primaryError = error;
            if (transactionStarted) {
                try { await connection.rollback(); } catch (cleanupError) {
                    connectionReusable = false;
                    primaryError.rollbackError = cleanupError;
                }
            }
            throw error;
        } finally {
            try {
                if (connectionReusable) connection.release();
                else connection.destroy();
            } catch (cleanupError) {
                if (primaryError) primaryError.connectionCleanupError = cleanupError;
                else throw cleanupError;
            }
        }
    }

    async function loadCanonicalRecord(task) {
        try {
            return await loadAndValidateCanonicalRecord(mysql, task);
        } catch (error) {
            if (error instanceof CanonicalRecordValidationError) {
                throw new PermanentSyncError(error.message);
            }
            throw error;
        }
    }

    async function runNeo4jTransaction(task, record, ownership) {
        const session = getNeo4jSession();
        let transaction;
        let operationError = null;

        const assertOwnership = () => {
            if (ownership.signal.aborted) {
                throw ownership.signal.reason || new Error('Synchronization lease was lost.');
            }
        };
        const run = async (query, params) => {
            assertOwnership();
            const result = await transaction.run(query, params);
            assertOwnership();
            return result;
        };

        try {
            transaction = await session.beginTransaction({ timeout: settings.neo4jTransactionTimeoutMs });
            assertOwnership();
            if (task.canonical_record_type === 'CONCEPT') {
                await run(
                    `MERGE (c:Concept {concept_id: $graphId})
                     ON CREATE SET c.name = $name,
                                   c.description = $description,
                                   c.difficulty_level = $difficultyLevel
                     RETURN c.concept_id AS graphId`,
                    {
                        graphId: record.graph_concept_id,
                        name: record.concept_name,
                        description: record.description || '',
                        difficultyLevel: record.difficulty_level ?? null
                    }
                );
                for (const courseGraphId of record.courses) {
                    const result = await run(
                        `MATCH (course:Course {course_id: $courseId})
                         MATCH (concept:Concept {concept_id: $conceptId})
                         MERGE (course)-[:CONTAINS]->(concept)
                         RETURN course.course_id AS courseId`,
                        { courseId: courseGraphId, conceptId: record.graph_concept_id }
                    );
                    if (!result.records.length) {
                        throw new MissingGraphDependencyError(`Mapped course ${courseGraphId} is missing in Neo4j.`);
                    }
                }
            } else if (task.canonical_record_type === 'PREREQUISITE') {
                const result = await run(
                    `MATCH (prerequisite:Concept {concept_id: $prerequisiteId})
                     MATCH (target:Concept {concept_id: $targetId})
                     MERGE (prerequisite)-[:PREREQUISITE_OF]->(target)
                     RETURN prerequisite.concept_id AS prerequisiteId`,
                    { prerequisiteId: record.prerequisite_graph_id, targetId: record.target_graph_id }
                );
                if (!result.records.length) {
                    throw new MissingGraphDependencyError('A prerequisite concept is missing in Neo4j.');
                }
            } else if (task.canonical_record_type === 'RESOURCE') {
                const result = await run(
                    `MATCH (concept:Concept {concept_id: $conceptId})
                     MERGE (resource:LearningResource {resource_id: $resourceId})
                     ON CREATE SET resource.title = $title,
                                   resource.type = $type,
                                   resource.url = $url
                     MERGE (concept)-[:HAS_RESOURCE]->(resource)
                     RETURN resource.resource_id AS resourceId`,
                    {
                        conceptId: record.concept_graph_id,
                        resourceId: record.graph_resource_id,
                        title: record.title,
                        type: record.resource_type,
                        url: record.file_url
                    }
                );
                if (!result.records.length) {
                    throw new MissingGraphDependencyError('The resource concept is missing in Neo4j.');
                }
            } else {
                throw new PermanentSyncError('Unsupported canonical record type.');
            }

            await ownership.assertLeaseOwned();
            assertOwnership();
            await transaction.commit();
        } catch (error) {
            operationError = error;
            if (transaction) {
                try {
                    await transaction.rollback();
                } catch (cleanupError) {
                    operationError.rollbackError = cleanupError;
                }
            }
            throw error;
        } finally {
            try {
                await session.close();
            } catch (cleanupError) {
                if (operationError) operationError.sessionCloseError = cleanupError;
                else throw cleanupError;
            }
        }
    }

    async function completeTask(task) {
        const [result] = await mysql.execute(
            `UPDATE knowledge_sync_outbox
             SET sync_status = 'completed', completed_at = CURRENT_TIMESTAMP,
                 lease_expires_at = NULL, claim_token = NULL, last_error = NULL
             WHERE outbox_id = ? AND sync_status = 'processing' AND claim_token = ?
               AND lease_expires_at > CURRENT_TIMESTAMP`,
            [task.outbox_id, task.claim_token]
        );
        return result.affectedRows === 1;
    }

    async function renewLease(task) {
        const [result] = await mysql.execute(
            `UPDATE knowledge_sync_outbox
             SET lease_expires_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND)
             WHERE outbox_id = ? AND sync_status = 'processing' AND claim_token = ?
               AND lease_expires_at > CURRENT_TIMESTAMP`,
            [settings.leaseSeconds, task.outbox_id, task.claim_token]
        );
        return result.affectedRows === 1;
    }

    function retryDelaySeconds(attemptCount) {
        const exponential = Math.min(
            settings.retryMaxSeconds,
            settings.retryBaseSeconds * (2 ** Math.max(0, attemptCount - 1))
        );
        return Math.max(1, Math.min(
            settings.retryMaxSeconds,
            Math.floor(exponential * (0.5 + random()))
        ));
    }

    function errorDiagnostic(error) {
        const prefix = error && error.name ? `${error.name}: ` : '';
        return `${prefix}${String(error && error.message ? error.message : 'Unknown synchronization error')}`
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/\b(?:bolt\+s?|neo4j(?:\+s)?|mysql):\/\/[^\s]+/gi, '[database endpoint]')
            .replace(/(password|passwd|pwd)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
            .slice(0, ERROR_TEXT_LIMIT);
    }

    async function failTask(task, error) {
        const diagnostic = errorDiagnostic(error);
        const shouldRetry = error.retryable !== false && task.attempt_count < settings.maxAttempts;
        if (shouldRetry) {
            const delaySeconds = retryDelaySeconds(task.attempt_count);
            const [result] = await mysql.execute(
                `UPDATE knowledge_sync_outbox
                 SET sync_status = 'pending', available_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND),
                     lease_expires_at = NULL, claim_token = NULL, last_error = ?
                 WHERE outbox_id = ? AND sync_status = 'processing' AND claim_token = ?
                   AND lease_expires_at > CURRENT_TIMESTAMP`,
                [delaySeconds, diagnostic, task.outbox_id, task.claim_token]
            );
            return { outcome: result.affectedRows === 1 ? 'retry' : 'stale', delaySeconds };
        }
        const [result] = await mysql.execute(
            `UPDATE knowledge_sync_outbox
             SET sync_status = 'failed', lease_expires_at = NULL,
                 claim_token = NULL, last_error = ?
             WHERE outbox_id = ? AND sync_status = 'processing' AND claim_token = ?
               AND lease_expires_at > CURRENT_TIMESTAMP`,
            [diagnostic, task.outbox_id, task.claim_token]
        );
        return { outcome: result.affectedRows === 1 ? 'failed' : 'stale' };
    }

    async function processTask(task) {
        if (!RECORD_TYPES.has(task.canonical_record_type)) {
            return failTask(task, new PermanentSyncError('Unsupported canonical record type.'));
        }
        let leaseLost = false;
        let renewalBusy = false;
        let renewalPromise = Promise.resolve();
        const controller = new AbortController();
        const loseLease = () => {
            leaseLost = true;
            if (!controller.signal.aborted) {
                controller.abort(new Error('Synchronization lease ownership was lost.'));
            }
        };
        const refreshLease = () => {
            if (renewalBusy) return renewalPromise;
            renewalBusy = true;
            renewalPromise = renewLease(task)
                .then(renewed => { if (!renewed) loseLease(); })
                .catch(loseLease)
                .finally(() => { renewalBusy = false; });
            return renewalPromise;
        };
        const assertLeaseOwned = async () => {
            if (controller.signal.aborted) throw controller.signal.reason;
            await refreshLease();
            if (controller.signal.aborted) throw controller.signal.reason;
        };
        const renewalTimer = setInterval(() => {
            void refreshLease();
        }, settings.leaseRenewIntervalMs || Math.max(1000, Math.floor(settings.leaseSeconds * 1000 / 3)));
        if (typeof renewalTimer.unref === 'function') renewalTimer.unref();

        try {
            const record = await loadCanonicalRecord(task);
            if (controller.signal.aborted) throw controller.signal.reason;
            await runNeo4jTransaction(task, record, {
                signal: controller.signal,
                assertLeaseOwned
            });
        } catch (error) {
            clearInterval(renewalTimer);
            await renewalPromise;
            if (leaseLost) return { outcome: 'stale' };
            return failTask(task, error);
        }
        clearInterval(renewalTimer);
        await renewalPromise;
        if (leaseLost) return { outcome: 'stale' };

        try {
            await assertLeaseOwned();
            if (leaseLost) return { outcome: 'stale' };
            const completed = await completeTask(task);
            return { outcome: completed ? 'completed' : 'stale' };
        } catch (error) {
            // Neo4j may already be committed. Leave the lease to expire so a retry
            // replays idempotent MERGE operations rather than risking false failure.
            return { outcome: 'completion_update_error', error: errorDiagnostic(error) };
        }
    }

    return { claimTasks, processTask, loadCanonicalRecord, retryDelaySeconds };
}

module.exports = {
    createKnowledgeSyncService,
    PermanentSyncError,
    MissingGraphDependencyError
};
