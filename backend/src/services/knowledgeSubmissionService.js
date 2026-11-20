'use strict';

const { randomUUID } = require('crypto');
const mysql = require('../config/mysql');
const {
    CourseValidationError,
    validateCourseIds,
    getAllCourses
} = require('./knowledgeGraphService');
const {
    CanonicalRecordValidationError,
    loadCanonicalRecord: loadAndValidateCanonicalRecord
} = require('./knowledgeCanonicalRecord');

const PREREQUISITE_GRAPH_LOCK = 'neurolearn:prerequisite_graph_write';
const PREREQUISITE_LOCK_TIMEOUT_SECONDS = 5;
const INITIAL_DOMAIN_NAME = 'Database Concepts';
const CONCEPT_DIFFICULTY_LEVELS = new Set(['Beginner', 'Intermediate', 'Advanced']);

function databaseDomainCourseIds(courses) {
    return courses
        .filter(course => typeof course?.name === 'string' &&
            course.name.trim().toLocaleLowerCase() === INITIAL_DOMAIN_NAME.toLocaleLowerCase() &&
            typeof course.course_id === 'string' && course.course_id.trim())
        .map(course => course.course_id);
}

async function getDatabaseDomainCourseIds() {
    try {
        return databaseDomainCourseIds(await getAllCourses());
    } catch {
        throw new ApprovalError('domain_validation_unavailable', 'Database Concepts domain validation could not be completed.', 503);
    }
}

async function getDatabaseConceptOptions() {
    const courseIds = await getDatabaseDomainCourseIds();
    if (!courseIds.length) {
        return {
            concepts: [],
            domainAvailable: false,
            emptyReason: 'course_missing',
            diagnostics: { totalConcepts: 0, domainAssociatedConcepts: 0, graphMappedConcepts: 0, missingGraphConceptId: 0 }
        };
    }
    const placeholders = courseIds.map(() => '?').join(', ');
    const [[counts]] = await mysql.execute(
        `SELECT COUNT(DISTINCT c.concept_id) AS total_concepts,
                COUNT(DISTINCT CASE WHEN cc.concept_id IS NOT NULL THEN c.concept_id END) AS domain_associated_concepts,
                COUNT(DISTINCT CASE WHEN cc.concept_id IS NOT NULL
                    AND c.graph_concept_id IS NOT NULL AND TRIM(c.graph_concept_id) <> ''
                    THEN c.concept_id END) AS graph_mapped_concepts,
                COUNT(DISTINCT CASE WHEN cc.concept_id IS NOT NULL
                    AND (c.graph_concept_id IS NULL OR TRIM(c.graph_concept_id) = '')
                    THEN c.concept_id END) AS missing_graph_concept_id
         FROM concept AS c
         LEFT JOIN concept_course AS cc
           ON cc.concept_id = c.concept_id
          AND cc.course_graph_id IN (${placeholders})`, courseIds
    );
    const [rows] = await mysql.execute(
        `SELECT DISTINCT c.concept_id, c.concept_name, c.description, c.difficulty_level
         FROM concept AS c
         INNER JOIN concept_course AS cc ON cc.concept_id = c.concept_id
         WHERE c.graph_concept_id IS NOT NULL AND TRIM(c.graph_concept_id) <> ''
           AND cc.course_graph_id IN (${placeholders})
         ORDER BY c.concept_name`, courseIds
    );
    const concepts = rows.map(row => ({
        concept_id: row.concept_id,
        name: row.concept_name,
        description: row.description,
        difficulty_level: row.difficulty_level
    }));
    const diagnostics = {
        totalConcepts: Number(counts.total_concepts),
        domainAssociatedConcepts: Number(counts.domain_associated_concepts),
        graphMappedConcepts: Number(counts.graph_mapped_concepts),
        missingGraphConceptId: Number(counts.missing_graph_concept_id)
    };
    let emptyReason = null;
    if (!concepts.length) {
        if (diagnostics.totalConcepts === 0) emptyReason = 'no_approved_concepts';
        else if (diagnostics.domainAssociatedConcepts === 0) emptyReason = 'missing_course_association';
        else if (diagnostics.missingGraphConceptId > 0) emptyReason = 'missing_graph_concept_id';
        else emptyReason = 'no_approved_concepts';
    }
    return { concepts, domainAvailable: true, emptyReason, diagnostics };
}

async function getDatabaseConcepts() {
    return (await getDatabaseConceptOptions()).concepts;
}

async function createAdministratorPrerequisiteSubmission({ prerequisiteId, targetId, adminId }) {
    const prerequisite = Number(prerequisiteId);
    const target = Number(targetId);
    if (!Number.isSafeInteger(prerequisite) || prerequisite < 1 || !Number.isSafeInteger(target) || target < 1) {
        throw new ApprovalError('invalid_concept_reference', 'Select two valid Database Concepts.', 400);
    }
    if (prerequisite === target) throw new ApprovalError('self_prerequisite', 'A concept cannot be its own prerequisite.', 400);
    const courseIds = await getDatabaseDomainCourseIds();
    if (!courseIds.length) throw new ApprovalError('database_domain_unavailable', 'The existing Database Concepts course is unavailable.', 422);
    const placeholders = courseIds.map(() => '?').join(', ');
    const [rows] = await mysql.execute(
        `SELECT DISTINCT c.concept_id
         FROM concept AS c
         INNER JOIN concept_course AS cc ON cc.concept_id = c.concept_id
         WHERE c.concept_id IN (?, ?) AND c.graph_concept_id IS NOT NULL
           AND cc.course_graph_id IN (${placeholders})`, [prerequisite, target, ...courseIds]
    );
    if (new Set(rows.map(row => Number(row.concept_id))).size !== 2) {
        throw new ApprovalError('invalid_concept_reference', 'Both selected concepts must belong to Database Concepts.', 422);
    }
    return createPendingSubmission('PREREQUISITE', {
        prerequisiteId: prerequisite,
        targetId: target
    }, adminId);
}

