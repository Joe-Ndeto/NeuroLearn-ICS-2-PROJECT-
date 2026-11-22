'use strict';

const { randomUUID } = require('crypto');

const COURSE_PREREQUISITE_LOCK = 'neurolearn:course_prerequisite_write';
const COURSE_CONCEPT_LOCK = 'neurolearn:course_concept_write';
const DIFFICULTIES = new Set(['Beginner', 'Intermediate', 'Advanced']);

class CourseManagementError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'CourseManagementError';
        this.code = code;
        this.status = status;
    }
}

function wouldCycle(edges, prerequisiteId, targetId) {
    const adjacency = new Map();
    for (const edge of edges) {
        const source = Number(edge.prerequisite_course_id);
        const target = Number(edge.target_course_id);
        if (!adjacency.has(source)) adjacency.set(source, []);
        adjacency.get(source).push(target);
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

function createCourseManagementService({ mysql: injectedMysql } = {}) {
    const mysql = injectedMysql || require('../config/mysql');

    async function listApprovedCourses() {
        const [rows] = await mysql.execute(
            `SELECT c.course_id, c.graph_course_id, c.title, c.description, c.difficulty_level,
                    cp.course_prerequisite_id, cp.prerequisite_course_id,
                    prerequisite.title AS prerequisite_title
             FROM course AS c
             LEFT JOIN course_prerequisite AS cp
               ON cp.target_course_id = c.course_id AND cp.is_active = TRUE
             LEFT JOIN course AS prerequisite ON prerequisite.course_id = cp.prerequisite_course_id
             ORDER BY c.title, prerequisite.title`
        );
        const byId = new Map();
        for (const row of rows) {
            const id = Number(row.course_id);
            if (!byId.has(id)) byId.set(id, {
                courseId: id,
                courseGraphId: row.graph_course_id,
                title: row.title,
                description: row.description,
                difficultyLevel: row.difficulty_level,
                prerequisites: []
            });
            if (row.course_prerequisite_id !== null) {
                byId.get(id).prerequisites.push({
                    courseId: Number(row.prerequisite_course_id),
                    title: row.prerequisite_title
                });
            }
        }
        return [...byId.values()];
    }

    async function getCoursesForStudents() {
        return (await listApprovedCourses()).map(course => ({
            course_id: course.courseGraphId,
            name: course.title,
            description: course.description,
            difficulty_level: course.difficultyLevel
        }));
    }

    async function recordAdminSyncEvent(connection, adminId, type, recordId, operationData) {
        const [submission] = await connection.execute(
            `INSERT INTO knowledge_submissions
                (submission_type, submission_data, status, submitted_by, reviewed_by, review_notes, reviewed_at)
             VALUES (?, ?, 'approved', ?, ?, ?, CURRENT_TIMESTAMP)`,
            [type, JSON.stringify(operationData), adminId, adminId, 'Administrator-managed canonical update']
        );
        await connection.execute(
            `INSERT INTO knowledge_sync_outbox
                (submission_id, canonical_record_type, canonical_record_id)
             VALUES (?, ?, ?)`,
            [submission.insertId, type, recordId]
        );
    }

    async function updateCourse({ courseId, title, description, difficultyLevel, adminId }) {
        const id = Number(courseId);
        const cleanTitle = typeof title === 'string' ? title.trim() : '';
        const cleanDescription = typeof description === 'string' ? description.trim() : '';
        if (!Number.isSafeInteger(id) || id < 1 || !cleanTitle || cleanTitle.length > 200 ||
            cleanDescription.length > 5000 || !DIFFICULTIES.has(difficultyLevel)) {
            throw new CourseManagementError('INVALID_COURSE', 'Course details are invalid.');
        }
        const connection = await mysql.getConnection();
        let started = false;
        let destroyed = false;
        try {
            await connection.beginTransaction();
            started = true;
            const [rows] = await connection.execute('SELECT course_id FROM course WHERE course_id = ? FOR UPDATE', [id]);
            if (!rows.length) throw new CourseManagementError('COURSE_NOT_FOUND', 'Approved course not found.', 404);
            const normalized = cleanTitle.toLocaleLowerCase();
            const [duplicates] = await connection.execute(
                'SELECT course_id FROM course WHERE normalized_title = ? AND course_id <> ? FOR UPDATE', [normalized, id]
            );
            if (duplicates.length) throw new CourseManagementError('DUPLICATE_COURSE', 'Another approved course already uses this title.', 409);
            await connection.execute(
                `UPDATE course SET title = ?, normalized_title = ?, description = ?, difficulty_level = ?
                 WHERE course_id = ?`,
                [cleanTitle, normalized, cleanDescription, difficultyLevel, id]
            );
            await recordAdminSyncEvent(connection, adminId, 'COURSE', id, { operation: 'update' });
            await connection.commit();
            started = false;
            return { courseId: id, title: cleanTitle, description: cleanDescription, difficultyLevel };
        } catch (error) {
            if (started) {
                try { await connection.rollback(); } catch { try { connection.destroy(); destroyed = true; } catch {} }
            }
            throw error;
        } finally {
            if (!destroyed) try { connection.release(); } catch {}
        }
    }

    async function getConceptAssignmentOptions(courseId) {
        const id = Number(courseId);
        if (!Number.isSafeInteger(id) || id < 1) {
            throw new CourseManagementError('INVALID_COURSE', 'Select an approved course.');
        }
        const [rows] = await mysql.execute(
            `SELECT c.concept_id, c.concept_name,
                    CASE WHEN association.concept_id IS NULL THEN 0 ELSE 1 END AS assigned
             FROM course
             LEFT JOIN concept AS c
               ON c.graph_concept_id IS NOT NULL AND TRIM(c.graph_concept_id) <> ''
             LEFT JOIN concept_course AS association
               ON association.course_graph_id = course.graph_course_id
              AND association.concept_id = c.concept_id
             WHERE course.course_id = ?
             ORDER BY c.concept_name, c.concept_id`, [id]
        );
        if (!rows.length) {
            const [courseRows] = await mysql.execute('SELECT course_id FROM course WHERE course_id = ?', [id]);
            if (!courseRows.length) throw new CourseManagementError('COURSE_NOT_FOUND', 'Approved course not found.', 404);
        }
        return {
            assigned: rows.filter(row => row.concept_id != null && Number(row.assigned) === 1)
                .map(row => ({ conceptId: Number(row.concept_id), name: row.concept_name })),
            available: rows.filter(row => row.concept_id != null && Number(row.assigned) === 0)
                .map(row => ({ conceptId: Number(row.concept_id), name: row.concept_name }))
        };
    }

    async function assignConceptToCourse({ courseId, conceptId, adminId }) {
        const targetCourseId = Number(courseId);
        const canonicalConceptId = Number(conceptId);
        if (!Number.isSafeInteger(targetCourseId) || targetCourseId < 1 ||
            !Number.isSafeInteger(canonicalConceptId) || canonicalConceptId < 1 ||
            !Number.isSafeInteger(Number(adminId)) || Number(adminId) < 1) {
            throw new CourseManagementError('INVALID_ASSOCIATION', 'Select an approved course and concept.');
        }

        const connection = await mysql.getConnection();
        let started = false;
        let lockAcquired = false;
        let destroyed = false;
        try {
            const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 5) AS acquired', [COURSE_CONCEPT_LOCK]);
            if (Number(lockRows[0]?.acquired) !== 1) {
                throw new CourseManagementError('ASSOCIATION_BUSY', 'Course concept assignment is busy. Retry shortly.', 503);
            }
            lockAcquired = true;
            await connection.beginTransaction();
            started = true;

            const [canonicalRows] = await connection.execute(
                `SELECT course.course_id, course.graph_course_id, concept.concept_id, concept.graph_concept_id
                 FROM course CROSS JOIN concept
                 WHERE course.course_id = ? AND concept.concept_id = ?
                   AND concept.graph_concept_id IS NOT NULL AND TRIM(concept.graph_concept_id) <> ''
                 FOR UPDATE`, [targetCourseId, canonicalConceptId]
            );
            if (canonicalRows.length !== 1) {
                throw new CourseManagementError('CANONICAL_RECORD_NOT_FOUND', 'Both an approved course and an approved graph-mapped concept are required.', 422);
            }

            const [courseSyncRows] = await connection.execute(
                `SELECT outbox_id FROM knowledge_sync_outbox
                 WHERE canonical_record_type = 'COURSE' AND canonical_record_id = ?
                   AND sync_status = 'completed'
                 ORDER BY outbox_id DESC LIMIT 1`, [targetCourseId]
            );
            if (!courseSyncRows.length) {
                throw new CourseManagementError('COURSE_SYNC_PENDING', 'Wait until the course has synchronized before assigning concepts.', 409);
            }

            const [existing] = await connection.execute(
                `SELECT concept_id FROM concept_course
                 WHERE concept_id = ? AND course_graph_id = ? FOR UPDATE`,
                [canonicalConceptId, canonicalRows[0].graph_course_id]
            );
            if (existing.length) {
                throw new CourseManagementError('CONCEPT_ALREADY_ASSIGNED', 'This concept already belongs to the selected course.', 409);
            }

            await connection.execute(
                'INSERT INTO concept_course (concept_id, course_graph_id) VALUES (?, ?)',
                [canonicalConceptId, canonicalRows[0].graph_course_id]
            );
            await recordAdminSyncEvent(
                connection, Number(adminId), 'CONCEPT', canonicalConceptId,
                { operation: 'course-assignment', courseId: targetCourseId }
            );
            await connection.commit();
            started = false;
            return { courseId: targetCourseId, conceptId: canonicalConceptId, syncStatus: 'pending' };
        } catch (error) {
            if (started) {
                try { await connection.rollback(); }
                catch { try { connection.destroy(); destroyed = true; } catch {} }
            }
            throw error;
        } finally {
            if (lockAcquired && !destroyed) {
                try { await connection.execute('SELECT RELEASE_LOCK(?)', [COURSE_CONCEPT_LOCK]); } catch {}
            }
            if (!destroyed) try { connection.release(); } catch {}
        }
    }

    async function changePrerequisite({ prerequisiteCourseId, targetCourseId, adminId, action }) {
        const prerequisiteId = Number(prerequisiteCourseId);
        const targetId = Number(targetCourseId);
        if (!Number.isSafeInteger(prerequisiteId) || prerequisiteId < 1 ||
            !Number.isSafeInteger(targetId) || targetId < 1 || !['add', 'remove'].includes(action)) {
            throw new CourseManagementError('INVALID_PREREQUISITE', 'Choose two valid approved courses.');
        }
        if (prerequisiteId === targetId) throw new CourseManagementError('SELF_PREREQUISITE', 'A course cannot be its own prerequisite.');
        const connection = await mysql.getConnection();
        let started = false;
        let lockAcquired = false;
        let destroyed = false;
        try {
            const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 5) AS acquired', [COURSE_PREREQUISITE_LOCK]);
            if (Number(lockRows[0]?.acquired) !== 1) throw new CourseManagementError('PREREQUISITE_BUSY', 'Course prerequisite management is busy. Retry shortly.', 503);
            lockAcquired = true;
            await connection.beginTransaction();
            started = true;
            const [courses] = await connection.execute(
                'SELECT course_id FROM course WHERE course_id IN (?, ?) FOR UPDATE', [prerequisiteId, targetId]
            );
            if (new Set(courses.map(row => Number(row.course_id))).size !== 2) {
                throw new CourseManagementError('COURSE_NOT_FOUND', 'Both courses must be approved and available.', 422);
            }
            const [courseTasks] = await connection.execute(
                `SELECT c.course_id, o.sync_status
                 FROM course AS c
                 INNER JOIN knowledge_sync_outbox AS o
                   ON o.canonical_record_type = 'COURSE' AND o.canonical_record_id = c.course_id
                 WHERE c.course_id IN (?, ?) AND o.sync_status = 'completed'`,
                [prerequisiteId, targetId]
            );
            if (new Set(courseTasks.map(row => Number(row.course_id))).size !== 2) {
                throw new CourseManagementError('COURSE_SYNC_PENDING', 'Wait until both courses have synchronized before changing prerequisites.', 409);
            }
            const [existingRows] = await connection.execute(
                `SELECT course_prerequisite_id, is_active FROM course_prerequisite
                 WHERE prerequisite_course_id = ? AND target_course_id = ? FOR UPDATE`, [prerequisiteId, targetId]
            );
            let relationshipId;
            if (action === 'add') {
                if (existingRows[0]?.is_active) throw new CourseManagementError('DUPLICATE_PREREQUISITE', 'This course prerequisite already exists.', 409);
                const [edges] = await connection.execute(
                    'SELECT prerequisite_course_id, target_course_id FROM course_prerequisite WHERE is_active = TRUE FOR UPDATE'
                );
                if (wouldCycle(edges, prerequisiteId, targetId)) throw new CourseManagementError('PREREQUISITE_CYCLE', 'This relationship would create a course prerequisite cycle.', 409);
                if (existingRows.length) {
                    relationshipId = Number(existingRows[0].course_prerequisite_id);
                    await connection.execute('UPDATE course_prerequisite SET is_active = TRUE WHERE course_prerequisite_id = ?', [relationshipId]);
                } else {
                    const [inserted] = await connection.execute(
                        'INSERT INTO course_prerequisite (prerequisite_course_id, target_course_id, is_active) VALUES (?, ?, TRUE)',
                        [prerequisiteId, targetId]
                    );
                    relationshipId = Number(inserted.insertId);
                }
            } else {
                if (!existingRows[0]?.is_active) throw new CourseManagementError('PREREQUISITE_NOT_FOUND', 'Active course prerequisite not found.', 404);
                relationshipId = Number(existingRows[0].course_prerequisite_id);
                await connection.execute('UPDATE course_prerequisite SET is_active = FALSE WHERE course_prerequisite_id = ?', [relationshipId]);
            }
            await recordAdminSyncEvent(connection, adminId, 'COURSE_PREREQUISITE', relationshipId, { action });
            await connection.commit();
            started = false;
            return { relationshipId, prerequisiteCourseId: prerequisiteId, targetCourseId: targetId, active: action === 'add' };
        } catch (error) {
            if (started) {
                try { await connection.rollback(); } catch { try { connection.destroy(); destroyed = true; } catch {} }
            }
            throw error;
        } finally {
            if (lockAcquired && !destroyed) {
                try { await connection.execute('SELECT RELEASE_LOCK(?)', [COURSE_PREREQUISITE_LOCK]); } catch {}
            }
            if (!destroyed) try { connection.release(); } catch {}
        }
    }

    return {
        assignConceptToCourse,
        changePrerequisite,
        getConceptAssignmentOptions,
        getCoursesForStudents,
        listApprovedCourses,
        updateCourse
    };
}

module.exports = { CourseManagementError, createCourseManagementService };
