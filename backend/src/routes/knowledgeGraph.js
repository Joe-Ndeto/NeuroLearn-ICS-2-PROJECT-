
const express = require('express');

const authenticateToken = require('../middleware/authenticateToken');
const requireAdmin = require('../middleware/requireAdmin');

const {
    getAllCourses,
    getAllConcepts,
    provisionCourse
} = require('../services/knowledgeGraphService');

const router = express.Router();

// Require authentication for every Knowledge Graph endpoint.
router.use(authenticateToken);

function validateRequired(body, fields) {
    return fields.every(field =>
        typeof body[field] === 'string' &&
        body[field].trim().length > 0
    );
}

// GET /api/kg/courses
// Authenticated students and administrators can view courses.
router.get('/courses', async (req, res) => {
    try {
        const courses = await getAllCourses();

        res.json({
            success: true,
            count: courses.length,
            courses
        });
    } catch (error) {
        console.error('[KG] Courses:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to retrieve courses.'
        });
    }
});

// GET /api/kg/concepts
// Authenticated students and administrators can view concepts.
router.get('/concepts', async (req, res) => {
    try {
        const concepts = await getAllConcepts();

        res.json({
            success: true,
            count: concepts.length,
            concepts
        });
    } catch (error) {
        console.error('[KG] Concepts:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to retrieve concepts.'
        });
    }
});

// POST /api/kg/courses
// Only administrators can create courses.
router.post('/courses', requireAdmin, async (req, res) => {
    if (!validateRequired(req.body, ['name'])) {
        return res.status(400).json({ success: false, message: 'Course name is required.' });
    }
    try {
        const result = await provisionCourse(req.body);
        return res.status(result.created ? 201 : 200).json({ success: true, created: result.created, course: result.course });
    } catch (error) {
        console.error('[KG] Create course:', error.code || 'course_provision_failed');
        return res.status(500).json({ success: false, message: 'Failed to create course.' });
    }
});

// POST /api/kg/concepts
// Direct graph writes are disabled; concepts must use canonical review.
router.post('/concepts', requireAdmin, (req, res) => {
    return res.status(410).json({
        success: false,
        code: 'CONCEPT_SUBMISSION_REQUIRED',
        message: 'Direct concept creation is deprecated. Submit a concept at /api/submissions/concepts, then approve it at /api/admin/submissions/:id/approve.'
    });
});

// POST /api/kg/prerequisites
// Direct graph writes are disabled; prerequisites must use canonical review.
router.post('/prerequisites', requireAdmin, (req, res) => {
    return res.status(410).json({
        success: false,
        code: 'PREREQUISITE_SUBMISSION_REQUIRED',
        message: 'Direct prerequisite creation is deprecated. Submit a prerequisite at /api/submissions/prerequisites, then approve it at /api/admin/submissions/:id/approve.'
    });
});

// POST /api/kg/resources
// Direct graph writes are disabled; resources must use canonical review.
router.post('/resources', requireAdmin, (req, res) => {
    return res.status(410).json({
        success: false,
        code: 'RESOURCE_SUBMISSION_REQUIRED',
        message: 'Direct resource creation is deprecated. Submit a learning resource at /api/submissions/resources, then approve it at /api/admin/submissions/:id/approve.'
    });
});

module.exports = router;
