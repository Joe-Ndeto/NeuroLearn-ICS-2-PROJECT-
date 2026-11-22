'use strict';

const { calculateMastery } = require('./masteryCalculator');
const { rankRecommendations } = require('./recommendationRanker');

const DOMAIN_COURSE_NAME = 'database concepts';
const COURSE_ID_PATTERN = /^COURSE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class RecommendationServiceError extends Error {
    constructor(code, message, status = 503, cause = null) {
        super(message);
        this.name = 'RecommendationServiceError';
        this.code = code;
        this.status = status;
        if (cause) this.cause = cause;
    }
}

function positiveInteger(value, field) {
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new RecommendationServiceError('INVALID_RECOMMENDATION_DATA', `Invalid ${field}.`, 500);
    }
    return parsed;
}

function parseScore(value) {
    const validString = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
    if (typeof value !== 'number' && !validString) {
        throw new RecommendationServiceError('INVALID_RECOMMENDATION_DATA', 'Assessment evidence is invalid.', 500);
    }
    const score = Number(value);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
        throw new RecommendationServiceError('INVALID_RECOMMENDATION_DATA', 'Assessment evidence is invalid.', 500);
    }
    return score;
}

function graphConceptId(value, field = 'graph concept ID') {
    if (typeof value !== 'string' || !value.trim()) {
        throw new RecommendationServiceError('INVALID_RECOMMENDATION_DATA', `Invalid ${field}.`, 500);
    }
    return value;
}

function mapEvidenceRow(row) {
    if (!row || (row.timestampProvenance !== 'utc' && row.timestampProvenance !== 'unknown')) {
        throw new RecommendationServiceError('INVALID_RECOMMENDATION_DATA', 'Assessment timestamp provenance is invalid.', 500);
    }
    return {
        assessmentId: positiveInteger(row.assessmentId, 'assessment ID'),
        score: parseScore(row.score),
        assessmentDate: row.assessmentDate,
        questionCount: row.questionCount === null ? null : positiveInteger(row.questionCount, 'question count'),
        correctCount: row.correctCount === null ? null : positiveIntegerOrZero(row.correctCount, 'correct count'),
        timestampProvenance: row.timestampProvenance
    };
}

function positiveIntegerOrZero(value, field) {
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new RecommendationServiceError('INVALID_RECOMMENDATION_DATA', `Invalid ${field}.`, 500);
    }
    return parsed;
}

function adjacencyFromCanonicalEdges(edges) {
    const incoming = new Map();
    const edgeKeys = new Set();
    const relationshipIds = new Set();
    for (const edge of edges) {
        const prerequisiteId = positiveInteger(edge.prerequisiteId, 'prerequisite concept ID');
        const targetId = positiveInteger(edge.targetId, 'target concept ID');
        const prerequisiteIdRow = positiveInteger(edge.prerequisiteRowId, 'prerequisite relationship ID');
        const key = `${prerequisiteId}:${targetId}`;
        if (prerequisiteId === targetId || edgeKeys.has(key) || relationshipIds.has(prerequisiteIdRow)) {
            throw new RecommendationServiceError('PREREQUISITE_CYCLE_OR_DUPLICATE', 'Canonical prerequisite data is inconsistent.');
        }
        edgeKeys.add(key);
        relationshipIds.add(prerequisiteIdRow);
        if (!incoming.has(targetId)) incoming.set(targetId, []);
        incoming.get(targetId).push({ prerequisiteId, relationshipId: prerequisiteIdRow });
    }
    return incoming;
}

function getCanonicalClosure(candidateId, incoming) {
    const ancestors = new Set();
    const active = new Set();
    const expanded = new Set();
    const relationshipIds = new Set();

    function visit(conceptId) {
        if (active.has(conceptId)) {
            throw new RecommendationServiceError('PREREQUISITE_CYCLE_OR_DUPLICATE', 'Canonical prerequisite data contains a cycle.');
        }
        if (expanded.has(conceptId)) return;
        active.add(conceptId);
        for (const edge of incoming.get(conceptId) || []) {
            relationshipIds.add(edge.relationshipId);
            ancestors.add(edge.prerequisiteId);
            visit(edge.prerequisiteId);
        }
        active.delete(conceptId);
        expanded.add(conceptId);
    }

    visit(candidateId);
    if (ancestors.has(candidateId)) {
        throw new RecommendationServiceError('PREREQUISITE_CYCLE_OR_DUPLICATE', 'A concept cannot be its own prerequisite.');
    }
    return { ancestors, relationshipIds };
}

