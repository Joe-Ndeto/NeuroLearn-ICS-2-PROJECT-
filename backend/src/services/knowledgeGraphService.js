
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
    initializeKnowledgeGraph,
    getAllCourses,
    provisionCourse,
    validateCourseIds,
    getAllConcepts,
    createCourse,
    createConcept,
    addPrerequisite,
    addLearningResource
};