class ApprovalError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'ApprovalError';
        this.code = code;
        this.status = status;
    }
}

function parseSubmissionData(value) {
    if (typeof value !== 'string') {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function formatSubmission(row) {
    return {
        submissionId: row.submission_id,
        submissionType: row.submission_type,
        submissionData: parseSubmissionData(row.submission_data),
        status: row.status,
        submittedAt: row.submitted_at,
        reviewedBy: row.reviewed_by,
        reviewNotes: row.review_notes,
        reviewedAt: row.reviewed_at
    };
}

function formatAdminSubmission(row) {
    return {
        ...formatSubmission(row),
        sync: {
            outboxId: row.sync_outbox_id ?? null,
            status: row.sync_status ?? null,
            attemptCount: row.sync_attempt_count == null
                ? 0
                : Number(row.sync_attempt_count),
            lastError: row.sync_last_error ?? null,
            completedAt: row.sync_completed_at ?? null,
            updatedAt: row.sync_updated_at ?? null
        },
        submitter: {
            learnerId: row.submitter_learner_id,
            username: row.submitter_username,
            email: row.submitter_email
        },
        reviewer: row.reviewer_learner_id === null
            ? null
            : {
                learnerId: row.reviewer_learner_id,
                username: row.reviewer_username,
                email: row.reviewer_email
            }
    };
}

const ADMIN_SUBMISSION_SELECT = `
    SELECT s.submission_id, s.submission_type, s.submission_data, s.status,
           s.submitted_at, s.reviewed_by, s.review_notes, s.reviewed_at,
           submitter.learner_id AS submitter_learner_id,
           submitter.username AS submitter_username,
           submitter.email AS submitter_email,
           reviewer.learner_id AS reviewer_learner_id,
           reviewer.username AS reviewer_username,
           reviewer.email AS reviewer_email,
           o.outbox_id AS sync_outbox_id,
           o.sync_status AS sync_status,
           o.attempt_count AS sync_attempt_count,
           o.last_error AS sync_last_error,
           o.completed_at AS sync_completed_at,
           o.updated_at AS sync_updated_at
    FROM knowledge_submissions AS s
    INNER JOIN learner AS submitter
        ON submitter.learner_id = s.submitted_by
    LEFT JOIN learner AS reviewer
        ON reviewer.learner_id = s.reviewed_by
    LEFT JOIN knowledge_sync_outbox AS o
        ON o.submission_id = s.submission_id`;

async function getAdminSubmissions({ status, type, syncStatus, limit, offset }) {
    const conditions = [];
    const values = [];

    if (status !== undefined) {
        conditions.push('s.status = ?');
        values.push(status);
    }

    if (type !== undefined) {
        conditions.push('s.submission_type = ?');
        values.push(type);
    }

    if (syncStatus !== undefined) {
        conditions.push('o.sync_status = ?');
        values.push(syncStatus);
    }

    const whereClause = conditions.length
        ? ` WHERE ${conditions.join(' AND ')}`
        : '';

    const [[countRow]] = await mysql.execute(
        `SELECT COUNT(*) AS total
         FROM knowledge_submissions AS s
         LEFT JOIN knowledge_sync_outbox AS o
            ON o.submission_id = s.submission_id${whereClause}`,
        values
    );

    const [rows] = await mysql.execute(
        `${ADMIN_SUBMISSION_SELECT}${whereClause}
         ORDER BY s.submitted_at DESC, s.submission_id DESC
         LIMIT ? OFFSET ?`,
        [...values, limit, offset]
    );

    return {
        total: Number(countRow.total),
        submissions: rows.map(formatAdminSubmission)
    };
}

async function getAdminSubmission(submissionId) {
    const [rows] = await mysql.execute(
        `${ADMIN_SUBMISSION_SELECT}
         WHERE s.submission_id = ?`,
        [submissionId]
    );

    return rows.length ? formatAdminSubmission(rows[0]) : null;
}

async function getOutboxStatistics() {
    const [[row]] = await mysql.execute(
        `SELECT
             COALESCE(SUM(sync_status = 'pending'), 0) AS pending_count,
             COALESCE(SUM(sync_status = 'processing'), 0) AS processing_count,
             COALESCE(SUM(sync_status = 'completed'), 0) AS completed_count,
             COALESCE(SUM(sync_status = 'failed'), 0) AS failed_count,
             COALESCE(SUM(sync_status = 'processing'
                 AND (lease_expires_at IS NULL
                      OR lease_expires_at <= CURRENT_TIMESTAMP)), 0) AS expired_processing_count,
             MIN(CASE WHEN sync_status = 'pending' THEN created_at END) AS oldest_pending_at,
             COALESCE(SUM(sync_status IN ('pending', 'processing')), 0) AS total_outstanding
         FROM knowledge_sync_outbox`
    );

    return {
        pending: Number(row.pending_count),
        processing: Number(row.processing_count),
        completed: Number(row.completed_count),
        failed: Number(row.failed_count),
        expiredProcessing: Number(row.expired_processing_count),
        oldestPendingAt: row.oldest_pending_at ?? null,
        totalOutstanding: Number(row.total_outstanding)
    };
}

async function retryFailedOutboxTask(outboxId) {
    const connection = await mysql.getConnection();
    let transactionStarted = false;
    let connectionDestroyed = false;
    let commitConfirmed = false;
    let primaryError = null;

    async function rollback() {
        await connection.rollback();
        transactionStarted = false;
    }

    try {
        await connection.beginTransaction();
        transactionStarted = true;
        const [tasks] = await connection.execute(
            `SELECT outbox_id, sync_status, canonical_record_type,
                    canonical_record_id, attempt_count, last_error
             FROM knowledge_sync_outbox
             WHERE outbox_id = ?
             FOR UPDATE`,
            [outboxId]
        );
        if (!tasks.length) {
            await rollback();
            return { outcome: 'not_found' };
        }

        const task = tasks[0];
        if (task.sync_status !== 'failed') {
            await rollback();
            return { outcome: 'not_failed' };
        }

        try {
            await loadAndValidateCanonicalRecord(connection, task, { lockRecords: true });
        } catch (error) {
            if (!(error instanceof CanonicalRecordValidationError)) throw error;
            await rollback();
            return { outcome: 'invalid_canonical_record', message: error.message };
        }

        const [result] = await connection.execute(
            `UPDATE knowledge_sync_outbox
             SET sync_status = 'pending', available_at = CURRENT_TIMESTAMP,
                 completed_at = NULL, lease_expires_at = NULL, claim_token = NULL,
                 manual_retry_requested = TRUE
             WHERE outbox_id = ? AND sync_status = 'failed'
               AND canonical_record_type = ? AND canonical_record_id = ?`,
            [outboxId, task.canonical_record_type, task.canonical_record_id]
        );
        if (result.affectedRows !== 1) {
            await rollback();
            return { outcome: 'not_failed' };
        }

        const [[updated]] = await connection.execute(
            'SELECT updated_at FROM knowledge_sync_outbox WHERE outbox_id = ?',
            [outboxId]
        );
        try {
            await connection.commit();
            commitConfirmed = true;
            transactionStarted = false;
            return {
                outcome: 'retried',
                sync: {
                    status: 'pending',
                    attemptCount: Number(task.attempt_count),
                    lastError: task.last_error ?? null,
                    completedAt: null,
                    updatedAt: updated?.updated_at ?? null
                }
            };
        } catch (commitError) {
            primaryError = commitError;
            if (transactionStarted) {
                try { await rollback(); } catch (rollbackError) {
                    commitError.rollbackError = rollbackError;
                }
                transactionStarted = false;
            }
            try { connection.destroy(); } catch (destroyError) {
                commitError.connectionDestroyError = destroyError;
            }
            connectionDestroyed = true;

            const reconciliation = await reconcileManualRetry(task);
            if (reconciliation.outcome === 'committed') {
                return { outcome: 'retried', sync: reconciliation.sync };
            }
            return { outcome: reconciliation.outcome === 'not_committed'
                ? 'commit_not_committed'
                : 'commit_uncertain' };
        }
    } catch (error) {
        primaryError = error;
        if (transactionStarted) {
            try {
                await rollback();
            } catch (rollbackError) {
                error.rollbackError = rollbackError;
                try {
                    connection.destroy();
                    connectionDestroyed = true;
                } catch (destroyError) {
                    error.connectionDestroyError = destroyError;
                }
            }
        }
        throw error;
    } finally {
        if (!connectionDestroyed) {
            try {
                connection.release();
            } catch (releaseError) {
                if (commitConfirmed) {
                    try { connection.destroy(); } catch { /* Preserve the confirmed commit result. */ }
                } else if (primaryError) {
                    primaryError.connectionCleanupError = releaseError;
                    try { connection.destroy(); } catch { /* Preserve the primary operation error. */ }
                } else {
                    throw releaseError;
                }
            }
        }
    }
}

async function reconcileManualRetry(expectedTask) {
    let connection;
    try {
        connection = await mysql.getConnection();
        const [rows] = await connection.execute(
            `SELECT outbox_id, sync_status, canonical_record_type,
                    canonical_record_id, attempt_count, manual_retry_requested,
                    last_error, completed_at, updated_at
             FROM knowledge_sync_outbox
             WHERE outbox_id = ?
             FOR UPDATE`,
            [expectedTask.outbox_id]
        );
        if (!rows.length) return { outcome: 'uncertain' };
        const row = rows[0];
        if (Number(row.outbox_id) !== Number(expectedTask.outbox_id) ||
            row.canonical_record_type !== expectedTask.canonical_record_type ||
            Number(row.canonical_record_id) !== Number(expectedTask.canonical_record_id)) {
            return { outcome: 'uncertain' };
        }

        const attempts = Number(row.attempt_count);
        const flagTrue = row.manual_retry_requested === true ||
            row.manual_retry_requested === 1 || row.manual_retry_requested === '1';
        const flagFalse = row.manual_retry_requested === false ||
            row.manual_retry_requested === 0 || row.manual_retry_requested === '0';
        const committedPending = row.sync_status === 'pending' && flagTrue &&
            attempts === Number(expectedTask.attempt_count);
        const alreadyClaimed = attempts > Number(expectedTask.attempt_count) && flagFalse;
        if (committedPending || alreadyClaimed) {
            return {
                outcome: 'committed',
                sync: {
                    status: row.sync_status,
                    attemptCount: attempts,
                    lastError: row.last_error ?? null,
                    completedAt: row.completed_at ?? null,
                    updatedAt: row.updated_at ?? null
                }
            };
        }

        const notCommitted = row.sync_status === 'failed' && flagFalse &&
            attempts === Number(expectedTask.attempt_count) &&
            (row.last_error ?? null) === (expectedTask.last_error ?? null);
        return { outcome: notCommitted ? 'not_committed' : 'uncertain' };
    } catch {
        return { outcome: 'uncertain' };
    } finally {
        if (connection) {
            try { connection.release(); } catch {
                try { connection.destroy(); } catch { /* Reconciliation result remains authoritative. */ }
            }
        }
    }
}

async function reviewPendingSubmission({
    submissionId,
    status,
    reviewNotes,
    reviewerId,
    courseIds,
    conceptId,
    difficultyLevel
}) {
    if (status !== 'approved' && status !== 'rejected') {
        throw new Error('Invalid review status. Expected "approved" or "rejected".');
    }

    let preflight;
    let validatedSubmissionData;
    let validatedCourseIds;
    let validatedDomainCourseIds;

    if (status === 'approved') {
        const [preflightRows] = await mysql.execute(
            `SELECT submission_type, submission_data, status
             FROM knowledge_submissions
             WHERE submission_id = ?`,
            [submissionId]
        );

        if (!preflightRows.length) return { outcome: 'not_found' };
        if (preflightRows[0].status !== 'pending') {
            return { outcome: 'already_reviewed' };
        }

        preflight = preflightRows[0];
        validatedSubmissionData = validateSubmissionData(
            preflight.submission_type,
            parseSubmissionData(preflight.submission_data)
        );

        if (preflight.submission_type === 'CONCEPT') {
            if (!CONCEPT_DIFFICULTY_LEVELS.has(difficultyLevel)) {
                throw new ApprovalError('invalid_difficulty_level', 'Select a valid difficulty level before approving this concept.', 400);
            }
            const domainCourseIds = await getDatabaseDomainCourseIds();
            if (!domainCourseIds.length) {
                throw new ApprovalError('database_domain_unavailable', 'The existing Database Concepts course is unavailable.', 422);
            }
            try {
                validatedCourseIds = await validateCourseIds(courseIds);
                if (validatedCourseIds.some(id => !domainCourseIds.includes(id))) {
                    throw new CourseValidationError('COURSES_NOT_FOUND', 'Concepts can only be associated with Database Concepts.');
                }
            } catch (error) {
                if (error instanceof CourseValidationError) {
                    if (error.code === 'INVALID_COURSE_IDS') {
                        throw new ApprovalError('invalid_course_ids', error.message, 400);
                    }
                    if (error.code === 'COURSES_NOT_FOUND') {
                        throw new ApprovalError('courses_not_found', error.message, 422);
                    }
                }
                throw new ApprovalError(
                    'course_validation_unavailable',
                    'Course validation could not be completed.',
                    503
                );
            }
        } else if (preflight.submission_type === 'RESOURCE') {
            const selectedConceptId = Number(conceptId);
            if (!Number.isSafeInteger(selectedConceptId) || selectedConceptId < 1) {
                throw new ApprovalError('invalid_concept_reference', 'Select a Database Concept before approving this resource.', 400);
            }
            const domainCourseIds = await getDatabaseDomainCourseIds();
            if (!domainCourseIds.length) {
                throw new ApprovalError('database_domain_unavailable', 'The existing Database Concepts course is unavailable.', 422);
            }
            validatedSubmissionData = { ...validatedSubmissionData, selectedConceptId };
            validatedSubmissionData.domainCourseIds = domainCourseIds;
        } else if (preflight.submission_type === 'PREREQUISITE') {
            validatedDomainCourseIds = await getDatabaseDomainCourseIds();
            if (!validatedDomainCourseIds.length) {
                throw new ApprovalError('database_domain_unavailable', 'The existing Database Concepts course is unavailable.', 422);
            }
        }
    }

    const connection = await mysql.getConnection();
    let prerequisiteLockAcquired = false;
    let transactionStarted = false;
    let commitAttempted = false;
    let commitConfirmed = false;
    let expectedCanonicalType = null;
    let expectedCanonicalId = null;
    let result;

    try {
        if (status === 'approved' && preflight.submission_type === 'PREREQUISITE') {
            let lockRows;
            try {
                [lockRows] = await connection.execute(
                    'SELECT GET_LOCK(?, ?) AS acquired',
                    [PREREQUISITE_GRAPH_LOCK, PREREQUISITE_LOCK_TIMEOUT_SECONDS]
                );
            } catch {
                throw new ApprovalError(
                    'prerequisite_lock_failed',
                    'Prerequisite approval could not be coordinated.',
                    503
                );
            }
            const acquired = lockRows[0]?.acquired;
            if (acquired !== 1 && acquired !== '1') {
                if (acquired === 0 || acquired === '0') {
                    throw new ApprovalError(
                        'prerequisite_lock_timeout',
                        'Prerequisite approval is busy. Please retry.',
                        503
                    );
                }
                throw new ApprovalError(
                    'prerequisite_lock_failed',
                    'Prerequisite approval could not be coordinated.',
                    503
                );
            }
            prerequisiteLockAcquired = true;
        }

        await connection.beginTransaction();
        transactionStarted = true;

        const [submissionRows] = await connection.execute(
            `SELECT submission_id, submission_type, submission_data, status,
                    submitted_at, reviewed_by, review_notes, reviewed_at
             FROM knowledge_submissions
             WHERE submission_id = ?
             FOR UPDATE`,
            [submissionId]
        );

        if (!submissionRows.length) {
            await connection.rollback();
            transactionStarted = false;
            return { outcome: 'not_found' };
        }

        const submission = submissionRows[0];
        if (submission.status !== 'pending') {
            await connection.rollback();
            transactionStarted = false;
            return { outcome: 'already_reviewed' };
        }

        let canonicalType = null;
        let canonicalId = null;

        if (status === 'approved') {
            if (
                submission.submission_type !== preflight.submission_type ||
                JSON.stringify(parseSubmissionData(submission.submission_data)) !==
                    JSON.stringify(parseSubmissionData(preflight.submission_data))
            ) {
                throw new ApprovalError(
                    'submission_changed',
                    'Submission data changed during approval. Please retry.',
                    409
                );
            }

            const data = validateSubmissionData(
                submission.submission_type,
                parseSubmissionData(submission.submission_data)
            );
            if (JSON.stringify(data) !== JSON.stringify(validatedSubmissionData)) {
                const expected = { ...validatedSubmissionData };
                const current = { ...data };
                delete expected.selectedConceptId;
                delete expected.domainCourseIds;
                if (JSON.stringify(current) === JSON.stringify(expected)) {
                    // Review-time concept association is supplied by the administrator, not student data.
                } else {
                    throw new ApprovalError(
                        'submission_changed',
                        'Submission data changed during approval. Please retry.',
                        409
                    );
                }
            }

            if (submission.submission_type === 'CONCEPT') {
                const [existingConcepts] = await connection.execute(
                    'SELECT concept_id FROM concept WHERE concept_name = ? LIMIT 1',
                    [data.name]
                );
                if (existingConcepts.length) {
                    throw new ApprovalError(
                        'duplicate_concept',
                        'A concept with this name already exists.',
                        409
                    );
                }

                const graphConceptId = `CONCEPT-${randomUUID()}`;
                const [conceptResult] = await connection.execute(
                    `INSERT INTO concept
                        (concept_name, description, difficulty_level, graph_concept_id)
                     VALUES (?, ?, ?, ?)`,
                    [data.name, data.description, difficultyLevel, graphConceptId]
                );
                canonicalType = 'CONCEPT';
                canonicalId = conceptResult.insertId;

                for (const courseGraphId of validatedCourseIds) {
                    await connection.execute(
                        `INSERT INTO concept_course (concept_id, course_graph_id)
                         VALUES (?, ?)`,
                        [canonicalId, courseGraphId]
                    );
                }
            } else if (submission.submission_type === 'PREREQUISITE') {
                const referencedPrerequisite = await resolveConceptReferenceWithConnection(connection, data.prerequisiteId);
                const referencedTarget = await resolveConceptReferenceWithConnection(connection, data.targetId);
                if (!referencedPrerequisite || !referencedTarget) {
                    throw new ApprovalError('invalid_concept_reference', 'Both prerequisite concepts must exist in MySQL.', 422);
                }
                const domainPlaceholders = validatedDomainCourseIds.map(() => '?').join(', ');
                const [domainConcepts] = await connection.execute(
                    `SELECT DISTINCT c.concept_id, c.graph_concept_id
                     FROM concept AS c
                     INNER JOIN concept_course AS cc ON cc.concept_id = c.concept_id
                     WHERE c.concept_id IN (?, ?) AND c.graph_concept_id IS NOT NULL
                       AND cc.course_graph_id IN (${domainPlaceholders})
                     FOR UPDATE`,
                    [referencedPrerequisite.concept_id, referencedTarget.concept_id, ...validatedDomainCourseIds]
                );
                const byId = new Map(domainConcepts.map(row => [Number(row.concept_id), row]));
                const prerequisite = byId.get(Number(referencedPrerequisite.concept_id));
                const target = byId.get(Number(referencedTarget.concept_id));

                if (!prerequisite || !target ||
                    !prerequisite.graph_concept_id || !target.graph_concept_id) {
                    throw new ApprovalError(
                        'invalid_concept_reference',
                        'Both prerequisite concepts must exist and have graph mappings.',
                        422
                    );
                }
                if (prerequisite.concept_id === target.concept_id) {
                    throw new ApprovalError(
                        'self_prerequisite',
                        'A concept cannot be its own prerequisite.',
                        422
                    );
                }

                const [duplicateRows] = await connection.execute(
                    `SELECT prerequisite_id
                     FROM concept_prerequisite
                     WHERE prerequisite_concept_id = ? AND target_concept_id = ?
                     LIMIT 1`,
                    [prerequisite.concept_id, target.concept_id]
                );
                if (duplicateRows.length) {
                    throw new ApprovalError(
                        'duplicate_prerequisite',
                        'This prerequisite relationship already exists.',
                        409
                    );
                }

                const [edgeRows] = await connection.execute(
                    `SELECT prerequisite_concept_id, target_concept_id
                     FROM concept_prerequisite`,
                    []
                );
                if (wouldCreatePrerequisiteCycle(
                    edgeRows,
                    prerequisite.concept_id,
                    target.concept_id
                )) {
                    throw new ApprovalError(
                        'prerequisite_cycle',
                        'This prerequisite would create a learning cycle.',
                        409
                    );
                }

                const [prerequisiteResult] = await connection.execute(
                    `INSERT INTO concept_prerequisite
                        (prerequisite_concept_id, target_concept_id)
                     VALUES (?, ?)`,
                    [prerequisite.concept_id, target.concept_id]
                );
                canonicalType = 'PREREQUISITE';
                canonicalId = prerequisiteResult.insertId;
            } else if (submission.submission_type === 'RESOURCE') {
                // The selected association is reviewed separately from immutable learner payload data.
                const selectedConceptId = validatedSubmissionData.selectedConceptId;
                const resourceDomainCourseIds = validatedSubmissionData.domainCourseIds;
                const domainPlaceholders = resourceDomainCourseIds.map(() => '?').join(', ');
                const [eligibleConcepts] = await connection.execute(
                    `SELECT c.concept_id, c.graph_concept_id
                     FROM concept AS c
                     INNER JOIN concept_course AS cc ON cc.concept_id = c.concept_id
                     WHERE c.concept_id = ? AND c.graph_concept_id IS NOT NULL
                       AND cc.course_graph_id IN (${domainPlaceholders})
                     FOR UPDATE`, [selectedConceptId, ...resourceDomainCourseIds]
                );
                const concept = eligibleConcepts[0];
                if (!concept || !concept.graph_concept_id) {
                    throw new ApprovalError('invalid_concept_reference', 'The selected concept is not an approved Database Concept.', 422);
                }

                const graphResourceId = `RESOURCE-${randomUUID()}`;
                const resourceFileUrl = data.document?.filename
                    ? `/api/submissions/resources/${submissionId}/document`
                    : data.url;
                const [resourceResult] = await connection.execute(
                    `INSERT INTO learning_resource
                        (concept_id, title, resource_type, file_url, graph_resource_id)
                     VALUES (?, ?, ?, ?, ?)`,
                    [concept.concept_id, data.title, data.type, resourceFileUrl, graphResourceId]
                );
                canonicalType = 'RESOURCE';
                canonicalId = resourceResult.insertId;
            } else {
                throw new ApprovalError(
                    'invalid_submission_type',
                    'This submission type cannot be approved.',
                    422
                );
            }
        }

        const [reviewResult] = await connection.execute(
            `UPDATE knowledge_submissions
             SET status = ?, review_notes = ?, reviewed_by = ?,
                 reviewed_at = CURRENT_TIMESTAMP
             WHERE submission_id = ? AND status = 'pending'`,
            [status, reviewNotes, reviewerId, submissionId]
        );
        if (reviewResult.affectedRows !== 1) {
            throw new ApprovalError(
                'review_conflict',
                'This submission has already been reviewed.',
                409
            );
        }

        if (status === 'approved') {
            await connection.execute(
                `INSERT INTO knowledge_sync_outbox
                    (submission_id, canonical_record_type, canonical_record_id)
                 VALUES (?, ?, ?)`,
                [submissionId, canonicalType, canonicalId]
            );
            expectedCanonicalType = canonicalType;
            expectedCanonicalId = canonicalId;
        }

        commitAttempted = true;
        await connection.commit();
        commitConfirmed = true;
        transactionStarted = false;
        try {
            const reviewedSubmission = await getAdminSubmission(submissionId);
            if (reviewedSubmission) {
                result = { outcome: 'reviewed', submission: reviewedSubmission };
            }
        } catch (lookupError) {
            console.error('[Admin submissions] Committed approval response lookup failed.', {
                submissionId,
                code: lookupError.code || 'response_lookup_failed'
            });
        }

        if (!result) {
            try {
                result = await reconcileUncertainApproval({
                    submissionId,
                    status,
                    reviewerId,
                    expectedCanonicalType,
                    expectedCanonicalId
                });
            } catch (reconciliationError) {
                console.error('[Admin submissions] Committed approval response reconciliation failed.', {
                    submissionId,
                    code: reconciliationError.code || 'response_reconciliation_failed'
                });
            }
        }

        if (!result) {
            result = {
                outcome: 'reviewed',
                submission: formatSubmission({
                    ...submission,
                    status,
                    reviewed_by: reviewerId,
                    review_notes: reviewNotes,
                    reviewed_at: null
                })
            };
        }
    } catch (error) {
        if (commitAttempted && !commitConfirmed) {
            if (transactionStarted) {
                try {
                    await connection.rollback();
                } catch (rollbackError) {
                    console.error('[Admin submissions] Rollback after uncertain commit failed.', {
                        submissionId,
                        code: rollbackError.code || 'rollback_failed'
                    });
                }
                transactionStarted = false;
            }
            try {
                result = await reconcileUncertainApproval({
                    submissionId,
                    status,
                    reviewerId,
                    expectedCanonicalType,
                    expectedCanonicalId
                });
            } catch (reconciliationError) {
                console.error('[Admin submissions] Approval commit outcome is uncertain.', {
                    submissionId,
                    code: reconciliationError.code || 'reconciliation_failed'
                });
                throw new ApprovalError(
                    'commit_uncertain',
                    'Approval outcome could not be confirmed. Please retry shortly.',
                    503
                );
            }
            if (result) return result;
            throw new ApprovalError(
                'commit_failed',
                'Approval was not committed. Please retry.',
                503
            );
        }

        if (transactionStarted) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('[Admin submissions] Approval rollback failed.', {
                    submissionId,
                    code: rollbackError.code || 'rollback_failed'
                });
            }
            transactionStarted = false;
        }

        if (error && error.code === 'ER_DUP_ENTRY') {
            const message = String(error.sqlMessage || error.message || '');
            if (message.includes('concept_name') || message.includes('uq_concept')) {
                throw new ApprovalError(
                    'duplicate_concept',
                    'A concept with this name already exists.',
                    409
                );
            }
            if (message.includes('uq_concept_prerequisite_pair')) {
                throw new ApprovalError(
                    'duplicate_prerequisite',
                    'This prerequisite relationship already exists.',
                    409
                );
            }
            if (message.includes('uq_knowledge_sync_outbox_submission')) {
                throw new ApprovalError(
                    'outbox_conflict',
                    'The approval synchronization task conflicts with existing data.',
                    409
                );
            }
        }
        throw error;
    } finally {
        let lockReleaseConfirmed = !prerequisiteLockAcquired;
        if (prerequisiteLockAcquired) {
            try {
                const [releaseRows] = await connection.execute(
                    'SELECT RELEASE_LOCK(?) AS released',
                    [PREREQUISITE_GRAPH_LOCK]
                );
                if (releaseRows[0]?.released !== 1 && releaseRows[0]?.released !== '1') {
                    lockReleaseConfirmed = false;
                    console.error('[Admin submissions] Prerequisite lock release was not confirmed.', {
                        submissionId
                    });
                } else {
                    lockReleaseConfirmed = true;
                }
            } catch (error) {
                lockReleaseConfirmed = false;
                console.error('[Admin submissions] Prerequisite lock release failed.', {
                    submissionId,
                    code: error.code || 'lock_release_failed'
                });
            }
        }
        if (lockReleaseConfirmed) {
            connection.release();
        } else {
            try {
                connection.destroy();
            } catch (error) {
                console.error('[Admin submissions] Connection disposal after lock cleanup failure failed.', {
                    submissionId,
                    code: error.code || 'connection_disposal_failed'
                });
            }
        }
    }

    return result;
}

