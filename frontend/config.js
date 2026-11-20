'use strict';

// Deployment-specific static configuration. Set apiBaseUrl to the deployed
// API origin plus /api, for example https://api.example.invalid/api.
// Leave the local default for development; application scripts do not need edits.
window.NEUROLEARN_CONFIG = Object.freeze({
    apiBaseUrl: 'http://localhost:5000/api'
});
