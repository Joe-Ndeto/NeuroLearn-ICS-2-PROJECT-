'use strict';

const { calculateMastery } = require('./masteryCalculator');

class LearnerProgressError extends Error {
    constructor(code, message, status = 503, cause = null) {
        super(message);
        this.name = 'LearnerProgressError';
        this.code = code;
        this.status = status;
        if (cause) this.cause = cause;
    }
}

function positiveInteger(value, field) {
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new LearnerProgressError('INVALID_PROGRESS_DATA', `Invalid ${field}.`);
    }
    return parsed;
}

function nonNegativeIntegerOrNull(value, field) {
    if (value === null) return null;
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new LearnerProgressError('INVALID_PROGRESS_DATA', `Invalid ${field}.`);
    }
    return parsed;
}

function positiveIntegerOrNull(value, field) {
    if (value === null) return null;
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new LearnerProgressError('INVALID_PROGRESS_DATA', `Invalid ${field}.`);
    }
    return parsed;
}

function scoreNumber(value) {
    const parsed = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        throw new LearnerProgressError('INVALID_PROGRESS_DATA', 'Assessment evidence is invalid.');
    }
    return parsed;
}

function collectCourseAncestors(courseId, edges) {
    const incoming = new Map();
    for (const edge of edges) {
        const prerequisite = positiveInteger(edge.prerequisiteCourseId, 'prerequisite course ID');
        const target = positiveInteger(edge.targetCourseId, 'target course ID');
        if (!incoming.has(target)) incoming.set(target, []);
        incoming.get(target).push({ prerequisite, relationshipId: positiveInteger(edge.relationshipId, 'course prerequisite ID') });
    }
    const active = new Set();
    const visited = new Set();
    const ancestors = new Set();
    const relationshipIds = new Set();
    function visit(id) {
        if (active.has(id)) throw new LearnerProgressError('COURSE_PREREQUISITE_CYCLE', 'Course prerequisite data contains a cycle.');
        if (visited.has(id)) return;
        active.add(id);
        for (const edge of incoming.get(id) || []) {
            relationshipIds.add(edge.relationshipId);
            ancestors.add(edge.prerequisite);
            visit(edge.prerequisite);
        }
        active.delete(id);
        visited.add(id);
    }
    visit(courseId);
    if (ancestors.has(courseId)) throw new LearnerProgressError('COURSE_PREREQUISITE_CYCLE', 'A course cannot be its own prerequisite.');
    return { ancestors, relationshipIds };
}

function sameSet(left, right) {
    return left.size === right.size && [...left].every(value => right.has(value));
}