function validateSubmissionData(type, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new ApprovalError('invalid_submission_data', 'Submission data is invalid.', 422);
    }

    const requiredText = (field, maxLength) => {
        const value = data[field];
        if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
            throw new ApprovalError(
                'invalid_submission_data',
                `Submission field ${field} is invalid.`,
                422
            );
        }
        return value.trim();
    };
    const optionalText = (field, maxLength) => {
        const value = data[field];
        if (value === undefined || value === null) return '';
        if (typeof value !== 'string' || value.trim().length > maxLength) {
            throw new ApprovalError(
                'invalid_submission_data',
                `Submission field ${field} is invalid.`,
                422
            );
        }
        return value.trim();
    };

    if (type === 'CONCEPT') {
        return {
            name: requiredText('name', 150),
            description: optionalText('description', 5000)
        };
    }

    if (type === 'PREREQUISITE') {
        return {
            prerequisiteId: validateReference(data.prerequisiteId, 'prerequisiteId'),
            targetId: validateReference(data.targetId, 'targetId')
        };
    }

    if (type === 'RESOURCE') {
        if (data.document && typeof data.document === 'object' &&
            /^[0-9a-f-]{36}\.(pdf|ppt|pptx|doc|docx)$/i.test(data.document.filename || '') &&
            typeof data.document.originalName === 'string') {
            return {
                title: requiredText('title', 255),
                type: 'document',
                document: data.document
            };
        }
        const url = requiredText('url', 500);
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch {
            throw new ApprovalError('invalid_submission_data', 'Resource URL is invalid.', 422);
        }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new ApprovalError('invalid_submission_data', 'Resource URL is invalid.', 422);
        }
        return {
            conceptId: validateReference(data.conceptId, 'conceptId'),
            title: requiredText('title', 255),
            type: requiredText('type', 50),
            url: parsedUrl.toString()
        };
    }

    throw new ApprovalError('invalid_submission_type', 'This submission type cannot be approved.', 422);
}

