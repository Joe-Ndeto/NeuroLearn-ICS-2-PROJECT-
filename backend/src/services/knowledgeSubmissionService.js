'use strict';

const { randomUUID, createHash } = require('crypto');
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

async function getApprovedCourseConceptOptions() {
    const [rows] = await mysql.execute(
        `SELECT course.graph_course_id AS course_id, course.title AS course_name,
                concept.concept_id, concept.concept_name
         FROM course
         INNER JOIN concept_course AS association
           ON association.course_graph_id = course.graph_course_id
         INNER JOIN concept ON concept.concept_id = association.concept_id
         WHERE concept.graph_concept_id IS NOT NULL
           AND TRIM(concept.graph_concept_id) <> ''
         ORDER BY course.title, concept.concept_name, concept.concept_id`
    );
    const courses = new Map();
    for (const row of rows) {
        if (!courses.has(row.course_id)) {
            courses.set(row.course_id, { courseId: row.course_id, name: row.course_name, concepts: [] });
        }
        courses.get(row.course_id).concepts.push({ conceptId: Number(row.concept_id), name: row.concept_name });
    }
    return [...courses.values()];
}

async function getCourseConceptOptions(courseId) {
    const normalizedCourseId = typeof courseId === 'string' ? courseId.trim() : '';
    if (!normalizedCourseId || normalizedCourseId.length > 100) {
        throw new ApprovalError('invalid_course_reference', 'A valid course is required.', 400);
    }
    const [rows] = await mysql.execute(
        `SELECT course.graph_course_id AS course_id, course.title AS course_name,
                concept.concept_id, concept.concept_name
         FROM course
         INNER JOIN concept_course AS association
           ON association.course_graph_id = course.graph_course_id
         INNER JOIN concept ON concept.concept_id = association.concept_id
         WHERE course.graph_course_id = ?
           AND concept.graph_concept_id IS NOT NULL
           AND TRIM(concept.graph_concept_id) <> ''
         ORDER BY concept.concept_name, concept.concept_id`, [normalizedCourseId]
    );
    return rows.map(row => ({ concept_id: Number(row.concept_id), name: row.concept_name }));
}