function createLearnerProgressService({ mysql: injectedMysql = null, asOf = () => new Date(), coursePrerequisiteReader = null } = {}) {
    const mysql = injectedMysql || require('../config/mysql');
    if (!mysql || typeof mysql.getConnection !== 'function') {
        throw new TypeError('A mysql2/promise pool is required.');
    }
    if (typeof asOf !== 'function' && !(asOf instanceof Date) && typeof asOf !== 'string') {
        throw new TypeError('asOf must be a clock function, Date, or date string.');
    }

    async function getProgressForLearner({ learnerId, courseId } = {}) {
        const numericLearnerId = Number(learnerId);
        if (!Number.isSafeInteger(numericLearnerId) || numericLearnerId < 1) {
            throw new LearnerProgressError('INVALID_LEARNER_ID', 'A valid learner ID is required.', 400);
        }
        if (typeof courseId !== 'string' || !/^COURSE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(courseId)) {
            throw new LearnerProgressError('INVALID_COURSE_ID', 'A valid course ID is required.', 400);
        }

        const connection = await mysql.getConnection();
        let transactionStarted = false;
        let reusable = true;
        let operationError = null;
        const destroy = () => {
            reusable = false;
            try {
                if (typeof connection.destroy === 'function') connection.destroy();
                else connection.release();
            } catch {
                // Keep the original request failure.
            }
        };

        try {
            await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await connection.beginTransaction();
            transactionStarted = true;

            const [learners] = await connection.execute(
                'SELECT learner_id FROM learner WHERE learner_id = ?',
                [numericLearnerId]
            );
            if (learners.length !== 1) {
                throw new LearnerProgressError('LEARNER_NOT_FOUND', 'The learner was not found.', 404);
            }

            const [targetCourseRows] = await connection.execute(
                'SELECT course_id, graph_course_id, title FROM course WHERE graph_course_id = ?', [courseId]
            );
            if (targetCourseRows.length !== 1) throw new LearnerProgressError('COURSE_NOT_CANONICAL', 'The requested course is not in the approved canonical catalogue.', 404);
            const targetCourse = targetCourseRows[0];
            const targetCourseId = positiveInteger(targetCourse.course_id, 'course ID');
            const [edgeRows] = await connection.execute(
                `SELECT course_prerequisite_id AS relationshipId,
                        prerequisite_course_id AS prerequisiteCourseId,
                        target_course_id AS targetCourseId
                 FROM course_prerequisite WHERE is_active = TRUE ORDER BY course_prerequisite_id`
            );
            const canonicalEdges = edgeRows.map(edge => ({
                relationshipId: positiveInteger(edge.relationshipId, 'course prerequisite ID'),
                prerequisiteCourseId: positiveInteger(edge.prerequisiteCourseId, 'prerequisite course ID'),
                targetCourseId: positiveInteger(edge.targetCourseId, 'target course ID')
            }));
            const closure = collectCourseAncestors(targetCourseId, canonicalEdges);
            const relevantCourseIds = [...closure.ancestors, targetCourseId].sort((a, b) => a - b);
            const coursePlaceholders = relevantCourseIds.map(() => '?').join(',');
            const [relevantCourses] = await connection.execute(
                `SELECT course_id, graph_course_id, title FROM course WHERE course_id IN (${coursePlaceholders})`,
                relevantCourseIds
            );
            if (relevantCourses.length !== relevantCourseIds.length) throw new LearnerProgressError('COURSE_MAPPING_MISSING', 'A prerequisite course is missing from the canonical catalogue.');
            const coursesById = new Map(relevantCourses.map(row => [positiveInteger(row.course_id, 'course ID'), row]));
            const relevantRelationIds = [...closure.relationshipIds];
            const unresolvedClauses = [`(canonical_record_type = 'COURSE' AND canonical_record_id IN (${coursePlaceholders}))`];
            let unresolvedParams = [...relevantCourseIds];
            if (relevantRelationIds.length) {
                unresolvedClauses.push(`(canonical_record_type = 'COURSE_PREREQUISITE' AND canonical_record_id IN (${relevantRelationIds.map(() => '?').join(',')}))`);
                unresolvedParams.push(...relevantRelationIds);
            }
            const [unresolvedTasks] = await connection.execute(
                `SELECT outbox_id FROM knowledge_sync_outbox WHERE sync_status <> 'completed' AND (${unresolvedClauses.join(' OR ')})`,
                unresolvedParams
            );
            if (unresolvedTasks.length) throw new LearnerProgressError('COURSE_SYNC_PENDING', 'Course prerequisite synchronization is incomplete.');
            const graphIds = relevantCourseIds.map(id => coursesById.get(id).graph_course_id);
            if (graphIds.some(id => typeof id !== 'string' || !/^COURSE-[0-9a-f-]{36}$/i.test(id))) throw new LearnerProgressError('COURSE_MAPPING_MISSING', 'A prerequisite course graph mapping is invalid.');

            const [conceptRows] = await connection.execute(
                `SELECT c.concept_id AS conceptId, c.concept_name AS conceptName, cc.course_graph_id AS graphCourseId
                 FROM concept AS c
                 INNER JOIN concept_course AS cc ON cc.concept_id = c.concept_id
                 WHERE cc.course_graph_id IN (${graphIds.map(() => '?').join(',')})
                 ORDER BY c.concept_id, cc.course_graph_id`,
                graphIds
            );
            const concepts = new Map();
            const conceptCourseMemberships = new Map();
            const targetConceptIds = new Set();
            for (const row of conceptRows) {
                const conceptId = positiveInteger(row.conceptId, 'concept ID');
                if (typeof row.conceptName !== 'string' || !row.conceptName.trim()) throw new LearnerProgressError('INVALID_PROGRESS_DATA', 'Course concept data is invalid.');
                if (concepts.has(conceptId) && concepts.get(conceptId) !== row.conceptName.trim()) throw new LearnerProgressError('INVALID_PROGRESS_DATA', 'Canonical concept names are inconsistent.');
                concepts.set(conceptId, row.conceptName.trim());
                if (!conceptCourseMemberships.has(conceptId)) conceptCourseMemberships.set(conceptId, new Set());
                conceptCourseMemberships.get(conceptId).add(row.graphCourseId);
                if (row.graphCourseId === courseId) targetConceptIds.add(conceptId);
            }

            const conceptIds = [...concepts.keys()];
            let evidenceRows = [];
            if (conceptIds.length) {
                const placeholders = conceptIds.map(() => '?').join(',');
                const [rows] = await connection.execute(
                    `SELECT qr.concept_id AS conceptId,
                            a.assessment_id AS assessmentId,
                            qr.score AS score,
                            a.assessment_date AS assessmentDate,
                            qr.question_count AS questionCount,
                            qr.correct_count AS correctCount,
                            a.timestamp_provenance AS timestampProvenance
                     FROM quiz_result AS qr
                     INNER JOIN assessment AS a ON a.assessment_id = qr.assessment_id
                     WHERE a.learner_id = ?
                       AND qr.concept_id IN (${placeholders})
                     ORDER BY qr.concept_id, a.assessment_date, a.assessment_id, qr.result_id`,
                    [numericLearnerId, ...conceptIds]
                );
                evidenceRows = rows;
            }

            const evidenceByConcept = new Map();
            for (const row of evidenceRows) {
                const conceptId = positiveInteger(row.conceptId, 'evidence concept ID');
                if (!concepts.has(conceptId) || !['utc', 'unknown'].includes(row.timestampProvenance)) {
                    throw new LearnerProgressError('INVALID_PROGRESS_DATA', 'Assessment evidence is invalid.');
                }
                if (!evidenceByConcept.has(conceptId)) evidenceByConcept.set(conceptId, []);
                evidenceByConcept.get(conceptId).push({
                    assessmentId: positiveInteger(row.assessmentId, 'assessment ID'),
                    score: scoreNumber(row.score),
                    assessmentDate: row.assessmentDate,
                    questionCount: positiveIntegerOrNull(row.questionCount, 'question count'),
                    correctCount: nonNegativeIntegerOrNull(row.correctCount, 'correct count'),
                    timestampProvenance: row.timestampProvenance
                });
            }

            const referenceTime = typeof asOf === 'function' ? asOf() : asOf;
            const results = [...targetConceptIds].map(conceptId => ({
                conceptId,
                mastery: calculateMastery(evidenceByConcept.get(conceptId) || [], { asOf: referenceTime })
            }));
            const assessed = results.filter(item => item.mastery.mastery !== null);
            // A single provisional score is not enough to count a concept as mastered.
            const masteredConcepts = results.filter(item =>
                item.mastery.evidenceStatus === 'EVIDENCE_QUALIFIED' &&
                item.mastery.mastery !== null && item.mastery.mastery >= 85
            ).length;
            const averageMastery = assessed.length
                ? Number((assessed.reduce((sum, item) => sum + item.mastery.mastery, 0) / assessed.length).toFixed(4))
                : null;
            const masteryStatus = assessed.length === 0
                ? 'UNKNOWN'
                : results.every(item => item.mastery.evidenceStatus === 'EVIDENCE_QUALIFIED')
                    ? 'EVIDENCE_QUALIFIED'
                    : 'PROVISIONAL';
            const progressPercentage = targetConceptIds.size === 0
                ? 0
                : Number(((masteredConcepts / targetConceptIds.size) * 100).toFixed(4));

            await connection.commit();
            transactionStarted = false;
            const readCoursePrerequisites = coursePrerequisiteReader || require('./knowledgeGraphService').getCoursePrerequisiteClosure;
            const graphClosures = await readCoursePrerequisites(graphIds);
            for (const relevantCourseId of relevantCourseIds) {
                const expected = new Set([...collectCourseAncestors(relevantCourseId, canonicalEdges).ancestors]
                    .map(id => coursesById.get(id)?.graph_course_id));
                const actual = new Set(graphClosures.get(coursesById.get(relevantCourseId).graph_course_id) || []);
                if ([...expected].some(id => typeof id !== 'string') || !sameSet(expected, actual)) {
                    throw new LearnerProgressError('COURSE_PREREQUISITE_MISMATCH', 'MySQL and Neo4j course prerequisite data differ.');
                }
            }
            const prerequisiteSummaries = [...closure.ancestors].sort((a, b) => a - b).map(prerequisiteId => {
                const prerequisiteCourse = coursesById.get(prerequisiteId);
                const ids = [...concepts.keys()].filter(conceptId => conceptCourseMemberships.get(conceptId)?.has(prerequisiteCourse.graph_course_id));
                const states = ids.map(conceptId => calculateMastery(evidenceByConcept.get(conceptId) || [], { asOf: referenceTime }));
                return {
                    courseId: prerequisiteId,
                    title: prerequisiteCourse.title,
                    satisfied: ids.length > 0 && states.every(mastery => mastery.evidenceStatus === 'EVIDENCE_QUALIFIED' && mastery.mastery !== null && mastery.mastery >= 80)
                };
            });
            const completion = targetConceptIds.size > 0 && results.length === targetConceptIds.size && masteredConcepts === targetConceptIds.size;
            return {
                progress: {
                    percentage: progressPercentage,
                    masteredConcepts,
                    totalConcepts: targetConceptIds.size
                },
                mastery: {
                    percentage: averageMastery,
                    status: masteryStatus,
                    assessedConcepts: assessed.length,
                    totalConcepts: targetConceptIds.size
                },
                courseCompletion: { complete: completion, masteredConcepts, totalConcepts: targetConceptIds.size },
                prerequisiteEligibility: { eligible: prerequisiteSummaries.every(item => item.satisfied), prerequisites: prerequisiteSummaries }
            };
        } catch (error) {
            operationError = error;
            if (transactionStarted) {
                try {
                    await connection.rollback();
                    transactionStarted = false;
                } catch {
                    transactionStarted = false;
                    destroy();
                }
            }
            if (error instanceof LearnerProgressError) throw error;
            throw new LearnerProgressError('PROGRESS_UNAVAILABLE', 'Learner progress could not be loaded.', 503, error);
        } finally {
            if (reusable) {
                try {
                    connection.release();
                } catch (error) {
                    destroy();
                    if (!operationError) {
                        throw new LearnerProgressError('PROGRESS_UNAVAILABLE', 'Learner progress could not be loaded.', 503, error);
                    }
                }
            }
        }
    }

    return { getProgressForLearner };
}

module.exports = { createLearnerProgressService, LearnerProgressError };