function validateReference(reference, field) {
    const normalized = typeof reference === 'string' ? reference.trim() : reference;
    if (
        (typeof normalized === 'number' &&
            (!Number.isSafeInteger(normalized) || normalized < 1)) ||
        (typeof normalized === 'string' &&
            (!normalized || normalized.length > 100)) ||
        (typeof normalized !== 'number' && typeof normalized !== 'string')
    ) {
        throw new ApprovalError(
            'invalid_concept_reference',
            `${field} must be a valid concept reference.`,
            422
        );
    }
    return normalized;
}

async function resolveConceptReferenceWithConnection(connection, reference) {
    const normalized = validateReference(reference, 'concept reference');
    const isNumericId = typeof normalized === 'number' || /^[1-9]\d*$/.test(normalized);
    const [rows] = isNumericId
        ? await connection.execute(
            `SELECT concept_id, graph_concept_id
             FROM concept
             WHERE concept_id = ?`,
            [Number(normalized)]
        )
        : await connection.execute(
            `SELECT concept_id, graph_concept_id
             FROM concept
             WHERE graph_concept_id = ?`,
            [normalized]
        );
    return rows[0] || null;
}

function wouldCreatePrerequisiteCycle(edges, prerequisiteId, targetId) {
    const adjacency = new Map();
    for (const edge of edges) {
        if (!adjacency.has(edge.prerequisite_concept_id)) {
            adjacency.set(edge.prerequisite_concept_id, []);
        }
        adjacency.get(edge.prerequisite_concept_id).push(edge.target_concept_id);
    }

    const pending = [targetId];
    const visited = new Set();
    while (pending.length) {
        const current = pending.pop();
        if (current === prerequisiteId) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        pending.push(...(adjacency.get(current) || []));
    }
    return false;
}

