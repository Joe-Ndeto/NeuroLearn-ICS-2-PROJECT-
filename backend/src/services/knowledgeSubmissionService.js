'use strict';

const mysql = require('../config/mysql');

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
           reviewer.email AS reviewer_email
    FROM knowledge_submissions AS s
    INNER JOIN learner AS submitter
        ON submitter.learner_id = s.submitted_by
    LEFT JOIN learner AS reviewer
        ON reviewer.learner_id = s.reviewed_by`;

async function getAdminSubmissions({ status, type, limit, offset }) {
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

    const whereClause = conditions.length
        ? ` WHERE ${conditions.join(' AND ')}`
        : '';

    const [[countRow]] = await mysql.execute(
        `SELECT COUNT(*) AS total
         FROM knowledge_submissions AS s${whereClause}`,
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

async function reviewPendingSubmission({
    submissionId,
    status,
    reviewNotes,
    reviewerId
}) {
    if (status !== 'approved' && status !== 'rejected') {
        throw new Error('Invalid review status. Expected "approved" or "rejected".');
    }

    const [result] = await mysql.execute(
        `UPDATE knowledge_submissions
         SET status = ?, review_notes = ?, reviewed_by = ?,
             reviewed_at = CURRENT_TIMESTAMP
         WHERE submission_id = ? AND status = 'pending'`,
        [status, reviewNotes, reviewerId, submissionId]
    );

    if (result.affectedRows !== 1) {
        const [rows] = await mysql.execute(
            `SELECT status
             FROM knowledge_submissions
             WHERE submission_id = ?`,
            [submissionId]
        );

        return {
            outcome: rows.length ? 'already_reviewed' : 'not_found'
        };
    }

    return {
        outcome: 'reviewed',
        submission: await getAdminSubmission(submissionId)
    };
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
    createPendingSubmission,
    getAdminSubmission,
    getAdminSubmissions,
    getLearnerSubmissions,
    resolveConceptReference,
    reviewPendingSubmission
};