function assertGraphAcyclic(nodes, edges, conceptIdByGraphId) {
    const adjacency = new Map();
    const seenEdges = new Set();
    for (const edge of edges) {
        const sourceGraphId = graphConceptId(edge.prerequisiteGraphId, 'graph prerequisite ID');
        const targetGraphId = graphConceptId(edge.targetGraphId, 'graph target ID');
        const sourceId = conceptIdByGraphId.get(sourceGraphId);
        const targetId = conceptIdByGraphId.get(targetGraphId);
        if (sourceId === undefined || targetId === undefined) {
            throw new RecommendationServiceError('MISSING_CANONICAL_MAPPING', 'A graph prerequisite has no canonical concept mapping.');
        }
        if (!nodes.has(sourceId) || !nodes.has(targetId)) {
            throw new RecommendationServiceError('INVALID_PREREQUISITE_GRAPH', 'The graph returned an unrelated prerequisite edge.');
        }
        const key = `${sourceId}:${targetId}`;
        if (sourceId === targetId || seenEdges.has(key)) {
            throw new RecommendationServiceError('PREREQUISITE_CYCLE_OR_DUPLICATE', 'Graph prerequisite data contains a cycle or duplicate edge.');
        }
        seenEdges.add(key);
        if (!adjacency.has(sourceId)) adjacency.set(sourceId, []);
        adjacency.get(sourceId).push(targetId);
    }

    const active = new Set();
    const visited = new Set();
    function visit(conceptId) {
        if (active.has(conceptId)) {
            throw new RecommendationServiceError('PREREQUISITE_CYCLE_OR_DUPLICATE', 'Graph prerequisite data contains a cycle.');
        }
        if (visited.has(conceptId)) return;
        active.add(conceptId);
        for (const targetId of adjacency.get(conceptId) || []) visit(targetId);
        active.delete(conceptId);
        visited.add(conceptId);
    }
    for (const conceptId of nodes) visit(conceptId);
}

function sameSet(left, right) {
    return left.size === right.size && [...left].every(value => right.has(value));
}

function getCourseClosure(candidateId, rows) {
    const incoming = new Map();
    for (const row of rows) {
        const prerequisiteId = positiveInteger(row.prerequisiteCourseId, 'prerequisite course ID');
        const targetId = positiveInteger(row.targetCourseId, 'target course ID');
        const relationshipId = positiveInteger(row.relationshipId, 'course prerequisite ID');
        if (!incoming.has(targetId)) incoming.set(targetId, []);
        incoming.get(targetId).push({ prerequisiteId, relationshipId });
    }
    const active = new Set();
    const visited = new Set();
    const ancestors = new Set();
    const relationshipIds = new Set();
    function visit(courseId) {
        if (active.has(courseId)) throw new RecommendationServiceError('COURSE_PREREQUISITE_CYCLE', 'Canonical course prerequisites contain a cycle.', 503);
        if (visited.has(courseId)) return;
        active.add(courseId);
        for (const edge of incoming.get(courseId) || []) {
            ancestors.add(edge.prerequisiteId);
            relationshipIds.add(edge.relationshipId);
            visit(edge.prerequisiteId);
        }
        active.delete(courseId);
        visited.add(courseId);
    }
    visit(candidateId);
    if (ancestors.has(candidateId)) throw new RecommendationServiceError('COURSE_PREREQUISITE_CYCLE', 'A course cannot be its own prerequisite.', 503);
    return { ancestors, relationshipIds };
}