async function reconcileUncertainApproval({
    submissionId,
    status,
    reviewerId,
    expectedCanonicalType,
    expectedCanonicalId
}) {
    const connection = await mysql.getConnection();
    try {
        const [rows] = await connection.execute(
            `SELECT s.submission_id, s.submission_type, s.submission_data,
                    s.status, s.submitted_at, s.reviewed_by, s.review_notes,
                    s.reviewed_at,
                    submitter.learner_id AS submitter_learner_id,
                    submitter.username AS submitter_username,
                    submitter.email AS submitter_email,
                    reviewer.learner_id AS reviewer_learner_id,
                    reviewer.username AS reviewer_username,
                    reviewer.email AS reviewer_email,
                    o.canonical_record_type, o.canonical_record_id,
                    o.sync_status AS sync_status,
                    o.attempt_count AS sync_attempt_count,
                    o.last_error AS sync_last_error,
                    o.completed_at AS sync_completed_at,
                    o.updated_at AS sync_updated_at
             FROM knowledge_submissions AS s
             INNER JOIN learner AS submitter
                ON submitter.learner_id = s.submitted_by
             LEFT JOIN learner AS reviewer
                ON reviewer.learner_id = s.reviewed_by
             LEFT JOIN knowledge_sync_outbox AS o
                ON o.submission_id = s.submission_id
             WHERE s.submission_id = ?`,
            [submissionId]
        );
        if (!rows.length) return null;
        const row = rows[0];

        if (status === 'rejected') {
            if (
                row.status !== 'rejected' ||
                row.reviewed_by !== reviewerId ||
                row.canonical_record_type !== null ||
                row.canonical_record_id !== null
            ) return null;
            return { outcome: 'reviewed', submission: formatAdminSubmission(row) };
        }

        if (
            row.status !== 'approved' ||
            row.reviewed_by !== reviewerId ||
            row.canonical_record_type !== expectedCanonicalType ||
            Number(row.canonical_record_id) !== Number(expectedCanonicalId)
        ) return null;

        const canonicalTables = {
            CONCEPT: ['concept', 'concept_id'],
            PREREQUISITE: ['concept_prerequisite', 'prerequisite_id'],
            RESOURCE: ['learning_resource', 'resource_id']
        };
        const canonical = canonicalTables[row.canonical_record_type];
        if (!canonical) return null;
        const [canonicalRows] = await connection.execute(
            `SELECT ${canonical[1]} FROM ${canonical[0]} WHERE ${canonical[1]} = ?`,
            [row.canonical_record_id]
        );
        if (!canonicalRows.length) return null;

        return { outcome: 'reviewed', submission: formatAdminSubmission(row) };
    } finally {
        connection.release();
    }
}

