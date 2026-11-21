'use strict';

const express = require('express');
const authenticateToken = require('../middleware/authenticateToken');
const { getAllCourses } = require('../services/knowledgeGraphService');
const {
    createRecommendationService,
    RecommendationServiceError
} = require('../services/recommendationService');

const router = express.Router();
const recommendationService = createRecommendationService();
const DATABASE_CONCEPTS_NAME = 'database concepts';

function requireStudent(req, res, next) {
    if (req.user?.role !== 'student') {
        return res.status(403).json({
            success: false,
            code: 'STUDENT_ROLE_REQUIRED',
            message: 'Only student accounts can access recommendations.'
        });
    }
    return next();
}

function findDatabaseConceptsCourse(courses) {
    if (!Array.isArray(courses)) return null;
    const matches = courses.filter(course =>
        typeof course?.name === 'string' && course.name.trim().toLowerCase() === DATABASE_CONCEPTS_NAME
    );
    if (matches.length !== 1 || typeof matches[0]?.course_id !== 'string' || !matches[0].course_id.trim()) {
        return null;
    }
    return { courseId: matches[0].course_id, name: matches[0].name.trim() };
}

function serviceErrorResponse(error, res) {
    if (error instanceof RecommendationServiceError) {
        if (error.code === 'COURSE_NOT_FOUND') {
            return res.status(404).json({
                success: false,
                code: error.code,
                message: 'The Database Concepts course is unavailable.'
            });
        }
        if (error.code === 'UNSUPPORTED_RECOMMENDATION_COURSE') {
            return res.status(422).json({
                success: false,
                code: error.code,
                message: 'Recommendations are currently available only for Database Concepts.'
            });
        }
    }

    return res.status(503).json({
        success: false,
        code: 'RECOMMENDATIONS_UNAVAILABLE',
        message: 'Recommendations could not be loaded. Please try again.'
    });
}

router.get('/me', authenticateToken, requireStudent, async (req, res) => {
    try {
        const courses = await getAllCourses();
        const course = findDatabaseConceptsCourse(courses);
        if (!course) {
            const hasMatchingCourse = Array.isArray(courses) && courses.some(item =>
                typeof item?.name === 'string' && item.name.trim().toLowerCase() === DATABASE_CONCEPTS_NAME
            );
            return res.status(hasMatchingCourse ? 503 : 404).json({
                success: false,
                code: hasMatchingCourse ? 'COURSE_LOOKUP_FAILED' : 'COURSE_NOT_FOUND',
                message: hasMatchingCourse
                    ? 'The Database Concepts course could not be validated.'
                    : 'The Database Concepts course is not available.'
            });
        }

        const recommendations = await recommendationService.getRecommendationsForLearner({
            learnerId: req.user.learner_id,
            courseId: course.courseId
        });
        return res.status(200).json({
            success: true,
            course,
            recommendations
        });
    } catch (error) {
        if (error instanceof RecommendationServiceError) {
            return serviceErrorResponse(error, res);
        }
        return res.status(503).json({
            success: false,
            code: 'RECOMMENDATIONS_UNAVAILABLE',
            message: 'Recommendations could not be loaded. Please try again.'
        });
    }
});

module.exports = router;
