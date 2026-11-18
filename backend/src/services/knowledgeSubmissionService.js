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
    getLearnerSubmissions,
    resolveConceptReference
};
