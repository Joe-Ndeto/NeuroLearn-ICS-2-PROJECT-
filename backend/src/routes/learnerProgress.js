
'use strict';

const express = require('express');
const authenticateToken = require('../middleware/authenticateToken');

const {
    createLearnerProgressService,
    LearnerProgressError
} = require('../services/learnerProgressService');

const router = express.Router();
const progressService = createLearnerProgressService();

const COURSE_ID_PATTERN =
    /^COURSE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

router.get('/me/progress', authenticateToken, requireStudent, async (req, res) => {
    const courseId = typeof req.query.courseId === 'string'
        ? req.query.courseId.trim()
        : '';

    if (!COURSE_ID_PATTERN.test(courseId)) {
        return res.status(400).json({
            success: false,
            code: 'INVALID_COURSE_ID',
            message: 'Select a valid approved course to view your progress.'
        });
    }

    try {
        const result = await progressService.getProgressForLearner({
            learnerId: req.user.learner_id,
            courseId
        });

        return res.status(200).json({
            success: true,
            course: {
                courseId
            },
            ...result
        });
    } catch (error) {
        if (error instanceof LearnerProgressError) {
            if (error.code === 'LEARNER_NOT_FOUND') {
                return res.status(404).json({
                    success: false,
                    code: error.code,
                    message: 'The learner was not found.'
                });
            }

            if (
                error.code === 'COURSE_NOT_CANONICAL' ||
                error.code === 'COURSE_MAPPING_MISSING'
            ) {
                return res.status(404).json({
                    success: false,
                    code: error.code,
                    message: 'The selected course is not available in the approved course catalogue.'
                });
            }

            if (
                error.code === 'COURSE_SYNC_PENDING' ||
                error.code === 'COURSE_PREREQUISITE_MISMATCH'
            ) {
                return res.status(503).json({
                    success: false,
                    code: error.code,
                    message: 'Course and prerequisite data are still synchronizing. Please retry shortly.'
                });
            }

            if (error.code === 'INVALID_COURSE_ID') {
                return res.status(400).json({
                    success: false,
                    code: error.code,
                    message: 'Select a valid approved course.'
                });
            }
        }

        const errorName =
            typeof error?.name === 'string' &&
            /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
                ? error.name
                : 'Error';

        const errorCode =
            typeof error?.code === 'string' &&
            /^[A-Z0-9_-]+$/.test(error.code)
                ? error.code
                : 'unknown';

        console.error(
            `[Progress] Request failed name=${errorName} code=${errorCode}`
        );

        return res.status(503).json({
            success: false,
            code: 'PROGRESS_UNAVAILABLE',
            message: 'Learner progress could not be loaded. Please try again.'
        });
    }
});

module.exports = router;
