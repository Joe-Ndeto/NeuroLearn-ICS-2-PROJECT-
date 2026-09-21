const express = require('express');
const mysql = require('../config/mysql');
const { getSession } = require('../config/neo4j');

const router = express.Router();

router.get('/', async (req, res) => {
    let mysqlStatus = 'disconnected';
    let neo4jStatus = 'disconnected';

    try {
        await mysql.query('SELECT 1');
        mysqlStatus = 'connected';
    } catch (error) {
        console.error('MySQL health check failed:', error.message);
    }

    const session = getSession();

    try {
        await session.run('RETURN 1');
        neo4jStatus = 'connected';
    } catch (error) {
        console.error('Neo4j health check failed:', error.message);
    } finally {
        await session.close();
    }

    const overallStatus =
        mysqlStatus === 'connected' && neo4jStatus === 'connected'
            ? 'healthy'
            : 'degraded';

    res.json({
        status: overallStatus,
        mysql: mysqlStatus,
        neo4j: neo4jStatus
    });
});

module.exports = router;