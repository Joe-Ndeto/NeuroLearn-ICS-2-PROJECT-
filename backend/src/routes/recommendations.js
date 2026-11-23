
'use strict';

const express = require('express');
const authenticateToken = require('../middleware/authenticateToken');

const {
    createRecommendationService,
    RecommendationServiceError
} = require('../services/recommendationService');

const router = express.Router();
const recommendationService = createRecommendationService();

const COURSE_ID_PATTERN =
    /^COURSE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function logRecommendationFailure(error) {
    const name =
        typeof error?.name === 'string' &&
        /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
            ? error.name
            : 'Error';

    const code =
        typeof error?.code === 'string' &&
        /^[A-Z0-9_-]+$/.test(error.code)
            ? error.code
            : 'unknown';

    console.error(
        `[Recommendations] Request failed name=${name} code=${code}`
    );
}

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

function serviceErrorResponse(error, res) {
    if (error instanceof RecommendationServiceError) {
        if (
            error.code === 'COURSE_NOT_FOUND' ||
            error.code === 'COURSE_NOT_CANONICAL'
        ) {
            return res.status(404).json({
                success: false,
                code: error.code,
                message: 'The selected course is not available in the approved course catalogue.'
            });
        }

        if (error.code === 'UNSUPPORTED_RECOMMENDATION_COURSE') {
            return res.status(422).json({
                success: false,
                code: error.code,
                message: 'Recommendations are not available for this course.'
            });
        }

        if (
            error.code === 'COURSE_ASSOCIATION_MISMATCH' ||
            error.code === 'COURSE_PREREQUISITE_MISMATCH' ||
            error.code === 'PREREQUISITE_CLOSURE_MISMATCH' ||
            error.code === 'KNOWLEDGE_SYNC_PENDING'
        ) {
            return res.status(503).json({
                success: false,
                code: error.code,
                message: 'Course and prerequisite data are still synchronizing. Please retry shortly.'
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
    const courseId = typeof req.query.courseId === 'string'
        ? req.query.courseId.trim()
        : '';

    if (!COURSE_ID_PATTERN.test(courseId)) {
        return res.status(400).json({
            success: false,
            code: 'INVALID_COURSE_ID',
            message: 'Select a valid approved course to view recommendations.'
        });
    }

    try {
        const recommendationResult =
            await recommendationService.getRecommendationResultForLearner({
                learnerId: req.user.learner_id,
                courseId
            });

        return res.status(200).json({
            success: true,
            course: {
                courseId
            },
            recommendationMode: recommendationResult.recommendationMode,
            recommendations: recommendationResult.recommendations,
            concepts: recommendationResult.concepts,
            coursePrerequisiteEligibility:
                recommendationResult.coursePrerequisiteEligibility
        });
    } catch (error) {
        logRecommendationFailure(error);

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
