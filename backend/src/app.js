require('dotenv').config();

const express = require('express');
const cors = require('cors');
const healthRoute = require('./routes/health');
const uploadRoute = require('./routes/upload');
const authRoute = require('./routes/auth');
const aiRoute = require('./routes/ai');
const knowledgeGraphRoute = require('./routes/knowledgeGraph');

const app = express();

app.use(cors());
app.use(express.json());
app.use('/health', healthRoute);
app.use('/api/upload', uploadRoute);
app.use('/api/auth', authRoute);
app.use('/api/ai', aiRoute);
app.use('/api/kg', knowledgeGraphRoute);

app.get('/', (req, res) => {
    res.json({
        message: 'NeuroLearn backend is running'
    });
});

module.exports = app;