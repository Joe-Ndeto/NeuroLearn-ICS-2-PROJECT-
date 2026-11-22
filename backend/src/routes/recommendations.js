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

function sanitizeDiagnostic(value) {
    return String(value ?? 'unknown')
        .replace(/(?:bolt(?:\+s)?|neo4j(?:\+s)?|mysql|https?):\/\/[^\s'"<>]+/gi, '[redacted connection string]')
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(/\b(?:MYSQL|NEO4J|JWT|GEMINI)_[A-Z0-9_]+\s*[:=]\s*[^\s,;]+/gi, '[redacted environment setting]')
        .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)\b\s*[:=]\s*(['"]?)[^\s,;'"]+/gi, '$1=[redacted]')
        .replace(/for user\s+['"][^'"]+['"]/gi, 'for user [redacted]')
        .replace(/[\r\n\t]+/g, ' ')
        .slice(0, 500);
}

function logRecommendationFailure(error) {
    const chain = [];
    const seen = new Set();
    let current = error;
    while (current && typeof current === 'object' && !seen.has(current) && chain.length < 5) {
        seen.add(current);
        chain.push({
            name: sanitizeDiagnostic(current.name || 'Error'),
            code: current.code === undefined ? null : sanitizeDiagnostic(current.code),
            message: sanitizeDiagnostic(current.message)
        });
        current = current.cause;
    }
    if (chain.length === 0) {
        chain.push({ name: 'Error', code: null, message: sanitizeDiagnostic(error) });
    }
    console.error('[Recommendations] Request failed:', JSON.stringify(chain));
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
        if (error.code === 'COURSE_NOT_CANONICAL') {
            return res.status(503).json({
                success: false,
                code: error.code,
                message: 'Database Concepts has not been connected to the approved course catalogue. Ask an administrator to reconcile the course and its approved concept associations.'
            });
        }
        if (error.code === 'COURSE_ASSOCIATION_MISMATCH' || error.code === 'COURSE_PREREQUISITE_MISMATCH' ||
            error.code === 'PREREQUISITE_CLOSURE_MISMATCH' || error.code === 'KNOWLEDGE_SYNC_PENDING') {
            return res.status(503).json({
                success: false,
                code: error.code,
                message: 'Course and prerequisite data are not fully synchronized. Please try again later or contact an administrator.'
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
            if (hasMatchingCourse) {
                logRecommendationFailure({
                    name: 'CourseResolutionError',
                    code: 'COURSE_LOOKUP_FAILED',
                    message: 'Database Concepts course is duplicated or has no valid course ID.'
                });
            }
            return res.status(hasMatchingCourse ? 503 : 404).json({
                success: false,
                code: hasMatchingCourse ? 'COURSE_LOOKUP_FAILED' : 'COURSE_NOT_FOUND',
                message: hasMatchingCourse
                    ? 'The Database Concepts course could not be validated.'
                    : 'The Database Concepts course is not available.'
            });
        }

        const recommendationResult = await recommendationService.getRecommendationResultForLearner({
            learnerId: req.user.learner_id,
            courseId: course.courseId
        });
        return res.status(200).json({
            success: true,
            course,
            recommendationMode: recommendationResult.recommendationMode,
            recommendations: recommendationResult.recommendations,
            concepts: recommendationResult.concepts,
            coursePrerequisiteEligibility: recommendationResult.coursePrerequisiteEligibility
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
