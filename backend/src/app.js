require('dotenv').config();

const express = require('express');
const cors = require('cors');
const healthRoute = require('./routes/health');
const uploadRoute = require('./routes/upload');

const app = express();

app.use(cors());
app.use(express.json());
app.use('/health', healthRoute);
app.use('/api/upload', uploadRoute);

app.get('/', (req, res) => {
    res.json({
        message: 'NeuroLearn backend is running'
    });
});

module.exports = app;