async function validateResourceCourseConcept(courseId, conceptId) {
    const normalizedCourseId = typeof courseId === 'string' ? courseId.trim() : '';
    const normalizedConceptId = Number(conceptId);
    if (!normalizedCourseId || normalizedCourseId.length > 100 ||
        !Number.isSafeInteger(normalizedConceptId) || normalizedConceptId < 1) return false;
    const [rows] = await mysql.execute(
        `SELECT 1
         FROM course
         INNER JOIN concept_course AS association
           ON association.course_graph_id = course.graph_course_id
         INNER JOIN concept ON concept.concept_id = association.concept_id
         WHERE course.graph_course_id = ? AND concept.concept_id = ?
           AND concept.graph_concept_id IS NOT NULL
           AND TRIM(concept.graph_concept_id) <> ''
         LIMIT 1`, [normalizedCourseId, normalizedConceptId]
    );
    return rows.length === 1;
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
    const submissionData = parseSubmissionData(row.submission_data);
    if (submissionData && typeof submissionData === 'object') delete submissionData._idempotency;
    return {
        submissionId: row.submission_id,
        submissionType: row.submission_type,
        submissionData,
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
    const safeLimit = Number(limit);
    const safeOffset = Number(offset);

    if (
        !Number.isSafeInteger(safeLimit) || safeLimit < 1 ||
        !Number.isSafeInteger(safeOffset) || safeOffset < 0
    ) {
        throw new Error('Invalid admin submission pagination values.');
    }

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
        [...values, safeLimit, safeOffset]
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
            return {
                outcome: reconciliation.outcome === 'not_committed'
                    ? 'commit_not_committed'
                    : 'commit_uncertain'
            };
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
    let validatedGraphCourseId;

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

            try {
                // Concepts may be associated with any existing approved course.
                // validateCourseIds rejects malformed IDs and nonexistent courses.
                validatedCourseIds = await validateCourseIds(courseIds);
            } catch (error) {
                if (error instanceof ApprovalError) throw error;
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
        } else if (preflight.submission_type === 'COURSE') {
            if (!CONCEPT_DIFFICULTY_LEVELS.has(difficultyLevel)) {
                throw new ApprovalError('invalid_difficulty_level', 'Select a valid difficulty level before approving this course.', 400);
            }
            const normalizedTitle = validatedSubmissionData.title.toLocaleLowerCase();
            try {
                const graphCourses = await getAllCourses();
                const matching = graphCourses.filter(course => typeof course?.name === 'string' &&
                    course.name.trim().toLocaleLowerCase() === normalizedTitle);
                if (matching.length > 1) throw new ApprovalError('ambiguous_existing_course', 'Multiple graph courses match this title. Reconcile them before approval.', 409);
                validatedGraphCourseId = matching[0]?.course_id || `COURSE-${randomUUID()}`;
                if (typeof validatedGraphCourseId !== 'string' ||
                    !/^COURSE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(validatedGraphCourseId)) {
                    throw new ApprovalError('invalid_existing_course_id', 'The matching graph course has an invalid identifier.', 422);
                }
            } catch (error) {
                if (error instanceof ApprovalError) throw error;
                throw new ApprovalError('course_lookup_unavailable', 'Existing courses could not be checked safely.', 503);
            }
        } else if (preflight.submission_type === 'RESOURCE') {
            const hasUploadedDocument = Boolean(validatedSubmissionData.document);
            const submittedConceptId = hasUploadedDocument ? validatedSubmissionData.conceptId : undefined;
            const submittedCourseId = hasUploadedDocument ? validatedSubmissionData.courseId : undefined;
            const selectedConceptId = submittedConceptId !== undefined ? Number(submittedConceptId) : Number(conceptId);
            if (!Number.isSafeInteger(selectedConceptId) || selectedConceptId < 1) {
                throw new ApprovalError('invalid_concept_reference', 'Select a valid approved concept before approving this resource.', 400);
            }
            if (submittedConceptId !== undefined) {
                if (typeof submittedCourseId !== 'string' || !submittedCourseId.trim()) {
                    throw new ApprovalError('invalid_course_reference', 'The submitted course association is invalid.', 422);
                }
                if (conceptId !== undefined && Number(conceptId) !== selectedConceptId) {
                    throw new ApprovalError('resource_concept_mismatch', 'A resource must remain associated with the concept selected during submission.', 409);
                }
                if (!await validateResourceCourseConcept(submittedCourseId, selectedConceptId)) {
                    throw new ApprovalError('invalid_concept_reference', 'The submitted concept is no longer associated with its approved course.', 422);
                }
                validatedSubmissionData.courseId = submittedCourseId;
            } else {
                const domainCourseIds = await getDatabaseDomainCourseIds();
                if (!domainCourseIds.length) {
                    throw new ApprovalError('database_domain_unavailable', 'The existing Database Concepts course is unavailable.', 422);
                }
                validatedSubmissionData.domainCourseIds = domainCourseIds;
            }
            validatedSubmissionData = { ...validatedSubmissionData, selectedConceptId };
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
            `SELECT submission_id, submission_type, submission_data, status, submitted_by,
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
            } else if (submission.submission_type === 'COURSE') {
                const normalizedTitle = data.title.trim().toLocaleLowerCase();
                const [existingCourses] = await connection.execute(
                    'SELECT course_id FROM course WHERE normalized_title = ? LIMIT 1 FOR UPDATE',
                    [normalizedTitle]
                );
                if (existingCourses.length) {
                    throw new ApprovalError('duplicate_course', 'An approved course with this name already exists.', 409);
                }
                const [courseResult] = await connection.execute(
                    `INSERT INTO course
                        (graph_course_id, title, normalized_title, description, difficulty_level, created_by, approved_by, approved_submission_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [validatedGraphCourseId, data.title, normalizedTitle, data.description, difficultyLevel,
                        submission.submitted_by, reviewerId, submissionId]
                );
                canonicalType = 'COURSE';
                canonicalId = courseResult.insertId;
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
                const selectedConceptId = validatedSubmissionData.selectedConceptId;
                const submittedCourseId = validatedSubmissionData.courseId;
                let eligibleConcepts;
                if (submittedCourseId) {
                    [eligibleConcepts] = await connection.execute(
                        `SELECT c.concept_id, c.graph_concept_id
                         FROM concept AS c
                         INNER JOIN concept_course AS cc ON cc.concept_id = c.concept_id
                         INNER JOIN course ON course.graph_course_id = cc.course_graph_id
                         WHERE c.concept_id = ? AND cc.course_graph_id = ?
                           AND c.graph_concept_id IS NOT NULL AND TRIM(c.graph_concept_id) <> ''
                         FOR UPDATE`, [selectedConceptId, submittedCourseId]
                    );
                } else {
                    const resourceDomainCourseIds = validatedSubmissionData.domainCourseIds;
                    const domainPlaceholders = resourceDomainCourseIds.map(() => '?').join(', ');
                    [eligibleConcepts] = await connection.execute(
                        `SELECT c.concept_id, c.graph_concept_id
                         FROM concept AS c
                         INNER JOIN concept_course AS cc ON cc.concept_id = c.concept_id
                         WHERE c.concept_id = ? AND c.graph_concept_id IS NOT NULL
                           AND cc.course_graph_id IN (${domainPlaceholders})
                         FOR UPDATE`, [selectedConceptId, ...resourceDomainCourseIds]
                    );
                }
                const concept = eligibleConcepts[0];
                if (!concept || !concept.graph_concept_id) {
                    throw new ApprovalError('invalid_concept_reference', 'The selected concept is not approved for this resource.', 422);
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

    if (type === 'COURSE') {
        return {
            title: requiredText('title', 200),
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
            if ((data.courseId === undefined) !== (data.conceptId === undefined)) {
                throw new ApprovalError('invalid_submission_data', 'Resource course and concept references must be supplied together.', 422);
            }
            if (data.document.documentId !== undefined &&
                (!Number.isSafeInteger(Number(data.document.documentId)) || Number(data.document.documentId) < 1)) {
                throw new ApprovalError('invalid_submission_data', 'Resource document reference is invalid.', 422);
            }
            return {
                ...(data.courseId === undefined ? {} : { courseId: validateReference(data.courseId, 'courseId') }),
                ...(data.conceptId === undefined ? {} : { conceptId: validateReference(data.conceptId, 'conceptId') }),
                title: requiredText('title', 255),
                type: 'document',
                document: {
                    filename: data.document.filename,
                    originalName: data.document.originalName,
                    extension: data.document.extension,
                    documentType: data.document.documentType,
                    size: data.document.size,
                    ...(data.document.documentId === undefined
                        ? {}
                        : { documentId: Number(data.document.documentId) })
                }
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

async function createPendingCourseSubmission({ title, description = '', learnerId }) {
    const normalizedTitle = typeof title === 'string' ? title.trim() : '';
    const courseDescription = typeof description === 'string' ? description.trim() : '';
    if (!normalizedTitle || normalizedTitle.length > 200 || courseDescription.length > 5000) {
        throw new ApprovalError('invalid_course_submission', 'Course title or description is invalid.', 400);
    }
    return createPendingSubmission('COURSE', {
        title: normalizedTitle,
        description: courseDescription
    }, learnerId);
}

function resourceRequestError(status, code, message) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

async function findResourceSubmission(queryable, learnerId, idempotencyKey) {
    const [rows] = await queryable.execute(
        `SELECT s.submission_id, s.submission_type, s.submission_data, s.status,
                s.submitted_at, s.reviewed_by, s.review_notes, s.reviewed_at,
                ud.processing_status AS document_processing_status
         FROM knowledge_submissions AS s
         LEFT JOIN uploaded_document AS ud
           ON ud.document_id = CAST(JSON_UNQUOTE(JSON_EXTRACT(s.submission_data, '$.document.documentId')) AS UNSIGNED)
         WHERE s.submitted_by = ? AND s.submission_type = 'RESOURCE'
           AND JSON_UNQUOTE(JSON_EXTRACT(s.submission_data, '$._idempotency.key')) = ?
         ORDER BY s.submission_id DESC LIMIT 1`,
        [learnerId, idempotencyKey]
    );
    return rows[0] || null;
}

function existingResourceResult(row, fingerprint) {
    const data = parseSubmissionData(row.submission_data);
    if (data?._idempotency?.fingerprint !== fingerprint) {
        throw resourceRequestError(409, 'IDEMPOTENCY_KEY_REUSED', 'This submission retry key was already used for different document data. Change the title or file and submit again.');
    }
    const submission = formatSubmission(row);
    if (!Number.isSafeInteger(Number(submission.submissionData?.document?.documentId))) {
        throw resourceRequestError(503, 'SUBMISSION_LINK_UNAVAILABLE', 'The saved document submission could not be safely retrieved.');
    }
    return { submission, replayed: true, processingStatus: row.document_processing_status || 'unknown' };
}

async function createPendingResourceSubmission({ learnerId, title, courseId, conceptId, document, idempotencyKey, fingerprint }) {
    if (typeof courseId !== 'string' || !courseId.trim() || courseId.length > 100 ||
        !Number.isSafeInteger(Number(conceptId)) || Number(conceptId) < 1) {
        throw resourceRequestError(400, 'RESOURCE_CONCEPT_REQUIRED', 'Select an approved course and concept for this document.');
    }
    if (typeof idempotencyKey !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey) ||
        typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
        throw resourceRequestError(400, 'INVALID_IDEMPOTENCY_KEY', 'A valid resource submission retry key is required.');
    }
    const connection = await mysql.getConnection();
    let transactionOpen = false;
    let connectionUsable = true;
    let lockAcquired = false;
    let commitAttempted = false;
    let primaryError;
    let result;
    try {
        const lockName = `nl-resource:${createHash('sha256').update(`${learnerId}:${idempotencyKey}`).digest('hex').slice(0, 40)}`;
        const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 8) AS acquired', [lockName]);
        if (Number(lockRows[0]?.acquired) !== 1) {
            throw resourceRequestError(503, 'RESOURCE_SUBMISSION_BUSY', 'This submission is still being processed. Please retry shortly.');
        }
        lockAcquired = true;

        const existing = await findResourceSubmission(connection, learnerId, idempotencyKey);
        if (existing) return existingResourceResult(existing, fingerprint);

        await connection.beginTransaction();
        transactionOpen = true;
        const [documentResult] = await connection.execute(
            `INSERT INTO uploaded_document
                (learner_id, filename, file_type, file_size, file_path, processing_status)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [learnerId, document.originalName, document.extension.slice(1), document.size, document.filePath, document.processingStatus]
        );
        const submissionData = {
            title,
            courseId,
            conceptId: Number(conceptId),
            type: 'document',
            document: {
                filename: document.filename,
                originalName: document.originalName,
                extension: document.extension,
                documentType: document.documentType,
                size: document.size,
                documentId: Number(documentResult.insertId)
            },
            _idempotency: { key: idempotencyKey, fingerprint }
        };
        const [submissionResult] = await connection.execute(
            `INSERT INTO knowledge_submissions
                (submission_type, submission_data, status, submitted_by)
             VALUES ('RESOURCE', ?, 'pending', ?)`,
            [JSON.stringify(submissionData), learnerId]
        );
        commitAttempted = true;
        await connection.commit();
        transactionOpen = false;
        const { _idempotency: internalIdempotency, ...publicSubmissionData } = submissionData;
        void internalIdempotency;
        result = {
            submission: {
                submissionId: Number(submissionResult.insertId),
                submissionType: 'RESOURCE',
                submissionData: publicSubmissionData,
                status: 'pending'
            },
            replayed: false,
            processingStatus: document.processingStatus
        };
    } catch (error) {
        primaryError = error;
        if (transactionOpen && !commitAttempted) {
            try {
                await connection.rollback();
                transactionOpen = false;
            } catch {
                connectionUsable = false;
                try { connection.destroy(); } catch { /* Do not reuse an uncertain connection. */ }
            }
        }
        if (commitAttempted) {
            connectionUsable = false;
            try { connection.destroy(); } catch { /* Reconcile on a fresh connection. */ }
        }
    } finally {
        if (connectionUsable && lockAcquired) {
            try {
                const [releaseRows] = await connection.execute('SELECT RELEASE_LOCK(?) AS released', [
                    `nl-resource:${createHash('sha256').update(`${learnerId}:${idempotencyKey}`).digest('hex').slice(0, 40)}`
                ]);
                if (Number(releaseRows[0]?.released) !== 1) throw new Error('Resource submission lock was not released.');
            } catch {
                connectionUsable = false;
                try { connection.destroy(); } catch { /* Discard uncertain named-lock ownership. */ }
            }
        }
        if (connectionUsable) {
            try {
                connection.release();
            } catch {
                try { connection.destroy(); } catch { /* A committed submission remains valid; never return this connection to the pool. */ }
            }
        }
    }

    if (primaryError && commitAttempted) {
        try {
            const existing = await findResourceSubmission(mysql, learnerId, idempotencyKey);
            if (existing) return existingResourceResult(existing, fingerprint);
        } catch (reconciliationError) {
            reconciliationError.outcomeUncertain = true;
            reconciliationError.status = 503;
            reconciliationError.code = 'RESOURCE_SUBMISSION_STATUS_UNCONFIRMED';
            reconciliationError.message = 'Submission status could not be confirmed. Refresh your submission history before retrying.';
            throw reconciliationError;
        }
    }
    if (primaryError) throw primaryError;
    return result;
}


async function getLearnerSubmissions(learnerId, limit, offset) {
    const safeLimit = Number(limit);
    const safeOffset = Number(offset);

    if (
        !Number.isSafeInteger(safeLimit) || safeLimit < 1 ||
        !Number.isSafeInteger(safeOffset) || safeOffset < 0
    ) {
        throw new Error('Invalid submission pagination values.');
    }

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
         LIMIT ${safeLimit} OFFSET ${safeOffset}`,
        [learnerId]
    );

    return {
        total: Number(countRow.total),
        submissions: rows.map(formatSubmission)
    };
}


module.exports = {
    ApprovalError,
    createPendingSubmission,
    createPendingCourseSubmission,
    createPendingResourceSubmission,
    createAdministratorPrerequisiteSubmission,
    getDatabaseConcepts,
    getDatabaseConceptOptions,
    getApprovedCourseConceptOptions,
    getCourseConceptOptions,
    validateResourceCourseConcept,
    getAdminSubmission,
    getAdminSubmissions,
    getOutboxStatistics,
    getLearnerSubmissions,
    retryFailedOutboxTask,
    resolveConceptReference,
    reviewPendingSubmission
};
