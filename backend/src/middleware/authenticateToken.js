
const jwt = require('jsonwebtoken');
const db = require('../config/mysql');

async function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            message: 'Authentication token is required.'
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const learnerId = decoded.learnerId || decoded.sub;

        if (!learnerId) {
            return res.status(401).json({
                success: false,
                message: 'Invalid authentication token.'
            });
        }

        const [learners] = await db.execute(
            `SELECT learner_id, username, email, role
             FROM learner
             WHERE learner_id = ?`,
            [learnerId]
        );

        if (learners.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Learner account not found.'
            });
        }

        // Get the latest account details and role from MySQL.
        req.user = learners[0];

        next();

    } catch (error) {
        if (
            error.name === 'JsonWebTokenError' ||
            error.name === 'TokenExpiredError'
        ) {
            return res.status(401).json({
                success: false,
                message: 'Invalid or expired authentication token.'
            });
        }

        console.error('Authentication error:', error);

        return res.status(500).json({
            success: false,
            message: 'Authentication could not be completed.'
        });
    }
}

module.exports = authenticateToken;
