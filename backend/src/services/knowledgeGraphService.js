
const { createHash, randomUUID } = require('crypto');
const { getSession } = require('../config/neo4j');

const MAX_COURSE_ID_LENGTH = 100;
const COURSE_ID_PATTERN = /^COURSE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class CourseValidationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CourseValidationError';
        this.code = code;
    }
}

class PrerequisiteGraphError extends Error {
    constructor(code, message, cause = null) {
        super(message);
        this.name = 'PrerequisiteGraphError';
        this.code = code;
        if (cause) this.cause = cause;
    }
}

async function initializeKnowledgeGraph() {
    const session = getSession();

    try {
        await session.run(`
            CREATE CONSTRAINT course_id_unique IF NOT EXISTS
            FOR (c:Course)
            REQUIRE c.course_id IS UNIQUE
        `);

        await session.run(`
            CREATE CONSTRAINT concept_id_unique IF NOT EXISTS
            FOR (c:Concept)
            REQUIRE c.concept_id IS UNIQUE
        `);

        await session.run(`
            CREATE CONSTRAINT resource_id_unique IF NOT EXISTS
            FOR (r:LearningResource)
            REQUIRE r.resource_id IS UNIQUE
        `);

        console.log('[NeuroLearn KG] Constraints initialized.');
    } finally {
        await session.close();
    }
}

async function getAllCourses() {
    const session = getSession();

    try {
        const result = await session.run(`
            MATCH (c:Course)
            RETURN c
            ORDER BY c.name
        `);

        return result.records.map(record =>
            record.get('c').properties
        );
    } finally {
        await session.close();
    }
}

