'use strict';

const COURSE_ID_PATTERN = /^COURSE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class CanonicalRecordValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CanonicalRecordValidationError';
        this.code = 'INVALID_CANONICAL_RECORD';
    }
}

function invalid(message) {
    throw new CanonicalRecordValidationError(message);
}

function validId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0;
}

function requiredText(value, field, maxLength) {
    if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
        invalid(`Canonical record has an invalid ${field}.`);
    }
}

function optionalText(value, field, maxLength) {
    if (value !== null && value !== undefined &&
        (typeof value !== 'string' || value.length > maxLength)) {
        invalid(`Canonical record has an invalid ${field}.`);
    }
}

function graphId(value, field) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 100) {
        invalid(`Canonical record has an invalid ${field} graph ID.`);
    }
}

function validateConceptFields(concept, graphIdField = 'graph_concept_id') {
    if (!validId(concept.concept_id)) invalid('Canonical concept reference is invalid.');
    requiredText(concept.concept_name, 'concept name', 150);
    optionalText(concept.description, 'concept description', 65535);
    optionalText(concept.difficulty_level, 'concept difficulty', 50);
    graphId(concept[graphIdField], 'concept');
}

async function loadCanonicalRecord(queryable, task, { lockRecords = false } = {}) {
    const recordId = Number(task.canonical_record_id);
    if (!validId(recordId)) invalid('Canonical record ID is invalid.');
    const lockClause = lockRecords ? ' FOR UPDATE' : '';

    if (task.canonical_record_type === 'CONCEPT') {
        const [concepts] = await queryable.execute(
            `SELECT concept_id, concept_name, description, difficulty_level, graph_concept_id
             FROM concept WHERE concept_id = ?${lockClause}`,
            [recordId]
        );
        if (!concepts.length) invalid('Canonical concept record is missing.');
        const concept = concepts[0];
        validateConceptFields(concept);

        const [courses] = await queryable.execute(
            `SELECT course_graph_id FROM concept_course
             WHERE concept_id = ? ORDER BY course_graph_id${lockClause}`,
            [recordId]
        );
        if (!courses.length || courses.some(course =>
            typeof course.course_graph_id !== 'string' ||
            !COURSE_ID_PATTERN.test(course.course_graph_id)
        )) {
            invalid('Canonical concept has missing or invalid course associations.');
        }
        if (new Set(courses.map(course => course.course_graph_id)).size !== courses.length) {
            invalid('Canonical concept has duplicate course associations.');
        }
        return { ...concept, courses: courses.map(course => course.course_graph_id) };
    }

    if (task.canonical_record_type === 'PREREQUISITE') {
        const [rows] = await queryable.execute(
            `SELECT p.prerequisite_id, p.prerequisite_concept_id, p.target_concept_id,
                    prerequisite.concept_name AS prerequisite_name,
                    prerequisite.description AS prerequisite_description,
                    prerequisite.difficulty_level AS prerequisite_difficulty_level,
                    prerequisite.graph_concept_id AS prerequisite_graph_id,
                    target.concept_name AS target_name,
                    target.description AS target_description,
                    target.difficulty_level AS target_difficulty_level,
                    target.graph_concept_id AS target_graph_id
             FROM concept_prerequisite AS p
             INNER JOIN concept AS prerequisite
                ON prerequisite.concept_id = p.prerequisite_concept_id
             INNER JOIN concept AS target
                ON target.concept_id = p.target_concept_id
             WHERE p.prerequisite_id = ?${lockClause}`,
            [recordId]
        );
        if (!rows.length) invalid('Canonical prerequisite relationship or concept reference is missing.');
        const relationship = rows[0];
        if (!validId(relationship.prerequisite_id) ||
            Number(relationship.prerequisite_id) !== recordId ||
            !validId(relationship.prerequisite_concept_id) ||
            !validId(relationship.target_concept_id) ||
            Number(relationship.prerequisite_concept_id) === Number(relationship.target_concept_id)) {
            invalid('Canonical prerequisite relationship is malformed.');
        }
        validateConceptFields({
            concept_id: relationship.prerequisite_concept_id,
            concept_name: relationship.prerequisite_name,
            description: relationship.prerequisite_description,
            difficulty_level: relationship.prerequisite_difficulty_level,
            graph_concept_id: relationship.prerequisite_graph_id
        });
        validateConceptFields({
            concept_id: relationship.target_concept_id,
            concept_name: relationship.target_name,
            description: relationship.target_description,
            difficulty_level: relationship.target_difficulty_level,
            graph_concept_id: relationship.target_graph_id
        });
        const [edges] = await queryable.execute(
            `SELECT prerequisite_concept_id, target_concept_id
             FROM concept_prerequisite
             WHERE prerequisite_id <> ?${lockClause}`,
            [recordId]
        );
        const adjacency = new Map();
        for (const edge of edges) {
            if (!validId(edge.prerequisite_concept_id) || !validId(edge.target_concept_id)) {
                invalid('Canonical prerequisite graph contains a malformed relationship.');
            }
            const source = Number(edge.prerequisite_concept_id);
            if (!adjacency.has(source)) adjacency.set(source, []);
            adjacency.get(source).push(Number(edge.target_concept_id));
        }
        const pending = [Number(relationship.target_concept_id)];
        const visited = new Set();
        while (pending.length) {
            const current = pending.pop();
            if (current === Number(relationship.prerequisite_concept_id)) {
                invalid('Canonical prerequisite relationship would create a cycle.');
            }
            if (visited.has(current)) continue;
            visited.add(current);
            pending.push(...(adjacency.get(current) || []));
        }
        return relationship;
    }

    if (task.canonical_record_type === 'RESOURCE') {
        const [rows] = await queryable.execute(
            `SELECT r.resource_id, r.concept_id, r.title, r.resource_type, r.file_url,
                    r.graph_resource_id,
                    c.concept_name, c.description, c.difficulty_level,
                    c.graph_concept_id AS concept_graph_id
             FROM learning_resource AS r
             INNER JOIN concept AS c ON c.concept_id = r.concept_id
             WHERE r.resource_id = ?${lockClause}`,
            [recordId]
        );
        if (!rows.length) invalid('Canonical resource or its concept reference is missing.');
        const resource = rows[0];
        if (!validId(resource.resource_id) || Number(resource.resource_id) !== recordId ||
            !validId(resource.concept_id)) {
            invalid('Canonical resource reference is malformed.');
        }
        requiredText(resource.title, 'resource title', 255);
        requiredText(resource.resource_type, 'resource type', 50);
        if (typeof resource.file_url !== 'string' || resource.file_url.length > 500) {
            invalid('Canonical record has an invalid resource URL.');
        }
        const protectedDocumentRoute = /^\/api\/submissions\/resources\/[1-9]\d*\/document$/.test(resource.file_url);
        let parsedUrl = null;
        if (!protectedDocumentRoute) {
            try { parsedUrl = new URL(resource.file_url); } catch { invalid('Canonical record has an invalid resource URL.'); }
        }
        if (!protectedDocumentRoute && !['http:', 'https:'].includes(parsedUrl.protocol)) {
            invalid('Canonical record has an invalid resource URL.');
        }
        graphId(resource.graph_resource_id, 'resource');
        validateConceptFields({
            concept_id: resource.concept_id,
            concept_name: resource.concept_name,
            description: resource.description,
            difficulty_level: resource.difficulty_level,
            graph_concept_id: resource.concept_graph_id
        });
        return resource;
    }

    if (task.canonical_record_type === 'COURSE') {
        const [rows] = await queryable.execute(
            `SELECT course_id, graph_course_id, title, description, difficulty_level
             FROM course WHERE course_id = ?${lockClause}`,
            [recordId]
        );
        if (!rows.length) invalid('Canonical course record is missing.');
        const course = rows[0];
        if (!validId(course.course_id) || Number(course.course_id) !== recordId) invalid('Canonical course ID is invalid.');
        graphId(course.graph_course_id, 'course');
        requiredText(course.title, 'course title', 200);
        optionalText(course.description, 'course description', 65535);
        if (!['Beginner', 'Intermediate', 'Advanced'].includes(course.difficulty_level)) invalid('Canonical course difficulty is invalid.');
        return course;
    }

    if (task.canonical_record_type === 'COURSE_PREREQUISITE') {
        const [rows] = await queryable.execute(
            `SELECT cp.course_prerequisite_id, cp.prerequisite_course_id, cp.target_course_id, cp.is_active,
                    prerequisite.graph_course_id AS prerequisite_graph_id,
                    target.graph_course_id AS target_graph_id
             FROM course_prerequisite AS cp
             INNER JOIN course AS prerequisite ON prerequisite.course_id = cp.prerequisite_course_id
             INNER JOIN course AS target ON target.course_id = cp.target_course_id
             WHERE cp.course_prerequisite_id = ?${lockClause}`,
            [recordId]
        );
        if (!rows.length) invalid('Canonical course prerequisite record is missing.');
        const relation = rows[0];
        if (!validId(relation.course_prerequisite_id) || Number(relation.course_prerequisite_id) !== recordId ||
            !validId(relation.prerequisite_course_id) || !validId(relation.target_course_id) ||
            Number(relation.prerequisite_course_id) === Number(relation.target_course_id) ||
            ![0, 1, true, false].includes(relation.is_active)) invalid('Canonical course prerequisite is malformed.');
        graphId(relation.prerequisite_graph_id, 'prerequisite course');
        graphId(relation.target_graph_id, 'target course');
        return relation;
    }

    invalid('Unsupported canonical record type.');
}

module.exports = { CanonicalRecordValidationError, loadCanonicalRecord };
