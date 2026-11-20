# Frontend API configuration

The frontend is served as static files. `config.js` is loaded before `api.js`
and the page scripts. It contains the development default:

```js
window.NEUROLEARN_CONFIG = Object.freeze({
    apiBaseUrl: 'http://localhost:5000/api'
});
```

For deployment, provide the API origin and `/api` path in this configuration
asset (or replace it during static-site deployment). Application scripts use
the shared `NeuroLearnApi` helper and do not need environment-specific edits.
No production origin is assumed. The API must permit the deployed static
frontend origin through its CORS configuration.

## Worker health

The administrator synchronization panel calls the authenticated
`GET /api/admin/submissions/worker-health` API endpoint. The API contacts the
worker on `127.0.0.1` using `KNOWLEDGE_SYNC_HEALTH_PORT` (default `5001`) with a
bounded timeout. The browser does not contact the worker port directly, and
the worker health listener should remain bound to loopback.
