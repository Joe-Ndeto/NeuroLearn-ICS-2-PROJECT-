
require('dotenv').config();

const app = require('./app');
const {
    initializeKnowledgeGraph
} = require('./services/knowledgeGraphService');

const {
    closeNeo4jConnection
} = require('./config/neo4j');

const PORT = process.env.PORT || 5000;

async function startServer() {
    try {
        await initializeKnowledgeGraph();

        app.listen(PORT, () => {
            console.log(`NeuroLearn backend running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start NeuroLearn:', error);

        await closeNeo4jConnection();
        process.exit(1);
    }
}

startServer();
