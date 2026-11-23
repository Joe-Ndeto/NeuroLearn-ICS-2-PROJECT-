# Frontend API configuration

The static frontend loads `config.js` before `api.js`. The shared API helper uses an explicit `window.NEUROLEARN_CONFIG.apiBaseUrl` when supplied. If no value is supplied, loopback development uses the local API and deployed HTTP(S) sites use their same-origin `/api` path.

For a same-origin deployment, route `/api` through the frontend host or reverse proxy to the backend. For a separately hosted API, define `window.NEUROLEARN_CONFIG` before `config.js` or replace the deployment configuration asset with the API origin plus `/api`. This is a public URL setting only: never put MySQL, Neo4j, JWT or Gemini secrets in frontend files.

The deployed API must allow the exact frontend origin through `CORS_ALLOWED_ORIGINS`. CORS does not replace API authentication or server-side role authorization.

See the repository [`DEPLOYMENT.md`](../DEPLOYMENT.md) for environment variable names, health checks, Python setup, worker topology and persistent storage requirements.
