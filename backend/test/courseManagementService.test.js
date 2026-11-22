'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCourseManagementService, CourseManagementError } = require('../src/services/courseManagementService');

function harness({ edges = [], active = [], courseSyncCount = 2, existingAssociations = [], availableCourseIds = [1, 2, 3], availableConceptIds = [10, 11] } = {}) {
    const state = {
        edges: edges.map(edge => ({ ...edge })),
        active: new Set(active), tasks: [], submissions: [], calls: [],
        courses: availableCourseIds.map(course_id => ({ course_id, graph_course_id: `COURSE-${course_id}` })),
        concepts: availableConceptIds.map(concept_id => ({ concept_id, graph_concept_id: `CONCEPT-${concept_id}`, concept_name: `Concept ${concept_id}` })),
        associations: existingAssociations.map(row => ({ ...row })),
        courseSyncCount, released: 0, destroyed: 0, rolledBack: 0
    };
    const connection = {
        async beginTransaction() { state.calls.push('BEGIN'); },
        async commit() { state.calls.push('COMMIT'); },
        async rollback() { state.rolledBack++; },
        release() { state.released++; },
        destroy() { state.destroyed++; },
        async execute(sql, params = []) {
            const query = sql.replace(/\s+/g, ' ').trim();
            state.calls.push(query);
            if (query.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
            if (query.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
            if (query.startsWith('SELECT course.course_id, course.graph_course_id, concept.concept_id')) {
                const course = state.courses.find(row => row.course_id === Number(params[0]));
                const concept = state.concepts.find(row => row.concept_id === Number(params[1]));
                return [course && concept ? [{ ...course, ...concept }] : [], []];
            }
            if (query.startsWith('SELECT outbox_id FROM knowledge_sync_outbox')) {
                return [state.courseSyncCount > 0 ? [{ outbox_id: 1 }] : [], []];
            }
            if (query.startsWith('SELECT concept_id FROM concept_course')) {
                const relation = state.associations.find(row => row.concept_id === Number(params[0]) && row.course_graph_id === params[1]);
                return [relation ? [{ concept_id: relation.concept_id }] : [], []];
            }
            if (query.startsWith('INSERT INTO concept_course')) {
                state.associations.push({ concept_id: Number(params[0]), course_graph_id: params[1] });
                return [{ affectedRows: 1 }, []];
            }
            if (query.startsWith('SELECT c.concept_id, c.concept_name')) {
                const course = state.courses.find(row => row.course_id === Number(params[0]));
                if (!course) return [[], []];
                return [state.concepts.map(concept => ({
                    ...concept,
                    assigned: state.associations.some(item => item.concept_id === concept.concept_id && item.course_graph_id === course.graph_course_id) ? 1 : 0
                })), []];
            }
            if (query.startsWith('SELECT course_id FROM course WHERE course_id =')) {
                return [state.courses.filter(row => row.course_id === Number(params[0])), []];
            }
            if (query.startsWith('SELECT course_id FROM course WHERE course_id IN')) {
                return [state.courses.filter(row => params.map(Number).includes(row.course_id)), []];
            }
            if (query.includes('FROM course AS c') && query.includes('knowledge_sync_outbox')) {
                return [Array.from({ length: state.courseSyncCount }, (_, index) => ({ course_id: index + 1 })), []];
            }
            if (query.startsWith('SELECT course_prerequisite_id, is_active')) {
                const edge = state.edges.find(row => row.prerequisite_course_id === Number(params[0]) && row.target_course_id === Number(params[1]));
                return [edge ? [{ course_prerequisite_id: edge.course_prerequisite_id, is_active: state.active.has(edge.course_prerequisite_id) }] : [], []];
            }
            if (query.startsWith('SELECT prerequisite_course_id, target_course_id')) return [state.edges.filter(edge => state.active.has(edge.course_prerequisite_id)), []];
            if (query.startsWith('INSERT INTO course_prerequisite')) {
                const id = 20 + state.edges.length;
                state.edges.push({ course_prerequisite_id: id, prerequisite_course_id: Number(params[0]), target_course_id: Number(params[1]) });
                state.active.add(id);
                return [{ insertId: id, affectedRows: 1 }, []];
            }
            if (query.startsWith('UPDATE course_prerequisite')) {
                const id = Number(params[0]);
                if (query.includes('SET is_active = TRUE')) state.active.add(id); else state.active.delete(id);
                return [{ affectedRows: 1 }, []];
            }
            if (query.startsWith('INSERT INTO knowledge_submissions')) {
                state.submissions.push({ type: params[0], data: params[1] });
                return [{ insertId: 30 + state.submissions.length }, []];
            }
            if (query.startsWith('INSERT INTO knowledge_sync_outbox')) {
                state.tasks.push({ submission: Number(params[0]), type: params[1], record: Number(params[2]) });
                return [{ insertId: state.tasks.length }, []];
            }
            throw new Error(`Unexpected test SQL: ${query}`);
        }
    };
    return { state, service: createCourseManagementService({ mysql: {
        execute: connection.execute.bind(connection),
        async getConnection() { return connection; }
    } }) };
}

test('course prerequisite creation is admin-event/outbox-backed and self/duplicate/cycle checks fail closed', async t => {
    await t.test('creates canonical edge and outbox task', async () => {
        const { state, service } = harness();
        const result = await service.changePrerequisite({ prerequisiteCourseId: 1, targetCourseId: 2, adminId: 8, action: 'add' });
        assert.equal(result.active, true);
        assert.equal(state.tasks[0].type, 'COURSE_PREREQUISITE');
        assert.equal(state.tasks[0].record, result.relationshipId);
        assert.equal(state.released, 1);
    });
    await t.test('self and duplicate relationships reject', async () => {
        const { service } = harness({ edges: [{ course_prerequisite_id: 9, prerequisite_course_id: 1, target_course_id: 2 }], active: [9] });
        await assert.rejects(service.changePrerequisite({ prerequisiteCourseId: 1, targetCourseId: 1, adminId: 8, action: 'add' }), error => error.code === 'SELF_PREREQUISITE');
        await assert.rejects(service.changePrerequisite({ prerequisiteCourseId: 1, targetCourseId: 2, adminId: 8, action: 'add' }), error => error.code === 'DUPLICATE_PREREQUISITE');
    });
    await t.test('cycle and unsynchronized course prerequisites reject', async () => {
        const cyclic = harness({ edges: [
            { course_prerequisite_id: 1, prerequisite_course_id: 1, target_course_id: 2 },
            { course_prerequisite_id: 2, prerequisite_course_id: 2, target_course_id: 3 }
        ], active: [1, 2] });
        await assert.rejects(cyclic.service.changePrerequisite({ prerequisiteCourseId: 3, targetCourseId: 1, adminId: 8, action: 'add' }), error => error.code === 'PREREQUISITE_CYCLE');
        const pending = harness({ courseSyncCount: 1 });
        await assert.rejects(pending.service.changePrerequisite({ prerequisiteCourseId: 1, targetCourseId: 2, adminId: 8, action: 'add' }), error => error.code === 'COURSE_SYNC_PENDING');
    });
});

test('removing course prerequisite retains canonical tombstone and enqueues graph deletion', async () => {
    const { state, service } = harness({ edges: [{ course_prerequisite_id: 7, prerequisite_course_id: 1, target_course_id: 2 }], active: [7] });
    const result = await service.changePrerequisite({ prerequisiteCourseId: 1, targetCourseId: 2, adminId: 8, action: 'remove' });
    assert.equal(result.active, false);
    assert.equal(state.active.has(7), false);
    assert.equal(state.tasks[0].record, 7);
    assert.equal(state.tasks[0].type, 'COURSE_PREREQUISITE');
});

test('invalid course prerequisite arguments return typed validation errors', async () => {
    const { service } = harness();
    await assert.rejects(service.changePrerequisite({ prerequisiteCourseId: 'x', targetCourseId: 2, adminId: 8, action: 'add' }), error => error instanceof CourseManagementError && error.status === 400);
});

test('approved concepts can be assigned to different approved courses and enqueue canonical concept sync tasks', async () => {
    const { state, service } = harness();
    await service.assignConceptToCourse({ courseId: 1, conceptId: 10, adminId: 8 });
    await service.assignConceptToCourse({ courseId: 2, conceptId: 10, adminId: 8 });
    assert.deepEqual(state.associations, [
        { concept_id: 10, course_graph_id: 'COURSE-1' },
        { concept_id: 10, course_graph_id: 'COURSE-2' }
    ]);
    assert.deepEqual(state.tasks.map(task => [task.type, task.record]), [['CONCEPT', 10], ['CONCEPT', 10]]);
    assert.deepEqual(state.submissions.map(item => item.type), ['CONCEPT', 'CONCEPT']);
    assert.equal(state.calls.filter(query => query === 'COMMIT').length, 2);
});

test('concept assignment validates both canonical records, waits for course sync, and rejects duplicates', async t => {
    await t.test('unapproved course', async () => {
        const { service, state } = harness({ availableCourseIds: [1] });
        await assert.rejects(service.assignConceptToCourse({ courseId: 99, conceptId: 10, adminId: 8 }), error => error.code === 'CANONICAL_RECORD_NOT_FOUND');
        assert.equal(state.tasks.length, 0);
        assert.equal(state.rolledBack, 1);
    });
    await t.test('unapproved or unmapped concept', async () => {
        const { service } = harness({ availableConceptIds: [10] });
        await assert.rejects(service.assignConceptToCourse({ courseId: 1, conceptId: 99, adminId: 8 }), error => error.code === 'CANONICAL_RECORD_NOT_FOUND');
    });
    await t.test('course graph task incomplete', async () => {
        const { service } = harness({ courseSyncCount: 0 });
        await assert.rejects(service.assignConceptToCourse({ courseId: 1, conceptId: 10, adminId: 8 }), error => error.code === 'COURSE_SYNC_PENDING');
    });
    await t.test('duplicate association', async () => {
        const { service } = harness({ existingAssociations: [{ concept_id: 10, course_graph_id: 'COURSE-1' }] });
        await assert.rejects(service.assignConceptToCourse({ courseId: 1, conceptId: 10, adminId: 8 }), error => error.code === 'CONCEPT_ALREADY_ASSIGNED');
    });
});

test('concept assignment option lists distinguish existing mappings from concepts available to the selected course', async () => {
    const { service } = harness({ existingAssociations: [{ concept_id: 10, course_graph_id: 'COURSE-1' }] });
    assert.deepEqual(await service.getConceptAssignmentOptions(1), {
        assigned: [{ conceptId: 10, name: 'Concept 10' }],
        available: [{ conceptId: 11, name: 'Concept 11' }]
    });
    await assert.rejects(service.getConceptAssignmentOptions('invalid'), error => error.code === 'INVALID_COURSE');
});