function normalizeCourseName(name) {
    return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

function courseProvisioningId(normalizedName) {
    // Deterministic IDs let the existing course_id uniqueness constraint
    // serialize concurrent provisioning attempts without a new schema change.
    const bytes = createHash('sha256').update(normalizedName).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `COURSE-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function provisionCourse(data) {
    const name = typeof data?.name === 'string' ? data.name.trim() : '';
    const normalizedName = normalizeCourseName(name);
    if (!normalizedName) throw new TypeError('Course name is required.');
    const courseId = courseProvisioningId(normalizedName);
    const session = getSession();

    try {
        return await session.executeWrite(async tx => {
            const existing = await tx.run(`
                MATCH (c:Course)
                WHERE toLower(trim(c.name)) = $normalizedName
                RETURN c
                ORDER BY c.course_id
                LIMIT 1
            `, { normalizedName });
            if (existing.records.length) {
                return { course: existing.records[0].get('c').properties, created: false };
            }

            const created = await tx.run(`
                MERGE (c:Course {course_id: $courseId})
                ON CREATE SET c.name = $name,
                              c.description = $description,
                              c.created_at = datetime()
                RETURN c
            `, {
                courseId,
                name,
                description: data.description || ''
            });
            const course = created.records[0]?.get('c')?.properties;
            if (!course || normalizeCourseName(course.name) !== normalizedName) {
                throw new Error('Course provisioning identifier conflicts with an existing course.');
            }
            const counters = created.summary?.counters?.updates?.();
            return { course, created: Number(counters?.nodesCreated) > 0 };
        });
    } finally {
        await session.close();
    }
}

async function validateCourseIds(courseIds) {
    if (!Array.isArray(courseIds) || courseIds.length === 0) {
        throw new CourseValidationError(
            'INVALID_COURSE_IDS',
            'At least one course ID must be provided.'
        );
    }

    const seen = new Set();
    for (const courseId of courseIds) {
        if (
            typeof courseId !== 'string' ||
            !courseId.trim() ||
            courseId.length > MAX_COURSE_ID_LENGTH ||
            !COURSE_ID_PATTERN.test(courseId)
        ) {
            throw new CourseValidationError(
                'INVALID_COURSE_IDS',
                'Every course ID must be a valid course identifier.'
            );
        }

        if (seen.has(courseId)) {
            throw new CourseValidationError(
                'INVALID_COURSE_IDS',
                'Course IDs must not contain duplicates.'
            );
        }
        seen.add(courseId);
    }

    let session;
    try {
        session = getSession();
        const result = await session.run(`
            MATCH (c:Course)
            WHERE c.course_id IN $courseIds
            RETURN c.course_id AS courseId
        `, { courseIds });

        const foundIds = new Set(result.records.map(record =>
            record.get('courseId')
        ));
        const missingIds = courseIds.filter(courseId => !foundIds.has(courseId));

        if (missingIds.length > 0) {
            throw new CourseValidationError(
                'COURSES_NOT_FOUND',
                'One or more selected courses do not exist.'
            );
        }

        return courseIds;
    } catch (error) {
        if (error instanceof CourseValidationError) throw error;
        throw new CourseValidationError(
            'COURSE_VALIDATION_UNAVAILABLE',
            'Course validation could not be completed.'
        );
    } finally {
        if (session) {
            try {
                await session.close();
            } catch {
                throw new CourseValidationError(
                    'COURSE_VALIDATION_UNAVAILABLE',
                    'Course validation could not be completed.'
                );
            }
        }
    }
}

async function getAllConcepts() {
    const session = getSession();

    try {
        const result = await session.run(`
            MATCH (c:Concept)
            RETURN c
            ORDER BY c.name
        `);

        return result.records.map(record =>
            record.get('c').properties
        );
    } finally {
        await session.close();
    }
}

/**
 * Reads the selected course's concept associations and the complete prerequisite
 * closure for each candidate. Edge direction is prerequisite -> dependent, so
 * prerequisite traversal follows incoming PREREQUISITE_OF paths.
 */
async function getPrerequisiteClosure(candidateGraphIds, {
    courseId,
    getSessionFactory = getSession
} = {}) {
    if (typeof courseId !== 'string' || !courseId.trim()) {
        throw new PrerequisiteGraphError('INVALID_COURSE_ID', 'A course ID is required.');
    }
    if (!Array.isArray(candidateGraphIds)) {
        throw new PrerequisiteGraphError('INVALID_CANDIDATE_IDS', 'Candidate graph IDs must be an array.');
    }
    const candidateIds = candidateGraphIds.map(id => {
        if (typeof id !== 'string' || !id.trim()) {
            throw new PrerequisiteGraphError('INVALID_CANDIDATE_IDS', 'Candidate graph IDs must be non-empty strings.');
        }
        return id;
    });
    if (new Set(candidateIds).size !== candidateIds.length) {
        throw new PrerequisiteGraphError('INVALID_CANDIDATE_IDS', 'Candidate graph IDs must be unique.');
    }

    let session;
    let operationError = null;
    try {
        session = getSessionFactory();
        return await session.executeRead(async tx => {
            const courseResult = await tx.run(`
                MATCH (course:Course {course_id: $courseId})
                RETURN course.name AS courseName
            `, { courseId });
            if (courseResult.records.length !== 1) {
                throw new PrerequisiteGraphError('COURSE_NOT_FOUND', 'The requested course was not found in the knowledge graph.');
            }
            const courseName = courseResult.records[0].get('courseName');
            if (typeof courseName !== 'string' || !courseName.trim()) {
                throw new PrerequisiteGraphError('INVALID_COURSE', 'The requested graph course has no valid name.');
            }
            const membersResult = await tx.run(`
                MATCH (course:Course {course_id: $courseId})-[:CONTAINS]->(concept:Concept)
                RETURN DISTINCT concept.concept_id AS conceptId
                ORDER BY conceptId
            `, { courseId });
            const courseConceptIds = membersResult.records.map(record => record.get('conceptId'));
            if (courseConceptIds.some(id => typeof id !== 'string' || !id.trim()) ||
                new Set(courseConceptIds).size !== courseConceptIds.length) {
                throw new PrerequisiteGraphError('INVALID_COURSE_ASSOCIATION', 'The graph course has invalid concept associations.');
            }

            if (candidateIds.length === 0) {
                return { courseId, courseName, courseConceptIds, closures: [], edges: [] };
            }

            const closureResult = await tx.run(`
                UNWIND $candidateGraphIds AS candidateGraphId
                MATCH (candidate:Concept {concept_id: candidateGraphId})
                OPTIONAL MATCH (prerequisite:Concept)-[:PREREQUISITE_OF*1..]->(candidate)
                RETURN candidateGraphId AS candidateGraphId,
                       collect(DISTINCT CASE WHEN prerequisite IS NULL THEN null
                           ELSE { conceptId: prerequisite.concept_id }
                       END) AS prerequisiteNodes
                ORDER BY candidateGraphId
            `, { candidateGraphIds: candidateIds });
            if (closureResult.records.length !== candidateIds.length) {
                throw new PrerequisiteGraphError('MISSING_CANDIDATE_NODE', 'A candidate concept is missing from the knowledge graph.');
            }
            const closures = closureResult.records.map(record => {
                const prerequisiteNodes = record.get('prerequisiteNodes');
                if (!Array.isArray(prerequisiteNodes)) {
                    throw new PrerequisiteGraphError('INVALID_PREREQUISITE_CLOSURE', 'The graph returned an invalid prerequisite closure.');
                }
                const prerequisiteGraphIds = prerequisiteNodes.map(node => {
                    const conceptId = node && node.conceptId;
                    if (typeof conceptId !== 'string' || !conceptId.trim()) {
                        throw new PrerequisiteGraphError('INVALID_PREREQUISITE_NODE', 'A prerequisite graph node has no valid concept ID.');
                    }
                    return conceptId;
                });
                return { candidateGraphId: record.get('candidateGraphId'), prerequisiteGraphIds };
            });
            const closureCandidateIds = closures.map(item => item.candidateGraphId);
            if (new Set(closureCandidateIds).size !== candidateIds.length ||
                candidateIds.some(id => !closureCandidateIds.includes(id)) ||
                closures.some(item => !Array.isArray(item.prerequisiteGraphIds) ||
                    item.prerequisiteGraphIds.some(id => typeof id !== 'string' || !id.trim()) ||
                    new Set(item.prerequisiteGraphIds).size !== item.prerequisiteGraphIds.length)) {
                throw new PrerequisiteGraphError('INVALID_PREREQUISITE_CLOSURE', 'The graph returned an invalid prerequisite closure.');
            }

            const relevantNodeIds = [...new Set([
                ...candidateIds,
                ...closures.flatMap(item => item.prerequisiteGraphIds)
            ])];
            const edgeResult = await tx.run(`
                MATCH (prerequisite:Concept)-[:PREREQUISITE_OF]->(target:Concept)
                WHERE prerequisite.concept_id IN $conceptIds
                  AND target.concept_id IN $conceptIds
                RETURN prerequisite.concept_id AS prerequisiteGraphId,
                       target.concept_id AS targetGraphId
            `, { conceptIds: relevantNodeIds });
            const edges = edgeResult.records.map(record => ({
                prerequisiteGraphId: record.get('prerequisiteGraphId'),
                targetGraphId: record.get('targetGraphId')
            }));
            if (edges.some(edge => typeof edge.prerequisiteGraphId !== 'string' || !edge.prerequisiteGraphId.trim() ||
                typeof edge.targetGraphId !== 'string' || !edge.targetGraphId.trim())) {
                throw new PrerequisiteGraphError('INVALID_PREREQUISITE_EDGE', 'The graph returned an invalid prerequisite edge.');
            }
            return { courseId, courseName, courseConceptIds, closures, edges };
        });
    } catch (error) {
        operationError = error;
        if (error instanceof PrerequisiteGraphError) throw error;
        throw new PrerequisiteGraphError('GRAPH_UNAVAILABLE', 'Prerequisite graph data is unavailable.', error);
    } finally {
        if (session) {
            try {
                await session.close();
            } catch (error) {
                if (!operationError) {
                    throw new PrerequisiteGraphError('GRAPH_UNAVAILABLE', 'Prerequisite graph data is unavailable.', error);
                }
            }
        }
    }
}

async function getCoursePrerequisiteClosure(candidateCourseIds, { getSessionFactory = getSession } = {}) {
    if (!Array.isArray(candidateCourseIds) || candidateCourseIds.some(id =>
        typeof id !== 'string' || !COURSE_ID_PATTERN.test(id)) ||
        new Set(candidateCourseIds).size !== candidateCourseIds.length) {
        throw new PrerequisiteGraphError('INVALID_COURSE_IDS', 'Unique valid course IDs are required.');
    }
    let session;
    let operationError = null;
    try {
        session = getSessionFactory();
        const result = await session.run(`
            UNWIND $courseIds AS courseId
            OPTIONAL MATCH (candidate:Course {course_id: courseId})
            OPTIONAL MATCH (prerequisite:Course)-[:PREREQUISITE_OF*1..]->(candidate)
            RETURN courseId, candidate.course_id AS matchedCourseId,
                   collect(DISTINCT CASE WHEN prerequisite IS NULL THEN null
                       ELSE { courseId: prerequisite.course_id }
                   END) AS prerequisiteNodes
        `, { courseIds: candidateCourseIds });
        if (!Array.isArray(result.records) || result.records.length !== candidateCourseIds.length) {
            throw new PrerequisiteGraphError('MISSING_COURSE_NODE', 'A course is missing from the knowledge graph.');
        }
        const closures = new Map();
        for (const record of result.records) {
            const candidateId = record.get('courseId');
            if (record.get('matchedCourseId') !== candidateId || closures.has(candidateId)) {
                throw new PrerequisiteGraphError('MISSING_COURSE_NODE', 'A course is missing or ambiguous in the knowledge graph.');
            }
            const nodes = record.get('prerequisiteNodes');
            if (!Array.isArray(nodes)) throw new PrerequisiteGraphError('INVALID_COURSE_PREREQUISITE', 'Course prerequisite closure is invalid.');
            const ids = nodes.map(node => {
                const id = node?.courseId;
                if (typeof id !== 'string' || !COURSE_ID_PATTERN.test(id)) {
                    throw new PrerequisiteGraphError('INVALID_COURSE_PREREQUISITE_NODE', 'A prerequisite course has a missing or invalid ID.');
                }
                if (id === candidateId) throw new PrerequisiteGraphError('COURSE_PREREQUISITE_CYCLE', 'Course prerequisite data contains a self-ancestor.');
                return id;
            });
            if (new Set(ids).size !== ids.length) throw new PrerequisiteGraphError('INVALID_COURSE_PREREQUISITE', 'Course prerequisite closure contains duplicates.');
            closures.set(candidateId, ids.sort());
        }
        return closures;
    } catch (error) {
        operationError = error;
        if (error instanceof PrerequisiteGraphError) throw error;
        throw new PrerequisiteGraphError('COURSE_PREREQUISITE_LOOKUP_FAILED', 'Course prerequisite graph lookup failed.', error);
    } finally {
        if (session) {
            try { await session.close(); }
            catch (error) {
                if (!operationError) throw new PrerequisiteGraphError('GRAPH_UNAVAILABLE', 'Course prerequisite graph data is unavailable.', error);
            }
        }
    }
}

async function createCourse(data) {
    return (await provisionCourse(data)).course;
}

async function createConcept(data) {
    const session = getSession();

    try {
        const conceptId = `CONCEPT-${randomUUID()}`;

        const result = await session.run(`
            MATCH (course:Course {course_id: $courseId})
            CREATE (concept:Concept {
                concept_id: $conceptId,
                name: $name,
                description: $description,
                difficulty_level: $difficulty,
                created_at: datetime()
            })
            CREATE (course)-[:CONTAINS]->(concept)
            RETURN concept
        `, {
            courseId: data.courseId,
            conceptId,
            name: data.name,
            description: data.description || '',
            difficulty: data.difficultyLevel || 'Beginner'
        });

        if (!result.records.length) {
            throw new Error('Course not found.');
        }

        return result.records[0].get('concept').properties;
    } finally {
        await session.close();
    }
}

async function addPrerequisite(data) {
    const session = getSession();

    try {
        const result = await session.run(`
            MATCH (prerequisite:Concept {
                concept_id: $prerequisiteId
            })
            MATCH (target:Concept {
                concept_id: $targetId
            })
            WHERE prerequisite <> target
            MERGE (prerequisite)-[r:PREREQUISITE_OF]->(target)
            RETURN prerequisite.name AS prerequisite,
                   target.name AS target
        `, {
            prerequisiteId: data.prerequisiteId,
            targetId: data.targetId
        });

        if (!result.records.length) {
            throw new Error(
                'One or both concepts were not found, or they are identical.'
            );
        }

        return result.records[0].toObject();
    } finally {
        await session.close();
    }
}

async function addLearningResource(data) {
    const session = getSession();

    try {
        const resourceId = `RESOURCE-${randomUUID()}`;

        const result = await session.run(`
            MATCH (concept:Concept {
                concept_id: $conceptId
            })
            CREATE (resource:LearningResource {
                resource_id: $resourceId,
                title: $title,
                type: $type,
                url: $url,
                created_at: datetime()
            })
            CREATE (concept)-[:HAS_RESOURCE]->(resource)
            RETURN resource
        `, {
            conceptId: data.conceptId,
            resourceId,
            title: data.title,
            type: data.type,
            url: data.url
        });

        if (!result.records.length) {
            throw new Error('Concept not found.');
        }

        return result.records[0].get('resource').properties;
    } finally {
        await session.close();
    }
}

module.exports = {
    CourseValidationError,
    PrerequisiteGraphError,
    initializeKnowledgeGraph,
    getAllCourses,
    provisionCourse,
    validateCourseIds,
    getAllConcepts,
    getPrerequisiteClosure,
    getCoursePrerequisiteClosure,
    createCourse,
    createConcept,
    addPrerequisite,
    addLearningResource
};
