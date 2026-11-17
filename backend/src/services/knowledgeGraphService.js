
const { randomUUID } = require('crypto');
const { getSession } = require('../config/neo4j');

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
    const session = getSession();

    try {
        const courseId = `COURSE-${randomUUID()}`;

        const result = await session.run(`
            CREATE (c:Course {
                course_id: $courseId,
                name: $name,
                description: $description,
                created_at: datetime()
            })
            RETURN c
        `, {
            courseId,
            name: data.name,
            description: data.description || ''
        });

        return result.records[0].get('c').properties;
    } finally {
        await session.close();
    }
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
    initializeKnowledgeGraph,
    getAllCourses,
    getAllConcepts,
    createCourse,
    createConcept,
    addPrerequisite,
    addLearningResource
};
