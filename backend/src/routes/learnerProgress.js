'use strict';

const express = require('express');
const authenticateToken = require('../middleware/authenticateToken');
const { getAllCourses } = require('../services/knowledgeGraphService');
const {
    createLearnerProgressService,
    LearnerProgressError
} = require('../services/learnerProgressService');

const router = express.Router();
const progressService = createLearnerProgressService();
const DATABASE_CONCEPTS_NAME = 'database concepts';

function requireStudent(req, res, next) {
    if (req.user?.role !== 'student') {
        return res.status(403).json({
            success: false,
            code: 'STUDENT_ROLE_REQUIRED',
            message: 'Only student accounts can access learner progress.'
        });
    }
    return next();
}

function resolveDatabaseConceptsCourse(courses) {
    if (!Array.isArray(courses)) return { status: 'unavailable' };
    const matches = courses.filter(course =>
        typeof course?.name === 'string' && course.name.trim().toLowerCase() === DATABASE_CONCEPTS_NAME
    );
    if (matches.length === 0) return { status: 'missing' };
    if (matches.length !== 1 || typeof matches[0].course_id !== 'string' || !matches[0].course_id.trim()) {
        return { status: 'invalid' };
    }
    return { status: 'found', course: { courseId: matches[0].course_id, name: matches[0].name.trim() } };
}

router.get('/me/progress', authenticateToken, requireStudent, async (req, res) => {
    try {
        const resolved = resolveDatabaseConceptsCourse(await getAllCourses());
        if (resolved.status === 'missing') {
            return res.status(404).json({ success: false, code: 'COURSE_NOT_FOUND', message: 'The Database Concepts course is not available.' });
        }
        if (resolved.status !== 'found') {
            return res.status(503).json({ success: false, code: 'COURSE_LOOKUP_FAILED', message: 'The Database Concepts course could not be validated.' });
        }

        const result = await progressService.getProgressForLearner({
            learnerId: req.user.learner_id,
            courseId: resolved.course.courseId
        });
        return res.status(200).json({ success: true, course: resolved.course, ...result });
    } catch (error) {
        if (error instanceof LearnerProgressError && error.code === 'LEARNER_NOT_FOUND') {
            return res.status(404).json({ success: false, code: error.code, message: 'The learner was not found.' });
        }
        const rawName = typeof error?.name === 'string' ? error.name : '';
        const rawCode = typeof error?.code === 'string' ? error.code : '';
        const errorName = /^[A-Za-z][A-Za-z0-9]*$/.test(rawName) ? rawName : 'Error';
        const errorCode = /^[A-Z0-9_-]+$/.test(rawCode) ? rawCode : 'unknown';
        console.error(`[Progress] Request failed name=${errorName} code=${errorCode}`);
        if (error instanceof LearnerProgressError && error.code === 'COURSE_NOT_CANONICAL') {
            return res.status(503).json({
                success: false,
                code: error.code,
                message: 'Database Concepts has not been connected to the approved course catalogue. Ask an administrator to reconcile the course and its approved concept associations.'
            });
        }
        if (error instanceof LearnerProgressError && error.code === 'COURSE_SYNC_PENDING') {
            return res.status(503).json({
                success: false,
                code: error.code,
                message: 'Course prerequisite data is still synchronizing. Please retry shortly.'
            });
        }
        return res.status(503).json({
            success: false,
            code: 'PROGRESS_UNAVAILABLE',
            message: 'Learner progress could not be loaded. Please try again.'
        });
    }
});

module.exports = router;
