
const express = require('express');

const authenticateToken = require('../middleware/authenticateToken');
const requireAdmin = require('../middleware/requireAdmin');

const {
    getAllCourses,
    getAllConcepts,
    createCourse,
    createConcept,
    addPrerequisite,
    addLearningResource
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
        return res.status(400).json({
            success: false,
            message: 'Course name is required.'
        });
    }

    try {
        const course = await createCourse(req.body);

        res.status(201).json({
            success: true,
            course
        });
    } catch (error) {
        console.error('[KG] Create course:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to create course.'
        });
    }
});

// POST /api/kg/concepts
// Only administrators can create concepts.
router.post('/concepts', requireAdmin, async (req, res) => {
    if (!validateRequired(req.body, ['name', 'courseId'])) {
        return res.status(400).json({
            success: false,
            message: 'Concept name and course ID are required.'
        });
    }

    try {
        const concept = await createConcept(req.body);

        res.status(201).json({
            success: true,
            concept
        });
    } catch (error) {
        console.error('[KG] Create concept:', error);

        res.status(404).json({
            success: false,
            message: error.message
        });
    }
});

// POST /api/kg/prerequisites
// Only administrators can add prerequisite relationships.
router.post('/prerequisites', requireAdmin, async (req, res) => {
    if (!validateRequired(req.body, ['prerequisiteId', 'targetId'])) {
        return res.status(400).json({
            success: false,
            message: 'Both concept IDs are required.'
        });
    }

    try {
        const relationship = await addPrerequisite(req.body);

        res.status(201).json({
            success: true,
            relationship
        });
    } catch (error) {
        console.error('[KG] Add prerequisite:', error);

        res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// POST /api/kg/resources
// Only administrators can add learning resources.
router.post('/resources', requireAdmin, async (req, res) => {
    if (!validateRequired(req.body, [
        'conceptId',
        'title',
        'type',
        'url'
    ])) {
        return res.status(400).json({
            success: false,
            message: 'Concept ID, title, type and URL are required.'
        });
    }

    try {
        const resource = await addLearningResource(req.body);

        res.status(201).json({
            success: true,
            resource
        });
    } catch (error) {
        console.error('[KG] Add resource:', error);

        res.status(404).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;
