require('dotenv').config();

const express = require('express');
const cors = require('cors');
const healthRoute = require('./routes/health');
const uploadRoute = require('./routes/upload');
const authRoute = require('./routes/auth');
const aiRoute = require('./routes/ai');
const knowledgeGraphRoute = require('./routes/knowledgeGraph');
const submissionsRoute = require('./routes/submissions');
const adminSubmissionsRoute = require('./routes/adminSubmissions');
const recommendationsRoute = require('./routes/recommendations');

const app = express();

app.use(cors());
app.use(express.json());
app.use('/health', healthRoute);
app.use('/api/upload', uploadRoute);
app.use('/api/auth', authRoute);
app.use('/api/ai', aiRoute);
app.use('/api/kg', knowledgeGraphRoute);
app.use('/api/submissions', submissionsRoute);
app.use('/api/admin/submissions', adminSubmissionsRoute);
app.use('/api/recommendations', recommendationsRoute);

app.get('/', (req, res) => {
    res.json({
        message: 'NeuroLearn backend is running'
    });
});

app.use((error, req, res, next) => {
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
        return res.status(400).json({
            success: false,
            message: 'Request body must contain valid JSON.'
        });
    }

    return next(error);
});

module.exports = app;
