const neo4j = require('neo4j-driver');

const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const username = process.env.NEO4J_USERNAME || 'neo4j';
const password = process.env.NEO4J_PASSWORD;

if (!password) {
    throw new Error('NEO4J_PASSWORD is missing from the backend environment.');
}

const driver = neo4j.driver(
    uri,
    neo4j.auth.basic(username, password)
);

const getSession = () => driver.session({
    database: process.env.NEO4J_DATABASE || 'neo4j'
});

async function verifyNeo4jConnection() {
    const session = getSession();

    try {
        await session.run('RETURN 1 AS connected');
        console.log('Neo4j connection successful.');
    } finally {
        await session.close();
    }
}

async function closeNeo4jConnection() {
    await driver.close();
}

module.exports = {
    driver,
    getSession,
    verifyNeo4jConnection,
    closeNeo4jConnection
};