async function resolveConceptReference(reference) {
    const normalized = typeof reference === 'string'
        ? reference.trim()
        : reference;

    if (
        (typeof normalized === 'number' &&
            (!Number.isSafeInteger(normalized) || normalized < 1)) ||
        (typeof normalized === 'string' &&
            (!normalized || normalized.length > 100)) ||
        (typeof normalized !== 'number' && typeof normalized !== 'string')
    ) {
        return null;
    }

    const isNumericId = typeof normalized === 'number' || /^[1-9]\d*$/.test(normalized);
    const [rows] = isNumericId
        ? await mysql.execute(
            'SELECT concept_id FROM concept WHERE concept_id = ?',
            [Number(normalized)]
        )
        : await mysql.execute(
            'SELECT concept_id FROM concept WHERE graph_concept_id = ?',
            [normalized]
        );

    return rows[0] || null;
}

async function createPendingSubmission(submissionType, submissionData, learnerId) {
    const [result] = await mysql.execute(
        `INSERT INTO knowledge_submissions
            (submission_type, submission_data, status, submitted_by)
         VALUES (?, ?, ?, ?)`,
        [submissionType, JSON.stringify(submissionData), 'pending', learnerId]
    );

    const [rows] = await mysql.execute(
        `SELECT submission_id, submission_type, submission_data, status,
                submitted_at, reviewed_by, review_notes, reviewed_at
         FROM knowledge_submissions
         WHERE submission_id = ? AND submitted_by = ?`,
        [result.insertId, learnerId]
    );

    if (!rows.length) {
        throw new Error('Created submission could not be retrieved.');
    }

    return formatSubmission(rows[0]);
}

async function getLearnerSubmissions(learnerId, limit, offset) {
    const [[countRow]] = await mysql.execute(
        `SELECT COUNT(*) AS total
         FROM knowledge_submissions
         WHERE submitted_by = ?`,
        [learnerId]
    );

    const [rows] = await mysql.execute(
        `SELECT submission_id, submission_type, submission_data, status,
                submitted_at, reviewed_by, review_notes, reviewed_at
         FROM knowledge_submissions
         WHERE submitted_by = ?
         ORDER BY submitted_at DESC, submission_id DESC
         LIMIT ? OFFSET ?`,
        [learnerId, limit, offset]
    );

    return {
        total: Number(countRow.total),
        submissions: rows.map(formatSubmission)
    };
}

module.exports = {
    ApprovalError,
    createPendingSubmission,
    createAdministratorPrerequisiteSubmission,
    getDatabaseConcepts,
    getDatabaseConceptOptions,
    getAdminSubmission,
    getAdminSubmissions,
    getOutboxStatistics,
    getLearnerSubmissions,
    retryFailedOutboxTask,
    resolveConceptReference,
    reviewPendingSubmission
};