function createRecommendationService({
    mysql: injectedMysql = null,
    getNeo4jSession = null,
    asOf = () => new Date(),
    ranker = rankRecommendations,
    graphReader = null,
    courseGraphReader = null
} = {}) {
    const mysql = injectedMysql || require('../config/mysql');
    if (!mysql || typeof mysql.getConnection !== 'function') {
        throw new TypeError('A mysql2/promise pool is required.');
    }
    if (getNeo4jSession !== null && typeof getNeo4jSession !== 'function') {
        throw new TypeError('getNeo4jSession must be a function.');
    }
    if (typeof asOf !== 'function' && !(asOf instanceof Date) && typeof asOf !== 'string') {
        throw new TypeError('asOf must be a clock function, Date, or date string.');
    }
    if (typeof ranker !== 'function') throw new TypeError('ranker must be a function.');
    if (graphReader !== null && typeof graphReader !== 'function') {
        throw new TypeError('graphReader must be a function.');
    }
    if (courseGraphReader !== null && typeof courseGraphReader !== 'function') throw new TypeError('courseGraphReader must be a function.');

    const readGraph = async (candidateGraphIds, courseId) => {
        if (graphReader) {
            return graphReader(candidateGraphIds, { courseId, getSessionFactory: getNeo4jSession || undefined });
        }
        const { getPrerequisiteClosure } = require('./knowledgeGraphService');
        const options = { courseId };
        if (getNeo4jSession) options.getSessionFactory = getNeo4jSession;
        return getPrerequisiteClosure(candidateGraphIds, options);
    };

    const readCourseGraph = async courseIds => {
        if (courseGraphReader) return courseGraphReader(courseIds, { getSessionFactory: getNeo4jSession || undefined });
        const { getCoursePrerequisiteClosure } = require('./knowledgeGraphService');
        const options = {};
        if (getNeo4jSession) options.getSessionFactory = getNeo4jSession;
        return getCoursePrerequisiteClosure(courseIds, options);
    };

    async function readCanonicalSnapshot(courseId, learnerId) {
        const connection = await mysql.getConnection();
        let transactionStarted = false;
        let connectionReusable = true;
        let primaryError = null;
        let transactionCommitted = false;

        const destroyConnection = () => {
            connectionReusable = false;
            try {
                if (typeof connection.destroy === 'function') connection.destroy();
                else connection.release();
            } catch {
                // Preserve the primary data/transaction failure.
            }
        };

        try {
            await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await connection.beginTransaction();
            transactionStarted = true;

            const [learnerRows] = await connection.execute(
                'SELECT learner_id FROM learner WHERE learner_id = ?',
                [learnerId]
            );
            if (learnerRows.length !== 1) {
                throw new RecommendationServiceError('LEARNER_NOT_FOUND', 'The learner was not found.', 404);
            }

            const [candidateRows] = await connection.execute(
                `SELECT c.concept_id AS conceptId, c.concept_name AS conceptName,
                        c.graph_concept_id AS graphConceptId, cc.course_graph_id AS courseGraphId
                 FROM concept AS c
                 INNER JOIN concept_course AS cc ON cc.concept_id = c.concept_id
                 WHERE cc.course_graph_id = ?
                 ORDER BY c.concept_id`,
                [courseId]
            );
            const [courseRows] = await connection.execute(
                'SELECT course_id AS courseId, graph_course_id AS graphCourseId, title FROM course WHERE graph_course_id = ?',
                [courseId]
            );
            if (courseRows.length !== 1) throw new RecommendationServiceError('COURSE_NOT_CANONICAL', 'The requested course is not available in the canonical course catalogue.', 503);
            const canonicalCourseId = positiveInteger(courseRows[0].courseId, 'course ID');
            const [coursePrerequisiteRows] = await connection.execute(
                `SELECT course_prerequisite_id AS relationshipId,
                        prerequisite_course_id AS prerequisiteCourseId,
                        target_course_id AS targetCourseId
                 FROM course_prerequisite WHERE is_active = TRUE`,
                []
            );
            const courseClosure = getCourseClosure(canonicalCourseId, coursePrerequisiteRows);
            const relevantCourseIds = [...courseClosure.ancestors, canonicalCourseId].sort((a, b) => a - b);
            const [relevantCourseRows] = await connection.execute(
                `SELECT course_id AS courseId, graph_course_id AS graphCourseId, title
                 FROM course WHERE course_id IN (${relevantCourseIds.map(() => '?').join(',')})`,
                relevantCourseIds
            );
            if (relevantCourseRows.length !== relevantCourseIds.length) throw new RecommendationServiceError('MISSING_CANONICAL_COURSE', 'A prerequisite course has no canonical record.', 503);
            const coursesById = new Map(relevantCourseRows.map(row => [positiveInteger(row.courseId, 'course ID'), row]));
            const courseGraphIds = relevantCourseIds.map(id => coursesById.get(id).graphCourseId);
            if (courseGraphIds.some(id => typeof id !== 'string' || !COURSE_ID_PATTERN.test(id))) throw new RecommendationServiceError('INVALID_COURSE_ASSOCIATION', 'A prerequisite course graph mapping is invalid.', 503);
            const [courseConceptRows] = await connection.execute(
                `SELECT cc.course_graph_id AS courseGraphId, c.concept_id AS conceptId
                 FROM concept_course AS cc INNER JOIN concept AS c ON c.concept_id = cc.concept_id
                 WHERE cc.course_graph_id IN (${courseGraphIds.map(() => '?').join(',')})`,
                courseGraphIds
            );
            const conceptsByCourseGraphId = new Map(courseGraphIds.map(id => [id, new Set()]));
            for (const row of courseConceptRows) {
                if (!conceptsByCourseGraphId.has(row.courseGraphId)) throw new RecommendationServiceError('INVALID_COURSE_ASSOCIATION', 'A course association is inconsistent.', 503);
                conceptsByCourseGraphId.get(row.courseGraphId).add(positiveInteger(row.conceptId, 'course concept ID'));
            }
            const [conceptRows] = await connection.execute(
                `SELECT concept_id AS conceptId, concept_name AS conceptName,
                        graph_concept_id AS graphConceptId
                 FROM concept`,
                []
            );
            const [edgeRows] = await connection.execute(
                `SELECT prerequisite_id AS prerequisiteRowId,
                        prerequisite_concept_id AS prerequisiteId,
                        target_concept_id AS targetId
                 FROM concept_prerequisite`,
                []
            );

            const conceptsById = new Map();
            const conceptIdByGraphId = new Map();
            for (const row of conceptRows) {
                const conceptId = positiveInteger(row.conceptId, 'concept ID');
                if (typeof row.conceptName !== 'string' || !row.conceptName.trim() || conceptsById.has(conceptId)) {
                    throw new RecommendationServiceError('INVALID_RECOMMENDATION_DATA', 'Canonical concept data is invalid.', 503);
                }
                const graphId = typeof row.graphConceptId === 'string' && row.graphConceptId.trim()
                    ? row.graphConceptId
                    : null;
                const concept = { conceptId, conceptName: row.conceptName.trim(), graphConceptId: graphId };
                conceptsById.set(conceptId, concept);
                if (graphId) {
                    if (conceptIdByGraphId.has(graphId)) {
                        conceptIdByGraphId.set(graphId, null);
                    } else {
                        conceptIdByGraphId.set(graphId, conceptId);
                    }
                }
            }

            const candidates = candidateRows.map(row => {
                const conceptId = positiveInteger(row.conceptId, 'candidate concept ID');
                const canonical = conceptsById.get(conceptId);
                if (!canonical || typeof row.conceptName !== 'string' ||
                    row.conceptName.trim() !== canonical.conceptName || row.courseGraphId !== courseId) {
                    throw new RecommendationServiceError('INVALID_COURSE_ASSOCIATION', 'Candidate course associations are invalid.', 503);
                }
                const graphId = graphConceptId(row.graphConceptId, 'candidate graph concept ID');
                if (canonical.graphConceptId !== graphId || conceptIdByGraphId.get(graphId) !== conceptId) {
                    throw new RecommendationServiceError('MISSING_CANONICAL_MAPPING', 'A candidate has no unique graph mapping.', 503);
                }
                return { ...canonical, graphConceptId: graphId };
            });
            if (new Set(candidates.map(candidate => candidate.conceptId)).size !== candidates.length ||
                new Set(candidates.map(candidate => candidate.graphConceptId)).size !== candidates.length) {
                throw new RecommendationServiceError('AMBIGUOUS_CANONICAL_MAPPING', 'Candidate graph mappings are ambiguous.', 503);
            }

            const incoming = adjacencyFromCanonicalEdges(edgeRows);
            const canonicalClosures = new Map();
            const relevantConceptIds = new Set();
            const relevantPrerequisiteRowIds = new Set();
            for (const candidate of candidates) {
                relevantConceptIds.add(candidate.conceptId);
                const closure = getCanonicalClosure(candidate.conceptId, incoming);
                canonicalClosures.set(candidate.conceptId, closure.ancestors);
                for (const conceptId of closure.ancestors) relevantConceptIds.add(conceptId);
                for (const relationshipId of closure.relationshipIds) relevantPrerequisiteRowIds.add(relationshipId);
            }

            for (const courseIdInClosure of relevantCourseIds) {
                for (const conceptId of conceptsByCourseGraphId.get(coursesById.get(courseIdInClosure).graphCourseId)) {
                    relevantConceptIds.add(conceptId);
                }
            }

            const unresolvedClauses = [];
            const unresolvedParams = [];
            if (relevantConceptIds.size) {
                const ids = [...relevantConceptIds];
                unresolvedClauses.push(`(canonical_record_type = 'CONCEPT' AND canonical_record_id IN (${ids.map(() => '?').join(',')}))`);
                unresolvedParams.push(...ids);
            }
            if (relevantPrerequisiteRowIds.size) {
                const ids = [...relevantPrerequisiteRowIds];
                unresolvedClauses.push(`(canonical_record_type = 'PREREQUISITE' AND canonical_record_id IN (${ids.map(() => '?').join(',')}))`);
                unresolvedParams.push(...ids);
            }
            const courseTaskIds = [...relevantCourseIds];
            unresolvedClauses.push(`(canonical_record_type = 'COURSE' AND canonical_record_id IN (${courseTaskIds.map(() => '?').join(',')}))`);
            unresolvedParams.push(...courseTaskIds);
            if (courseClosure.relationshipIds.size) {
                const ids = [...courseClosure.relationshipIds];
                unresolvedClauses.push(`(canonical_record_type = 'COURSE_PREREQUISITE' AND canonical_record_id IN (${ids.map(() => '?').join(',')}))`);
                unresolvedParams.push(...ids);
            }
            if (unresolvedClauses.length) {
                const [unresolvedTasks] = await connection.execute(
                    `SELECT canonical_record_type AS recordType,
                            canonical_record_id AS recordId, sync_status AS syncStatus
                     FROM knowledge_sync_outbox
                     WHERE sync_status <> 'completed' AND (${unresolvedClauses.join(' OR ')})`,
                    unresolvedParams
                );
                if (unresolvedTasks.length) {
                    throw new RecommendationServiceError('KNOWLEDGE_SYNC_PENDING', 'Knowledge graph synchronization is incomplete.', 503);
                }
            }

            const evidenceIds = [...relevantConceptIds].sort((a, b) => a - b);
            let evidenceRows = [];
            if (evidenceIds.length) {
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
                       AND qr.concept_id IN (${evidenceIds.map(() => '?').join(',')})
                     ORDER BY qr.concept_id, a.assessment_date, a.assessment_id, qr.result_id`,
                    [learnerId, ...evidenceIds]
                );
                evidenceRows = rows;
            }

            try {
                await connection.commit();
                transactionStarted = false;
                transactionCommitted = true;
            } catch (error) {
                transactionStarted = false;
                destroyConnection();
                throw error;
            }
            return {
                candidates,
                conceptsById,
                conceptIdByGraphId,
                canonicalClosures,
                relevantConceptIds,
                evidenceRows,
                courseId: canonicalCourseId,
                courseGraphIds,
                relevantCourseIds,
                coursesById,
                courseClosure,
                coursePrerequisiteRows,
                conceptsByCourseGraphId
            };
        } catch (error) {
            primaryError = error;
            if (transactionStarted) {
                try {
                    await connection.rollback();
                    transactionStarted = false;
                } catch {
                    transactionStarted = false;
                    destroyConnection();
                }
            }
            if (error instanceof RecommendationServiceError) throw error;
            throw new RecommendationServiceError(
                'RECOMMENDATION_DATA_UNAVAILABLE',
                'Learner recommendation data is unavailable.',
                503,
                error
            );
        } finally {
            if (connectionReusable) {
                try {
                    connection.release();
                } catch (error) {
                    destroyConnection();
                    if (!primaryError && transactionCommitted) {
                        throw new RecommendationServiceError(
                            'RECOMMENDATION_DATA_UNAVAILABLE',
                            'Learner recommendation data is unavailable.',
                            503,
                            error
                        );
                    }
                }
            }
        }
    }

    async function getRecommendationResultForLearner({ learnerId, courseId } = {}) {
        const numericLearnerId = Number(learnerId);
        if (!Number.isSafeInteger(numericLearnerId) || numericLearnerId < 1) {
            throw new RecommendationServiceError('INVALID_LEARNER_ID', 'A valid learner ID is required.', 400);
        }
        if (typeof courseId !== 'string' || !COURSE_ID_PATTERN.test(courseId)) {
            throw new RecommendationServiceError('INVALID_COURSE_ID', 'A valid course ID is required.', 400);
        }

        const snapshot = await readCanonicalSnapshot(courseId, numericLearnerId);
        let graph;
        try {
            graph = await readGraph(snapshot.candidates.map(candidate => candidate.graphConceptId), courseId);
        } catch (error) {
            if (error?.code === 'COURSE_NOT_FOUND') {
                throw new RecommendationServiceError('COURSE_NOT_FOUND', 'The requested course was not found.', 404, error);
            }
            throw new RecommendationServiceError(
                'PREREQUISITE_GRAPH_UNAVAILABLE',
                'Prerequisite graph data is unavailable.',
                503,
                error
            );
        }
        if (!graph || graph.courseId !== courseId || typeof graph.courseName !== 'string' ||
            graph.courseName.trim().toLowerCase() !== DOMAIN_COURSE_NAME) {
            throw new RecommendationServiceError('UNSUPPORTED_RECOMMENDATION_COURSE', 'Recommendations are currently available only for Database Concepts.', 422);
        }
        if (!Array.isArray(graph.courseConceptIds) || graph.courseConceptIds.some(id => typeof id !== 'string' || !id.trim())) {
            throw new RecommendationServiceError('INVALID_COURSE_ASSOCIATION', 'Graph course associations are invalid.', 503);
        }
        const mysqlCourseConceptIds = new Set(snapshot.candidates.map(candidate => candidate.graphConceptId));
        const graphCourseConceptIds = new Set(graph.courseConceptIds);
        if (graphCourseConceptIds.size !== graph.courseConceptIds.length ||
            !sameSet(mysqlCourseConceptIds, graphCourseConceptIds)) {
            throw new RecommendationServiceError('COURSE_ASSOCIATION_MISMATCH', 'Course concept associations are not synchronized.', 503);
        }

        const graphClosures = new Map();
        for (const closure of graph.closures || []) {
            if (!closure || typeof closure.candidateGraphId !== 'string' || !closure.candidateGraphId.trim() ||
                !Array.isArray(closure.prerequisiteGraphIds) ||
                closure.prerequisiteGraphIds.some(id => typeof id !== 'string' || !id.trim()) ||
                new Set(closure.prerequisiteGraphIds).size !== closure.prerequisiteGraphIds.length ||
                graphClosures.has(closure.candidateGraphId)) {
                throw new RecommendationServiceError('INVALID_PREREQUISITE_GRAPH', 'Prerequisite graph data is invalid.', 503);
            }
            graphClosures.set(closure.candidateGraphId, new Set(closure.prerequisiteGraphIds));
        }
        if (graphClosures.size !== snapshot.candidates.length) {
            throw new RecommendationServiceError('MISSING_CANDIDATE_NODE', 'A candidate concept is missing from the knowledge graph.', 503);
        }

        let courseGraphClosures;
        try {
            courseGraphClosures = await readCourseGraph(snapshot.courseGraphIds);
        } catch (error) {
            throw new RecommendationServiceError('COURSE_PREREQUISITE_GRAPH_UNAVAILABLE', 'Course prerequisite data is unavailable.', 503, error);
        }
        if (!(courseGraphClosures instanceof Map) || courseGraphClosures.size !== snapshot.courseGraphIds.length) {
            throw new RecommendationServiceError('COURSE_PREREQUISITE_GRAPH_INVALID', 'Course prerequisite graph data is invalid.', 503);
        }
        for (const canonicalCourseId of snapshot.relevantCourseIds) {
            const course = snapshot.coursesById.get(canonicalCourseId);
            const actual = courseGraphClosures.get(course.graphCourseId);
            const expected = new Set([...getCourseClosure(canonicalCourseId, snapshot.coursePrerequisiteRows).ancestors]
                .map(id => snapshot.coursesById.get(id)?.graphCourseId));
            if (!Array.isArray(actual) || actual.some(id => typeof id !== 'string' || !COURSE_ID_PATTERN.test(id)) ||
                [...expected].some(id => typeof id !== 'string') || !sameSet(expected, new Set(actual))) {
                throw new RecommendationServiceError('COURSE_PREREQUISITE_MISMATCH', 'MySQL and Neo4j course prerequisite closures differ.', 503);
            }
        }

        const relevantGraphIds = new Set(snapshot.candidates.map(candidate => candidate.graphConceptId));
        for (const ids of graphClosures.values()) for (const graphId of ids) relevantGraphIds.add(graphConceptId(graphId));
        const canonicalPrerequisiteIdsByCandidate = new Map();
        for (const candidate of snapshot.candidates) {
            const graphPrerequisites = graphClosures.get(candidate.graphConceptId);
            if (!graphPrerequisites) {
                throw new RecommendationServiceError('MISSING_CANDIDATE_NODE', 'A candidate concept is missing from the knowledge graph.', 503);
            }
            if (graphPrerequisites.has(candidate.graphConceptId)) {
                throw new RecommendationServiceError('PREREQUISITE_CYCLE_OR_DUPLICATE', 'A concept cannot be its own prerequisite.', 503);
            }
            const mappedIds = new Set();
            for (const graphId of graphPrerequisites) {
                const conceptId = snapshot.conceptIdByGraphId.get(graphId);
                if (conceptId === undefined || conceptId === null) {
                    throw new RecommendationServiceError('MISSING_CANONICAL_MAPPING', 'A prerequisite has no unique canonical concept mapping.', 503);
                }
                if (mappedIds.has(conceptId)) {
                    throw new RecommendationServiceError('AMBIGUOUS_CANONICAL_MAPPING', 'Prerequisite graph mappings are ambiguous.', 503);
                }
                mappedIds.add(conceptId);
            }
            const canonicalClosure = snapshot.canonicalClosures.get(candidate.conceptId) || new Set();
            if (!sameSet(canonicalClosure, mappedIds)) {
                throw new RecommendationServiceError('PREREQUISITE_CLOSURE_MISMATCH', 'MySQL and Neo4j prerequisite data are not synchronized.', 503);
            }
            canonicalPrerequisiteIdsByCandidate.set(candidate.conceptId, mappedIds);
        }

        if (!Array.isArray(graph.edges)) {
            throw new RecommendationServiceError('INVALID_PREREQUISITE_GRAPH', 'Prerequisite graph edges are unavailable.', 503);
        }
        const canonicalGraphNodeIds = new Set([...relevantGraphIds].map(graphId => {
            const conceptId = snapshot.conceptIdByGraphId.get(graphId);
            if (conceptId === undefined || conceptId === null) {
                throw new RecommendationServiceError('MISSING_CANONICAL_MAPPING', 'A graph prerequisite has no canonical concept mapping.', 503);
            }
            return conceptId;
        }));
        assertGraphAcyclic(canonicalGraphNodeIds, graph.edges, snapshot.conceptIdByGraphId);

        const evidenceByConceptId = new Map();
        for (const row of snapshot.evidenceRows) {
            const conceptId = positiveInteger(row.conceptId, 'evidence concept ID');
            if (!snapshot.relevantConceptIds.has(conceptId)) {
                throw new RecommendationServiceError('INVALID_RECOMMENDATION_DATA', 'Evidence query returned an unrelated concept.', 503);
            }
            if (!evidenceByConceptId.has(conceptId)) evidenceByConceptId.set(conceptId, []);
            evidenceByConceptId.get(conceptId).push(mapEvidenceRow(row));
        }

        const referenceTime = typeof asOf === 'function' ? asOf() : asOf;
        const candidateInputs = snapshot.candidates.map(candidate => {
            const observations = evidenceByConceptId.get(candidate.conceptId) || [];
            const mastery = calculateMastery(observations, { asOf: referenceTime });
            const prerequisites = [...(canonicalPrerequisiteIdsByCandidate.get(candidate.conceptId) || [])]
                .sort((a, b) => a - b)
                .map(conceptId => {
                    const concept = snapshot.conceptsById.get(conceptId);
                    if (!concept) {
                        throw new RecommendationServiceError('MISSING_CANONICAL_MAPPING', 'A prerequisite has no canonical concept record.', 503);
                    }
                    const prerequisiteMastery = calculateMastery(evidenceByConceptId.get(conceptId) || [], { asOf: referenceTime });
                    return {
                        conceptId,
                        conceptName: concept.conceptName,
                        mastery: prerequisiteMastery.mastery,
                        evidenceStatus: prerequisiteMastery.evidenceStatus
                    };
                });
            return {
                conceptId: candidate.conceptId,
                conceptName: candidate.conceptName,
                mastery: mastery.mastery,
                evidenceStatus: mastery.evidenceStatus,
                prerequisites,
                assessmentHistory: observations.map(({ assessmentId, assessmentDate, timestampProvenance }) => ({
                    assessmentId,
                    assessmentDate,
                    timestampProvenance
                }))
            };
        });
        const prerequisiteCourseStatus = [...snapshot.courseClosure.ancestors].sort((a, b) => a - b).map(prerequisiteCourseId => {
            const prerequisiteCourse = snapshot.coursesById.get(prerequisiteCourseId);
            const conceptIds = [...(snapshot.conceptsByCourseGraphId.get(prerequisiteCourse.graphCourseId) || [])];
            const satisfied = conceptIds.length > 0 && conceptIds.every(conceptId => {
                const mastery = calculateMastery(evidenceByConceptId.get(conceptId) || [], { asOf: referenceTime });
                return mastery.evidenceStatus === 'EVIDENCE_QUALIFIED' && mastery.mastery !== null && mastery.mastery >= 80;
            });
            return { courseId: prerequisiteCourseId, title: prerequisiteCourse.title, satisfied };
        });
        const coursePrerequisitesSatisfied = prerequisiteCourseStatus.every(item => item.satisfied);
        const recommendations = coursePrerequisitesSatisfied
            ? ranker(candidateInputs, { asOf: referenceTime })
            : [];
        const concepts = candidateInputs.map(candidate => ({
            conceptId: candidate.conceptId,
            conceptName: candidate.conceptName,
            mastery: candidate.mastery,
            evidenceStatus: candidate.evidenceStatus,
            assessmentCount: candidate.assessmentHistory.length,
            prerequisites: candidate.prerequisites.map(prerequisite => ({
                conceptId: prerequisite.conceptId,
                conceptName: prerequisite.conceptName,
                mastery: prerequisite.mastery,
                evidenceStatus: prerequisite.evidenceStatus,
                satisfied: prerequisite.evidenceStatus === 'EVIDENCE_QUALIFIED' &&
                    prerequisite.mastery !== null && prerequisite.mastery >= 80
            }))
        }));
        const courseConceptIds = new Set(snapshot.candidates.map(candidate => candidate.conceptId));
        const hasCourseAssessmentHistory = snapshot.evidenceRows.some(row =>
            courseConceptIds.has(positiveInteger(row.conceptId, 'evidence concept ID'))
        );
        return {
            recommendationMode: coursePrerequisitesSatisfied
                ? hasCourseAssessmentHistory ? 'adaptive' : 'cold_start'
                : 'course_prerequisite_blocked',
            recommendations,
            concepts,
            coursePrerequisiteEligibility: {
                eligible: coursePrerequisitesSatisfied,
                prerequisites: prerequisiteCourseStatus
            }
        };
    }

    async function getRecommendationsForLearner(input) {
        const result = await getRecommendationResultForLearner(input);
        return result.recommendations;
    }

    return { getRecommendationsForLearner, getRecommendationResultForLearner };
}

module.exports = { createRecommendationService, RecommendationServiceError };
